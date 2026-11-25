import {
  CodexCallbackBusyError, connectCodexAccount, type CodexAccountConnection, type CodexAccountState,
  type CodexLogin, type CodexLoginCompletion, type CodexLoginMethod,
} from '../../../packages/agent-codex/src/account.js'
import type { Runtime } from '../../../packages/protocol/src/index.js'
import type { DiagnosticEvent, Diagnostics } from './diagnostics.js'
import { HttpError } from './store.js'

type AccountStatus = (CodexAccountState | { state: 'unknown' }) & { detail?: string }
type Status = AccountStatus | {
  state: 'pending'; account?: string; method: CodexLoginMethod; verificationUrl: string; userCode?: string
}
type LoginEnd = 'success' | 'failed' | 'expired' | 'disconnected'
interface PendingLogin {
  connection: CodexAccountConnection
  login: CodexLogin
  timer: NodeJS.Timeout
  end?: LoginEnd
}

const actionTimeout = 12_000
const loginTimeout = { browser: 10 * 60_000, device: 15 * 60_000 }
const working = 'Codex 正在处理登录操作，请稍后重试。'
const unknown: AccountStatus = { state: 'unknown' }

export class ConsoleCodexAuth {
  private readonly stopped = new AbortController()
  private status = unknown
  private notice?: string
  private pending?: PendingLogin
  private operation?: Promise<Status>
  private reading = false

  constructor(
    private readonly home: string,
    private readonly dataDirectory: string,
    private readonly runtime: () => Runtime,
    private readonly runtimeBusy: () => string | undefined,
    private readonly diagnostics: Diagnostics,
    private readonly credentialsChanged: () => void,
  ) {}

  get busy() { return Boolean(this.operation || this.pending) }
  get changingAccount() { return this.busy && !this.reading }

  reset() {
    this.status = unknown
    this.notice = undefined
  }

  private snapshot(): Status {
    if (this.pending) {
      const { method, verificationUrl } = this.pending.login
      const account = this.status.state === 'signed-in' ? this.status.account : undefined
      const userCode = this.pending.login.method === 'device' ? this.pending.login.userCode : undefined
      return { state: 'pending', account, method, verificationUrl, userCode }
    }
    return this.notice ? { ...this.status, detail: this.notice } : this.status
  }

  read(): Promise<Status> | Status {
    if (this.pending) return this.snapshot()
    if (this.operation) return this.operation
    const busy = this.runtimeBusy()
    if (busy) return { ...this.status, detail: busy }
    this.reading = true
    return this.run(signal => this.connected(signal, async connection => {
      this.status = await connection.read(signal)
      return this.snapshot()
    }), 'authReadFailed', '无法读取 Nexus 专用 Codex 的登录状态。请检查 Runtime 设置后重试。')
  }

  login(method: CodexLoginMethod): Promise<Status> | Status {
    if (this.pending && !this.operation) {
      if (this.pending.login.method === method) return this.snapshot()
      throw new HttpError(409, '请先完成或取消正在等待的授权。')
    }
    this.assertAvailable()
    this.notice = undefined
    return this.run(async signal => {
      let early: CodexLoginCompletion | undefined
      let disconnected = false
      let owned: PendingLogin | undefined
      const onCompletion = (completion: CodexLoginCompletion) => {
        if (!owned) early = completion
        else if (completion.loginId === owned.login.loginId) this.markEnd(owned, completion.success ? 'success' : 'failed')
      }
      const onFailure = () => {
        if (owned) this.markEnd(owned, 'disconnected')
        else disconnected = true
      }
      const connection = await this.connect(signal, onCompletion, onFailure)
      try {
        const login = await connection.startLogin(method, signal)
        signal.throwIfAborted()
        const timer = setTimeout(() => { if (owned) this.markEnd(owned, 'expired') }, loginTimeout[method])
        timer.unref()
        this.pending = owned = { connection, login, timer }
        if (early) onCompletion(early)
        if (disconnected) onFailure()
        this.diagnostics.record(method === 'browser' ? 'authBrowserStarted' : 'authDeviceStarted')
        return this.snapshot()
      } finally {
        if (!owned) await connection.close()
      }
    }, 'authStartFailed', method === 'browser'
      ? '无法打开官方网页授权。请检查 Codex 和网络，或选择设备码授权。'
      : '无法发起设备码授权。请检查 Codex、网络和 ChatGPT 中的设备码授权设置。')
  }

