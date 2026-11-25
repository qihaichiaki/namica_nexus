// Copied to an isolated directory as "app-server" and launched using the Node executable.
const { createInterface } = require('node:readline')
const assert = require('node:assert/strict')
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const context = { threadId: 'thread', turnId: 'turn' }
let scenario = ''
let denyCount = 0
function notify(method, params) { send({ method, params: { ...context, ...params } }) }
function complete(status) { notify('turn/completed', { turn: { id: 'turn', status } }) }
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params, result, error } = JSON.parse(line)
  const respond = output => send({ id, result: output })
  if (method === 'initialize') respond({ userAgent: 'codex/1.2.0' })
  else if (method === 'account/read') respond({ account: { type: 'chatgpt' } })
  else if (method === 'thread/start') {
    assert.equal(params.sandbox, 'workspace-write')
    assert.equal(params.approvalPolicy, 'on-request')
    const approvalPolicy = params.developerInstructions === 'unknown policy' ? 'future-mode' : 'on-request'
    respond({ thread: { id: 'thread' }, sandbox: { type: 'workspaceWrite' }, approvalPolicy, approvalsReviewer: 'user' })
  } else if (method === 'turn/start') {
    scenario = params.input[0].text
    respond({ turn: { id: 'turn' } })
    notify('turn/started', { turn: { id: 'turn' } })
    notify('item/agentMessage/delta', { itemId: 'a', delta: 'part' })
    notify('item/agentMessage/delta', { turnId: 'foreign', itemId: 'a', delta: 'wrong turn' })
    if (scenario === 'crash') return process.exit(12)
    if (scenario === 'failed') return complete('failed')
    if (scenario === 'approve') {
      const approval = { ...context, cwd: process.cwd(), itemId: 'exec', command: 'echo hi', environmentId: 'local',
        availableDecisions: ['accept', 'decline', 'cancel'] }
      send({ id: 'ok', method: 'item/commandExecution/requestApproval', params: approval })
      send({ id: 'unknown', method: 'unknown/request', params: approval })
      send({ id: 'unclear', method: 'item/fileChange/requestApproval', params: approval })
      send({ id: 'masked', method: 'item/commandExecution/requestApproval', params: { ...approval, command: 'token=private' } })
      send({ id: 'extra', method: 'item/commandExecution/requestApproval', params: { ...approval, additionalPermissions: { network: true } } })
      send({ id: 'remote', method: 'item/commandExecution/requestApproval', params: { ...approval, environmentId: 'remote' } })
      send({ id: 'noOnce', method: 'item/commandExecution/requestApproval', params: { ...approval, availableDecisions: ['acceptForSession', 'cancel'] } })
      send({ id: 'broad', method: 'item/permissions/requestApproval', params: approval })
    }
  } else if (method === 'turn/interrupt') {
    respond({})
    complete('interrupted')
  } else if (['ok', 'unknown', 'unclear', 'masked', 'extra', 'broad', 'remote', 'noOnce'].includes(id)) {
    if (id === 'ok') assert.equal(result.decision, 'accept')
    if (id === 'unknown') assert.equal(error.code, -32601)
    if (['unclear', 'masked', 'extra', 'remote'].includes(id)) assert.equal(result.decision, 'decline')
    if (id === 'noOnce') assert.equal(result.decision, 'cancel')
    if (id === 'broad') assert.deepEqual(result.permissions, {})
    if (++denyCount === 8) {
      notify('item/completed', { item: { id: 'exec', type: 'commandExecution', command: 'echo hi', status: 'failed', exitCode: 2 } })
      notify('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'partial, now final' } })
      complete('completed')
    }
  }
})
