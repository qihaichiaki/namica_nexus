import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildHost } from './app.js'
import { deploymentProfile, lockProfile, probeEndpoint, type Deployment, type RestartTicket } from './deployment.js'
import { migrateDirectory, validateMigration } from './migration.js'

const profile = deploymentProfile()
const initial = profile.read().active
validateMigration(initial.dataDirectory, initial.dataDirectory, profile.file)
const release = lockProfile(profile.file, 'host')
process.once('exit', release)
let running: Awaited<ReturnType<typeof buildHost>> | undefined
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true
    void running?.close().catch(() => { process.exitCode = 1 })
  })
}

async function serve(target: Deployment, ticket?: RestartTicket) {
  if (existsSync(target.dataDirectory) && readdirSync(target.dataDirectory).some(name => name.startsWith('.nexus-migration-'))) {
    throw new Error('数据目录含未完成迁移的暂存文件。请使用原数据目录并检查目标。')
  }
  const host = await buildHost({
    ...target, deployment: profile, dev: process.argv.includes('--dev'), restartResult: ticket,
    onRestart: receipt => { if (!stopping) void start(receipt).catch(fail) },
  })
  running = host
  try {
    const address = await host.listen({host: target.address, port: target.port})
    console.log('Namica Nexus listening at ' + address)
    return host
  } catch (error) {
    await host.close()
    throw error
  }
}

async function start(ticket?: RestartTicket) {
  const previous = profile.read()
  const {active, pending} = previous
  validateMigration(active.dataDirectory, active.dataDirectory, profile.file)
  if (existsSync(profile.file) && !existsSync(join(active.dataDirectory, 'nexus.sqlite'))) {
    throw new Error('上次生效的 Nexus 数据目录缺少数据库。请恢复原目录后重新启动。')
  }
  const changed = pending.address !== active.address || pending.port !== active.port || pending.dataDirectory !== active.dataDirectory
  let unlockLogin: (() => void) | undefined
  let candidate: typeof running
  try {
    await probeEndpoint(pending)
    unlockLogin = lockProfile(profile.file, 'login')
    if (pending.dataDirectory !== active.dataDirectory) {
      migrateDirectory(active.dataDirectory, pending.dataDirectory, profile.file)
    }
    candidate = await serve(pending, ticket && {...ticket, expires: Date.now() + 300_000})
    if (changed || !existsSync(profile.file)) profile.write({active: pending, pending})
  } catch (error) {
    await candidate?.close()
    if (!changed) throw error
    // The old source remains authoritative until both listen and the atomic profile write succeed.
    const failed = {active, pending: active, lastError: '启动配置未能应用，已恢复原设置。' +
      (error instanceof Error ? error.message : '请核对目标地址和目录。')}
    profile.recover(failed)
    await serve(active, ticket && {...ticket, status: 'failed', expires: Date.now() + 300_000})
    console.error(failed.lastError)
  } finally { unlockLogin?.() }
}

function fail(error: unknown) {
  console.error(error instanceof Error ? error.message : 'Host 启动失败。')
  process.exitCode = 1
}

await start().catch(fail)