  cancel(): Promise<Status> | Status {
    this.assertAvailable()
    const pending = this.pending
    if (!pending) return this.snapshot()
    this.release(pending)
    return this.run(async signal => {
      const { connection, login } = pending
      try {
        const cancelled = await connection.cancelLogin(login.loginId, signal)
        this.status = await connection.read(signal)
        if (cancelled) {
          this.diagnostics.record('authCancelled')
          this.notice = '授权已取消。'
        } else {
          this.credentialsChanged()
          this.notice = '授权已结束，已刷新登录状态。'
        }
        return this.snapshot()
      } finally { await connection.close() }
    }, 'authCancelFailed', '授权连接已关闭，请刷新以确认当前登录状态。')
  }

  logout(): Promise<Status> {
    this.assertAvailable()
    if (this.pending) throw new HttpError(409, '请先完成或取消正在等待的授权。')
    this.notice = undefined
    return this.run(signal => this.connected(signal, async connection => {
      await connection.logout(signal)
      this.credentialsChanged()
      this.status = await connection.read(signal)
      if (this.status.state !== 'signed-out') throw new Error('Codex is still signed in')
      this.diagnostics.record('authSignedOut')
      this.notice = 'Nexus 专用 Codex 已退出。'
      return this.snapshot()
    }), 'authLogoutFailed', '无法确认退出结果。请刷新以确认当前登录状态。')
  }

  async stop() {
    this.stopped.abort()
    const pending = this.pending
    if (pending) {
      this.release(pending)
      await pending.connection.close()
    }
    await this.operation
  }

  private assertAvailable() {
    const busy = this.operation ? working : this.runtimeBusy()
    if (busy) throw new HttpError(409, busy)
  }

  private connect(
    signal: AbortSignal,
    onCompletion: (completion: CodexLoginCompletion) => void,
    onFailure: () => void,
  ) {
    return connectCodexAccount({ ...this.runtime(), workspace: this.dataDirectory }, this.home, signal, onCompletion, onFailure)
  }

  private async connected(signal: AbortSignal, action: (connection: CodexAccountConnection) => Promise<Status>) {
    const connection = await this.connect(signal, () => {}, () => {})
    try { return await action(connection) } finally { await connection.close() }
  }

  private run(action: (signal: AbortSignal) => Promise<Status>, failure: DiagnosticEvent, detail: string) {
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(actionTimeout)])
    const operation = Promise.resolve().then(() => action(signal)).catch(error => {
      if (!this.stopped.signal.aborted) this.diagnostics.record(failure)
      if (error instanceof CodexCallbackBusyError) {
        this.notice = 'Codex 网页授权端口正在使用。请等待其他授权结束，或选择设备码授权。'
      } else {
        this.status = unknown
        this.notice = detail
      }
      return this.snapshot()
    }).finally(() => {
      this.reading = false
      this.operation = undefined
      this.settlePending()
    })
    this.operation = operation
    return operation
  }

  private markEnd(pending: PendingLogin, end: LoginEnd) {
    if (this.pending !== pending || pending.end) return
    pending.end = end
    this.settlePending()
  }

  private release(pending: PendingLogin) {
    clearTimeout(pending.timer)
    this.pending = undefined
  }

  private settlePending() {
    const pending = this.pending
    if (!pending?.end || this.operation || this.stopped.signal.aborted) return
    const { connection, end } = pending
    this.release(pending)
    void this.run(async signal => {
      try {
        // A replacement or any ambiguous outcome invalidates the last availability check.
        this.credentialsChanged()
        if (end === 'success' || end === 'failed') {
          this.status = await connection.read(signal)
          if (end === 'success' && this.status.state !== 'signed-in') throw new Error('Codex did not confirm sign-in')
          this.diagnostics.record(end === 'success' ? 'authCompleted' : 'authFailed')
          this.notice = end === 'success' ? 'Nexus 专用 Codex 已登录。' : '授权未完成。可重新发起授权。'
        } else {
          this.status = unknown
          this.diagnostics.record(end === 'expired' ? 'authExpired' : 'authDisconnected')
          this.notice = end === 'expired' ? '授权已过期，请重新发起授权。' : '授权连接已关闭，请刷新登录状态。'
        }
        return this.snapshot()
      } finally { await connection.close() }
    }, 'authFailed', '授权已结束，请刷新以确认当前登录状态。')
  }
}
