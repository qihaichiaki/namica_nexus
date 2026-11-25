import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentOptions } from '../../agent-core/src/index.js'
import { codexStorageArgs } from './home.js'

export type Fields = Record<string, unknown>
export function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : {}
}
export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Do not forward raw server objects, stderr or account records to Host clients.
export function summary(value: unknown): string {
  return stringValue(value)
    .replace(/(\b(?:https?|socks5h?):\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/(Bearer\s+|(?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1600)
}

interface Pending {
  resolve: (result: Fields) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export function resolveCodexExecutable(value: string): string {
  if (process.platform !== 'win32' || isAbsolute(value)) return value
  if (/[\\/:]/.test(value)) throw new Error('Use an absolute path to the Codex executable')
  // Windows can otherwise look in the agent's working directory before PATH.
  const filename = value.toLowerCase().endsWith('.exe') ? value : value + '.exe'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, filename)
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Codex executable was not found on PATH. Configure its absolute path.')
}

export class Rpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private closed = false
  private readonly lines
  readonly exited: Promise<void>
  private readonly home: string

  constructor(options: AgentOptions, env: NodeJS.ProcessEnv, receive: (message: Fields) => void, onFailure: (error: Error) => void) {
    if (!env.CODEX_HOME || env.CODEX_HOME !== env.CODEX_SQLITE_HOME) throw new Error('Missing private Codex storage.')
    this.home = env.CODEX_HOME
    this.child = spawn(resolveCodexExecutable(options.executable), ['app-server', ...codexStorageArgs(this.home)], {
      cwd: options.workspace, windowsHide: true, shell: false, stdio: 'pipe', env
    })
    const fail = (error: Error) => {
      if (this.closed) return
      this.close(error)
      onFailure(error)
    }
    this.child.on('error', error => fail(new Error('Codex failed to start: ' + summary(error.message))))
    this.child.stdin.on('error', () => fail(new Error('Codex closed its input stream')))
    this.child.stderr.resume()
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      resolve()
      fail(new Error('Codex app-server exited (' + (signal ?? code) + ')'))
    }))
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.lines.on('line', line => {
      if (this.closed || !line.trim()) return
      try {
        const message = fields(JSON.parse(line))
        if (typeof message.method === 'string') return receive(message)
        if (typeof message.id !== 'number') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(summary(fields(message.error).message) || 'Codex RPC failed'))
        else pending.resolve(fields(message.result))
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid Codex message'))
      }
    })
  }

  send(message: Fields) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  request(method: string, params: Fields): Promise<Fields> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex timed out during ' + method))
      }, 45_000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  async initialize(): Promise<string> {
    const response = await this.request('initialize', {
      clientInfo: { name: 'namica_nexus', title: 'Namica Nexus', version: '0.1.0' }
    })
    this.send({ method: 'initialized', params: {} })
    const matches = (value: unknown, expected: string) => typeof value === 'string' && isAbsolute(value) && relative(expected, value) === ''
    if (!matches(response.codexHome, this.home)) throw new Error('Codex did not confirm the private Nexus home.')
    const { config } = await this.request('config/read', {})
    if (!matches(fields(config).sqlite_home, this.home) || !matches(fields(config).log_dir, join(this.home, 'log'))) {
      throw new Error('Codex did not confirm the private Nexus database and log paths.')
    }
    return stringValue(response.userAgent).match(/\/(\d+\.\d+\.\d+[^\s)]*)/)?.[1] ?? 'unknown'
  }

  close(error = new Error('Codex connection closed')) {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
    // EOF allows Codex to flush the thread and release its child processes.
    this.child.stdin.end()
    const kill = setTimeout(() => this.child.kill(), 1500)
    kill.unref()
    this.child.once('close', () => clearTimeout(kill))
  }
}
