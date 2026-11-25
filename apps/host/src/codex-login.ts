import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { codexEnvironment, codexStorageArgs } from '../../../packages/agent-codex/src/home.js'
import { resolveCodexExecutable } from '../../../packages/agent-codex/src/executable.js'
import type { HostStatus, Runtime } from '../../../packages/protocol/src/index.js'
import { consoleUrl, deploymentProfile, lockProfile, type Deployment } from './deployment.js'
import { validateMigration } from './migration.js'
import { codexHomeFor } from './paths.js'

type LoginConfig = Pick<Runtime, 'executable' | 'proxyUrl'>

function offlineConfig(directory: string): LoginConfig | undefined {
  const file = join(directory, 'nexus.sqlite')
  if (!existsSync(file)) return {executable: 'codex', proxyUrl: ''}

  // Read-only access avoids taking Host ownership or marking an active turn interrupted.
  const db = new DatabaseSync(file, {readOnly: true})
  try {
    const row = db.prepare('SELECT json FROM runtimes WHERE id=?').get('codex')
    if (!row) throw new Error('数据目录中没有 Codex Runtime 配置。')
    return JSON.parse(String(row.json)) as LoginConfig
  } catch (error) {
    const code = (error as {errcode?: number}).errcode
    if (code !== 5 && code !== 6) throw error
  } finally { db.close() }
}

type AccountState = {state: string; account?: string; detail?: string; verificationUrl?: string; userCode?: string}
async function onlineLogin(active: Deployment, args: string[]) {
  const base = new URL('/api/manage/', consoleUrl(active))
  async function request<T>(endpoint: string, body?: object): Promise<T> {
    const res = await fetch(new URL(endpoint, base), {redirect: 'error', signal: AbortSignal.timeout(30_000),
      ...(body && {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})})
    if (!res.ok) throw new Error((await res.json() as {error?: string}).error ?? 'Host returned HTTP ' + res.status)
    return res.json() as Promise<T>
  }
  const status = await request<HostStatus>('host/status')
  if (status.service !== 'namica-nexus' || status.port !== active.port || status.address !== active.address ||
      relative(realpathSync(active.dataDirectory), realpathSync(status.dataDirectory))) throw new Error('当前端口没有预期的 Nexus Host。')

  const path = 'auth/codex'
  let auth = args[0] === 'status' ? await request<AccountState>(path)
    : await request<AccountState>(path + '/login', {method: args[0] === '--device-auth' ? 'device' : 'browser'})
  if (auth.verificationUrl) console.log('官方授权地址：' + auth.verificationUrl)
  if (auth.userCode) console.log('设备码：' + auth.userCode)
  while (args[0] !== 'status' && auth.state === 'pending') {
    await delay(1500)
    auth = await request<AccountState>(path)
  }
  if (auth.state === 'signed-in') console.log('已登录' + (auth.account ? '：' + auth.account : ''))
  else {
    console.log(auth.detail ?? (auth.state === 'pending' ? '等待官方授权。' : '尚未登录。'))
    process.exitCode = 1
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && !['status', '--device-auth'].includes(args[0]))) {
    throw new Error('用法：npm run codex:login [-- status | -- --device-auth]')
  }
  const profile = deploymentProfile()
  let unlock: (() => void) | undefined = lockProfile(profile.file, 'login')
  try {
    const active = profile.read().active
    const directory = active.dataDirectory
    validateMigration(directory, directory, profile.file)
    if (existsSync(profile.file) && !existsSync(join(directory, 'nexus.sqlite'))) throw new Error('上次生效的 Nexus 数据库不存在。')
    const runtime = offlineConfig(directory)
    if (!runtime) {
      unlock()
      unlock = undefined
      return await onlineLogin(active, args)
    }
    const env = await codexEnvironment(codexHomeFor(directory), runtime.proxyUrl)
    const privateHome = env.CODEX_HOME!
    console.log('Nexus Codex 目录：' + privateHome)
    const executable = await resolveCodexExecutable(runtime.executable)
    const child = spawn(executable, [...codexStorageArgs(privateHome), 'login', ...args], {
      env, cwd: directory, stdio: 'inherit', shell: false, windowsHide: true,
    })
    process.exitCode = await new Promise<number>((accept, reject) => {
      child.once('error', reject)
      child.once('close', code => accept(code ?? 1))
    })
  } finally { unlock?.() }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
