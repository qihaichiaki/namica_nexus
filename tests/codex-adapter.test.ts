import { afterAll, beforeAll, expect, test } from 'vitest'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../packages/agent-core/src/index.js'
import { codexAdapter } from '../packages/agent-codex/src/index.js'
import { manualProxyEnv } from '../packages/agent-codex/src/proxy.js'

let workspace: string
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-rpc-'))
  await copyFile(new URL('./fixtures/codex-server.cjs', import.meta.url), join(workspace, 'app-server'))
})
afterAll(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
function input(message: string) { return { executable: process.execPath, workspace, instructions: 'test', message } }

test('handshakes without exposing account properties', async () => {
  const result = await codexAdapter.checkAvailability(input(''))
  expect(result).toEqual({ available: true, version: '1.2.0', detail: 'Codex app-server is ready.' })
})

test('confines stream events to this turn and routes single-use approvals', async () => {
  const events: AgentEvent[] = []
  const run = codexAdapter.run(input('approve'), event => {
    events.push(event)
    if (event.type !== 'approval.requested') return
    expect(event.label).toContain('echo hi')
    expect(run.respondApproval(event.approvalId, true)).toBe(true)
    expect(run.respondApproval(event.approvalId, true)).toBe(false)
  })
  expect(await run.done).toBe('completed')
  expect(events.filter(event => event.type === 'message.updated').map(event => event.content)).toEqual(['part', 'partial, now final'])
  expect(events.filter(event => event.type === 'approval.requested')).toHaveLength(1)
  expect(events).toContainEqual({ type: 'tool.completed', itemId: 'exec', label: 'echo hi', failed: true, detail: 'failed, exit 2' })
})

test.each(['crash', 'failed'])('preserves partial text and rejects a %s', async scenario => {
  const events: AgentEvent[] = []
  const run = codexAdapter.run(input(scenario), event => events.push(event))
  await expect(run.done).rejects.toThrow(/exited|turn failed/)
  expect(events).toContainEqual({ type: 'message.updated', content: 'part' })
})

test('declines dispatch when the server returns an unknown approval policy', async () => {
  const run = codexAdapter.run({ ...input('unsafe'), instructions: 'unknown policy' }, () => {})
  await expect(run.done).rejects.toThrow('approval policy')
})

test('can cancel before spawn and during an active turn', async () => {
  const early = codexAdapter.run(input('cancel'), () => {})
  early.cancel()
  expect(await early.done).toBe('cancelled')
  const run = codexAdapter.run(input('cancel'), event => { if (event.type === 'turn.started') run.cancel() })
  expect(await run.done).toBe('cancelled')
})

test('reads enabled Windows manual proxy schemes', () => {
  const enabled = '    ProxyEnable    REG_DWORD    0x1\r\n'
  expect(manualProxyEnv(enabled + '    ProxyServer    REG_SZ    http=localhost:8081;https=localhost:8082\r\n')).toEqual({
    HTTP_PROXY: 'http://localhost:8081/', HTTPS_PROXY: 'http://localhost:8082/'
  })
  expect(manualProxyEnv('ProxyEnable REG_DWORD 0x0\r\nProxyServer REG_SZ localhost:80')).toEqual({})
  expect(manualProxyEnv(enabled + 'ProxyServer REG_SZ localhost:80\nProxyOverride REG_SZ <local>')).toEqual({})
  expect(manualProxyEnv(enabled + 'ProxyServer REG_SZ localhost:80\nAutoConfigURL REG_SZ http://localhost/proxy.pac')).toEqual({})
  expect(manualProxyEnv(enabled + 'ProxyServer REG_SZ localhost:80\nProxyOverride REG_SZ localhost;*.example.org').NO_PROXY)
    .toBe('localhost,.example.org')
})
