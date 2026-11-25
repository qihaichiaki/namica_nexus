import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildHost } from '../apps/host/src/app.js'
import type { AgentAdapter, AgentEvent, AgentInput, AgentOptions } from '../packages/agent-core/src/index.js'
import type { SessionSnapshot } from '../packages/protocol/src/index.js'

/** Keep runtime I/O under test control while exercising the real HTTP and SQLite paths. */
function controlledRuntime() {
  const checks: AgentOptions[] = []
  const runs: {
    input: AgentInput
    publish: (event: AgentEvent) => void
    complete: () => void
    fail: () => void
  }[] = []
  const adapter: AgentAdapter = {
    type: 'codex',
    capabilities: { resume: true, stream: true, cancel: true, approvals: true },
    async checkAvailability(options) {
      checks.push(options)
      return { available: true, version: 'test', detail: 'ready' }
    },
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
  return { runs, checks, adapter }
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
    const [config] = (await api('GET', '/manage/runtimes')).json()
    const check = await api('POST', '/manage/runtimes/' + config.id + '/check')
    expect(check.statusCode, check.body).toBe(200)
    expect(check.json().available).toBe(true)
    expect((await api('PATCH', '/manage/host/config', { executionTimeoutSeconds: 90, logLevel: 'warn' })).statusCode).toBe(200)
    await app.close()
    app = await connect()
    expect((await api('GET', '/manage/host/config')).json()).toMatchObject({ executionTimeoutSeconds: 90, logLevel: 'warn' })
  })

  it('exposes only runtime selection fields through the Client endpoint', async () => {
    expect((await api('GET', '/runtime-options')).json()).toEqual([
      { id: 'codex', type: 'codex', enabled: true, isDefault: true },
    ])
    expect((await api('PATCH', '/manage/runtimes/codex', { enabled: false, proxyUrl: 'http://localhost:7890' })).statusCode).toBe(200)
    expect((await api('GET', '/runtime-options')).json()).toEqual([
      { id: 'codex', type: 'codex', enabled: false, isDefault: true },
    ])
    for (const route of ['/host/status', '/host/config', '/runtimes']) {
      expect((await api('GET', route)).statusCode).toBe(404)
    }
  })

  it('serves the Console entry and gives missing Console files a 404', async () => {
    const webDirectory = join(dataDirectory, 'web')
    await mkdir(join(webDirectory, 'console'), {recursive: true})
    await writeFile(join(webDirectory, 'index.html'), '<html><title>Client</title></html>')
    await writeFile(join(webDirectory, 'console', 'index.html'), '<html><title>Console</title></html>')
    await app.close()
    app = await buildHost({dataDirectory, port: 8080, webDirectory})
    const open = (url: string) => app.inject({url, headers: {...headers, accept: 'text/html'}})
    expect((await open('/')).body).toContain('<title>Client</title>')
    expect((await open('/console')).headers.location).toBe('/console/')
    expect((await open('/console/?ref=test')).body).toContain('<title>Console</title>')
    expect((await open('/console/missing')).statusCode).toBe(404)
    await rm(join(webDirectory, 'console', 'index.html'))
    expect((await open('/console/')).statusCode).toBe(404)
  })

  it('loads a legacy runtime, persists its proxy and passes the selection to checks and turns', async () => {
    const route = '/manage/runtimes/codex'
    await app.close()
    const db = new DatabaseSync(join(dataDirectory, 'nexus.sqlite'))
    try {
      db.exec("UPDATE runtimes SET json=json_remove(json,'$.proxyUrl')")
    } finally { db.close() }
    app = await connect()
    expect((await api('GET', '/manage/runtimes')).json()[0].proxyUrl).toBe('')
    const proxyUrl = 'https://proxy.example.test:7443'
    expect((await api('PATCH', route, {proxyUrl})).json().proxyUrl).toBe(proxyUrl)
    await app.close()
    app = await connect()
    expect((await api('POST', route + '/check')).json().proxyUrl).toBe(proxyUrl)
    expect(runtime.checks.at(-1)?.proxyUrl).toBe(proxyUrl)
    const session = await createSession(await createIdentity('Proxy test', ''))
    await send(session, 'test')
    expect(runtime.runs[0].input.proxyUrl).toBe(proxyUrl)
    expect((await api('PATCH', route, {proxyUrl: ''})).statusCode).toBe(409)
    runtime.runs[0].complete()
    await expect.poll(async () => (await snapshot(session)).session.status).toBe('completed')
    expect((await api('PATCH', route, {proxyUrl: ''})).json().proxyUrl).toBe('')
    await send(session, 'test again')
    expect(runtime.runs[1].input.proxyUrl).toBe('')
    runtime.runs[1].complete()
  })

  it('accepts proxy endpoints and rejects credentials or URL suffixes without echoing the input', async () => {
    const route = '/manage/runtimes/codex'
    for (const proxyUrl of ['http://localhost:7890', 'http://192.168.1.8:9080/', 'https://[::1]']) {
      expect((await api('PATCH', route, {proxyUrl})).json().proxyUrl).toBe(proxyUrl)
    }
    for (const proxyUrl of [
      'http://user:private-marker@127.0.0.1', 'socks5://localhost:1090', 'http://localhost/private-marker',
      'http://localhost/?key=private-marker', 'https://localhost#private-marker', 'http://localhost:99999',
      'http://localhost/private-marker/..', 'http://@localhost',
    ]) {
      const response = await api('PATCH', route, {proxyUrl})
      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain('private-marker')
    }
    expect((await api('GET', '/manage/runtimes')).json()[0].proxyUrl).toBe('https://[::1]')
  })

  it('rejects foreign hosts and origins and invalid timeout values', async () => {
    for (const badHeaders of [
      { host: 'untrusted.invalid:8080' },
      { ...headers, origin: 'https://untrusted.invalid' },
      { ...headers, origin: 'null' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      const shutdown = await app.inject({ method: 'POST', url: '/api/manage/host/shutdown', headers: badHeaders, payload: {} })
      expect(shutdown.statusCode).toBe(403)
      expect(shutdown.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect((await api('PATCH', '/manage/host/config', { executionTimeoutSeconds: -1 })).statusCode).toBe(400)
    expect((await api('POST', '/manage/host/shutdown', { unexpected: true })).statusCode).toBe(400)
    expect((await api('GET', '/manage/host/status')).statusCode).toBe(200)
  })
})
