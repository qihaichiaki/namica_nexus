import { createConnection } from 'node:net'
import type { AgentOptions } from '../../agent-core/src/index.js'
import { resolveCodexExecutable } from './executable.js'
import { codexEnvironment } from './home.js'
import { fields, Rpc, type Fields } from './rpc.js'

export type CodexAccountState =
  | { state: 'signed-in'; account: 'ChatGPT' | 'API key' | 'Amazon Bedrock' | 'GCP' }
  | { state: 'signed-out'; detail?: string }

export const deviceVerificationUrl = 'https://auth.openai.com/codex/device'
const accountLabels = { chatgpt: 'ChatGPT', apiKey: 'API key', amazonBedrock: 'Amazon Bedrock', gcp: 'GCP' } as const
const loginIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export type CodexLoginMethod = 'browser' | 'device'
export type CodexLogin = { loginId: string } & (
  | { method: 'browser'; verificationUrl: string }
  | { method: 'device'; verificationUrl: typeof deviceVerificationUrl; userCode: string }
)

const authQuery = new Set(['client_id', 'redirect_uri', 'response_type', 'scope', 'code_challenge', 'code_challenge_method',
  'state', 'id_token_add_organizations', 'codex_cli_simplified_flow', 'originator', 'allowed_workspace_id'])

function officialBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 ||
      !value.startsWith('https://auth.openai.com/oauth/authorize?') || /[\s\x00-\x1f\x7f#]/.test(value)) return false
  const query = new URL(value).searchParams
  const redirect = query.get('redirect_uri')
  return (redirect === 'http://127.0.0.1:1455/auth/callback' || redirect === 'http://127.0.0.1:1457/auth/callback') &&
    query.get('response_type') === 'code' && query.get('code_challenge_method') === 'S256' &&
    Boolean(query.get('state') && query.get('client_id') && query.get('code_challenge')) &&
    [...query.keys()].every(key => authQuery.has(key) && query.getAll(key).length === 1)
}

export class CodexCallbackBusyError extends Error {}

function checkCallbackPort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // The native login server can send /cancel on its preferred port if it is occupied.
    // Probe with TCP only so we do not disrupt an already active local sign-in.
    const socket = createConnection({ host: '127.0.0.1', port: 1455, signal })
    socket.setTimeout(1000)
    const busy = () => {
      socket.destroy()
      reject(new CodexCallbackBusyError())
    }
    socket.once('connect', busy)
    socket.once('timeout', busy)
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })
}

export interface CodexLoginCompletion {
  loginId: string
  success: boolean
}

export interface CodexAccountConnection {
  read(signal: AbortSignal): Promise<CodexAccountState>
  startLogin(method: CodexLoginMethod, signal: AbortSignal): Promise<CodexLogin>
  cancelLogin(loginId: string, signal: AbortSignal): Promise<boolean>
  logout(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

export async function connectCodexAccount(
  options: Pick<AgentOptions, 'executable' | 'proxyUrl' | 'workspace'>,
  privateHome: string,
  signal: AbortSignal,
  onCompletion: (completion: CodexLoginCompletion) => void,
  onFailure: () => void,
): Promise<CodexAccountConnection> {
  signal.throwIfAborted()
  const env: NodeJS.ProcessEnv = await codexEnvironment(privateHome, options.proxyUrl)
  for (const key of Object.keys(env)) {
    if (/^CODEX_APP_SERVER_(LOGIN_ISSUER|DEV_OPEN_APP_URL)$/i.test(key)) delete env[key]
  }
  const executable = await resolveCodexExecutable(options.executable, signal)
  signal.throwIfAborted()
  const rpc = new Rpc(executable, options.workspace, env, message => {
    if (typeof message.id === 'number' || typeof message.id === 'string') {
      rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } })
      return
    }
    if (message.method !== 'account/login/completed') return
    const { loginId, success } = fields(message.params)
    if (typeof loginId === 'string' && loginIdPattern.test(loginId) && typeof success === 'boolean') {
      onCompletion({ loginId, success })
    }
  }, onFailure)
  const abort = () => rpc.close()
  const close = async () => {
    abort()
    await rpc.exited
  }
  async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await operation()
      signal.throwIfAborted()
      return result
    } finally { signal.removeEventListener('abort', abort) }
  }
  function request(method: string, params: Fields, signal: AbortSignal) {
    return bounded(() => rpc.request(method, params), signal)
  }
  try {
    await bounded(() => rpc.initialize(), signal)
  } catch (error) {
    await close()
    throw error
  }
  return {
    async read(signal) {
      const result = await request('account/read', { refreshToken: false }, signal)
      const { type } = fields(result.account)
      if (typeof type === 'string' && Object.hasOwn(accountLabels, type)) {
        return { state: 'signed-in', account: accountLabels[type as keyof typeof accountLabels] }
      }
      if (result.account === null && typeof result.requiresOpenaiAuth === 'boolean') {
        const detail = result.requiresOpenaiAuth ? undefined : '当前模型服务无需 OpenAI 登录。'
        return { state: 'signed-out', detail }
      }
      throw new Error('Unexpected Codex account response')
    },
    async startLogin(method, signal) {
      if (method === 'browser') await checkCallbackPort(signal)
      const expectedType = method === 'browser' ? 'chatgpt' : 'chatgptDeviceCode'
      const { type, loginId, authUrl, verificationUrl, userCode } = await request('account/login/start', { type: expectedType }, signal)
      if (type === expectedType && typeof loginId === 'string' && loginIdPattern.test(loginId)) {
        if (method === 'browser' && officialBrowserUrl(authUrl)) return { method, loginId, verificationUrl: authUrl }
        if (method === 'device' && verificationUrl === deviceVerificationUrl && typeof userCode === 'string' &&
            /^[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,2}$/.test(userCode)) {
          return { method, loginId, verificationUrl, userCode }
        }
      }
      throw new Error('Unexpected Codex authorization response')
    },
    async cancelLogin(loginId, signal) {
      const { status } = await request('account/login/cancel', { loginId }, signal)
      if (status === 'canceled') return true
      if (status === 'notFound') return false
      throw new Error('Unexpected Codex cancellation response')
    },
    async logout(signal) {
      await request('account/logout', {}, signal)
    },
    close,
  }
}
