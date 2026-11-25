import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from './store.js'
import { validateMigration } from './migration.js'

const directory = z.string().trim().min(1).max(32767).refine(isAbsolute, '请选择绝对目录。')
export const deploymentSchema = z.strictObject({
  address: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(1).max(65535),
  dataDirectory: directory,
})
export type Deployment = z.infer<typeof deploymentSchema>
const stateSchema = z.strictObject({active: deploymentSchema, pending: deploymentSchema, lastError: z.string().optional()})
export type DeploymentState = z.infer<typeof stateSchema>
export type RestartTicket = {id: string; origin: string; expires: number; status: 'ready' | 'failed'}
export function consoleUrl(value: Deployment) {
  return new URL('/console/', 'http://' + (value.address === '::1' ? '[::1]' : value.address) + ':' + value.port).href
}

export function deploymentProfile() {
  const seed = deploymentSchema.parse({
    address: process.env.NEXUS_ADDRESS ?? '127.0.0.1', port: Number(process.env.NEXUS_PORT ?? 8080),
    dataDirectory: resolve(process.env.NEXUS_DATA_DIR || 'data'),
  })
  // Bootstrap variables select a separate installation profile. Subsequent starts find Console edits.
  const key = [seed.address, seed.port, seed.dataDirectory].join('\n')
  const name = createHash('sha256').update(key).digest('hex')
  const file = resolve(process.env.NEXUS_DEPLOYMENT_FILE || join('.nexus-deployment', name + '.json'))
  return new DeploymentProfile(file, seed)
}

export class DeploymentProfile {
  private recovered?: DeploymentState
  constructor(readonly file: string, readonly seed: Deployment) {}
  read(): DeploymentState {
    if (this.recovered) return this.recovered
    if (!existsSync(this.file)) return {active: this.seed, pending: this.seed}
    return stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
  }
  write(state: DeploymentState) {
    mkdirSync(dirname(this.file), {recursive: true})
    const temp = this.file + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', {flag: 'wx', mode: 0o600, flush: true})
      renameSync(temp, this.file)
      this.recovered = undefined
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  recover(state: DeploymentState) {
    try { this.write(state) } catch {
      state.lastError += ' 回退状态暂时无法写入部署文件。请检查权限后重新保存。'
      this.recovered = state
    }
  }
  save(active: Deployment, patch: unknown) {
    const pending = {...this.read().pending, ...deploymentSchema.partial().parse(patch)}
    pending.dataDirectory = resolve(pending.dataDirectory)
    validateMigration(active.dataDirectory, pending.dataDirectory, this.file)
    const state = {active, pending}
    this.write(state)
    return state
  }
}

// SQLite's OS lock is released even after process termination. The profile guard serializes
// manual and double-click startup; the login guard excludes external CLI writes during copying.
export function lockProfile(file: string, purpose: 'host' | 'login') {
  mkdirSync(dirname(file), {recursive: true})
  const db = new DatabaseSync(file + '.' + purpose + '.sqlite')
  try {
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE')
    return () => db.close()
  } catch (error) {
    db.close()
    if ((error as {errcode?: number}).errcode === 5) throw new HttpError(409,
      purpose === 'host' ? '同一部署配置已有 Host 正在运行或启动。' : '专用登录操作或迁移正在进行。')
    throw error
  }
}

export async function probeEndpoint(target: Deployment) {
  const server = createServer()
  await new Promise<void>((accept, reject) => {
    server.once('error', () => reject(new HttpError(409, '目标监听地址或端口不可用，请选择其他地址或端口。')))
    server.listen({host: target.address, port: target.port, exclusive: true}, () => {
      server.close(error => error ? reject(error) : accept())
    })
  })
}
