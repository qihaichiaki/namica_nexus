import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpRight, Cpu, Power, RefreshCw, RotateCcw, Server, Settings2 } from 'lucide-react'
import { HostRequestError, request, useAction, useResource } from './data'
import type { HostConfig, HostStatus, Runtime } from './data'
import { deploymentPath, formatListener, readConsoleResource, readHostStatus, requestTimeout, statusPath } from './console-data'
import type { Deployment } from './console-data'
import { DeploymentSection } from './console-deployment'
import { CodexAuth, HostLogs } from './console-operations'
import { clearRestartNavigation, consoleUrl, readRestartResult, rememberRestart, restartExpired, restartNavigationUrl, restoreRestart } from './console-restart'
import type { RestartAttempt } from './console-restart'
import { HostForm, RuntimeForm, SettingsSection } from './console-settings'
import { Brand, Modal, Notice } from './ui'
import './shared.css'
import './console.css'

const pollInterval = 2000

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
    <div><dt>监听地址</dt><dd><code>{formatListener(host.address, host.port)}</code></dd></div>
    <div><dt>日志等级</dt><dd><code>{host.logLevel}</code></dd></div>
    <div className="fact-wide"><dt>数据目录</dt><dd><code>{host.dataDirectory}</code></dd></div>
  </dl>
}

function ConsoleSettings({ activeTurns, prepareRestart, restartBusy, refreshStatus }: {
  activeTurns: number
  prepareRestart: () => void
  restartBusy: boolean
  refreshStatus: () => void
}) {
  const config = useResource<HostConfig>('/manage/host/config', readConsoleResource)
  const runtimes = useResource<Runtime[]>('/manage/runtimes', readConsoleResource)
  const [authRevision, setAuthRevision] = useState(0)
  const error = config.error || runtimes.error
  useEffect(() => {
    const interval = window.setInterval(runtimes.refresh, 5000)
    return () => window.clearInterval(interval)
  }, [runtimes.refresh])

  return <>
    <CodexAuth activeTurns={activeTurns} runtimeRevision={authRevision} refreshRuntime={runtimes.refresh}/>
    <DeploymentSection restart={prepareRestart} restartBusy={restartBusy}/>
    <SettingsSection id="host-settings" title="Host 配置" icon={<Settings2 size={18}/>}>
      {error && <div className="padded">
        <Notice notice={{ text: error, error: true }}/>
        <div className="form-actions"><button className="secondary" onClick={() => { config.refresh(); runtimes.refresh() }}>重试</button></div>
      </div>}
      {config.data && runtimes.data ? <HostForm config={config.data} runtimes={runtimes.data} refresh={() => { config.refresh(); refreshStatus() }}/> :
        !error && <p className="padded console-load" role="status">正在读取配置…</p>}
    </SettingsSection>
    {runtimes.data?.map(runtime =>
      <SettingsSection key={runtime.id} title="Runtime 配置" icon={<Cpu size={18}/>}>
        <RuntimeForm runtime={runtime} refresh={() => { runtimes.refresh(); setAuthRevision(value => value + 1) }}/>
      </SettingsSection>)}
    <HostLogs/>
  </>
}

type Operation = 'restart' | 'shutdown'
type Confirmation = Pick<HostStatus, 'instanceId' | 'activeTurns'> & {
  operation: Operation
  deployment?: Deployment
  changed?: string
}

function makeConfirmation(operation: Operation, host: HostStatus, deployment?: Deployment, changed?: string): Confirmation {
  return { operation, instanceId: host.instanceId, activeTurns: host.activeTurns, deployment, changed }
}

function sameLaunchSettings(left: Deployment['pending'] | undefined, right: Deployment['pending']) {
  return left?.address === right.address && left.port === right.port && left.dataDirectory === right.dataDirectory
}

