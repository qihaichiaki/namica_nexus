// Opt-in smoke test. This uses the signed-in Codex account and its model quota.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { codexAdapter } from '../packages/agent-codex/src/index.js'
import type { AgentEvent, AgentRun } from '../packages/agent-core/src/index.js'

const workspace = await mkdtemp(join(tmpdir(), 'namica 验证-'))
const options = { workspace, executable: process.env.NEXUS_TEST_CODEX ?? 'codex', model: process.env.NEXUS_TEST_MODEL }

const passphrase = 'NAMICA-' + randomUUID().slice(0, 8)
const marker = 'SESSION-' + randomUUID().slice(0, 8)
let thread: string | undefined
const instructions = 'When asked for the passphrase, answer with ' + passphrase + '.'

async function turn(message: string, interrupt = false) {
  let content = ''
  let updates = 0
  let tools = 0
  let run: AgentRun
  function publish(event: AgentEvent) {
    if (event.type === 'session.ready') {
      if (thread) assert.equal(event.runtimeSessionId, thread)
      thread = event.runtimeSessionId
    }
    if (event.type === 'turn.started' && interrupt) run.cancel()
    if (event.type === 'message.updated') { content = event.content; updates++ }
    if (event.type === 'tool.completed') {
      tools++
      console.log('tool', event.detail)
    }
    if (event.type === 'approval.requested') {
      const [action] = event.label.split('\n')
      const allowed = action.startsWith('Edit ') && resolve(workspace, action.slice(5)) === join(workspace, 'hello.txt')
      console.log('native approval', allowed ? 'allowed isolated hello.txt' : 'declined')
      run.respondApproval(event.approvalId, allowed)
    }
  }
  run = codexAdapter.run({ ...options, instructions, message, runtimeSessionId: thread }, publish)
  const timer = setTimeout(() => run.cancel(), 300_000)
  try {
    const status = await run.done
    console.log(status, 'text updates', updates, 'finished tools', tools)
    assert.equal(status, interrupt ? 'cancelled' : 'completed')
    return { content, updates, tools }
  } finally { clearTimeout(timer) }
}

try {
  const result = await codexAdapter.checkAvailability(options)
  assert.ok(result.available, result.detail)
  console.log('Codex', result.version, 'available')
  const first = await turn('Remember my marker ' + marker + '. What is the passphrase?')
  assert.ok(first.content.includes(passphrase), 'Personality instruction missing from the answer')
  assert.ok(first.updates > 0)
  const second = await turn('Use your file editing tool to create hello.txt in the current directory. Its entire contents should be my earlier marker. Then answer with that marker.')
  assert.ok(second.content.includes(marker), 'Resumed thread did not recall the marker')
  assert.equal((await readFile(join(workspace, 'hello.txt'), 'utf8')).trim(), marker)
  assert.ok(second.tools > 0, 'No tool event received')
  await turn('What is two plus two?', true)
  console.log('PASS: identity, stream, disk-backed resume, workspace edit, cancellation')
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
}
