import { useEffect, useState } from 'react'
import { ArrowRight, Blocks, Box, Folder, LoaderCircle, Pencil, Plus } from 'lucide-react'
import type { FormEvent } from 'react'
import type { ClientRuntimeOption, Identity, Session } from './data'
import { api, useAction } from './data'
import { Avatar, Field, Modal, Notice, State } from './ui'

interface EditorProps {
  identity?: Identity; runtimes: ClientRuntimeOption[]; close: () => void; saved: () => void
}
function IdentityEditor({ identity, runtimes, close, saved }: EditorProps) {
  const action = useAction()
  const [runtimeId, setRuntimeId] = useState(identity?.runtimeConfigId)
  const defaultRuntimeId = runtimes.find(runtime => runtime.isDefault)?.id ?? runtimes[0]?.id
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void action.perform(async () => {
      await api(identity ? '/identities/' + identity.id : '/identities', identity ? 'PATCH' : 'POST', Object.fromEntries(data))
      saved()
    })
  }
  return <Modal title={identity ? '编辑身份' : '创建 AI 身份'} pending={action.pending} close={close}>
    <form onSubmit={submit}><div className="form-body">
      <Field title="名称">{id => <input id={id} autoFocus required name="name" maxLength={100} defaultValue={identity?.name} placeholder="例如：研究助手"/>}</Field>
      <Field title="描述（选填）">{id => <input id={id} name="description" defaultValue={identity?.description} placeholder="这个身份负责什么？"/>}</Field>
      <Field title="基础人格" hint="保存后在新会话中生效。已有会话沿用创建时的人格版本。">{id => <textarea id={id} rows={4} name="personality" defaultValue={identity?.personality} placeholder="描述它的语气、专长以及你希望它如何协作。"/>}</Field>
      <Field title="Agent Runtime">{id => <select id={id} name="runtimeConfigId" required value={runtimeId ?? defaultRuntimeId ?? ''} onChange={event => setRuntimeId(event.target.value)}>{runtimes.map(r => <option key={r.id} value={r.id}>{r.type}{!r.enabled && '（已停用）'}</option>)}</select>}</Field>
      <Field title="默认工作目录" hint="填写绝对路径，或留空使用 Runtime 的默认目录。">{id => <input id={id} name="workspace" className="mono-input" defaultValue={identity?.workspace} placeholder="使用 Runtime 默认目录"/>}</Field>
      <Notice notice={action.notice}/>
    </div><div className="modal-actions"><button type="button" disabled={action.pending} className="secondary" onClick={close}>取消</button>
    <button className="primary" disabled={action.pending || !runtimes.length}>{action.pending ? '保存中…' : identity ? '保存修改' : '创建身份'}</button></div></form>
  </Modal>
}

interface AgentsProps {
  identities?: Identity[]; sessions: Session[]; runtimes: ClientRuntimeOption[]
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
          <div className="agent-path"><Folder size={14}/><code title={i.workspace}>{i.workspace || 'Runtime 默认目录'}</code></div>
          <div className="agent-actions"><button className="text-btn" onClick={() => setEditing(i)}><Pencil size={14}/>编辑</button><button className="text-btn" onClick={() => p.chat(i.id)}>进入对话<ArrowRight size={14}/></button></div>
        </article>
      })}</div>}
  </div>{editing && <IdentityEditor identity={editing === 'new' ? undefined : editing} runtimes={p.runtimes} close={() => setEditing(null)} saved={() => { p.refresh(); setEditing(null) }}/>}</main>
}
