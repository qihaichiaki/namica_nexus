// Run after npm run build. Uses the current Codex login and real model calls.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildHost } from '../dist/apps/host/src/app.js'

const dataDirectory = await mkdtemp(join(tmpdir(), 'Namica 验收 '))
const workspace = join(dataDirectory, 'workspace')
let base
let app
let feed

async function start() {
  app = await buildHost({ dataDirectory, port: 0 })
  base = await app.listen({ host: '127.0.0.1', port: 0 })
}
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  const result = await response.text()
  assert.ok(response.ok, method + ' ' + path + ' returned ' + response.status + ' ' + result)
  return result ? JSON.parse(result) : undefined
}
// Allow the Host's default ten-minute execution deadline to report its own failure.
async function until(query, ok, timeout = 610000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await query()
    if (ok(value)) return value
    await sleep(250)
  }
  throw new Error('Timed out waiting for ' + ok.toString())
}
async function openFeed() {
  feed = new AbortController()
  const res = await fetch(base + '/api/events', { signal: feed.signal })
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
  return res.body.getReader()
}
try {
  await mkdir(workspace, { recursive: true })
  const marker = randomBytes(4).toString('hex')
  // The file value is deliberately absent from the prompt.
  await writeFile(join(workspace, 'fixture.js'), 'console.log("fixture-' + marker + '")\n')
  await start()
  const web = await fetch(base)
  assert.ok(web.ok && (await web.text()).includes('<html'), 'built Web Client must be served')
  const [runtime] = await request('/runtimes')
  if (process.env.NEXUS_TEST_MODEL) {
    await request('/runtimes/' + runtime.id, { model: process.env.NEXUS_TEST_MODEL }, 'PATCH')
  }
  const availability = await request('/runtimes/' + runtime.id + '/check', {})
  assert.ok(availability.available, availability.detail)
  const identity = await request('/identities', {
    name: '验收助手', personality: 'Always include NEXUS-READY in your final response.', workspace,
    runtimeConfigId: runtime.id,
  })
  const { sessionId } = await request('/sessions', { identityId: identity.id, title: '真实回归' })
  const path = '/sessions/' + sessionId
  const reported = new Set()
  async function get() {
    const snapshot = await request(path)
    for (const approval of snapshot.approvals) {
      if (!reported.has(approval.id)) {
        reported.add(approval.id)
        console.log('Review the native request in the 验收助手 session at ' + base)
      }
    }
    return snapshot
  }
  const stream = await openFeed()
  await request(path + '/messages', { content: 'Inspect fixture.js in this workspace using a tool. Tell me its exact console output. Do not modify files.' })
  // Receive at least one session-specific invalidation, then close the client mid-turn.
  const eventDeadline = setTimeout(() => feed.abort(), 30000)
  try {
    let events = ''
    const decoder = new TextDecoder()
    while (!events.includes(sessionId)) {
      const { value, done } = await stream.read()
      assert.ok(!done, 'event stream closed before session update')
      events += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(eventDeadline)
    feed.abort()
  }
  let snapshot = await until(get, s => s.session.status !== 'running')
  assert.equal(snapshot.session.status, 'completed', snapshot.turns.at(-1)?.error)
  assert.ok(snapshot.messages.at(-1).content.includes('fixture-' + marker), 'expected code fixture value')
  assert.ok(snapshot.messages.at(-1).content.includes('NEXUS-READY'), 'expected injected personality')
  assert.ok(snapshot.tools.length > 0, 'expected native tool activity')
  assert.equal(await readFile(join(workspace, 'fixture.js'), 'utf8'), 'console.log("fixture-' + marker + '")\n')
  const thread = snapshot.session.runtimeSessionId
  assert.ok(thread && thread !== sessionId)
  console.log('PASS real tool, personality, SSE disconnect, SQLite history')
  await app.close()
  await start()
  await request(path + '/messages', { content: 'Without tools, repeat the exact output you reported in your previous answer.' })
  snapshot = await until(get, s => s.session.status !== 'running')
  assert.equal(snapshot.session.status, 'completed', snapshot.turns.at(-1)?.error)
  assert.equal(snapshot.session.runtimeSessionId, thread)
  assert.ok(snapshot.messages.at(-1).content.includes('fixture-' + marker), 'expected resumed thread context')
  console.log('PASS Host restart and real runtime thread resume')
  await request(path + '/messages', { content: 'Write a detailed 1200 word explanation of how TypeScript compiles.' })
  await request(path + '/cancel', {})
  snapshot = await until(get, s => s.session.status !== 'running')
  assert.equal(snapshot.session.status, 'cancelled')
  assert.equal(snapshot.messages.length, 6)
  console.log('PASS cancellation and message ordering')
} finally {
  feed?.abort()
  await app?.close()
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 })
}
