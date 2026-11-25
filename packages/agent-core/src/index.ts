/** Configuration captured at dispatch time. A handle owns one isolated runtime process. */
export interface AgentOptions {
  executable: string
  workspace: string
  model?: string | null
}

export interface AgentInput extends AgentOptions {
  runtimeSessionId?: string | null
  instructions: string
  message: string
}

export type AgentEvent =
  | { type: 'session.ready'; runtimeSessionId: string }
  | { type: 'turn.started' }
  | { type: 'message.updated'; content: string }
  | { type: 'tool.started'; itemId: string; label: string }
  | { type: 'tool.completed'; itemId: string; label: string; failed?: boolean; detail?: string }
  | { type: 'approval.requested'; approvalId: string; label: string }
  | { type: 'approval.resolved'; approvalId: string }

export interface AgentRun {
  /** Failed runs reject. Cancellation is confirmed by the runtime or by terminating its process. */
  done: Promise<'completed' | 'cancelled'>
  cancel(): void
  respondApproval(approvalId: string, allow: boolean): boolean
}

export interface AgentAdapter {
  type: string
  capabilities: { resume: boolean; stream: boolean; cancel: boolean; approvals: boolean }
  checkAvailability(options: AgentOptions): Promise<{ available: boolean; version: string | null; detail: string }>
  run(input: AgentInput, publish: (event: AgentEvent) => void): AgentRun
}
