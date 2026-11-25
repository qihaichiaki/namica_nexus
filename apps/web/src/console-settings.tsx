import { Activity, Save, Terminal } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { DirectoryField } from './console-directory'
import type { HostConfig, LogLevel, Runtime } from './data'
import { api, useAction } from './data'
import { Field, Notice } from './ui'

export function SettingsSection({ id, title, icon, children }: { id?: string; title: string; icon: ReactNode; children: ReactNode }) {
  return <section id={id} className="settings-card"><div className="settings-title">{icon}<h2>{title}</h2></div>{children}</section>
}

export function HostForm({ config, runtimes, refresh }: { config: HostConfig; runtimes: Runtime[]; refresh: () => void }) {
  const action = useAction()
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void action.perform(async () => {
      await api('/manage/host/config', 'PATCH', { defaultRuntimeId: form.get('defaultRuntimeId'), logLevel: form.get('logLevel') as LogLevel, executionTimeoutSeconds: Number(form.get('timeout')) })
      refresh()
    }, 'Host 配置已保存。')
  }
  return <form onSubmit={onSubmit} className="settings-form"><div className="field-grid">
    <Field title="日志等级" hint="从保存起记录所选级别及以上的事件。例如 warn 记录警告和错误。">{id =>
      <select id={id} name="logLevel" disabled={action.pending} defaultValue={config.logLevel}>{['debug', 'info', 'warn', 'error'].map(v => <option key={v}>{v}</option>)}</select>}
    </Field>
    <Field title="单轮超时（秒）" hint="应用于之后开始的每一轮。设为 600 时，单轮运行到 10 分钟会请求停止。">{id =>
      <input id={id} type="number" min={5} max={86400} step={1} required name="timeout" disabled={action.pending} defaultValue={config.executionTimeoutSeconds}/>}
    </Field>
    <Field title="默认 Runtime" hint="新建身份时默认选择此 Runtime。当前只支持 Codex，已有身份和会话保留原绑定。">{id =>
      <select id={id} name="defaultRuntimeId" disabled={action.pending} defaultValue={config.defaultRuntimeId}>{runtimes.map(r => <option key={r.id} value={r.id}>{r.type === 'codex' ? 'Codex' : r.type}</option>)}</select>}
    </Field>
  </div>
    <Notice notice={action.notice}/><div className="form-actions"><button className="primary" disabled={action.pending}><Save size={15}/>{action.pending ? '正在保存…' : '保存 Host 配置'}</button></div>
  </form>
}

export function RuntimeForm({ runtime, refresh }: { runtime: Runtime; refresh: () => void }) {
  const action = useAction()
  const busy = action.pending || runtime.processState === 'running'
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void action.perform(async () => {
      await api('/manage/runtimes/' + runtime.id, 'PATCH', {
        enabled: form.has('enabled'), executable: form.get('executable'), workspace: form.get('workspace'), model: form.get('model'),
        proxyUrl: String(form.get('proxyUrl') ?? '').trim(),
      })
      refresh()
    }, 'Runtime 配置已保存。')
  }
  return <form className="settings-form" onSubmit={onSubmit}>
    <div className="runtime-summary"><div className="runtime-glyph"><Terminal size={21}/></div><div><strong>{runtime.type}</strong><small>{runtime.version || '版本待检测'} · {runtime.processState === 'running' ? '进程运行中' : '进程空闲'}</small></div>
      <label className="switch"><input type="checkbox" name="enabled" disabled={busy} defaultChecked={runtime.enabled}/><span/>启用</label></div>
    <div className="field-grid two">
      <Field title="可执行文件" hint="保留 codex 即可自动查找。Windows 会先查 PATH，再查已安装的 Codex 桌面版。也可填写完整路径。">{id => <input className="mono-input" id={id} required name="executable" disabled={busy} defaultValue={runtime.executable}/>}</Field>
      <Field title="默认模型">{id => <input className="mono-input" id={id} name="model" disabled={busy} defaultValue={runtime.model} placeholder="跟随 Runtime 默认模型"/>}</Field>
    </div>
    <div className="field-grid two">
      <DirectoryField title="默认工作目录" name="workspace" defaultValue={runtime.workspace} disabled={busy}
        placeholder="使用数据目录下的 workspace" hint="请输入绝对路径或浏览本机文件夹。清空并保存可使用数据目录下的 workspace。"/>
      <Field title="本地代理地址" hint="填写 HTTP 或 HTTPS 代理地址，可带端口。留空沿用环境变量或 Windows 系统代理。">
        {id => <input id={id} name="proxyUrl" className="mono-input" type="url"
          spellCheck={false} autoComplete="off" disabled={busy} placeholder="http://127.0.0.1:7890" defaultValue={runtime.proxyUrl}/>}
      </Field>
    </div>
    <p className="help">保存后用于后续调用。工作目录在创建会话时确定；运行中无法修改 Runtime。</p>
    <div className="check-result"><span className={'check-dot ' + (runtime.available === true ? 'good' : runtime.available === false ? 'bad' : '')}/>{runtime.available === true ? '可用' : runtime.available === false ? '不可用' : '尚未检测'}{runtime.detail && <span> · {runtime.detail}</span>}</div>
    <Notice notice={action.notice}/><div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={() => action.perform(async () => {
      await api('/manage/runtimes/' + runtime.id + '/check', 'POST'); refresh()
    }, '已检测保存的 Runtime 配置。')}><Activity size={15}/>检测可用性</button><button className="primary" disabled={busy}><Save size={15}/>保存 Runtime</button></div>
  </form>
}
