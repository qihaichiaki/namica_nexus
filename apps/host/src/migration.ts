import {
  constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HttpError } from './store.js'

function canonical(path: string): string {
  try { return realpathSync.native(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    if (lstatSync(path, {throwIfNoEntry: false})?.isSymbolicLink()) throw new HttpError(400, '目录包含失效链接。')
    return join(canonical(dirname(path)), basename(path))
  }
}
function contains(parent: string, path: string) {
  const rel = relative(parent, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}
function overlap(a: string, b: string) { return contains(a, b) || contains(b, a) }

export function validateMigration(source: string, target: string, config: string) {
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(target) || /[:*?"<>|\x00-\x1f]/.test(target.slice(2)) ||
      target.split(/[\\/]/).some(s => /[. ]$/.test(s)))) throw new HttpError(400, '目标必须是本机有效目录。')
  const from = canonical(source), to = canonical(target)
  for (const protectedPath of [config, join(homedir(), '.codex'), process.env.CODEX_HOME, process.env.CODEX_SQLITE_HOME]) {
    if (protectedPath && [from, to].some(p => overlap(p, canonical(resolve(protectedPath))))) {
      throw new HttpError(400, '迁移目录必须与部署配置和日常 Codex 存储分开。')
    }
  }
  if (from === parse(from).root || to === parse(to).root) throw new HttpError(400, '请选择独立的数据文件夹。')
  if (source === target) return
  if (overlap(from, to)) throw new HttpError(400, '新旧目录不能相同、互相包含或通过别名重叠。')
  const entry = lstatSync(target, {throwIfNoEntry: false})
  if (entry && (!entry.isDirectory() || readdirSync(target).length)) throw new HttpError(409, '目标必须是空文件夹或尚未创建的文件夹。')
  if (!existsSync(join(from, 'nexus.sqlite'))) throw new HttpError(409, '源 Nexus 数据库不存在。')
}

function verifyDatabase(db: DatabaseSync) {
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('数据库一致性检查失败。')
}

function relocatePaths(stage: string, source: string, target: string) {
  // Native Windows paths may include the extended-length prefix or 8.3 directory names.
  const from = canonical(source)
  const rebase = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) return
    const path = value.replace(/^\\\\\?\\(?=[a-z]:)/i, '')
    if (!isAbsolute(path)) return
    // Resolve only local paths under candidate roots. Unrelated external workspaces may be offline.
    if (contains(source, path)) return join(target, relative(source, path))
    if (contains(from, path)) return join(target, relative(from, path))
    if (process.platform !== 'win32' || !path.includes('~') || !/^[a-z]:[\\/]/i.test(path)) return
    const actual = canonical(path)
    if (contains(from, actual)) return join(target, relative(from, actual))
  }

  const db = new DatabaseSync(join(stage, 'nexus.sqlite'))
  try {
    verifyDatabase(db)
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['runtimes', 'identities']) {
      const update = db.prepare("UPDATE " + table + " SET json=json_set(json,'$.workspace',?) WHERE id=?")
      for (const row of db.prepare("SELECT id,json_extract(json,'$.workspace') AS workspace FROM " + table).all()) {
        const path = rebase(row.workspace)
        if (path) update.run(path, row.id)
      }
    }
    const update = db.prepare('UPDATE sessions SET workspace=? WHERE sessionId=?')
    for (const row of db.prepare("SELECT sessionId,workspace FROM sessions WHERE workspace<>''").all()) {
      const path = rebase(row.workspace)
      if (path) update.run(path, row.sessionId)
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
  } finally { db.close() }

  const home = join(stage, 'codex-home')
  if (!existsSync(home)) return
  const settings = join(home, 'config.toml')
  if (existsSync(settings)) {
    const config = readFileSync(settings, 'utf8')
    if (/^\s*["']?cli_auth_credentials_store["']?\s*=\s*["'](keyring|ephemeral)["']/mi.test(config) ||
        (/^\s*["']?cli_auth_credentials_store["']?\s*=\s*["']auto["']/mi.test(config) && !existsSync(join(home, 'auth.json')))) {
      throw new Error('此 Codex 使用目录外的凭据存储。请先通过官方流程切换到文件型专用登录，再迁移。')
    }
  }
  for (const name of readdirSync(home).filter(s => /^state_.*\.sqlite$/.test(s))) {
    if (name !== 'state_5.sqlite') throw new Error('此版本的 Codex 线程索引尚不支持自动迁移。')
    const native = new DatabaseSync(join(home, name))
    try {
      verifyDatabase(native)
      native.exec('BEGIN IMMEDIATE')
      for (const [table, column] of [
        ['threads', 'rollout_path'], ['threads', 'cwd'], ['project_roots', 'path'],
        ['rollout_migration_skipped_rollouts', 'rollout_path'],
      ]) {
        if (table !== 'threads' && !native.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue
        // Bind by value so both ordinary tables and WITHOUT ROWID tables are supported.
        const update = native.prepare('UPDATE ' + table + ' SET ' + column + '=? WHERE ' + column + '=?')
        for (const row of native.prepare('SELECT DISTINCT ' + column + ' AS value FROM ' + table).all()) {
          const path = rebase(row.value)
          if (column === 'rollout_path' && row.value) {
            if (!path) throw new Error('Codex 线程文件位于源数据目录之外，无法独立迁移。')
            const staged = join(stage, relative(target, path))
            if (!['sessions', 'archived_sessions'].some(dir => contains(join(home, dir), staged))) {
              throw new Error('Codex 线程文件位于专用会话目录之外。')
            }
            const file = statSync(staged, {throwIfNoEntry: false})
            if ((file && !file.isFile()) || (!file && existsSync(join(source, relative(target, path))))) {
              throw new Error('Codex 线程文件未完整复制。')
            }
          }
          if (path) update.run(path, row.value)
        }
      }
      native.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { native.close() }
  }
}

// Called only after Host.close has drained runtimes, login helpers and SQLite. Source data is retained.
export function migrateDirectory(source: string, target: string, config: string) {
  validateMigration(source, target, config)
  if (source === target) return
  const existed = existsSync(target)
  mkdirSync(target, {recursive: true, mode: 0o700})
  // Stage under the selected directory: Windows retains its original ACL, and new files inherit it.
  const destination = canonical(target)
  const stage = mkdtempSync(join(target, '.nexus-migration-'))
  const published: string[] = []
  let complete = false
  let db: DatabaseSync | undefined
  try {
    // Refuse a source in use by another Host. Keep the lock through the entire copy.
    db = new DatabaseSync(join(source, 'nexus.sqlite'))
    db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA wal_checkpoint(TRUNCATE); BEGIN EXCLUSIVE')
    verifyDatabase(db)
    cpSync(source, stage, {recursive: true, preserveTimestamps: true, filter(path) {
      const entry = lstatSync(path)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('源数据含链接或特殊文件，请处理后再迁移。')
      }
      return path !== join(source, 'nexus.sqlite-shm')
    }})
    relocatePaths(stage, source, target)
    if (readdirSync(target).some(name => name !== basename(stage))) throw new Error('迁移期间目标目录已被其他程序写入。')
    const entries = readdirSync(stage).filter(name => name !== 'nexus.sqlite')
    // Publish the platform database last. A crash leaves the old profile and a recognizable stage.
    for (const name of [...entries, 'nexus.sqlite']) {
      const from = join(stage, name), to = join(target, name)
      if (existsSync(to)) throw new Error('迁移期间目标文件已存在。')
      if (statSync(from).isDirectory()) renameSync(from, to)
      else {
        copyFileSync(from, to, constants.COPYFILE_EXCL)
        unlinkSync(from)
      }
      published.push(name)
    }
    complete = true
  } finally {
    db?.close()
    // If publication failed midway, retain the verified private copy and all newly arrived files
    // for inspection. Never recursively delete a directory someone else could have populated.
    if (complete || !published.length) {
      if (dirname(canonical(stage)) !== destination || lstatSync(stage).isSymbolicLink()) {
        throw new Error('暂存目录位置已改变，已保留现场。')
      }
      rmSync(stage, {recursive: true, force: true, maxRetries: 3})
      if (!existed && !complete && !readdirSync(target).length) rmdirSync(target)
    }
  }
}
