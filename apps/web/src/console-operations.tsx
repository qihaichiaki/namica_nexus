import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, ClipboardList, KeyRound, RefreshCw } from 'lucide-react'
import { api, useAction, useResource } from './data'
import type { LogLevel } from './data'
import { readConsoleResource, requestTimeout } from './console-data'
import { SettingsSection } from './console-settings'
import { Field, Modal, Notice } from './ui'

const authPath = '/manage/auth/codex'
type AuthMethod = 'browser' | 'device'
const deviceHelp = '使用设备码前，请在 ChatGPT 安全设置启用 Codex 设备码授权。组织账号可能需要管理员先启用。'

interface CodexStatus {
  state: 'signed-in' | 'signed-out' | 'pending' | 'unknown'
  account?: string
  method?: AuthMethod
  verificationUrl?: string
  userCode?: string
  detail?: string
}

const authLabels: Record<CodexStatus['state'], string> = {
  'signed-in': '已登录',
  'signed-out': '未登录',
  pending: '等待官方授权',
  unknown: '登录状态待确认',
}

async function readCodexStatus(path: string) {
  const startedAt = performance.now()
  return { startedAt, status: await readConsoleResource<CodexStatus>(path) }
}

function officialVerificationUrl(auth: CodexStatus) {
  if (!auth.verificationUrl) return
  try {
    const url = new URL(auth.verificationUrl)
    if (url.origin !== 'https://auth.openai.com' || url.username || url.password || url.hash) return
    if (auth.method === 'device' && url.pathname === '/codex/device' && !url.search) return url.href
    if (auth.method === 'browser' && url.pathname === '/oauth/authorize' && url.search) return url.href
  } catch {
    // The Host only returns an official OpenAI authorization URL.
  }
}

export function CodexAuth({ activeTurns, runtimeRevision, refreshRuntime }: {
  activeTurns: number
  runtimeRevision: number
  refreshRuntime: () => void
}) {
  const resource = useResource(authPath, readCodexStatus)
  const [latestAction, setLatestAction] = useState<{ receivedAt: number; status: CodexStatus }>()
  const [confirm, setConfirm] = useState<'switch' | 'logout'>()
  const [method, setMethod] = useState<AuthMethod>('browser')
  const [completed, setCompleted] = useState<string>()
  const action = useAction()
  const auth = latestAction && (!resource.data || resource.data.startedAt <= latestAction.receivedAt) ? latestAction.status : resource.data?.status
  const waiting = auth?.state === 'pending'
  const busy = activeTurns > 0
  const authorizationUrl = waiting ? officialVerificationUrl(auth) : undefined

  useEffect(() => {
    const timer = waiting ? window.setInterval(resource.refresh, 2000) : undefined
    window.addEventListener('focus', resource.refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', resource.refresh)
    }
  }, [waiting, resource.refresh])

  useEffect(() => {
    if (auth?.state === 'signed-in' || auth?.state === 'signed-out') refreshRuntime()
  }, [auth?.state, refreshRuntime])
  useEffect(() => {
    if (runtimeRevision > 0) resource.refresh()
  }, [runtimeRevision, resource.refresh])

  const manage = (operation: 'login' | 'cancel' | 'logout', method: AuthMethod = 'browser') => void action.perform(async () => {
    setCompleted(undefined)
    try {
      const status = await api<CodexStatus>(authPath + '/' + operation, 'POST',
        operation === 'login' ? { method } : {}, AbortSignal.timeout(20000))
      setLatestAction({ receivedAt: performance.now(), status })
      if (status.state === 'unknown' || (operation === 'logout' && status.state !== 'signed-out') ||
          (operation === 'cancel' && status.state === 'pending')) {
        throw new Error(status.detail || '暂时无法确认操作结果，请刷新状态。')
      }
      if (operation === 'cancel') setCompleted('已取消授权。')
      if (operation === 'logout') setCompleted('已退出 Nexus 的 Codex 授权。')
      if (status.state !== 'pending') refreshRuntime()
      setConfirm(undefined)
    } finally {
      resource.refresh()
    }
  })

  return <SettingsSection id="codex" title="Codex 独立登录" icon={<KeyRound size={18}/>}>
    <div className="padded auth-body">
      <div className="auth-head">
        <p className="auth-state" role="status">
          <span className={'service-dot ' + (auth?.state === 'signed-in' ? 'online' : waiting ? 'accepted' : '')}/>
          {auth ? authLabels[auth.state] : resource.error ? '无法读取登录状态' : '正在读取登录状态…'}
          {auth?.account && <small>{auth.account}</small>}
        </p>
        <button className="secondary" disabled={action.pending} onClick={resource.refresh}><RefreshCw size={14}/>刷新登录状态</button>
      </div>
      <p className="console-description">Nexus 使用当前数据目录的独立 Codex 授权。账号凭据由官方 Codex 管理，请在 OpenAI 官方页面完成授权。</p>
      {auth?.state === 'signed-out' && <p className="help">{deviceHelp}</p>}
      {resource.error && <Notice notice={{ text: resource.error, error: true }}/>}
      {auth?.detail && <p className="help">{auth.detail}</p>}
      {busy && <p className="help">有活动任务时，登录和退出操作需等任务结束。</p>}
      {waiting && <div className="device-panel">
        {authorizationUrl && (auth.method !== 'device' || auth.userCode) ? <>
          {auth.method === 'device' && auth.userCode ? <div><p>一次性授权码</p><code className="device-code">{auth.userCode}</code>
            <p className="help">{deviceHelp}</p></div> :
            <p>在 OpenAI 完成授权后，返回这里查看结果。</p>}
          <a className="primary" href={authorizationUrl} target="_blank" rel="noopener noreferrer">
            打开 OpenAI 授权页<ArrowUpRight size={15}/>
          </a>
        </> : <p role="status">正在等待 Runtime 提供官方授权信息。可刷新状态或取消本次授权。</p>}
      </div>}
      {!confirm && <Notice notice={action.notice ?? (completed ? { text: completed, error: false } : null)}/>}
      {auth && <div className="form-actions">
        {waiting && <button className="secondary" disabled={action.pending} onClick={() => manage('cancel')}>取消授权</button>}
        {auth.state === 'signed-in' && <>
          <button className="secondary console-danger" disabled={action.pending || busy || !!resource.error} onClick={() => setConfirm('logout')}>退出登录</button>
          <button className="primary" disabled={action.pending || busy || !!resource.error} onClick={() => { setMethod('browser'); setConfirm('switch') }}>更换账号</button>
        </>}
        {auth.state === 'unknown' && <button className="primary" disabled={action.pending || busy || !!resource.error}
          onClick={() => { setMethod('browser'); setConfirm('switch') }}>重新授权</button>}
        {auth.state === 'signed-out' && <>
          <button className="secondary" disabled={action.pending || busy || !!resource.error} onClick={() => manage('login', 'device')}>使用设备码</button>
          <button className="primary" disabled={action.pending || busy || !!resource.error} onClick={() => manage('login')}>
            <KeyRound size={15}/>{action.pending ? '正在启动授权…' : '通过 OpenAI 登录'}
          </button>
        </>}
      </div>}
    </div>
    {confirm && <Modal title={confirm === 'logout' ? '退出 Nexus 的 Codex 登录？' : '更换 Nexus 的 Codex 账号？'}
      pending={action.pending} close={() => setConfirm(undefined)}>
      <div className="form-body shutdown-copy">
        <p>{confirm === 'logout' ?
          '退出后，Nexus 需要重新授权才能通过 Codex 开始新任务。已有聊天记录和身份会保留。' :
          '授权成功后，新任务将使用新的 Codex 账号。已有聊天记录和身份会保留。如果原会话无法继续，请为原身份新建会话。'}</p>
        {confirm === 'switch' && <Field title="授权方式" hint={method === 'device' ? deviceHelp : undefined}>{id => <select id={id} value={method} disabled={action.pending}
          onChange={event => setMethod(event.currentTarget.value as AuthMethod)}>
          <option value="browser">浏览器登录</option><option value="device">设备码</option>
        </select>}</Field>}
        {busy && <p role="status">任务已开始，请等待活动任务结束。</p>}
        <Notice notice={action.notice}/>
      </div>
      <div className="modal-actions">
        <button className="secondary" disabled={action.pending} autoFocus onClick={() => setConfirm(undefined)}>取消</button>
        <button className={'primary' + (confirm === 'logout' ? ' confirm-stop' : '')} disabled={action.pending || busy}
          onClick={() => manage(confirm === 'logout' ? 'logout' : 'login', method)}>
          {action.pending ? '正在提交…' : confirm === 'logout' ? '确认退出' : '开始更换账号'}
        </button>
      </div>
    </Modal>}
  </SettingsSection>
}

