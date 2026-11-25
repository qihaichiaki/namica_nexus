import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHost } from '../apps/host/src/app.js'
import { Diagnostics } from '../apps/host/src/diagnostics.js'
import type { AgentAdapter } from '../packages/agent-core/src/index.js'

const auth = '/manage/auth/codex'
const logs = '/manage/logs'
const directories = '/manage/directories'
const runtime = '/manage/runtimes/codex'
const secret = 'fixture-sensitive-marker'
const headers = { host: '127.0.0.1:8080' }
const ready = { available: true, version: 'test', detail: 'ready' }

describe('Console management operations', () => {
  let dataDirectory: string
  let app: FastifyInstance
  let adapter: AgentAdapter

  const api = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
    app.inject({ method, url: '/api' + path, headers, payload })
  const login = () => api('POST', auth + '/login', { method: 'device' })
  const put = (name: string) => writeFile(join(dataDirectory, name), 'test')
  const browse = (path: string) => api('GET', directories + '?path=' + encodeURIComponent(path))
  const signIn = async () => {
    await mkdir(join(dataDirectory, 'codex-home'), { recursive: true })
    await put('codex-home/synthetic-account')
  }

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'nexus-console-'))
    await copyFile(new URL('./fixtures/codex-account.cjs', import.meta.url), join(dataDirectory, 'app-server'))
    adapter = {
      type: 'codex',
      capabilities: { resume: true, stream: true, cancel: true, approvals: true },
      checkAvailability: async () => ready,
      run(_input, publish) {
        let finish!: (value: 'cancelled') => void
        const done = new Promise<'cancelled'>(resolve => { finish = resolve })
        publish({ type: 'session.ready', runtimeSessionId: secret })
        return { done, cancel: () => finish('cancelled'), respondApproval: () => false }
      },
    }
    app = await buildHost({ dataDirectory, port: 8080, adapterFactory: () => adapter })
    expect((await api('PATCH', runtime, { executable: process.execPath })).statusCode).toBe(200)
  })

  afterEach(async () => {
    await app?.close()
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3 })
  })

  it('resumes pending authorization across requests, then invalidates the last check on completion and sign-out', async () => {
    expect((await api('GET', auth)).json()).toEqual({ state: 'signed-out' })
    const checked = await api('POST', runtime + '/check')
    expect(checked.json().available).toBe(true)
    const response = await login()
    const pending = {
      state: 'pending', method: 'device',
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234',
    }
    expect(response.json()).toEqual(pending)
    expect(response.headers['cache-control']).toBe('no-store')
    expect((await api('GET', auth)).json()).toEqual(pending)
    expect((await login()).json()).toEqual(pending)
    expect((await api('POST', auth + '/login')).statusCode).toBe(409)
    expect((await api('POST', auth + '/logout')).statusCode).toBe(409)
    await put('complete-login')
    await expect.poll(async () => (await api('GET', auth)).json().state).toBe('signed-in')
    const signedIn = (await api('GET', auth)).json()
    expect(signedIn).toEqual({ state: 'signed-in', account: 'ChatGPT', detail: expect.any(String) })
    expect((await api('GET', '/manage/runtimes')).json()[0]).toMatchObject({ available: null, version: null, detail: '' })
    expect((await api('POST', runtime + '/check')).json().available).toBe(true)
    expect((await api('POST', auth + '/logout')).json()).toEqual({ state: 'signed-out', detail: expect.any(String) })
    expect((await api('GET', '/manage/runtimes')).json()[0].available).toBeNull()
    const journal = (await api('GET', logs)).body
    for (const privateValue of [secret, 'TEST-1234', 'auth.openai.com', dataDirectory]) {
      expect(journal).not.toContain(privateValue)
    }
  })

  it('allows a new authorization after an account read fails and preserves an existing account on cancellation', async () => {
    await signIn()
    await put('account-read-error')
    const unreadable = await api('GET', auth)
    expect(unreadable.json().state).toBe('unknown')
    expect(unreadable.body).not.toContain(secret)
    expect((await login()).json().state).toBe('pending')
    await rm(join(dataDirectory, 'account-read-error'))
    const cancelled = await api('POST', auth + '/cancel')
    expect(cancelled.json()).toEqual({ state: 'signed-in', account: 'ChatGPT', detail: expect.any(String) })
    expect(cancelled.body).not.toContain(secret)
    expect((await api('GET', auth)).json().state).toBe('signed-in')
  })

  it('rejects an unauthorized challenge URL and closes a pending login on shutdown', async () => {
    await put('invalid-challenge')
    const invalid = await login()
    expect(invalid.json()).toEqual({ state: 'unknown', detail: expect.any(String) })
    expect(invalid.body).not.toContain(secret)
    await rm(join(dataDirectory, 'invalid-challenge'))
    expect((await login()).json().state).toBe('pending')
    const pid = Number(await readFile(join(dataDirectory, 'account-pid'), 'utf8'))
    await app.close()
    expect(() => process.kill(pid, 0)).toThrow()
    app = await buildHost({ dataDirectory, port: 8080 })
    expect((await api('GET', auth)).json().state).toBe('signed-out')
    expect((await api('GET', logs)).json().entries).toEqual([{
      time: expect.any(String), level: 'info', message: 'Host started',
    }])
  })

  it('keeps turn persistence and runtime checks exclusive to credential changes', async () => {
    const created = await api('POST', '/identities', { name: 'Fixture' })
    const session = await api('POST', '/sessions', { identityId: created.json().id })
    const path = '/sessions/' + session.json().sessionId
    const send = () => api('POST', path + '/messages', { content: secret })
    await put('hold-account-read')
    const accountRead = api('GET', auth)
    await expect.poll(() => readFile(join(dataDirectory, 'account-read-started'), 'utf8').catch(() => undefined)).toBe('')
    expect((await send()).statusCode).toBe(202)
    expect((await login()).statusCode).toBe(409)
    expect((await api('POST', auth + '/logout')).statusCode).toBe(409)
    await rm(join(dataDirectory, 'hold-account-read'))
    expect((await accountRead).json().state).toBe('signed-out')
    expect((await login()).statusCode).toBe(409)
    expect((await api('POST', path + '/cancel')).statusCode).toBe(202)
    await expect.poll(async () => (await api('GET', '/manage/host/status')).json().activeTurns).toBe(0)
    let finishCheck!: (result: typeof ready) => void
    adapter.checkAvailability = () => new Promise(resolve => { finishCheck = resolve })
    const check = api('POST', runtime + '/check')
    await expect.poll(() => typeof finishCheck).toBe('function')
    expect((await login()).statusCode).toBe(409)
    finishCheck(ready)
    expect((await check).json().available).toBe(true)
    expect((await login()).json().state).toBe('pending')
    expect((await api('POST', runtime + '/check')).statusCode).toBe(409)
    expect((await api('PATCH', runtime, { enabled: false })).statusCode).toBe(409)
    expect((await send()).statusCode).toBe(409)
    expect((await api('GET', path)).json().turns).toHaveLength(1)
    const journal = (await api('GET', logs)).body
    expect(journal).toContain('Turn cancelled')
    expect(journal).not.toContain(secret)
  })

  it('lists only local directories and rejects foreign Origins on the management routes', async () => {
    const folder = join(dataDirectory, '文件夹')
    const file = join(dataDirectory, 'private-file.txt')
    const link = join(dataDirectory, 'linked-folder')
    await mkdir(folder)
    await writeFile(file, secret)
    await symlink(folder, link, process.platform === 'win32' ? 'junction' : 'dir')
    const roots = await browse('')
    expect(roots.json()).toMatchObject({ path: '', parent: null })
    expect(roots.json().entries).toContainEqual({ name: parse(folder).root, path: parse(folder).root })
    const list = await browse(dataDirectory)
    expect(list.json().entries).toContainEqual({ name: '文件夹', path: folder })
    expect(list.body).not.toContain('private-file.txt')
    expect(list.body).not.toContain('linked-folder')
    expect(list.body).not.toContain(secret)
    expect((await browse(file)).statusCode).toBe(404)
    expect((await browse(link)).statusCode).toBe(403)
    expect((await browse('relative/folder')).statusCode).toBe(400)
    expect((await browse('\\\\server\\share')).statusCode).toBe(400)
    expect((await browse('\\\\?\\C:\\Windows')).statusCode).toBe(400)
    for (const [method, url] of [['POST', auth + '/logout'], ['GET', auth], ['GET', logs], ['GET', directories]] as const) {
      const rejected = await app.inject({ method, url: '/api' + url, headers: { ...headers, origin: 'https://' + secret + '.test' } })
      expect(rejected.statusCode).toBe(403)
    }
    const journal = (await api('GET', logs)).body
    expect(journal).toContain('Request rejected due to unrecognized Origin')
    expect(journal).not.toContain(secret)
  }, 15_000)
})

it('keeps the latest 200 eligible diagnostic events', () => {
  const log = { level: 'info', info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
  const journal = new Diagnostics(log)
  journal.record('hostStarted')
  journal.record('turnReady')
  for (let entry = 0; entry < 201; entry++) journal.record('runtimeConfigUpdated')
  log.level = 'warn'
  journal.record('turnAccepted')
  journal.record('turnFailed')
  const { entries } = journal.recent()
  expect(entries).toHaveLength(200)
  expect(entries[0]).toEqual({ time: expect.any(String), level: 'warn', message: 'Turn failed' })
  expect(entries.slice(1).every(entry => entry.message === 'Runtime settings saved')).toBe(true)
  expect(log.debug).not.toHaveBeenCalled()
})
