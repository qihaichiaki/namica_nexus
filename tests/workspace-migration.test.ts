import { DatabaseSync } from 'node:sqlite'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Store } from '../apps/host/src/store.js'

let root: string
let store: Store | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-move-'))
  vi.stubEnv('LOCALAPPDATA', join(root, 'appdata'))
})
afterEach(async () => {
  store?.close()
  store = undefined
  vi.unstubAllEnvs()
  await rm(root, {recursive: true, force: true, maxRetries: 5})
})
function identity(workspace = '') {
  return store!.saveIdentity({name: 'Test', avatar: '', description: '', personality: '', runtimeConfigId: 'codex', workspace})
}

test('moving a data directory relocates generated workspaces and preserves explicit session paths', async () => {
  const before = join(root, 'before')
  const after = join(root, 'after')
  store = new Store(before)
  const original = join(before, 'workspace')
  const external = join(root, 'other-workspace')
  const generated = identity()
  const session = store.createSession(generated.id)
  // Explicit identity paths stay fixed even if they happen to equal the current default.
  const fixed = store.createSession(identity(original).id)
  expect(store.saveRuntime({...store.runtime('codex'), workspace: external}).workspace).toBe(external)
  const custom = store.createSession(generated.id)
  expect(store.saveRuntime({...store.runtime('codex'), workspace: ''}).workspace).toBe(original)
  store.saveRuntime({...store.runtime('codex'), model: 'example'})
  store.close()
  store = undefined
  await cp(before, after, {recursive: true})
  store = new Store(after)
  expect(store.runtime('codex')).toMatchObject({workspace: join(after, 'workspace'), model: 'example'})
  expect(store.storedSession(session.sessionId).workspace).toBe(join(after, 'workspace'))
  expect(store.storedSession(fixed.sessionId).workspace).toBe(original)
  expect(store.storedSession(custom.sessionId).workspace).toBe(external)
})

test('a copied legacy database relocates only known generated paths without modifying the source', async () => {
  const before = join(process.env.LOCALAPPDATA!, 'NamicaNexus')
  const original = join(before, 'workspace')
  const after = join(root, 'project', 'data')
  store = new Store(before)
  const inherited = store.createSession(identity().id)
  const fixed = store.createSession(identity(original).id)
  const external = join(root, 'explicit', 'workspace')
  const custom = store.createSession(identity(external).id)
  store.close()
  store = undefined
  await mkdir(original, {recursive: true})
  await writeFile(join(original, 'fixture.txt'), 'moved')
  const database = join(before, 'nexus.sqlite')
  // Recreate the persisted values and schema version written by the original release.
  const legacy = new DatabaseSync(database)
  try {
    legacy.prepare("UPDATE runtimes SET json=json_set(json,'$.workspace',?) WHERE id='codex'").run(original)
    legacy.prepare('UPDATE sessions SET workspace=? WHERE sessionId=?').run(original, inherited.sessionId)
    legacy.exec('PRAGMA user_version=0')
  } finally { legacy.close() }
  const originalBytes = await readFile(database)
  await cp(before, after, {recursive: true})
  store = new Store(after)
  expect(store.runtimes()[0].workspace).toBe(join(after, 'workspace'))
  expect(await readFile(join(store.storedSession(inherited.sessionId).workspace, 'fixture.txt'), 'utf8')).toBe('moved')
  expect(store.storedSession(inherited.sessionId).workspace).toBe(join(after, 'workspace'))
  expect(store.storedSession(fixed.sessionId).workspace).toBe(original)
  expect(store.storedSession(custom.sessionId).workspace).toBe(external)
  // A user can deliberately restore the former absolute path; subsequent starts preserve it.
  store.saveRuntime({...store.runtime('codex'), workspace: original})
  store.close()
  store = new Store(after)
  expect(store.runtime('codex').workspace).toBe(original)
  expect(await readFile(database)).toEqual(originalBytes)
})
