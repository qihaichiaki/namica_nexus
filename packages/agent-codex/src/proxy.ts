import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const internetSettings = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

// WinINET supports one proxy for every scheme or a semicolon-separated per-scheme map.
export function manualProxyEnv(settings: string): NodeJS.ProcessEnv {
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+(?:0x0*1|1)\s*$/im.test(settings)) return {}
  if (/^\s*AutoConfigURL\s+REG_SZ\s+\S/im.test(settings)) return {}
  const bypass = /^\s*ProxyOverride\s+REG_SZ\s+([^\r\n]+)/im.exec(settings)?.[1]?.trim()
  const exclusions = (bypass ?? '').split(';').map(part => part.trim()).filter(Boolean)
  // NO_PROXY cannot represent WinINET's <local>, arbitrary globs or per-port rules reliably.
  // With an ambiguous rule, preserve the user's routing boundary and skip auto-configuration.
  if (exclusions.some(entry => !/^(\*\.)?[a-z\d.-]+$/i.test(entry))) return {}
  const value = /^\s*ProxyServer\s+REG_SZ\s+([^\r\n]+)/im.exec(settings)?.[1]?.trim()
  if (!value) return {}
  const entries = value.split(';').map(entry => entry.trim())
  const perScheme = entries.some(entry => /^(?:https?|ftp|socks)=/i.test(entry))
  const result: NodeJS.ProcessEnv = {}
  for (const scheme of ['http', 'https']) {
    const address = perScheme
      ? entries.find(entry => entry.toLowerCase().startsWith(scheme + '='))?.slice(scheme.length + 1)
      : entries[0]
    if (!address) continue
    try {
      const url = new URL(address.includes('://') ? address : 'http://' + address)
      if (['http:', 'https:'].includes(url.protocol) && url.hostname) result[scheme.toUpperCase() + '_PROXY'] = url.href
    } catch { /* Unsupported Windows proxy formats are left to the user's explicit environment. */ }
  }
  if (exclusions.length && Object.keys(result).length) {
    result.NO_PROXY = exclusions.map(entry => entry.replace(/^\*\./, '.')).join(',')
  }
  return result
}

export async function runtimeEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env }
  // A launched runtime must not attach tools to the developer's desktop task.
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID',
    'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_PERMISSION_PROFILE', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[key]
  const explicit = Object.keys(env).some(key => /^(https?|all)_proxy$/i.test(key))
  if (process.platform !== 'win32' || explicit || !env.SystemRoot) return env
  try {
    const { stdout } = await exec(join(env.SystemRoot, 'System32', 'reg.exe'), ['query', internetSettings], {
      windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024
    })
    const manual = manualProxyEnv(stdout)
    const existingKey = Object.keys(env).find(key => key.toLowerCase() === 'no_proxy')
    if (existingKey && manual.NO_PROXY) {
      env[existingKey] = [env[existingKey], manual.NO_PROXY].filter(Boolean).join(',')
      delete manual.NO_PROXY
    }
    Object.assign(env, manual)
  } catch { /* The registry can be unavailable under restricted accounts. */ }
  return env
}
