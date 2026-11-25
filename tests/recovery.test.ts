import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHost } from '../apps/host/src/app.js'
import type { Identity, Session, SessionSnapshot } from '../packages/protocol/src/index.js'

describe('Host process recovery', () => {
  let directory: string
  let child: ChildProcess | undefined
  let address: string
  async function start() {
    child = fork(new URL('./fixtures/pending-host.ts', import.meta.url), [directory], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    address = await new Promise<string>((resolve, reject) => {
      child!.once('message', address => resolve(String(address)))
      child!.once('error', reject)
      child!.once('exit', code => reject(new Error('Host exited: ' + code)))
    })
  }
  async function kill() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    child = undefined
  }
  function request(path: string, body?: object) {
    return fetch(address + '/api' + path, body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    })
  }
  async function begin() {
    const identity: Identity = await (await request('/identities', {name: 'Test'})).json()
    const session: Session = await (await request('/sessions', {identityId: identity.id})).json()
    const resource = '/sessions/' + session.sessionId
    expect((await request(resource + '/messages', {content: 'test'})).status).toBe(202)
    return resource
  }
  const snapshot = async (resource: string): Promise<SessionSnapshot> => (await request(resource)).json()

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-recovery-'))
    await start()
  })
  afterEach(async () => {
    await kill()
    await rm(directory, {recursive: true, force: true, maxRetries: 5})
  })

  it('prevents competing recovery and marks a killed Host turn interrupted on restart', async () => {
    const resource = await begin()
    await expect(buildHost({dataDirectory: directory})).rejects.toThrow(/locked|busy/i)
    expect((await snapshot(resource)).session.status).toBe('running')
    await kill()
    await start()
    const recovered = await snapshot(resource)
    expect(recovered.session).toMatchObject({status: 'interrupted', runtimeSessionId: 'fixture-thread', title: 'test'})
    expect(recovered.turns[0].status).toBe('interrupted')
    expect(recovered.messages[1]).toMatchObject({content: 'Partial reply', status: 'interrupted'})
    expect(recovered.tools[0].status).toBe('interrupted')
    expect(recovered.approvals).toHaveLength(0)
    expect((await request(resource + '/messages', {content: 'resume'})).status).toBe(202)
  })

  it('routes a pending decision to its own session and rejects stale responses', async () => {
    const first = await begin()
    const second = await begin()
    const [approval] = (await snapshot(first)).approvals
    const answer = (resource: string, id: string, decision: string) => request(resource + '/approvals/' + id, {decision})
    expect((await answer(first, 'missing', 'accept')).status).toBe(409)
    expect((await answer(first, approval.id, 'accept-always')).status).toBe(400)
    expect((await answer(first, approval.id, 'decline')).status).toBe(200)
    expect((await answer(first, approval.id, 'accept')).status).toBe(409)
    expect((await snapshot(first)).messages.at(-1)?.content).toBe('Declined')
    expect((await snapshot(first)).tools[0]).toMatchObject({status: 'failed', detail: 'declined'})
    expect((await snapshot(second)).approvals).toHaveLength(1)
    expect((await answer(second, approval.id, 'accept')).status).toBe(200)
    expect((await snapshot(second)).messages.at(-1)?.content).toBe('Accepted')
  })
})
