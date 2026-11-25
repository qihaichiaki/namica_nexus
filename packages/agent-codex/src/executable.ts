import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const packageQuery = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "Get-AppxPackage -Name OpenAI.Codex | Where-Object PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' | Select-Object -ExpandProperty InstallLocation"
].join('\n')

function fullyQualified(path: string) {
  // A single leading slash still depends on the current drive on Windows.
  return win32.isAbsolute(path) && win32.parse(path).root.length > 1
}

async function desktopInstallLocations(signal?: AbortSignal): Promise<string[]> {
  const windows = process.env.SystemRoot
  if (!windows || !fullyQualified(windows)) return []
  const powershell = win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', packageQuery], {
      cwd: windows, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8', signal
    })
    return stdout.trim().split(/\r?\n/).filter(fullyQualified)
  } catch {
    signal?.throwIfAborted()
    return []
  }
}

async function isFile(path: string) {
  try { return (await stat(path)).isFile() } catch { return false }
}

export async function resolveCodexExecutable(value: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32' || fullyQualified(value)) return value
  if (/[\\/:]/.test(value)) throw new Error('Use an absolute path to the Codex executable.')

  // Resolving here prevents CreateProcess from looking in the agent workspace first.
  const filename = value.toLowerCase().endsWith('.exe') ? value : value + '.exe'
  for (const entry of (process.env.PATH ?? '').split(win32.delimiter)) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!fullyQualified(directory)) continue
    signal?.throwIfAborted()
    const candidate = win32.join(directory, filename)
    if (await isFile(candidate)) return candidate
  }

  if (filename.toLowerCase() === 'codex.exe') {
    for (const location of await desktopInstallLocations(signal)) {
      const candidate = win32.join(location, 'app', 'resources', 'codex.exe')
      if (await isFile(candidate)) return candidate
    }
    throw new Error('未能从 PATH 或当前用户的 Codex 桌面版找到 codex.exe。请安装 Codex，或在 Runtime 配置中填写可执行文件的完整路径。')
  }
  throw new Error('Codex executable was not found on PATH. Configure its absolute path.')
}
