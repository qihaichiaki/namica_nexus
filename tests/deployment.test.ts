import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrateDirectory, validateMigration } from '../apps/host/src/migration.js'
import { DeploymentProfile, lockProfile } from '../apps/host/src/deployment.js'
import { buildHost } from '../apps/host/src/app.js'
import type { AgentAdapter } from '../packages/agent-core/src/index.js'
import { Store } from '../apps/host/src/store.js'

let root: string, source: string, target: string, settings: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-deployment-'))
  source = join(root, 'old')
  target = join(root, 'new')
  settings = join(root, 'installation', 'profile.json')
  new Store(source).close()
})
afterEach(() => rmSync(root, {recursive: true, force: true, maxRetries: 5}))

test('migrates a closed store, private file login, thread indices and managed workspaces to the final path', () => {
  const store = new Store(source)
  const identity = store.saveIdentity({name: 'Synthetic', description: '', personality: '', avatar: '', runtimeConfigId: 'codex', workspace: join(source, 'custom')})
  const session = store.createSession(identity.id)
  store.mapSession(session.sessionId, 'native')
  const turn = store.beginTurn(session.sessionId, 'fixture')
  store.writeReply(turn.turnId, 'partial')
  store.finish(turn, 'interrupted', 'stopped')
  store.close()
  const home = join(source, 'codex-home')
  const oldRollout = join(home, 'sessions', 'thread.jsonl')
  mkdirSync(join(home, 'sessions'), {recursive: true})
  mkdirSync(join(source, 'custom'))
  writeFileSync(join(home, 'auth.json'), 'synthetic login')
  writeFileSync(oldRollout, 'synthetic native history')
  const native = new DatabaseSync(join(home, 'state_5.sqlite'))
  native.exec('CREATE TABLE threads (rollout_path TEXT,cwd TEXT)')
  native.prepare('INSERT INTO threads VALUES (?,?)').run(oldRollout, join(source, 'custom'))
  native.close()
  const backup = readFileSync(join(source, 'nexus.sqlite'))
  migrateDirectory(source, target, settings)
  expect(readFileSync(join(source, 'nexus.sqlite'))).toEqual(backup)
  const moved = new Store(target)
  try {
    expect(moved.identity(identity.id).workspace).toBe(join(target, 'custom'))
    expect(moved.storedSession(session.sessionId)).toMatchObject({runtimeSessionId: 'native', workspace: join(target, 'custom')})
    expect(moved.snapshot(session.sessionId).messages[1]).toMatchObject({content: 'partial', status: 'interrupted'})
  } finally { moved.close() }
  const movedIndex = new DatabaseSync(join(target, 'codex-home', 'state_5.sqlite'))
  try {
    expect(movedIndex.prepare('SELECT * FROM threads').get()).toEqual({rollout_path: join(target, 'codex-home', 'sessions', 'thread.jsonl'), cwd: join(target, 'custom')})
  } finally { movedIndex.close() }
  expect(readFileSync(join(target, 'codex-home', 'auth.json'), 'utf8')).toBe('synthetic login')
})
test('rejects nested and aliased folders, nonempty targets, source links and a live store', () => {
  const alias = join(root, 'alias')
  symlinkSync(source, alias, 'junction')
  for (const invalid of [root, join(source, 'nested'), alias, join(alias, 'nested')]) {
    expect(() => validateMigration(source, invalid, settings)).toThrow()
  }
  mkdirSync(target)
  writeFileSync(join(target, 'keep'), 'unrelated')
  expect(() => migrateDirectory(source, target, settings)).toThrow()
  expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('unrelated')
  const live = new Store(source)
  try { expect(() => migrateDirectory(source, join(root, 'other'), settings)).toThrow() } finally { live.close() }
  symlinkSync(target, join(source, 'escape'), 'junction')
  expect(() => migrateDirectory(source, join(root, 'other'), settings)).toThrow()
  expect(readdirSync(root)).not.toContain('other')
  expect(readdirSync(root).filter(f => f.startsWith('.nexus-migration-'))).toEqual([])
})
test('confirmed restart drains an active turn and closes SQLite before migration', async () => {
  const seed = {address: '127.0.0.1' as const, port: 8080, dataDirectory: source}
  const profile = new DeploymentProfile(settings, seed)
  const fake: AgentAdapter = {
    type: 'codex', capabilities: {resume: true, stream: true, cancel: true, approvals: true},
    async checkAvailability() { return {available: true, version: 'fixture', detail: ''} },
    run(_input, publish) {
      let cancel!: () => void
      const done = new Promise<'cancelled'>(resolve => { cancel = () => resolve('cancelled') })
      publish({type: 'session.ready', runtimeSessionId: 'test-thread'})
      publish({type: 'message.updated', content: 'partial'})
      return {done, cancel, respondApproval: () => false}
    },
  }
  let confirm!: () => void
  const closed = new Promise<void>(resolve => { confirm = resolve })
  const app = await buildHost({dataDirectory: source, port: 0, adapterFactory: () => fake, deployment: profile, onRestart: confirm})
  try {
    const base = await app.listen({host: '127.0.0.1', port: 0})
    async function api(route: string, method = 'GET', body?: object) {
      return fetch(base + '/api/' + route, {method, headers: body && {'content-type': 'application/json'}, body: body && JSON.stringify(body)})
    }
    const {id} = await (await api('identities', 'POST', {name: 'Test'})).json()
    const {sessionId} = await (await api('sessions', 'POST', {identityId: id})).json()
    await api('sessions/' + sessionId + '/messages', 'POST', {content: 'test'})
    const status = await (await api('manage/host/status')).json()
    const pending = {address: seed.address, port: status.port, dataDirectory: target}
    await api('manage/deployment', 'PATCH', pending)
    expect(status.activeTurns).toBe(1)
    const confirmation = {instanceId: status.instanceId, activeTurns: 1, expectedPending: pending}
    expect((await api('manage/host/restart', 'POST', {...confirmation, activeTurns: 0})).status).toBe(409)
    expect((await api('manage/host/restart', 'POST', confirmation)).status).toBe(202)
    await closed
    migrateDirectory(source, target, settings)
    const migrated = new Store(target)
    try {
      expect(migrated.snapshot(sessionId).turns[0].status).toBe('interrupted')
      expect(migrated.snapshot(sessionId).messages[1]).toMatchObject({content: 'partial', status: 'interrupted'})
    } finally { migrated.close() }
  } finally { await app.close() }
})

test('pending settings survive reconstruction, lock out parallel boots and reject unrelated data', () => {
  const seed = {address: '127.0.0.1' as const, port: 9000, dataDirectory: source}
  const p = new DeploymentProfile(settings, seed)
  p.save(seed, {port: 9001, dataDirectory: target})
  expect(new DeploymentProfile(settings, seed).read()).toEqual({active: seed, pending: {...seed, port: 9001, dataDirectory: target}})
  expect(() => p.save(seed, {address: '0.0.0.0'})).toThrow()
  const unlock = lockProfile(settings, 'host')
  try { expect(() => lockProfile(settings, 'host')).toThrow() } finally { unlock() }
})
