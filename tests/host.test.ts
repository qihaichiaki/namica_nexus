import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildHost } from '../apps/host/src/app.js'
import type { AgentAdapter, AgentEvent, AgentInput } from '../packages/agent-core/src/index.js'
import type { SessionSnapshot } from '../packages/protocol/src/index.js'

/** Keep runtime I/O under test control while exercising the real HTTP and SQLite paths. */
function controlledRuntime() {
  const runs: {
    input: AgentInput
    publish: (event: AgentEvent) => void
    complete: () => void
    fail: () => void
  }[] = []
  const adapter: AgentAdapter = {
    type: 'codex',
    capabilities: { resume: true, stream: true, cancel: true, approvals: true },
    async checkAvailability() { return { available: true, version: 'test', detail: 'ready' } },
    run(input, publish) {
      let resolve!: (value: 'completed' | 'cancelled') => void
      let reject!: (reason: Error) => void
      const done = new Promise<'completed' | 'cancelled'>((ok, fail) => {
        resolve = ok
        reject = fail
      })
      runs.push({ input, publish, complete: () => resolve('completed'), fail: () => reject(new Error('runtime exited')) })
      return { done, cancel: () => resolve('cancelled'), respondApproval: () => false }
    },
  }
  return { runs, adapter }
}

describe('local Host', () => {
  let app: FastifyInstance
  let dataDirectory: string
  let runtime: ReturnType<typeof controlledRuntime>
  const headers = { host: '127.0.0.1:8080' }
  const connect = () => buildHost({ dataDirectory, port: 8080, adapterFactory: () => runtime.adapter })
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url: '/api' + url, headers, payload })
  const snapshot = async (id: string): Promise<SessionSnapshot> => (await api('GET', '/sessions/' + id)).json()
  const createIdentity = async (name: string, personality: string) => {
    const res = await api('POST', '/identities', { name, personality })
    expect(res.statusCode, res.body).toBeLessThan(300)
    return res.json().id as string
  }
  const createSession = async (identityId: string) => {
    const res = await api('POST', '/sessions', { identityId, title: '回归测试' })
    expect(res.statusCode, res.body).toBeLessThan(300)
    return res.json().sessionId as string
  }
  const send = (id: string, content: string) => api('POST', '/sessions/' + id + '/messages', { content })

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'nexus 测试 '))
    runtime = controlledRuntime()
    app = await connect()
  })
  afterEach(async () => {
    await app?.close()
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3 })
  })

  it('keeps immutable session instructions, ordered messages and runtime mappings across a restart', async () => {
    const id = await createIdentity('甲', '使用原始签名')
    const session = await createSession(id)
    await api('PATCH', '/identities/' + id, { personality: '使用新签名' })
    const fresh = await createSession(id)
    const other = await createSession(await createIdentity('乙', '独立人格'))
    expect((await send(session, '你好')).statusCode).toBe(202)
    expect((await send(session, 'duplicate')).statusCode).toBe(409)
    const first = runtime.runs[0]
    expect(first.input.instructions).toContain('使用原始签名')
    expect(first.input.workspace.startsWith(dataDirectory)).toBe(true)
    first.publish({ type: 'session.ready', runtimeSessionId: 'upstream-a' })
    first.publish({ type: 'message.updated', content: '流式' })
    expect((await snapshot(session)).messages.map(m => m.content)).toEqual(['你好', '流式'])
    first.publish({ type: 'message.updated', content: '流式回复' })
    first.complete()
    await expect.poll(async () => (await snapshot(session)).session.status).toBe('completed')
    await app.close()
    app = await connect()
    const saved = await snapshot(session)
    expect(saved.session.runtimeSessionId).toBe('upstream-a')
    expect(saved.messages[0].sequence).toBeLessThan(saved.messages[1].sequence)
    expect(saved.messages[1].content).toBe('流式回复')
    expect((await snapshot(other)).messages).toEqual([])
    await send(session, '继续')
    expect(runtime.runs.at(-1)?.input.runtimeSessionId).toBe('upstream-a')
    await send(fresh, '你好')
    expect(runtime.runs.at(-1)?.input.instructions).toContain('使用新签名')
    expect(runtime.runs.at(-1)?.input.runtimeSessionId).toBeFalsy()
    runtime.runs.slice(1).forEach(run => run.complete())
  })

  it('preserves partial text on failures and cancellation, then accepts another turn', async () => {
    const session = await createSession(await createIdentity('运行状态', '简明'))
    await send(session, '开始')
    runtime.runs[0].publish({ type: 'message.updated', content: '部分结果' })
    runtime.runs[0].fail()
    await expect.poll(async () => (await snapshot(session)).turns[0].status).toBe('failed')
    const failed = await snapshot(session)
    expect(failed.messages[1]).toMatchObject({ content: '部分结果', status: 'failed' })
    expect(failed.turns[0].error).toContain('runtime exited')
    expect((await send(session, '再次开始')).statusCode).toBe(202)
    await api('POST', '/sessions/' + session + '/cancel')
    await expect.poll(async () => (await snapshot(session)).session.status).toBe('cancelled')
  })

  it('persists editable configuration and checks the selected runtime', async () => {
    const [config] = (await api('GET', '/runtimes')).json()
    const check = await api('POST', '/runtimes/' + config.id + '/check')
    expect(check.statusCode, check.body).toBe(200)
    expect(check.json().available).toBe(true)
    expect((await api('PATCH', '/host/config', { executionTimeoutSeconds: 90, logLevel: 'warn' })).statusCode).toBe(200)
    await app.close()
    app = await connect()
    expect((await api('GET', '/host/config')).json()).toMatchObject({ executionTimeoutSeconds: 90, logLevel: 'warn' })
  })

  it('rejects foreign hosts and origins and invalid timeout values', async () => {
    for (const badHeaders of [
      { host: 'untrusted.invalid:8080' },
      { ...headers, origin: 'https://untrusted.invalid' },
      { ...headers, origin: 'null' },
    ]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/host/config', headers: badHeaders, payload: { logLevel: 'error' } })
      expect(res.statusCode).toBeGreaterThanOrEqual(400)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect((await api('PATCH', '/host/config', { executionTimeoutSeconds: -1 })).statusCode).toBe(400)
  })
})
