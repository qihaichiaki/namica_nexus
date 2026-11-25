import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, ArrowUp, Box, ChevronDown, CirclePlus, Code2, Command, CornerDownLeft, FolderClosed, LoaderCircle, MessageSquare, MessagesSquare, Plus, ShieldQuestion, Square, Terminal } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Identity, Runtime, Session, SessionSnapshot } from './data'
import { api, useAction } from './data'
import { Avatar, Brand, Notice, State, statuses, timestamp } from './ui'

interface SidebarProps {
  identities: Identity[]; identity?: Identity; sessions: Session[]; selected?: Session
  runtime?: Runtime; version?: string; pending: boolean
  selectIdentity: (id: string) => void; selectSession: (s: Session) => void
  onCreate: () => void; newSession: () => void
}
export function Sidebar(p: SidebarProps) {
  return <>
    <div className="side-content">
      <div className="side-heading"><Command size={19} strokeWidth={1.7}/><h2>工作空间</h2></div>
      <div className="side-label"><span>当前身份</span><button className="icon-button" onClick={p.onCreate} title="创建其他身份" aria-label="创建其他身份"><Plus size={15}/></button></div>
      {p.identity ? <div className="identity-picker">
        <Avatar seed={p.identity.id}/><div><strong>{p.identity.name}</strong><small>{p.runtime?.type || 'Agent'} · 人格 v{p.identity.personalityVersion}</small></div><ChevronDown size={15}/>
        <select aria-label="当前身份" value={p.identity.id} onChange={event => p.selectIdentity(event.target.value)}>
          {p.identities.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </div> : <button className="empty-picker" onClick={p.onCreate}><CirclePlus size={20}/>添加 AI 身份</button>}
      <div className="side-rule" />
      <div className="side-label"><h3>会话记录</h3><span className="count">{p.sessions.length}</span></div>
      <button className="new-chat" disabled={!p.identity || p.pending} onClick={p.newSession}><Plus size={16}/>新建会话</button>
      <div className="sessions">{p.sessions.map(s =>
        <button key={s.sessionId} className={s.sessionId === p.selected?.sessionId ? 'selected' : ''} onClick={() => p.selectSession(s)}>
          <MessageSquare size={15}/><span>{s.title}</span>{s.status === 'running' && <i className="live-dot"/>}
        </button>)}
        {p.sessions.length === 0 && <div className="sessions-empty"><MessagesSquare size={21}/><span>暂无会话记录</span></div>}
      </div>
    </div>
    <div className="side-footer"><Terminal size={16}/><span>Nexus Host</span><code>{p.version ? 'v' + p.version.replace(/^v/, '') : '—'}</code></div>
  </>
}

function WorkspaceMark() {
  return <div className="workspace-mark" aria-hidden="true">
    <div className="orbit orbit-one"/><div className="orbit orbit-two"/>
    <div className="tile-back"/><div className="tile-mid"/><div className="tile-face"><Brand large/></div>
    <i className="spark a"/><i className="spark b"/><i className="spark c"/>
  </div>
}

interface ChatProps {
  identity?: Identity; selected?: Session; snapshot?: SessionSnapshot; loading: boolean; loadFailed: boolean
  connection: string; startSession: () => Promise<Session>; refresh: () => void
  onCreate: () => void; onSettings: () => void
}
export function Chat(p: ChatProps) {
  const [draft, setDraft] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const sending = useRef(false)
  const action = useAction()
  const [submitted, setSubmitted] = useState(false)
  const id = p.selected?.sessionId
  const currentState = p.snapshot?.session.status ?? p.selected?.status
  const running = currentState === 'running'
  const ready = p.connection === 'online' && !action.pending
  const messages = p.snapshot?.messages ?? []
  const send = () => {
    const content = draft.trim()
    if (!id || !content || !ready || running || sending.current || submitted) return
    sending.current = true
    void action.perform(async () => {
      try {
        await api('/sessions/' + id + '/messages', 'POST', { content })
        setDraft('')
        setSubmitted(true)
        stick.current = true
        p.refresh()
      } finally { sending.current = false }
    })
  }
  useEffect(() => { setSubmitted(false) }, [p.snapshot])
  useLayoutEffect(() => {
    if (scroll.current && stick.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [p.snapshot])
  useEffect(() => {
    if (input.current) {
      input.current.style.height = 'auto'
      input.current.style.height = Math.min(input.current.scrollHeight, 160) + 'px'
    }
  }, [draft])

  if (p.loadFailed && p.loading) return <div className="empty-small">等待 Host 数据</div>
  if (p.loading) return <div className="empty-small"><LoaderCircle size={20} className="spin"/>加载工作空间…</div>
  return <>
    <div className="transcript" ref={scroll} onScroll={event => {
      const el = event.currentTarget
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    }}>
      {!messages.length ? <section className="welcome">
        <WorkspaceMark />
        <h2>{!p.identity ? '创建你的第一个 AI 身份' : !id ? '与 ' + p.identity.name + ' 开启对话' : '想和 ' + p.identity.name + ' 聊些什么？'}</h2>
        <p>{!p.identity ? '为它取一个名字，设定人格与工作目录。之后的每次对话，都从这个身份开始。' : !id ? '新建一个会话，在独立的上下文中与这个身份协作。' : '发送第一条消息，或选择一个任务开始。'}</p>
        {!p.identity ? <div className="welcome-actions"><button className="primary" onClick={p.onCreate}><Plus size={16}/>创建身份</button><button className="text-btn" onClick={p.onSettings}>查看运行配置<ArrowRight size={14}/></button></div>
          : !id ? <button className="primary" disabled={!ready} onClick={() => action.perform(async () => { await p.startSession() })}><Plus size={16}/>开始对话</button>
          : <div className="starters">{[
            { icon: Activity, label: '了解当前身份', text: '请介绍一下你的身份与工作方式。' },
            { icon: FolderClosed, label: '查看工作目录', text: '请列出当前工作目录中的文件，并简单说明目录结构。' },
            { icon: Code2, label: '编写示例代码', text: '请写一个简单的 TypeScript 函数，并解释如何使用。' },
          ].map(({ icon: Icon, label, text }) => <button key={label} onClick={() => { setDraft(text); input.current?.focus() }}><Icon size={15}/>{label}</button>)}</div>}
      </section> : <div className="messages">
        {messages.map(m => {
          const assistant = m.role === 'assistant'
          const turn = p.snapshot?.turns.find(t => t.turnId === m.turnId)
          const tools = assistant ? p.snapshot?.tools.filter(t => t.turnId === m.turnId) ?? [] : []
          return <article key={m.messageId} className={'message ' + m.role}>
            {assistant ? <Avatar seed={p.identity!.id}/> : <span className="user-avatar">我</span>}
            <div className="message-body">
              <div className="author"><strong>{assistant ? p.identity?.name : '你'}</strong><time dateTime={m.createdAt}>{timestamp(m.createdAt)}</time>
                {assistant && m.status !== 'completed' && <State value={m.status}/>}</div>
              {tools.map(tool => <details className="tool" key={tool.id}><summary><Terminal size={14}/><span>{tool.label}</span><small>{statuses[tool.status]}</small></summary>
                {tool.detail && <pre>{tool.detail}</pre>}</details>)}
              {m.content ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
                img: ({ alt }) => <span>[图片{alt ? ' · ' + alt : ''}]</span>,
              }}>{m.content}</ReactMarkdown></div> : assistant && m.status === 'running' && <span className="working"><i/>正在等待回复…</span>}
              {assistant && turn?.error && <div className="turn-error" role="alert">{turn.error}</div>}
            </div>
          </article>
        })}
      </div>}
    </div>
    {(p.snapshot?.approvals ?? []).map(approval => <div className="approval" key={approval.id}><ShieldQuestion size={20}/>
      <div><strong>工具请求审批</strong><pre>{approval.description}</pre>
      <div className="button-row">{(['decline', 'accept'] as const).map(decision => <button key={decision} disabled={!ready} className={decision === 'accept' ? 'primary' : 'secondary'} onClick={() => action.perform(async () => {
        await api('/sessions/' + id + '/approvals/' + encodeURIComponent(approval.id), 'POST', { decision }); p.refresh()
      })}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}</div></div></div>)}
    <div className="composer-zone">
      <Notice notice={action.notice}/>
      {id ? <><form className="composer" onSubmit={e => { e.preventDefault(); send() }}>
        <textarea ref={input} value={draft} aria-label="消息" placeholder={'发消息给 ' + p.identity?.name + '…'} rows={2}
          onChange={e => setDraft(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); send() }
          }}/>
        <div className="composer-row"><span className="composer-agent"><Box size={14}/>{p.identity?.name}</span>
          {running ? <button type="button" className="stop" disabled={!ready} onClick={() => action.perform(async () => {
            await api('/sessions/' + id + '/cancel', 'POST'); p.refresh()
          })}><Square size={12} fill="currentColor"/>停止</button> : <button className="send" type="submit" aria-label="发送消息" title="发送消息" disabled={!draft.trim() || !ready || submitted}><ArrowUp size={19}/></button>}
        </div></form>
        <div className="composer-foot"><State value={currentState ?? 'idle'}/><span><CornerDownLeft size={11}/> 发送 · Shift + Enter 换行</span></div></> :
        <div className="onboard-foot"><span className="local-mark"><i/></span>会话与身份保存在本机</div>}
    </div>
  </>
}
