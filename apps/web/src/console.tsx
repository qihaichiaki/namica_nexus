import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpRight, Cpu, Power, RefreshCw, Server, Settings2 } from 'lucide-react'
import { api, HostRequestError, request, useAction, useResource } from './data'
import type { HostConfig, HostStatus, Runtime } from './data'
import { HostForm, RuntimeForm, SettingsSection } from './console-settings'
import { Brand, Modal, Notice } from './ui'
import './shared.css'
import './console.css'

const statusPath = '/manage/host/status'
const pollInterval = 2000
const requestTimeout = 4000

function loadConsoleResource<T>(path: string) {
  return api<T>(path, 'GET', undefined, AbortSignal.timeout(requestTimeout))
}

async function readHostStatus() {
  const status = await loadConsoleResource<HostStatus>(statusPath)
  if (status?.service !== 'namica-nexus' || !status.instanceId || status.status !== 'running' ||
      !Number.isInteger(status.activeTurns) || status.activeTurns < 0) {
    throw new Error('无法确认此端口上的 Namica Nexus Host。')
  }
  return status
}

async function pollHostStatus() {
  const startedAt = performance.now()
  const host = await readHostStatus()
  return { host, startedAt }
}

function formatUptime(seconds: number) {
  if (seconds < 60) return Math.floor(seconds) + ' 秒'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + ' 分钟'
  return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分钟'
}

function HostFacts({ host }: { host: HostStatus }) {
  return <dl className="facts">
    <div><dt>活动任务</dt><dd><strong>{host.activeTurns}</strong> 个</dd></div>
    <div><dt>Host 版本</dt><dd><code>{host.version}</code></dd></div>
    <div><dt>运行时长</dt><dd>{formatUptime(host.uptimeSeconds)}</dd></div>
    <div><dt>监听地址</dt><dd><code>{host.address}:{host.port}</code></dd></div>
    <div><dt>日志等级</dt><dd><code>{host.logLevel}</code></dd></div>
    <div className="fact-wide"><dt>数据目录</dt><dd><code>{host.dataDirectory}</code></dd></div>
  </dl>
}

function ConsoleSettings({ refreshStatus }: { refreshStatus: () => void }) {
  const config = useResource<HostConfig>('/manage/host/config', loadConsoleResource)
  const runtimes = useResource<Runtime[]>('/manage/runtimes', loadConsoleResource)
  const error = config.error || runtimes.error
  useEffect(() => {
    const interval = window.setInterval(runtimes.refresh, 5000)
    return () => window.clearInterval(interval)
  }, [runtimes.refresh])

  return <>
    <SettingsSection title="Host 配置" icon={<Settings2 size={18}/>}>
      {error ?
        <div className="padded">
          <Notice notice={{ text: error, error: true }}/>
          <div className="form-actions"><button className="secondary" onClick={() => { config.refresh(); runtimes.refresh() }}>重试</button></div>
        </div> :
        config.data && runtimes.data ?
          <HostForm config={config.data} runtimes={runtimes.data} refresh={() => { config.refresh(); refreshStatus() }}/> :
          <p className="padded console-load" role="status">正在读取配置…</p>}
    </SettingsSection>
    {!runtimes.error && runtimes.data?.map(runtime =>
      <SettingsSection key={runtime.id} title="Runtime 配置" icon={<Cpu size={18}/>}>
        <RuntimeForm runtime={runtime} refresh={runtimes.refresh}/>
      </SettingsSection>)}
  </>
}

type Confirmation = Pick<HostStatus, 'instanceId' | 'activeTurns'> & { changed?: string }