interface JournalEntry {
  time: string
  level: LogLevel
  message: string
}

const logLevels: LogLevel[] = ['debug', 'info', 'warn', 'error']
const logTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false })

function formatLogTime(time: string) {
  const date = new Date(time)
  return Number.isNaN(date.valueOf()) ? time : logTime.format(date)
}

export function HostLogs() {
  const action = useAction()
  const [journal, setJournal] = useState<JournalEntry[]>()
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const entries = journal?.filter(entry => level === 'all' || entry.level === level)
  const { perform } = action
  const refresh = useCallback(() => void perform(async () => {
    const result = await readConsoleResource<{ entries: JournalEntry[] }>('/manage/logs')
    setJournal(result.entries)
  }), [perform])

  useEffect(refresh, [refresh])

  return <SettingsSection id="logs" title="Host 日志" icon={<ClipboardList size={18}/>}>
    <div className="padded log-body">
      <div className="log-tools">
        <p className="console-description">当前 Host 启动以来最多保留 200 条事件，按记录时的日志等级写入，最新事件在前。重启后重新记录。</p>
        <div className="log-controls">
          <Field title="筛选日志级别">{id => <select id={id} value={level} onChange={event => setLevel(event.currentTarget.value as typeof level)}>
            <option value="all">全部级别</option>
            {logLevels.map(value => <option key={value}>{value}</option>)}
          </select>}</Field>
          <button className="secondary" disabled={action.pending} onClick={refresh}><RefreshCw size={14} className={action.pending ? 'spin' : undefined}/>
            {action.pending ? '正在刷新…' : '刷新日志'}
          </button>
        </div>
      </div>
      <Notice notice={action.notice}/>
      {!action.notice && !entries && <p className="console-load" role="status">正在读取日志…</p>}
      {entries?.length === 0 && <p className="log-empty" role="status">
        {journal?.length ? '没有此级别的日志。' : '当前没有已记录的日志。'}
      </p>}
      {!!entries?.length && <div className="journal" tabIndex={0} role="region" aria-label="日志列表">
        <table>
          <thead><tr><th scope="col">本机时间</th><th scope="col">级别</th><th scope="col">事件</th></tr></thead>
          <tbody>{entries.map((entry, index) => <tr key={entry.time + '-' + index}>
            <td><time dateTime={entry.time}>{formatLogTime(entry.time)}</time></td>
            <td><span className={'log-level ' + entry.level}>{entry.level}</span></td>
            <td>{entry.message}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </div>
  </SettingsSection>
}