function Console() {
  const status = useResource(statusPath, pollHostStatus)
  const latest = status.error ? undefined : status.data
  const host = latest?.host
  const [acceptedShutdown, setAcceptedShutdown] = useState<{ instanceId: string; acceptedAt: number }>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [restart, setRestart] = useState(restoreRestart)
  const [restartDelayed, setRestartDelayed] = useState(false)
  const [restartNotice, setRestartNotice] = useState<{ text: string; error: boolean; target?: string }>()
  const lifecycle = useAction()

  // A poll from before the acknowledgement can still describe a previous Host.
  const reopened = Boolean(acceptedShutdown && latest &&
    latest.startedAt > acceptedShutdown.acceptedAt && latest.host.instanceId !== acceptedShutdown.instanceId)
  const stopped = Boolean(acceptedShutdown && !reopened)
  const running = Boolean(host && !stopped && !restart)
  const connection = restart || stopped ? 'accepted' : running ? 'online' : status.error ? 'offline' : 'connecting'
  const serviceLabel = restart ? '正在重启 Host…' : stopped ? '关停请求已受理' : running ? '运行中' :
    status.error ? status.data ? '连接中断' : '无法连接 Host' : '正在连接 Host…'

  useEffect(clearRestartNavigation, [])
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
    if (reopened) setAcceptedShutdown(undefined)
  }, [reopened])
  useEffect(() => {
    if (!restart) return
    let stopped = false
    let next: number | undefined
    const delayed = window.setTimeout(() => setRestartDelayed(true), Math.max(0, restart.startedAt + 30000 - Date.now()))
    const check = async () => {
      const outcome = await readRestartResult(restart)
      if (stopped) return
      const destination = restartNavigationUrl(restart)
      if (outcome?.status === 'ready' && destination && consoleUrl(outcome.consoleUrl)?.origin !== location.origin) {
        rememberRestart()
        location.replace(destination)
        return
      }
      if (outcome || restartExpired(restart)) {
        setRestartNotice(outcome?.status === 'ready' ? { text: 'Host 已重新启动。', error: false } : {
          text: outcome?.error || (outcome?.status === 'failed' ?
            '新设置启动失败，Host 已在原地址恢复。可在启动设置查看原因并修改后重试。' :
            '仍未确认 Host 的启动结果。请刷新原地址，或尝试打开目标 Console。'),
          error: true,
          target: outcome ? undefined : destination,
        })
        rememberRestart()
        setRestart(undefined)
        status.refresh()
        return
      }
      next = window.setTimeout(() => void check(), 1000)
    }
    void check()
    return () => {
      stopped = true
      window.clearTimeout(next)
      window.clearTimeout(delayed)
    }
  }, [restart, status.refresh])

  const prepare = (operation: Operation) => void lifecycle.perform(async () => {
    setRestartNotice(undefined)
    try {
      const [current, deployment] = await Promise.all([
        readHostStatus(),
        operation === 'restart' ? readConsoleResource<Deployment>(deploymentPath) : undefined,
      ])
      setConfirmation(makeConfirmation(operation, current, deployment))
    } finally {
      status.refresh()
    }
  })

  const confirm = () => void lifecycle.perform(async () => {
    if (!confirmation) return
    const { operation, instanceId, activeTurns, deployment } = confirmation
    try {
      const response = await request('/manage/host/' + operation, 'POST', {
        instanceId, activeTurns, ...(operation === 'restart' && { expectedPending: deployment?.pending }),
      }, AbortSignal.timeout(requestTimeout))
      if (response.status !== 202) throw new Error('Host 未确认操作请求。')
      if (operation === 'restart') {
        const result = await response.json() as Pick<RestartAttempt, 'consoleUrl' | 'restartId'>
        if (!consoleUrl(result.consoleUrl) || !result.restartId) throw new Error('Host 未返回可确认的重启地址。')
        const attempt = { ...result, instanceId, startedAt: Date.now() }
        rememberRestart(attempt)
        setRestartDelayed(false)
        setRestart(attempt)
      } else {
        setAcceptedShutdown({ instanceId, acceptedAt: performance.now() })
      }
      setConfirmation(undefined)
    } catch (error) {
      if (!(error instanceof HostRequestError) || error.status !== 409) throw error
      const [current, nextDeployment] = await Promise.all([
        readHostStatus().catch(() => undefined),
        operation === 'restart' ? readConsoleResource<Deployment>(deploymentPath).catch(() => undefined) : undefined,
      ])
      if (!current || (operation === 'restart' && !nextDeployment)) throw error
      const changed = current.instanceId !== instanceId ? 'Host 实例已变化。' :
        current.activeTurns !== activeTurns ? '活动任务数已变化。' :
        nextDeployment && !sameLaunchSettings(deployment?.pending, nextDeployment.pending) ? '下次启动设置已变化。' : undefined
      if (!changed) throw error
      setConfirmation(makeConfirmation(operation, current, nextDeployment, changed + '请再次确认。'))
    } finally {
      status.refresh()
    }
  })

  const restarting = confirmation?.operation === 'restart'
  const destination = confirmation?.deployment?.pending
  const migrating = destination && destination.dataDirectory !== confirmation?.deployment?.active.dataDirectory

  return <div className="console">
    <header className="console-bar"><div className="console-bar-content">
      <a href="/console/" className="wordmark"><Brand/><span>Namica <strong>Nexus</strong></span></a>
      {!restart && <a href="/" target="_blank" rel="noopener" className="secondary console-client" aria-label="在新标签页打开 Client">
        打开 Client<ArrowUpRight size={15} aria-hidden="true"/>
      </a>}
    </div></header>
    <main className="console-main">
      <header className="console-heading">
        <h1><span className="page-icon"><Settings2 size={22}/></span>管理控制台</h1>
        {status.data && !stopped && !restart && <nav className="console-nav" aria-label="管理控制台分区">
          <a href="#codex">Codex 登录</a><a href="#deployment">启动设置</a><a href="#host-settings">Host 配置</a><a href="#logs">Host 日志</a>
        </nav>}
      </header>
      <SettingsSection title="本地 Host" icon={<Server size={18}/>}>
        <div className="service-summary">
          <div className="service-state" role="status"><span className={'service-dot ' + connection}/>{serviceLabel}</div>
          <div className="service-actions">
            <button className="secondary" onClick={status.refresh}><RefreshCw size={14}/>刷新状态</button>
            <button className="secondary" disabled={!running || lifecycle.pending} onClick={() => prepare('restart')}><RotateCcw size={15}/>重启服务</button>
            <button className="secondary console-danger" disabled={!running || lifecycle.pending} onClick={() => prepare('shutdown')}>
              <Power size={15}/>停止服务
            </button>
          </div>
        </div>
        {running && host && <HostFacts host={host}/>}
        {restart && <div className="console-feedback" role="status">
          <p>{restartDelayed ? 'Host 仍未报告启动结果，页面会继续检查。' : '正在等待启动结果。就绪后会连接到新的 Host。'}</p>
          <p>目标 Console <code>{restart.consoleUrl}</code></p>
          {restartDelayed && <a href={restartNavigationUrl(restart)} target="_blank" rel="noopener">在新标签页尝试打开目标 Console</a>}
        </div>}
        {stopped && <p className="console-feedback">双击 Namica Nexus 可重新启动服务，此页面会自动连接。</p>}
        {!stopped && !restart && status.error && <p className="console-feedback">{status.error} 页面会自动重试连接。</p>}
        {!confirmation && (lifecycle.notice || restartNotice) && <div className="console-feedback">
          <Notice notice={lifecycle.notice ?? restartNotice ?? null}/>
          {restartNotice?.target && <a href={restartNotice.target} target="_blank" rel="noopener">在新标签页尝试打开目标 Console</a>}
          {restartNotice?.error && running && <a href="#deployment">返回启动设置</a>}
        </div>}
        {lifecycle.pending && !confirmation && <p className="console-feedback" role="status">正在读取当前 Host 状态…</p>}
      </SettingsSection>
      {status.data && !stopped && !restart && <ConsoleSettings key={status.data.host.instanceId}
        activeTurns={status.data.host.activeTurns} refreshStatus={status.refresh} prepareRestart={() => prepare('restart')}
        restartBusy={!running || lifecycle.pending}/>}
    </main>
    {confirmation && <Modal title={restarting ? '重启服务？' : '停止服务？'} pending={lifecycle.pending} close={() => setConfirmation(undefined)}>
      <div className="form-body shutdown-copy">
        <p>当前有 <strong>{confirmation.activeTurns}</strong> 个活动任务。</p>
        <p>{confirmation.activeTurns > 0 && '此操作会中断这些任务，并保留已生成的回复。'}{restarting ? 'Client 会暂时断开，请在重启后重新连接。' : 'Client 将断开连接。'}</p>
        {destination && <p>重启后监听 <code>{formatListener(destination.address, destination.port)}</code>，数据目录为 <code>{destination.dataDirectory}</code>。{migrating && '将复制现有数据并保留原目录。'}</p>}
        {restarting && <p className="help">更新程序时，请先停止服务，再双击启动新版 Namica Nexus。</p>}
        {confirmation.changed && <p role="status">{confirmation.changed}</p>}
        <Notice notice={lifecycle.notice}/>
      </div>
      <div className="modal-actions">
        <button className="secondary" disabled={lifecycle.pending} autoFocus onClick={() => setConfirmation(undefined)}>取消</button>
        <button className={'primary' + (confirmation.activeTurns > 0 || !restarting ? ' confirm-stop' : '')} disabled={lifecycle.pending} onClick={confirm}>
          {restarting ? <RotateCcw size={15}/> : <Power size={15}/>}
          {lifecycle.pending ? '正在提交…' : restarting ? '确认重启' : '确认停止'}
        </button>
      </div>
    </Modal>}
  </div>
}

createRoot(document.getElementById('root')!).render(<Console />)