function Console() {
  const status = useResource(statusPath, pollHostStatus)
  const latest = status.error ? undefined : status.data
  const host = latest?.host
  const [acceptedShutdown, setAcceptedShutdown] = useState<{ instanceId: string; acceptedAt: number }>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const shutdown = useAction()

  // A poll from before the acknowledgement can still describe a previous Host.
  const restarted = Boolean(acceptedShutdown && latest &&
    latest.startedAt > acceptedShutdown.acceptedAt && latest.host.instanceId !== acceptedShutdown.instanceId)
  const accepted = Boolean(acceptedShutdown && !restarted)
  const running = Boolean(host && !accepted)
  const connection = accepted ? 'accepted' : running ? 'online' : status.error ? 'offline' : 'connecting'
  const serviceLabel = accepted ? '关停请求已受理' : running ? '运行中' :
    status.error ? status.data ? '连接中断' : '无法连接 Host' : '正在连接 Host…'

  useEffect(() => {
    const interval = window.setInterval(status.refresh, pollInterval)
    window.addEventListener('online', status.refresh)
    window.addEventListener('focus', status.refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('online', status.refresh)
      window.removeEventListener('focus', status.refresh)
    }
  }, [status.refresh])
  useEffect(() => {
    if (restarted) setAcceptedShutdown(undefined)
  }, [restarted])

  const prepareShutdown = () => void shutdown.perform(async () => {
    try {
      const current = await readHostStatus()
      setConfirmation({ instanceId: current.instanceId, activeTurns: current.activeTurns })
    } finally {
      status.refresh()
    }
  })

  const confirmShutdown = () => void shutdown.perform(async () => {
    if (!confirmation) return
    const { instanceId, activeTurns } = confirmation
    try {
      const response = await request('/manage/host/shutdown', 'POST', { instanceId, activeTurns }, AbortSignal.timeout(requestTimeout))
      if (response.status !== 202) throw new Error('Host 未确认关停请求。')
      setAcceptedShutdown({ instanceId, acceptedAt: performance.now() })
      setConfirmation(undefined)
    } catch (error) {
      if (!(error instanceof HostRequestError) || error.status !== 409) throw error
      const current = await readHostStatus()
      const changed = current.instanceId !== instanceId ? 'Host 已重新启动。请再次确认。' : '活动任务状态已变化。请再次确认。'
      setConfirmation({ instanceId: current.instanceId, activeTurns: current.activeTurns, changed })
    } finally {
      status.refresh()
    }
  })

  return <div className="console">
    <header className="console-bar"><div className="console-bar-content">
      <a href="/console/" className="wordmark"><Brand/><span>Namica <strong>Nexus</strong></span></a>
      <a href="/" target="_blank" rel="noopener" className="secondary console-client" aria-label="在新标签页打开 Client">
        打开 Client<ArrowUpRight size={15} aria-hidden="true"/>
      </a>
    </div></header>
    <main className="console-main">
      <header className="console-heading"><h1><span className="page-icon"><Settings2 size={22}/></span>管理控制台</h1></header>
      <SettingsSection title="本地 Host" icon={<Server size={18}/>}>
        <div className="service-summary">
          <div className="service-state" role="status"><span className={'service-dot ' + connection}/>{serviceLabel}</div>
          <div className="service-actions">
            <button className="secondary" onClick={status.refresh}><RefreshCw size={14}/>刷新状态</button>
            <button className="secondary console-danger" disabled={!running || shutdown.pending} onClick={prepareShutdown}>
              <Power size={15}/>{shutdown.pending && !confirmation ? '正在读取任务…' : '停止服务'}
            </button>
          </div>
        </div>
        {running && host && <HostFacts host={host}/>}
        {accepted && <p className="console-feedback">双击 Namica Nexus 可重新启动服务，此页面会自动连接。</p>}
        {!accepted && status.error && <p className="console-feedback">{status.error} 页面会自动重试连接。</p>}
        {!confirmation && shutdown.notice && <div className="console-feedback"><Notice notice={shutdown.notice}/></div>}
      </SettingsSection>
      {running && host && <ConsoleSettings key={host.instanceId} refreshStatus={status.refresh}/>}
    </main>
    {confirmation && <Modal title="停止服务？" pending={shutdown.pending} close={() => setConfirmation(undefined)}>
      <div className="form-body shutdown-copy">
        <p>当前有 <strong>{confirmation.activeTurns}</strong> 个活动任务。</p>
        <p>{confirmation.activeTurns > 0 && '关停会中断这些任务，并保留已生成的回复。'}Client 将断开连接。</p>
        {confirmation.changed && <p role="status">{confirmation.changed}</p>}
        <Notice notice={shutdown.notice}/>
      </div>
      <div className="modal-actions">
        <button className="secondary" disabled={shutdown.pending} autoFocus onClick={() => setConfirmation(undefined)}>取消</button>
        <button className="primary confirm-stop" disabled={shutdown.pending} onClick={confirmShutdown}>
          <Power size={15}/>{shutdown.pending ? '正在提交…' : '确认停止'}
        </button>
      </div>
    </Modal>}
  </div>
}

createRoot(document.getElementById('root')!).render(<Console />)
