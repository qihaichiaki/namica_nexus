import { Activity, Save, Terminal } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import type { HostConfig, LogLevel, Runtime } from './data'
import { api, useAction } from './data'
import { Field, Notice } from './ui'

export function SettingsSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="settings-card"><div className="settings-title">{icon}<h2>{title}</h2></div>{children}</section>
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
    <Field title="日志等级">{id => <select id={id} name="logLevel" defaultValue={config.logLevel}>{['debug', 'info', 'warn', 'error'].map(v => <option key={v}>{v}</option>)}</select>}</Field>
    <Field title="执行超时（秒）">{id => <input id={id} type="number" min={5} max={86400} step={1} required name="timeout" defaultValue={config.executionTimeoutSeconds}/>}</Field>
    <Field title="默认 Runtime">{id => <select id={id} name="defaultRuntimeId" defaultValue={config.defaultRuntimeId}>{runtimes.map(r => <option key={r.id} value={r.id}>{r.type}</option>)}</select>}</Field>
  </div><p className="help">日志等级立即生效。超时用于后续任务，默认 Runtime 用于新建身份。</p>
    <Notice notice={action.notice}/><div className="form-actions"><button className="primary" disabled={action.pending}><Save size={15}/>保存 Host 配置</button></div>
  </form>
}

export function RuntimeForm({ runtime, refresh }: { runtime: Runtime; refresh: () => void }) {
  const action = useAction()
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
      <label className="switch"><input type="checkbox" name="enabled" defaultChecked={runtime.enabled}/><span/>启用</label></div>
    <div className="field-grid two">
      <Field title="可执行文件" hint="保留 codex 即可自动查找。Windows 会先查 PATH，再查已安装的 Codex 桌面版。也可填写完整路径。">{id => <input className="mono-input" id={id} required name="executable" defaultValue={runtime.executable}/>}</Field>
      <Field title="默认模型">{id => <input className="mono-input" id={id} name="model" defaultValue={runtime.model} placeholder="跟随 Runtime 默认模型"/>}</Field>
    </div>
    <div className="field-grid two">
      <Field title="默认工作目录" hint="清空并保存可恢复数据目录下的 workspace。">{id => <input className="mono-input" id={id} name="workspace" defaultValue={runtime.workspace} placeholder="使用数据目录下的 workspace"/>}</Field>
      <Field title="本地代理地址" hint="填写 HTTP 或 HTTPS 代理地址，可带端口。留空沿用环境变量或 Windows 系统代理。">
        {id => <input id={id} name="proxyUrl" className="mono-input" type="url"
          spellCheck={false} autoComplete="off" placeholder="http://127.0.0.1:7890" defaultValue={runtime.proxyUrl}/>}
      </Field>
    </div>
    <p className="help">保存后用于后续调用。工作目录在创建会话时确定；运行中无法修改 Runtime。</p>
    <div className="check-result"><span className={'check-dot ' + (runtime.available === true ? 'good' : runtime.available === false ? 'bad' : '')}/>{runtime.available === true ? '可用' : runtime.available === false ? '不可用' : '尚未检测'}{runtime.detail && <span> · {runtime.detail}</span>}</div>
    <Notice notice={action.notice}/><div className="form-actions"><button type="button" className="secondary" disabled={action.pending} onClick={() => action.perform(async () => {
      await api('/manage/runtimes/' + runtime.id + '/check', 'POST'); refresh()
    }, '已检测保存的 Runtime 配置。')}><Activity size={15}/>检测可用性</button><button className="primary" disabled={action.pending}><Save size={15}/>保存 Runtime</button></div>
    {runtime.type === 'codex' && <section className="runtime-login">
      <h3>Codex 独立登录</h3>
      <p>首次使用时，请在项目根目录运行以下命令并完成官方登录。如需代理，请先填写上方地址并保存 Runtime。</p>
      <pre><code>npm run codex:login</code></pre>
      <p>新线程保存在 Host 数据目录下的 <code>codex-home</code> 中。切换前的聊天记录仍可在会话列表中查看，继续协作时请为原身份新建会话。</p>
    </section>}
  </form>
}
