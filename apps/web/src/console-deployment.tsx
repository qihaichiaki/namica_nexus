import { useState } from 'react'
import type { FormEvent } from 'react'
import { HardDrive, Pencil, RotateCcw, Save } from 'lucide-react'
import { api, useAction, useResource } from './data'
import { deploymentPath, formatListener, readConsoleResource } from './console-data'
import type { Deployment, LaunchSettings } from './console-data'
import { DirectoryField } from './console-directory'
import { SettingsSection } from './console-settings'
import { Field, Notice } from './ui'

function changedSettings(active: LaunchSettings, pending: LaunchSettings): Partial<LaunchSettings> {
  return {
    ...(active.address !== pending.address && { address: pending.address }),
    ...(active.port !== pending.port && { port: pending.port }),
    ...(active.dataDirectory !== pending.dataDirectory && { dataDirectory: pending.dataDirectory }),
  }
}

function LaunchSummary({ title, settings }: { title: string; settings: LaunchSettings }) {
  return <div className="launch-summary">
    <h3>{title}</h3>
    <dl>
      <div><dt>监听地址</dt><dd><code>{formatListener(settings.address, settings.port)}</code></dd></div>
      <div><dt>数据目录</dt><dd><code>{settings.dataDirectory}</code></dd></div>
    </dl>
  </div>
}

export function DeploymentSection({ restart, restartBusy }: {
  restart: () => void
  restartBusy: boolean
}) {
  const deployment = useResource<Deployment>(deploymentPath, readConsoleResource)
  const [saved, setSaved] = useState<Deployment>()
  const [editing, setEditing] = useState(false)
  const action = useAction()
  const config = saved ?? deployment.data
  const hasChanges = config && Object.keys(changedSettings(config.active, config.pending)).length > 0

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!config) return
    const form = new FormData(event.currentTarget)
    const restartAfterSave = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'restart'
    const fields: LaunchSettings = {
      address: form.get('address') as LaunchSettings['address'],
      port: Number(form.get('port')),
      dataDirectory: String(form.get('dataDirectory')).trim(),
    }
    void action.perform(async () => {
      if (!fields.dataDirectory) throw new Error('请填写数据目录。')
      const patch = changedSettings(config.pending, fields)
      const result = Object.keys(patch).length ? await api<Deployment>(deploymentPath, 'PATCH', patch) :
        await readConsoleResource<Deployment>(deploymentPath)
      setSaved(result)
      setEditing(false)
      if (restartAfterSave) restart()
    }, '启动设置已保存。')
  }

  return <SettingsSection id="deployment" title="启动设置" icon={<HardDrive size={18}/>}>
    <div className="padded deployment-body">
      {deployment.error && !saved && <Notice notice={{ text: deployment.error, error: true }}/>}
      {deployment.error && !config && <div className="form-actions"><button className="secondary" onClick={deployment.refresh}>重试</button></div>}
      {!config && !deployment.error && <p className="console-load" role="status">正在读取启动设置…</p>}
      {config && <>
        <div className="launch-grid">
          <LaunchSummary title="当前生效" settings={config.active}/>
          <LaunchSummary title={hasChanges ? '待重启生效' : '下次启动 · 与当前相同'} settings={config.pending}/>
        </div>
        {config.lastError && <Notice notice={{ text: config.lastError, error: true }}/>}
        {editing ? <form className="launch-editor" onSubmit={save}>
          <div className="field-grid two">
            <Field title="本机监听地址" hint="Console 和 Client 仅向本机提供访问。">{id =>
              <select id={id} name="address" disabled={action.pending} defaultValue={config.pending.address}>
                <option value="127.0.0.1">127.0.0.1（IPv4）</option>
                <option value="::1">::1（IPv6）</option>
              </select>}</Field>
            <Field title="端口">{id => <input className="mono-input" id={id} name="port" type="number" min={1} max={65535} step={1} required
              disabled={action.pending} defaultValue={config.pending.port}/>}</Field>
          </div>
          <DirectoryField title="数据目录" name="dataDirectory" defaultValue={config.pending.dataDirectory} required disabled={action.pending}
            hint="请输入绝对路径或浏览本机文件夹。迁移目标须为空且可写。"/>
          <p className="help">更换数据目录后，下次启动会复制现有身份、聊天历史及 Nexus 独立 Codex 的本地授权资料，并保留原目录作为备份。若无法复制系统凭据库中的授权资料，Host 会取消迁移、继续使用原目录，并在此处显示原因。</p>
          <Notice notice={action.notice}/>
          <div className="form-actions">
            <button type="button" className="secondary" disabled={action.pending} onClick={() => setEditing(false)}>取消编辑</button>
            <button className="secondary" value="later" disabled={action.pending}><Save size={15}/>保存，稍后重启</button>
            <button className="primary" value="restart" disabled={action.pending || restartBusy}><RotateCcw size={15}/>{action.pending ? '正在保存…' : '保存并重启'}</button>
          </div>
        </form> : <>
          {action.notice && !action.notice.error && <Notice notice={action.notice}/>}
          <div className="form-actions">
            <button className="secondary" disabled={action.pending || restartBusy} onClick={() => setEditing(true)}><Pencil size={15}/>编辑启动设置</button>
            {hasChanges && <button className="primary" disabled={action.pending || restartBusy} onClick={restart}><RotateCcw size={15}/>应用设置并重启</button>}
          </div>
        </>}
      </>}
    </div>
  </SettingsSection>
}
