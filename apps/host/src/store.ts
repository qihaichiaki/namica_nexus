import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  HostConfig, Identity, Message, Runtime, Session, SessionSnapshot, ToolActivity, Turn, TurnStatus,
} from '../../../packages/protocol/src/index.js'

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}

const timestamp = () => new Date().toISOString()
const defaultConfig: HostConfig = { logLevel: 'info', executionTimeoutSeconds: 600, defaultRuntimeId: 'codex' }
export type IdentityFields = Pick<Identity, 'name' | 'description' | 'avatar' | 'workspace' | 'personality' | 'runtimeConfigId'>
export type RuntimeFields = Pick<Runtime, 'enabled' | 'executable' | 'workspace' | 'model' | 'proxyUrl'>
type StoredSession = Session & { instructions: string; workspace: string }

export class Store {
  private db: DatabaseSync
  private defaultWorkspace: string

  constructor(directory: string) {
    this.defaultWorkspace = join(directory, 'workspace')
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(join(directory, 'nexus.sqlite'))
    try {
      // One Host owns a database. A second process must never recover the first one's active turns.
      this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS hostConfig (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtimes (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          sessionId TEXT PRIMARY KEY, identityId TEXT NOT NULL REFERENCES identities,
          runtimeConfigId TEXT NOT NULL REFERENCES runtimes, runtimeSessionId TEXT,
          personalityVersion INTEGER NOT NULL, instructions TEXT NOT NULL, workspace TEXT NOT NULL,
          title TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns (
          turnId TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions, status TEXT NOT NULL, error TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn ON turns(sessionId) WHERE status='running';
        CREATE TABLE IF NOT EXISTS messages (
          messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions, turnId TEXT NOT NULL REFERENCES turns,
          role TEXT NOT NULL, content TEXT NOT NULL, sequence INTEGER NOT NULL, createdAt TEXT NOT NULL,
          status TEXT NOT NULL, UNIQUE(sessionId, sequence));
        CREATE TABLE IF NOT EXISTS tools (
          id TEXT NOT NULL, turnId TEXT NOT NULL REFERENCES turns, label TEXT NOT NULL,
          status TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(turnId, id));
        CREATE INDEX IF NOT EXISTS turn_session ON turns(sessionId);
        CREATE INDEX IF NOT EXISTS tool_turn ON tools(turnId);`)
      const runtime: Runtime = {
        id: 'codex', type: 'codex', enabled: true, executable: 'codex', workspace: '',
        model: '', proxyUrl: '', available: null, version: null, detail: '', processState: 'idle',
      }
      this.tx(() => {
        this.run('INSERT OR IGNORE INTO runtimes VALUES (?,?)', runtime.id, JSON.stringify(runtime))
        this.run("UPDATE runtimes SET json=json_set(json,'$.proxyUrl','') WHERE json_type(json,'$.proxyUrl') IS NULL")
        if (this.one<{user_version: number}>('PRAGMA user_version').user_version === 0) {
          this.migrateLegacyWorkspaces()
          this.db.exec('PRAGMA user_version=1')
        }
        this.run('INSERT OR IGNORE INTO hostConfig VALUES (1,?)', JSON.stringify(defaultConfig))
        this.run("UPDATE turns SET status='interrupted',error='Host stopped before this turn finished.' WHERE status='running'")
        this.run("UPDATE messages SET status='interrupted' WHERE status='running'")
        this.run("UPDATE tools SET status='interrupted' WHERE status='running'")
        this.run("UPDATE sessions SET status='interrupted',updatedAt=? WHERE status='running'", timestamp())
      })
    } catch (error) { this.db.close(); throw error }
  }

  close() { this.db.close() }
  private migrateLegacyWorkspaces() {
    // Earlier releases froze the generated absolute path. Only the exact known defaults
    // can be safely identified when opening a copied database, including on first upgrade.
    const oldDataRoot = process.env.LOCALAPPDATA || join(homedir(), '.local', 'share')
    const candidates = new Set([this.defaultWorkspace, join(oldDataRoot, 'NamicaNexus', 'workspace')])
    for (const path of candidates) {
      this.run("UPDATE runtimes SET json=json_set(json,'$.workspace','') WHERE json_extract(json,'$.workspace')=?", path)
      this.run(`UPDATE sessions SET workspace='' WHERE workspace=? AND NOT EXISTS (
        SELECT 1 FROM identities WHERE identities.id=sessions.identityId
          AND json_extract(identities.json,'$.workspace')=sessions.workspace)`, path)
    }
  }
  private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args) }
  private rows<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).all(...args) as unknown as T[]
  }
  private one<T>(sql: string, ...args: SQLInputValue[]): T {
    const row = this.db.prepare(sql).get(...args)
    if (!row) throw new HttpError(404, 'Resource not found.')
    return row as unknown as T
  }
  private tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = action()
      this.db.exec('COMMIT')
      return value
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  config(): HostConfig { return JSON.parse(this.one<{json: string}>('SELECT json FROM hostConfig WHERE id=1').json) }
  saveConfig(config: HostConfig) {
    this.runtime(config.defaultRuntimeId)
    this.run('UPDATE hostConfig SET json=? WHERE id=1', JSON.stringify(config))
    return config
  }
  private resolveRuntime(runtime: Runtime): Runtime {
    return {...runtime, workspace: runtime.workspace || this.defaultWorkspace}
  }
  private storedRuntime(id: string): Runtime {
    return JSON.parse(this.one<{json: string}>('SELECT json FROM runtimes WHERE id=?', id).json)
  }
  runtimes(): Runtime[] {
    return this.rows<{json: string}>('SELECT json FROM runtimes').map(r => this.resolveRuntime(JSON.parse(r.json)))
  }
  runtime(id: string) { return this.resolveRuntime(this.storedRuntime(id)) }
  saveRuntime(runtime: Runtime) {
    // API clients post the displayed absolute path back when saving unrelated settings.
    const previousWorkspace = this.storedRuntime(runtime.id).workspace
    const workspace = !previousWorkspace && runtime.workspace === this.defaultWorkspace ? '' : runtime.workspace
    const stored = {...runtime, workspace}
    this.run('UPDATE runtimes SET json=? WHERE id=?', JSON.stringify(stored), runtime.id)
    return this.resolveRuntime(stored)
  }
  identities(): Identity[] { return this.rows<{json: string}>('SELECT json FROM identities ORDER BY rowid').map(r => JSON.parse(r.json)) }
  identity(id: string): Identity { return JSON.parse(this.one<{json: string}>('SELECT json FROM identities WHERE id=?', id).json) }
  saveIdentity(fields: IdentityFields, previous?: Identity) {
    this.runtime(fields.runtimeConfigId)
    const now = timestamp()
    const changed = !previous || previous.name !== fields.name || previous.description !== fields.description || previous.personality !== fields.personality
    const identity: Identity = {
      ...fields, id: previous?.id ?? randomUUID(), personalityVersion: (previous?.personalityVersion ?? 0) + Number(changed),
      createdAt: previous?.createdAt ?? now, updatedAt: now,
    }
    this.run('INSERT INTO identities VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', identity.id, JSON.stringify(identity))
    return identity
  }
  sessions(identityId?: string) {
    const select = `SELECT sessionId,identityId,runtimeConfigId,runtimeSessionId,personalityVersion,
                    COALESCE(NULLIF(title,''),'新会话') AS title,status,createdAt,updatedAt
                    FROM sessions`
    return identityId === undefined
      ? this.rows<Session>(select + ' ORDER BY updatedAt DESC, rowid DESC')
      : this.rows<Session>(select + ' WHERE identityId=? ORDER BY updatedAt DESC, rowid DESC', identityId)
  }
  storedSession(id: string) {
    const session = this.one<StoredSession>('SELECT * FROM sessions WHERE sessionId=?', id)
    return {...session, workspace: session.workspace || this.defaultWorkspace}
  }
  session(id: string): Session {
    const {instructions, workspace, ...session} = this.storedSession(id)
    return { ...session, title: session.title || '新会话' }
  }
  createSession(identityId: string, title = '') {
    const identity = this.identity(identityId)
    const runtime = this.storedRuntime(identity.runtimeConfigId)
    const id = randomUUID(), now = timestamp()
    const instructions = [
      'Nexus identity: ' + identity.name, identity.description, identity.personality,
    ].filter(Boolean).join('\n\n')
    this.run(`INSERT INTO sessions
      (sessionId,identityId,runtimeConfigId,personalityVersion,instructions,workspace,title,status,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,'idle',?,?)`,
      id, identityId, runtime.id, identity.personalityVersion, instructions, identity.workspace || runtime.workspace, title, now, now)
    return this.session(id)
  }
  snapshot(id: string): SessionSnapshot {
    return {
      session: this.session(id),
      messages: this.rows<Message>('SELECT * FROM messages WHERE sessionId=? ORDER BY sequence', id),
      turns: this.rows<Turn>('SELECT * FROM turns WHERE sessionId=? ORDER BY rowid', id),
      tools: this.rows<ToolActivity>('SELECT tools.* FROM tools JOIN turns USING(turnId) WHERE sessionId=? ORDER BY tools.rowid', id),
      approvals: [],
    }
  }
  beginTurn(sessionId: string, content: string): Turn {
    const session = this.session(sessionId)
    if (session.status === 'running') throw new HttpError(409, 'This session already has an active turn.')
    const turn: Turn = { turnId: randomUUID(), sessionId, status: 'running', error: null }
    const now = timestamp()
    this.tx(() => {
      const {next} = this.one<{next: number}>('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE sessionId=?', sessionId)
      this.run('INSERT INTO turns VALUES (?,?,?,NULL)', turn.turnId, sessionId, turn.status)
      const insert = 'INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)'
      this.run(insert, randomUUID(), sessionId, turn.turnId, 'user', content, next, now, 'completed')
      this.run(insert, randomUUID(), sessionId, turn.turnId, 'assistant', '', next + 1, now, 'running')
      const firstLine = content.trim().split(/[\r\n]/, 1)[0]
      const title = Array.from(firstLine).slice(0, 40).join('')
      this.run(`UPDATE sessions SET status='running',updatedAt=?,title=COALESCE(NULLIF(title,''),?)
        WHERE sessionId=?`, now, title, sessionId)
    })
    return turn
  }
  mapSession(sessionId: string, runtimeSessionId: string) {
    this.run('UPDATE sessions SET runtimeSessionId=? WHERE sessionId=?', runtimeSessionId, sessionId)
  }
  writeReply(turnId: string, content: string) {
    this.run("UPDATE messages SET content=? WHERE turnId=? AND role='assistant' AND status='running'", content, turnId)
  }
  recordTool(turnId: string, id: string, label: string, status: ToolActivity['status'], detail = '') {
    this.run(`INSERT INTO tools VALUES (?,?,?,?,?) ON CONFLICT(turnId,id)
      DO UPDATE SET status=excluded.status,label=excluded.label,detail=excluded.detail`, id, turnId, label, status, detail)
  }
  finish(turn: Turn, status: Exclude<TurnStatus, 'running'>, reason: string | null) {
    this.tx(() => {
      this.run('UPDATE turns SET status=?, error=? WHERE turnId=?', status, reason, turn.turnId)
      this.run("UPDATE messages SET status=? WHERE turnId=? AND role='assistant'", status, turn.turnId)
      this.run("UPDATE tools SET status='interrupted' WHERE turnId=? AND status='running'", turn.turnId)
      this.run('UPDATE sessions SET status=?, updatedAt=? WHERE sessionId=?', status, timestamp(), turn.sessionId)
    })
  }
}
