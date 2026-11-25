import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runtimeEnv } from './proxy.js'

async function canonical(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await canonical(dirname(path)), basename(path))
  }
}

function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}

export async function prepareCodexHome(privateHome: string, workspace?: string) {
  if (!isAbsolute(privateHome)) throw new Error('Nexus requires an absolute private Codex home.')
  const home = await canonical(privateHome)
  // A junction in the selected data directory or workspace must not defeat separation.
  const separateFrom = [join(homedir(), '.codex'), process.env.CODEX_HOME, process.env.CODEX_SQLITE_HOME, workspace]
  for (const path of separateFrom) {
    if (!path) continue
    const other = await canonical(resolve(path))
    if (contains(home, other) || contains(other, home)) {
      throw new Error('Nexus 的专用 Codex 目录必须与常规 Codex 目录和工作目录分开。')
    }
  }
  for (const name of ['sessions', 'archived_sessions', 'log']) {
    if (!contains(home, await canonical(join(home, name)))) throw new Error('Codex storage path leaves its private home.')
  }
  await mkdir(home, { recursive: true })
  return home
}

export async function codexEnvironment(privateHome: string, proxyUrl?: string, workspace?: string) {
  const home = await prepareCodexHome(privateHome, workspace)
  const env = await runtimeEnv(proxyUrl)
  // Do not inherit desktop rollout diagnostics or global database routing into Nexus.
  for (const key of Object.keys(env)) {
    if (/^CODEX_(HOME|SQLITE_HOME|ROLLOUT_TRACE_ROOT)$/i.test(key)) delete env[key]
  }
  return { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: home }
}

export function codexStorageArgs(home: string): string[] {
  return ['-c', 'sqlite_home=' + JSON.stringify(home), '-c', 'log_dir=' + JSON.stringify(join(home, 'log'))]
}
