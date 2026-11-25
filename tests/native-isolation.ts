// Opt-in storage integration test. Uses the installed Codex binary and synthetic model output on loopback.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createCodexAdapter } from '../packages/agent-codex/src/index.js'
import { resolveCodexExecutable } from '../packages/agent-codex/src/executable.js'
import { codexStorageArgs } from '../packages/agent-codex/src/home.js'

const dir = await mkdtemp(join(tmpdir(), 'nexus-isolation-'))
const workspace = join(dir, 'work')
const home = join(dir, 'codex-home')
const executable = process.env.NEXUS_TEST_CODEX || 'codex'
const marker = 'synthetic-' + randomUUID()
let sawRestoredContext = false
let calls = 0
const model = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
    res.writeHead(404).end()
    return
  }
  const parts = []
  for await (const part of req) parts.push(part)
  const request = JSON.parse(Buffer.concat(parts).toString('utf8'))
  const context = JSON.stringify(request.input)
  if (context.includes('Resume-check') && context.includes(marker)) sawRestoredContext = true
  const msg = { type: 'message', id: 'msg-' + ++calls, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] }
  const response = { id: 'resp-' + calls, object: 'response', model: 'fixture', output: [], status: 'in_progress' }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  function emit(type: string, payload: object) {
    res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
  }
  emit('response.created', { response })
  emit('response.output_item.added', { output_index: 0, item: { ...msg, status: 'in_progress', content: [] } })
  emit('response.output_text.delta', { item_id: msg.id, output_index: 0, content_index: 0, delta: 'synthetic answer' })
  emit('response.output_item.done', { output_index: 0, item: msg })
  emit('response.completed', { response: { ...response, status: 'completed', output: [msg] } })
  res.end()
})

// Ask only for our new ID, without reading or printing any existing conversations.
async function listed(target: string, privateHome?: string) {
  const env = privateHome ? { ...process.env, CODEX_HOME: privateHome, CODEX_SQLITE_HOME: privateHome } : process.env
  const args = privateHome ? ['app-server', ...codexStorageArgs(privateHome)] : ['app-server']
  const child = spawn(await resolveCodexExecutable(executable), args, { cwd: workspace, windowsHide: true, env, stdio: 'pipe' })
  child.stderr.resume()
  const lines = createInterface({input: child.stdout})
  const timer = setTimeout(() => child.kill(), 30_000)
  const exited = new Promise(resolve => child.once('close', resolve))
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n')
  try {
    send({id: 1, method: 'initialize', params: {clientInfo: { name: 'nexus_isolation_test', version: '1' }, capabilities: { experimentalApi: true }}})
    for await (const line of lines) {
      const response = JSON.parse(line)
      if (response.error) throw new Error('Cannot verify thread list: ' + response.error.code)
      if (response.id === 1) {
        send({method: 'initialized'})
        send({id: 2, method: 'thread/list', params: { includedThreadIds: [target], modelProviders: [], cwd: workspace, limit: 1 }})
      }
      if (response.id === 2) return response.result.data.some((thread: {id: string}) => thread.id === target)
    }
    throw new Error('App Server closed before the thread list response')
  } finally {
    child.stdin.end()
    await exited
    clearTimeout(timer)
  }
}

try {
  await Promise.all([mkdir(workspace), mkdir(home)])
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const address = model.address()
  assert.ok(address && typeof address === 'object')
  await writeFile(join(home, 'config.toml'), [
    'sqlite_home = ' + JSON.stringify(join(dir, 'wrong-db')), 'log_dir = ' + JSON.stringify(join(dir, 'wrong-log')),
    'model_provider = "fixture"', 'model = "fixture"', '[model_providers.fixture]', 'name = "Local fixture"',
    'base_url = "http://127.0.0.1:' + address.port + '/v1"', 'wire_api = "responses"', 'requires_openai_auth = false',
    'supports_websockets = false'
  ].join('\n'))
  const adapter = createCodexAdapter(home)
  const options = {workspace, executable}
  const check = await adapter.checkAvailability(options)
  assert.ok(check.available, check.detail)
  let threadId: string | undefined
  async function turn(message: string) {
    let text = ''
    const run = adapter.run({ ...options, instructions: 'Test session isolation.', runtimeSessionId: threadId, message }, event => {
      if (event.type === 'session.ready') {
        if (threadId) assert.equal(event.runtimeSessionId, threadId)
        threadId = event.runtimeSessionId
      }
      if (event.type === 'message.updated') text = event.content
    })
    const timer = setTimeout(() => run.cancel(), 60_000)
    try { assert.equal(await run.done, 'completed'); assert.match(text, /synthetic answer/) } finally { clearTimeout(timer) }
  }
  await turn(marker)
  assert.ok(threadId)
  assert.ok((await readdir(join(home, 'sessions'), {recursive: true})).some(entry => entry.includes(threadId!)))
  await turn('Resume-check')
  assert.ok(sawRestoredContext, 'Native resume lost the synthetic marker')
  assert.equal(await listed(threadId, home), true)
  assert.equal(await listed(threadId), false)
  await assert.rejects(access(join(dir, 'wrong-db')))
  await assert.rejects(access(join(dir, 'wrong-log')))
  console.log('PASS: native Codex', check.version, 'private rollout, cross-process restore, private/global list separation')
} finally {
  model.closeAllConnections()
  await new Promise<void>(resolve => model.close(() => resolve()))
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
