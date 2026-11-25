export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface HostConfig {
  logLevel: LogLevel
  executionTimeoutSeconds: number
  defaultRuntimeId: string
}
export interface HostStatus {
  version: string
  status: 'running'
  uptimeSeconds: number
  address: string
  port: number
  dataDirectory: string
  logLevel: LogLevel
}
export interface Runtime {
  id: string
  type: string
  enabled: boolean
  executable: string
  workspace: string
  model: string
  proxyUrl: string
  version: string | null
  available: boolean | null
  detail: string
  processState: 'idle' | 'running'
}
export interface Identity {
  id: string
  name: string
  description: string
  avatar: string
  personality: string
  personalityVersion: number
  runtimeConfigId: string
  workspace: string
  createdAt: string
  updatedAt: string
}
export type TurnStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export interface Session {
  sessionId: string
  identityId: string
  runtimeConfigId: string
  runtimeSessionId: string | null
  personalityVersion: number
  title: string
  status: TurnStatus | 'idle'
  createdAt: string
  updatedAt: string
}
export interface Message {
  messageId: string
  sessionId: string
  turnId: string
  role: 'user' | 'assistant'
  content: string
  sequence: number
  createdAt: string
  status: TurnStatus
}
export interface ToolActivity {
  id: string
  turnId: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  detail: string
}
export interface Approval {
  id: string
  turnId: string
  description: string
}
export interface Turn {
  turnId: string
  sessionId: string
  status: TurnStatus
  error: string | null
}
export interface SessionSnapshot {
  session: Session
  messages: Message[]
  turns: Turn[]
  tools: ToolActivity[]
  approvals: Approval[]
}
// Notifications invalidate a snapshot. Clients fetch authoritative, ordered SQLite data.
export interface HostEvent {
  type: 'session.changed' | 'identities.changed' | 'runtimes.changed' | 'config.changed'
  sessionId?: string
}
