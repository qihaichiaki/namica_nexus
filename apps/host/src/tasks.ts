import { mkdirSync } from 'node:fs'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentAdapter, AgentEvent, AgentRun } from '../../../packages/agent-core/src/index.js'
import type { Approval, HostEvent, Runtime, Turn, TurnStatus } from '../../../packages/protocol/src/index.js'
import { HttpError, Store } from './store.js'

interface ActiveTurn {
  turn: Turn
  runtimeId: string
  approvals: Map<string, Approval>
  handle?: AgentRun
  timeout?: NodeJS.Timeout
  stopping?: 'timeout' | 'shutdown'
  settled?: Promise<void>
}

export class Tasks {
  private active = new Map<string, ActiveTurn>()
  private closing = false
  constructor(
    private store: Store,
    private adapterFor: (runtime: Runtime) => AgentAdapter,
    private publish: (event: HostEvent) => void,
    private log: FastifyBaseLogger,
  ) {}

  get activeTurns() { return this.active.size }

  runtimeState(runtime: Runtime): Runtime {
    const running = [...this.active.values()].some(task => task.runtimeId === runtime.id)
    return { ...runtime, processState: running ? 'running' : 'idle' }
  }
  snapshot(id: string) {
    const snapshot = this.store.snapshot(id)
    snapshot.approvals = Array.from(this.active.get(id)?.approvals.values() ?? [])
    return snapshot
  }
  start(sessionId: string, message: string) {
    if (this.closing) throw new HttpError(503, 'Host is shutting down.')
    const session = this.store.storedSession(sessionId)
    const runtime = this.store.runtime(session.runtimeConfigId)
    if (!runtime.enabled) throw new HttpError(409, 'The configured runtime is disabled.')
    const adapter = this.adapterFor(runtime)
    const timeoutSeconds = this.store.config().executionTimeoutSeconds
    const turn = this.store.beginTurn(sessionId, message)
    const task: ActiveTurn = { turn, runtimeId: runtime.id, approvals: new Map() }
    this.active.set(sessionId, task)
    this.log.info({ sessionId, turnId: turn.turnId, runtimeId: runtime.id }, 'Turn accepted')
    this.changed(sessionId)
    this.publish({type: 'runtimes.changed'})
    try {
      mkdirSync(session.workspace, {recursive: true})
      const handle = adapter.run({
        executable: runtime.executable, model: runtime.model, proxyUrl: runtime.proxyUrl,
        workspace: session.workspace, instructions: session.instructions,
        runtimeSessionId: session.runtimeSessionId, message,
      }, event => this.receive(task, event))
      task.handle = handle
      task.timeout = setTimeout(() => {
        task.stopping = 'timeout'
        handle.cancel()
      }, timeoutSeconds * 1000)
      task.timeout.unref()
      task.settled = handle.done.then(
        result => this.finish(task, result, null),
        error => this.finish(task, 'failed', error instanceof Error ? error.message : 'Runtime failed.'),
      )
    } catch (error) {
      this.finish(task, 'failed', error instanceof Error ? error.message : 'Runtime startup failed.')
      return {...turn, status: 'failed' as const, error: error instanceof Error ? error.message : 'Runtime startup failed.'}
    }
    return turn
  }
  private changed(sessionId: string) { this.publish({type: 'session.changed', sessionId}) }
  private receive(task: ActiveTurn, event: AgentEvent) {
    const {turnId, sessionId} = task.turn
    if (this.active.get(sessionId) !== task) return
    if (task.stopping === 'shutdown' && event.type !== 'session.ready' && event.type !== 'message.updated') return
    switch (event.type) {
      case 'session.ready':
        this.store.mapSession(sessionId, event.runtimeSessionId)
        this.log.debug({ sessionId, turnId }, 'Runtime session ready')
        break
      case 'message.updated': this.store.writeReply(turnId, event.content); break
      case 'approval.requested':
        task.approvals.set(event.approvalId, {id: event.approvalId, description: event.label, turnId})
        break
      case 'approval.resolved': task.approvals.delete(event.approvalId); break
      case 'tool.started':
        this.store.recordTool(turnId, event.itemId, event.label, 'running')
        break
      case 'tool.completed':
        this.store.recordTool(turnId, event.itemId, event.label, event.failed ? 'failed' : 'completed', event.detail)
        break
    }
    this.changed(sessionId)
  }
  private finish(task: ActiveTurn, result: Exclude<TurnStatus, 'running'>, reason: string | null) {
    if (this.active.get(task.turn.sessionId) !== task) return
    clearTimeout(task.timeout)
    if (task.stopping === 'timeout') { result = 'failed'; reason = 'Agent execution timeout.' }
    if (task.stopping === 'shutdown') { result = 'interrupted'; reason = 'Host shut down during this turn.' }
    this.store.finish(task.turn, result, reason)
    this.active.delete(task.turn.sessionId)
    const context = { sessionId: task.turn.sessionId, turnId: task.turn.turnId, status: result }
    if (result === 'failed' || result === 'interrupted') this.log.warn(context, 'Turn ended')
    else this.log.info(context, 'Turn ended')
    this.changed(task.turn.sessionId)
    this.publish({type: 'runtimes.changed'})
  }
  cancel(id: string) {
    const task = this.active.get(id)
    if (!task?.handle) throw new HttpError(409, 'No active turn.')
    task.handle.cancel()
  }
  respond(id: string, approvalId: string, allow: boolean) {
    const task = this.active.get(id)
    if (!task?.approvals.has(approvalId) || !task.handle?.respondApproval(approvalId, allow))
      throw new HttpError(409, 'Approval is no longer pending.')
    task.approvals.delete(approvalId)
    this.changed(id)
  }
  async stop() {
    this.closing = true
    const tasks = [...this.active.values()]
    for (const task of tasks) {
      task.stopping = 'shutdown'
      task.approvals.clear()
      clearTimeout(task.timeout)
      task.handle?.cancel()
    }
    await Promise.all(tasks.map(task => task.settled))
  }
}
