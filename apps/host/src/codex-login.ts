import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { codexEnvironment, codexStorageArgs } from '../../../packages/agent-codex/src/home.js'
import { resolveCodexExecutable } from '../../../packages/agent-codex/src/rpc.js'
import type { HostStatus, Runtime } from '../../../packages/protocol/src/index.js'
import { codexHomeFor, resolveDataDirectory } from './paths.js'

type LoginConfig = Pick<Runtime, 'executable' | 'proxyUrl'>

async function readLoginConfig(directory: string): Promise<LoginConfig> {
  const file = join(directory, 'nexus.sqlite')
  if (!existsSync(file)) return { executable: 'codex', proxyUrl: '' }

  // Read-only access avoids taking Host ownership or marking an active turn interrupted.
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT json FROM runtimes WHERE id=?').get('codex')
    if (!row) throw new Error('数据目录中没有 Codex Runtime 配置。')
    return JSON.parse(String(row.json)) as LoginConfig
  } catch (error) {
    const code = (error as { errcode?: number }).errcode
    if (code !== 5 && code !== 6) throw error
  } finally { db.close() }

  // A running Host holds an exclusive lock. Consult that same instance through its API.
  const port = Number(process.env.NEXUS_PORT || 8080)
  const base = 'http://127.0.0.1:' + port + '/api/manage/'
  async function get<T>(endpoint: string): Promise<T> {
    const res = await fetch(base + endpoint, { redirect: 'error', signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error('Host returned HTTP ' + res.status)
    return res.json() as Promise<T>
  }
  const status = await get<HostStatus>('host/status')
  if (status.service !== 'namica-nexus' || status.port !== port) throw new Error('当前端口没有预期的 Namica Nexus Host。')
  if (relative(directory, status.dataDirectory)) throw new Error('当前端口的 Host 使用另一数据目录，请核对 NEXUS_PORT 和 NEXUS_DATA_DIR。')
  const runtime = (await get<Runtime[]>('runtimes')).find(runtime => runtime.id === 'codex' && runtime.type === 'codex')
  if (!runtime) throw new Error('当前 Host 没有 Codex Runtime 配置。')
  return runtime
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && !['status', '--device-auth'].includes(args[0]))) {
    throw new Error('用法：npm run codex:login [-- status | -- --device-auth]')
  }
  const directory = resolveDataDirectory()
  const runtime = await readLoginConfig(directory)
  const env = await codexEnvironment(codexHomeFor(directory), runtime.proxyUrl)
  const privateHome = env.CODEX_HOME!
  console.log('Nexus Codex 目录：' + privateHome)
  const child = spawn(resolveCodexExecutable(runtime.executable), [...codexStorageArgs(privateHome), 'login', ...args], {
    env, cwd: directory, stdio: 'inherit', shell: false, windowsHide: true,
  })
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
