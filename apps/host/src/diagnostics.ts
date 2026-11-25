import type { FastifyBaseLogger } from 'fastify'
import type { LogLevel } from '../../../packages/protocol/src/index.js'

const capacity = 200
const severity = { debug: 10, info: 20, warn: 30, error: 40 }
const events = {
  hostStarted: ['info', 'Host started'],
  hostListening: ['info', 'Host is listening'],
  deploymentSaved: ['info', 'Next startup settings saved'],
  restartRequested: ['info', 'Host restart requested'],
  restartCompleted: ['info', 'Host restart completed'],
  restartReverted: ['warn', 'Host restarted with previous settings'],
  restartFailed: ['error', 'Host restart failed'],
  hostStopping: ['info', 'Host is shutting down'],
  shutdownFailed: ['error', 'Host shutdown failed'],
  hostConfigUpdated: ['info', 'Host settings saved'],
  runtimeConfigUpdated: ['info', 'Runtime settings saved'],
  runtimeCheckStarted: ['debug', 'Runtime check started'],
  runtimeCheckPassed: ['info', 'Runtime check passed'],
  runtimeCheckFailed: ['warn', 'Runtime check failed'],
  unrecognizedHost: ['warn', 'Request rejected due to unrecognized Host'],
  unrecognizedOrigin: ['warn', 'Request rejected due to unrecognized Origin'],
  requestFailed: ['error', 'Host request failed'],
  turnAccepted: ['info', 'Turn accepted'],
  turnReady: ['debug', 'Runtime session ready'],
  turnCompleted: ['info', 'Turn completed'],
  turnCancelled: ['info', 'Turn cancelled'],
  turnFailed: ['warn', 'Turn failed'],
  turnInterrupted: ['warn', 'Turn interrupted'],
  turnTimedOut: ['warn', 'Turn exceeded its execution timeout'],
  authReadFailed: ['warn', 'Codex sign-in status check failed'],
  authBrowserStarted: ['info', 'Codex browser authorization started'],
  authDeviceStarted: ['info', 'Codex device authorization started'],
  authStartFailed: ['warn', 'Codex authorization could not start'],
  authCompleted: ['info', 'Codex sign-in completed'],
  authFailed: ['warn', 'Codex sign-in did not complete'],
  authCancelled: ['info', 'Codex authorization cancelled'],
  authCancelFailed: ['warn', 'Codex authorization could not be cancelled'],
  authExpired: ['warn', 'Codex authorization timed out'],
  authDisconnected: ['warn', 'Codex authorization connection closed'],
  authSignedOut: ['info', 'Codex sign-out completed'],
  authLogoutFailed: ['warn', 'Codex sign-out failed'],
} as const satisfies Record<string, readonly [LogLevel, string]>

export type DiagnosticEvent = keyof typeof events
interface Entry { time: string; level: LogLevel; message: string }

export class Diagnostics {
  private readonly entries: Entry[] = []

  constructor(private readonly log: FastifyBaseLogger) {}

  record(event: DiagnosticEvent) {
    const [level, message] = events[event]
    if (severity[level] < severity[this.log.level as LogLevel]) return
    this.log[level](message)
    this.entries.push({ time: new Date().toISOString(), level, message })
    if (this.entries.length > capacity) this.entries.shift()
  }

  recent() { return { entries: this.entries.slice().reverse() } }
}
