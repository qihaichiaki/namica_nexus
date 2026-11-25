import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, Blocks, Box, Cpu, Folder, LoaderCircle, Pencil, Plus, Save, Server, SlidersHorizontal, Terminal, X } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import type { HostConfig, HostStatus, Identity, LogLevel, Runtime, Session } from './data'
import { api, useAction } from './data'
import { Avatar, Field, Notice, State } from './ui'

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog className="modal" ref={dialog} aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); close() }}>
    <div className="modal-head"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={19}/></button></div>{children}
  </dialog>
}

interface EditorProps {
  identity?: Identity; runtimes: Runtime[]; config?: HostConfig; close: () => void; saved: () => void
}
function IdentityEditor({ identity, runtimes, config, close, saved }: EditorProps) {
  const action = useAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void action.perform(async () => {
      await api(identity ? '/identities/' + identity.id : '/identities', identity ? 'PATCH' : 'POST', Object.fromEntries(data))
      saved()
    })
  }
  return <Modal title={identity ? '编辑身份' : '创建 AI 身份'} close={() => { if (!action.pending) close() }}>
    <form onSubmit={submit}><div className="form-body">
      <Field title="名称">{id => <input id={id} autoFocus required name="name" maxLength={100} defaultValue={identity?.name} placeholder="例如：研究助手"/>}</Field>
      <Field title="描述（选填）">{id => <input id={id} name="description" defaultValue={identity?.description} placeholder="这个身份负责什么？"/>}</Field>
      <Field title="基础人格" hint="保存后在新会话中生效。已有会话沿用创建时的人格版本。">{id => <textarea id={id} rows={4} name="personality" defaultValue={identity?.personality} placeholder="描述它的语气、专长以及你希望它如何协作。"/>}</Field>
      <Field title="Agent Runtime">{id => <select id={id} name="runtimeConfigId" required defaultValue={identity?.runtimeConfigId || config?.defaultRuntimeId || runtimes[0]?.id}>{runtimes.map(r => <option key={r.id} value={r.id}>{r.type}{!r.enabled && '（已停用）'}</option>)}</select>}</Field>
      <Field title="默认工作目录" hint="填写绝对路径，或留空使用 Runtime 的默认目录。">{id => <input id={id} name="workspace" className="mono-input" defaultValue={identity?.workspace} placeholder="使用 Runtime 默认目录"/>}</Field>
      <Notice notice={action.notice}/>
    </div><div className="modal-actions"><button type="button" disabled={action.pending} className="secondary" onClick={close}>取消</button>
    <button className="primary" disabled={action.pending || !runtimes.length}>{action.pending ? '保存中…' : identity ? '保存修改' : '创建身份'}</button></div></form>
  </Modal>
}

interface AgentsProps {
  identities?: Identity[]; sessions: Session[]; runtimes: Runtime[]; config?: HostConfig
  newRequested: boolean; clearRequest: () => void; refresh: () => void; chat: (id: string) => void
}
export function Agents(p: AgentsProps) {
  const [editing, setEditing] = useState<Identity | 'new' | null>(null)
  useEffect(() => { if (p.newRequested) { setEditing('new'); p.clearRequest() } }, [p.newRequested, p.clearRequest])
  return <main className="manage"><div className="page-wrap">
    <header className="page-head"><div><span className="page-icon"><Blocks size={22}/></span><h1>AI 身份</h1><p>管理每个身份的人格、运行环境与独立会话。</p></div>
      <button className="primary" onClick={() => setEditing('new')}><Plus size={16}/>创建身份</button></header>
    {!p.identities ? <div className="empty-small"><LoaderCircle size={18} className="spin"/>读取身份…</div> : !p.identities.length ?
      <section className="empty-card"><Blocks size={32}/><h2>还没有 AI 身份</h2><p>创建身份后，即可开启第一个会话。</p></section> :
      <div className="agent-grid">{p.identities.map(i => {
        const sessions = p.sessions.filter(s => s.identityId === i.id)
        const runtime = p.runtimes.find(r => r.id === i.runtimeConfigId)
        return <article className="agent-card" key={i.id}><div className="agent-head"><Avatar seed={i.id} large/><State value={sessions.some(s => s.status === 'running') ? 'running' : 'idle'}/></div>
          <h2>{i.name}</h2>{i.description && <p>{i.description}</p>}
          <div className="agent-meta"><span><Box size={14}/>{runtime?.type || i.runtimeConfigId}</span><span>人格 v{i.personalityVersion}</span><span>{sessions.length} 个会话</span></div>
          <div className="agent-path"><Folder size={14}/><code title={i.workspace || runtime?.workspace}>{i.workspace || runtime?.workspace || 'Runtime 默认目录'}</code></div>
          <div className="agent-actions"><button className="text-btn" onClick={() => setEditing(i)}><Pencil size={14}/>编辑</button><button className="text-btn" onClick={() => p.chat(i.id)}>进入对话<ArrowRight size={14}/></button></div>
        </article>
      })}</div>}
  </div>{editing && <IdentityEditor identity={editing === 'new' ? undefined : editing} runtimes={p.runtimes} config={p.config} close={() => setEditing(null)} saved={() => { p.refresh(); setEditing(null) }}/>}</main>
}

function SettingsSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="settings-card"><div className="settings-title">{icon}<h2>{title}</h2></div>{children}</section>
}

function HostForm({ config, runtimes, refresh }: { config: HostConfig; runtimes: Runtime[]; refresh: () => void }) {
  const action = useAction()
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void action.perform(async () => {
      await api('/host/config', 'PATCH', { defaultRuntimeId: form.get('defaultRuntimeId'), logLevel: form.get('logLevel') as LogLevel, executionTimeoutSeconds: Number(form.get('timeout')) })
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

function RuntimeForm({ runtime, refresh }: { runtime: Runtime; refresh: () => void }) {
  const action = useAction()
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void action.perform(async () => {
      await api('/runtimes/' + runtime.id, 'PATCH', {
        enabled: form.has('enabled'), executable: form.get('executable'), workspace: form.get('workspace'), model: form.get('model'),
      })
      refresh()
    }, 'Runtime 配置已保存。')
  }
  return <form className="settings-form" onSubmit={onSubmit}>
    <div className="runtime-summary"><div className="runtime-glyph"><Terminal size={21}/></div><div><strong>{runtime.type}</strong><small>{runtime.version || '版本待检测'} · {runtime.processState === 'running' ? '进程运行中' : '进程空闲'}</small></div>
      <label className="switch"><input type="checkbox" name="enabled" defaultChecked={runtime.enabled}/><span/>启用</label></div>
    <div className="field-grid two">
      <Field title="可执行文件">{id => <input className="mono-input" id={id} required name="executable" defaultValue={runtime.executable}/>}</Field>
      <Field title="默认模型">{id => <input className="mono-input" id={id} name="model" defaultValue={runtime.model} placeholder="跟随 Runtime 默认模型"/>}</Field>
    </div><Field title="默认工作目录">{id => <input className="mono-input" id={id} required name="workspace" defaultValue={runtime.workspace}/>}</Field>
    <p className="help">保存后用于后续调用。工作目录在创建会话时确定；运行中无法修改 Runtime。</p>
    <div className="check-result"><span className={'check-dot ' + (runtime.available === true ? 'good' : runtime.available === false ? 'bad' : '')}/>{runtime.available === true ? '可用' : runtime.available === false ? '不可用' : '尚未检测'}{runtime.detail && <span> · {runtime.detail}</span>}</div>
    <Notice notice={action.notice}/><div className="form-actions"><button type="button" className="secondary" disabled={action.pending} onClick={() => action.perform(async () => {
      await api('/runtimes/' + runtime.id + '/check', 'POST'); refresh()
    }, '已检测保存的 Runtime 配置。')}><Activity size={15}/>检测可用性</button><button className="primary" disabled={action.pending}><Save size={15}/>保存 Runtime</button></div>
  </form>
}
function formatUptime(seconds: number) {
  return seconds < 60 ? Math.floor(seconds) + ' 秒' : seconds < 3600 ? Math.floor(seconds / 60) + ' 分钟' : Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds / 60) % 60 + ' 分钟'
}
export function Settings({ status, config, runtimes, refresh }: { status?: HostStatus; config?: HostConfig; runtimes: Runtime[]; refresh: () => void }) {
  return <main className="manage"><div className="page-wrap settings-wrap">
    <header className="page-head"><div><span className="page-icon"><SlidersHorizontal size={22}/></span><h1>Host 设置</h1><p>查看本地服务状态，配置 Agent 的运行方式。</p></div></header>
    <SettingsSection title="服务状态" icon={<Server size={18}/>}>
      {status ? <dl className="facts"><div><dt>Host 版本</dt><dd><code>{status.version}</code></dd></div>
        <div><dt>服务状态</dt><dd><span className="check-dot good"/>运行中</dd></div><div><dt>运行时长</dt><dd>{formatUptime(status.uptimeSeconds)}</dd></div>
        <div><dt>监听地址</dt><dd><code>{status.address}:{status.port}</code></dd></div><div><dt>日志等级</dt><dd><code>{status.logLevel}</code></dd></div>
        <div className="fact-wide"><dt>数据目录</dt><dd><code>{status.dataDirectory}</code></dd></div></dl> : <p className="help padded">正在读取服务状态…</p>}</SettingsSection>
    <SettingsSection title="Host 配置" icon={<SlidersHorizontal size={18}/>} >{config && <HostForm config={config} runtimes={runtimes} refresh={refresh}/>}</SettingsSection>
    {runtimes.map(runtime => <SettingsSection key={runtime.id} title="Runtime 配置" icon={<Cpu size={18}/>}>
      <RuntimeForm runtime={runtime} refresh={refresh}/></SettingsSection>)}
  </div></main>
}
