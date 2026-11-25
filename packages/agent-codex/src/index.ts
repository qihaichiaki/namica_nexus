import { randomUUID } from 'node:crypto'
import type { AgentAdapter, AgentEvent, AgentInput, AgentOptions, AgentRun } from '../../agent-core/src/index.js'
import { fields, Rpc, stringValue, summary, type Fields } from './rpc.js'
import { codexEnvironment } from './home.js'

type Outcome = 'completed' | 'cancelled'
type RequestId = string | number

const loginHint = 'Nexus 专用 Codex 尚未登录。请在项目目录运行 npm run codex:login 后重新检测。'

async function authenticated(rpc: Rpc): Promise<boolean> {
  const result = await rpc.request('account/read', { refreshToken: false })
  return Boolean(result.account) || result.requiresOpenaiAuth === false
}

function safeLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && summary(value) === value
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
}

const requestFields = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason'])
const commandFields = new Set([...requestFields, 'kind', 'command', 'cwd', 'commandActions', 'approvalId',
  'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'environmentId', 'availableDecisions'])

function negativeDecision(choices: unknown): 'decline' | 'cancel' | undefined {
  if (choices == null || (Array.isArray(choices) && choices.includes('decline'))) return 'decline'
  if (Array.isArray(choices) && choices.includes('cancel')) return 'cancel'
}

function knownScope(params: Fields, supported: Set<string>): boolean {
  // A server upgrade may attach extra filesystem, network or environment permissions.
  // Decline anything we cannot fully describe with our one-operation approval UI.
  return Object.entries(params).every(([key, value]) => value == null || supported.has(key))
}

function deny(rpc: Rpc, method: unknown, id: RequestId, choices?: unknown) {
  const negative = negativeDecision(choices)
  if (method === 'item/commandExecution/requestApproval' && !negative) {
    rpc.send({ id, error: { code: -32602, message: 'No supported denial decision' } })
    return
  }
  const results: Record<string, Fields> = {
    'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
    'item/commandExecution/requestApproval': { decision: negative },
    'item/fileChange/requestApproval': { decision: 'decline' },
    'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
    execCommandApproval: { decision: 'denied' },
    applyPatchApproval: { decision: 'denied' }
  }
  const result = Object.hasOwn(results, String(method)) ? results[String(method)] : undefined
  rpc.send(result ? { id, result } : { id, error: { code: -32601, message: 'Unsupported client request' } })
}

function toolLabel(item: Fields): string {
  switch (item.type) {
    case 'commandExecution': return summary(item.command) || 'Command'
    case 'fileChange': {
      const paths = Array.isArray(item.changes) ? item.changes.map(change => stringValue(fields(change).path)) : []
      return summary(paths.join(', ')) || 'File change'
    }
    case 'mcpToolCall': return summary([item.server, item.tool].join(' / '))
    case 'dynamicToolCall': return summary(item.tool)
    case 'webSearch': return 'Web search'
    default: return ''
  }
}

class CodexTurn implements AgentRun {
  readonly done: Promise<Outcome>
  private resolve!: (value: Outcome) => void
  private reject!: (error: Error) => void
  private rpc!: Rpc
  private threadId = ''
  private turnId = ''
  private dispatching = false
  private ended = false
  private cancelling = false
  private cancelTimer?: NodeJS.Timeout
  private interruptRetry?: NodeJS.Timeout
  private readonly approvals = new Map<string, { requestId: RequestId; negative: 'decline' | 'cancel' }>()
  private readonly texts = new Map<string, string>()
  private readonly files = new Map<string, string>()

  constructor(input: AgentInput, private readonly publish: (event: AgentEvent) => void, private readonly home: string) {
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.start(input).catch(error => this.finish(error instanceof Error ? error : new Error('Codex startup failed')))
  }

  private async start(input: AgentInput) {
    const env = await codexEnvironment(this.home, input.proxyUrl, input.workspace)
    if (this.ended) return
    this.rpc = new Rpc(input, env, message => this.receive(message), error => this.finish(error))
    await this.rpc.initialize()
    if (!await authenticated(this.rpc)) throw new Error(loginHint)
    const params: Fields = {
      cwd: input.workspace, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      developerInstructions: input.instructions
    }
    if (input.model) params.model = input.model
    const result = input.runtimeSessionId
      ? await this.rpc.request('thread/resume', { ...params, threadId: input.runtimeSessionId, excludeTurns: true })
        .catch(error => { throw new Error('无法从 Nexus 专用目录恢复该会话，可新建会话继续。' + summary(error.message)) })
      : await this.rpc.request('thread/start', params)
    const sandbox = fields(result.sandbox).type
    if (!['workspaceWrite', 'readOnly'].includes(String(sandbox))
        || !['on-request', 'untrusted'].includes(String(result.approvalPolicy))
        || result.approvalsReviewer !== 'user') {
      throw new Error('Codex did not confirm the requested sandbox and user approval policy')
    }
    this.threadId = stringValue(fields(result.thread).id)
    if (!this.threadId || (input.runtimeSessionId && this.threadId !== input.runtimeSessionId)) {
      throw new Error('Codex returned an unexpected thread identifier')
    }
    if (this.ended) return
    this.publish({ type: 'session.ready', runtimeSessionId: this.threadId })
    this.dispatching = true
    const response = await this.rpc.request('turn/start', {
      threadId: this.threadId, input: [{ type: 'text', text: input.message, text_elements: [] }]
    })
    this.startTurn(stringValue(fields(response.turn).id))
  }

  private startTurn(id: string) {
    if (this.ended || this.turnId) return
    if (!id) throw new Error('Codex omitted its turn identifier')
    this.turnId = id
    this.publish({ type: 'turn.started' })
  }

  private receive(message: Fields) {
    const p = fields(message.params)
    const item = fields(p.item)
    const method = message.method
    const requestId = message.id
    const ownThread = this.dispatching && p.threadId === this.threadId
    if (typeof requestId === 'string' || typeof requestId === 'number') {
      if (ownThread && this.turnId && this.turnId === p.turnId && !this.cancelling) {
        let label = ''
        const choices = p.availableDecisions
        const negative = negativeDecision(choices)
        if (method === 'item/commandExecution/requestApproval' && (!p.kind || p.kind === 'command')
            && (p.environmentId == null || p.environmentId === 'local')
            && (choices == null || (Array.isArray(choices) && choices.includes('accept')))
            && knownScope(p, commandFields) && safeLabel(p.command) && safeLabel(p.cwd)) {
          label = [p.command, p.cwd, summary(p.reason)].filter(Boolean).join('\n')
        }
        if (method === 'item/fileChange/requestApproval' && knownScope(p, requestFields) && this.files.has(stringValue(p.itemId))) {
          label = ['Edit ' + this.files.get(stringValue(p.itemId)), summary(p.reason)].filter(Boolean).join('\n')
        }
        if (label && negative) {
          const approvalId = randomUUID()
          this.approvals.set(approvalId, { requestId, negative })
          this.publish({ type: 'approval.requested', approvalId, label })
          return
        }
      }
      return deny(this.rpc, method, requestId, p.availableDecisions)
    }
    if (!ownThread) return
    if (method === 'serverRequest/resolved') {
      for (const [key, pending] of this.approvals) if (pending.requestId === p.requestId) this.clearApproval(key)
      return
    }
    const turn = fields(p.turn)
    if (method === 'turn/started') return this.startTurn(stringValue(turn.id))
    if (!this.turnId || (p.turnId ?? turn.id) !== this.turnId) return
    if (method === 'item/agentMessage/delta') {
      const id = stringValue(p.itemId)
      this.setText(id, (this.texts.get(id) ?? '') + stringValue(p.delta))
    } else if (method === 'item/started' || method === 'item/completed') {
      const id = stringValue(item.id)
      if (item.type === 'agentMessage' && method === 'item/completed') this.setText(id, stringValue(item.text))
      const label = toolLabel(item)
      if (label) {
        if (item.type === 'fileChange' && Array.isArray(item.changes) && item.changes.length > 0) {
          const paths = item.changes.map(change => stringValue(fields(change).path))
          if (paths.every(safeLabel) && safeLabel(paths.join(', '))) this.files.set(id, paths.join(', '))
        }
        if (method === 'item/started') this.publish({ type: 'tool.started', itemId: id, label })
        else {
          const status = summary(item.status)
          const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined
          const failed = (status !== '' && !['completed', 'success'].includes(status)) || (exit !== undefined && exit !== 0)
          const detail = [status, exit === undefined ? '' : 'exit ' + exit].filter(Boolean).join(', ')
          this.publish({ type: 'tool.completed', itemId: id, label, failed, detail })
        }
      }
    } else if (method === 'turn/completed') {
      if (turn.status === 'completed') this.finish('completed')
      else if (turn.status === 'interrupted') this.finish('cancelled')
      else this.finish(new Error(summary(fields(turn.error).message) || 'Codex turn failed (' + String(turn.status) + ')'))
    }
  }

  private setText(id: string, text: string) {
    if (!id || this.texts.get(id) === text) return
    this.texts.set(id, text)
    this.publish({ type: 'message.updated', content: [...this.texts.values()].join('\n\n') })
  }

  private clearApproval(approvalId: string) {
    if (this.approvals.delete(approvalId)) this.publish({ type: 'approval.resolved', approvalId })
  }

  respondApproval(approvalId: string, allow: boolean) {
    const pending = this.approvals.get(approvalId)
    if (!pending || this.ended) return false
    this.rpc.send({ id: pending.requestId, result: { decision: allow ? 'accept' : pending.negative } })
    this.clearApproval(approvalId)
    return true
  }

  cancel() {
    if (this.ended || this.cancelling) return
    this.cancelling = true
    for (const key of this.approvals.keys()) this.respondApproval(key, false)
    if (!this.turnId) return this.finish('cancelled')
    this.cancelTimer = setTimeout(() => this.finish('cancelled'), 5000)
    this.interrupt()
  }

  private interrupt() {
    void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch(() => {
        // The v2 API can acknowledge turn/start before there is an active turn to interrupt.
        if (!this.ended) this.interruptRetry = setTimeout(() => this.interrupt(), 300)
      })
  }

  private finish(outcome: Outcome | Error) {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.cancelTimer)
    clearTimeout(this.interruptRetry)
    this.rpc?.close()
    try {
      for (const key of this.approvals.keys()) this.clearApproval(key)
    } finally {
      void Promise.resolve(this.rpc?.exited).then(() => {
        if (outcome instanceof Error) this.reject(outcome)
        else this.resolve(outcome)
      })
    }
  }
}

async function checkAvailability(options: AgentOptions, home: string, signal?: AbortSignal) {
  let rpc: Rpc | undefined
  let version: string | null = null
  const close = () => rpc?.close()
  try {
    signal?.throwIfAborted()
    const env = await codexEnvironment(home, options.proxyUrl, options.workspace)
    signal?.throwIfAborted()
    rpc = new Rpc(options, env, message => {
      if (rpc && (typeof message.id === 'string' || typeof message.id === 'number')) deny(rpc, message.method, message.id)
    }, () => {})
    signal?.addEventListener('abort', close, { once: true })
    version = await rpc.initialize()
    if (!await authenticated(rpc)) return { available: false, version, detail: loginHint }
    return { available: true, version, detail: 'Codex app-server is ready.' }
  } catch (error) {
    signal?.throwIfAborted()
    return { available: false, version, detail: summary(error instanceof Error ? error.message : 'Codex unavailable') }
  } finally {
    signal?.removeEventListener('abort', close)
    close()
    await rpc?.exited
  }
}

export function createCodexAdapter(privateHome: string): AgentAdapter {
  return {
    type: 'codex',
    capabilities: { resume: true, stream: true, cancel: true, approvals: true },
    checkAvailability: (options, signal) => checkAvailability(options, privateHome, signal),
    run: (input, publish) => new CodexTurn(input, publish, privateHome)
  }
}
