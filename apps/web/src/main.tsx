import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AudioLines, Blocks, Cable, MessageSquare, PanelLeftOpen, X } from 'lucide-react'
import { api, useAction, useResource } from './data'
import type { RuntimeOption, HostEvent, Identity, Session, SessionSnapshot } from './data'
import { Brand, Notice } from './ui'
import { Chat, Sidebar } from './chat'
import { Agents } from './agents'
import './shared.css'
import './style.css'

type Page = 'chat' | 'agents'
const pages = [
  { id: 'chat', label: '对话', icon: MessageSquare },
  { id: 'agents', label: '身份', icon: Blocks },
] as const

function currentPage(): Page {
  return location.hash === '#agents' ? 'agents' : 'chat'
}

function App() {
  const [page, setPage] = useState(currentPage)
  const [drawer, setDrawer] = useState(false)
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [identityId, setIdentityId] = useState(() => localStorage.getItem('nexus.identity') || '')
  const [selectedSessions, setSelectedSessions] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('nexus.sessions') || '{}') || {} } catch { return {} }
  })
  const [createAgent, setCreateAgent] = useState(false)
  const identities = useResource<Identity[]>('/identities')
  const sessions = useResource<Session[]>('/sessions')
  const runtimes = useResource<RuntimeOption[]>('/runtime-options')
  const identity = identities.data?.find(item => item.id === identityId) ?? identities.data?.[0]
  const list = (sessions.data ?? []).filter(item => item.identityId === identity?.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const selected = list.find(item => item.sessionId === selectedSessions[identity?.id ?? '']) ?? list[0]
  const snapshot = useResource<SessionSnapshot>(selected ? '/sessions/' + selected.sessionId : null)
  const action = useAction()

  // An update to a different conversation can reorder the list while reading.
  // Pin the initial choice so that incoming events never move the open chat.
  useEffect(() => {
    if (selected && !selectedSessions[selected.identityId]) {
      setSelectedSessions(previous => ({ ...previous, [selected.identityId]: selected.sessionId }))
    }
  }, [selected, selectedSessions])

  useEffect(() => {
    const changePage = () => { setPage(currentPage()); setDrawer(false) }
    window.addEventListener('hashchange', changePage)
    return () => window.removeEventListener('hashchange', changePage)
  }, [])
  useEffect(() => { localStorage.setItem('nexus.identity', identityId) }, [identityId])
  useEffect(() => { localStorage.setItem('nexus.sessions', JSON.stringify(selectedSessions)) }, [selectedSessions])
  useEffect(() => {
    if (!drawer) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawer(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [drawer])

  const callbacks = useRef({ open: () => {}, event: (_event: HostEvent) => {} })
  callbacks.current = {
    open() {
      identities.refresh(); sessions.refresh(); runtimes.refresh(); snapshot.refresh()
    },
    event(event) {
      switch (event.type) {
        case 'session.changed':
          sessions.refresh()
          if (event.sessionId === selected?.sessionId) snapshot.refresh()
          break
        case 'identities.changed': identities.refresh(); break
        case 'runtimes.changed':
        case 'config.changed': runtimes.refresh(); break
      }
    },
  }
  useEffect(() => {
    const feed = new EventSource('/api/events')
    feed.onopen = () => { setConnection('online'); callbacks.current.open() }
    feed.onerror = () => setConnection('offline')
    feed.onmessage = event => {
      try { callbacks.current.event(JSON.parse(event.data)) }
      catch { callbacks.current.open() }
    }
    return () => feed.close()
  }, [])
  const openPage = (target: Page) => { location.hash = target; setPage(target); setDrawer(false) }
  const select = (next: Session) => {
    setSelectedSessions(previous => ({ ...previous, [next.identityId]: next.sessionId }))
    sessions.refresh()
    setDrawer(false)
  }
  const startSession = async () => {
    if (!identity) throw new Error('请先创建 AI 身份。')
    const next = await api<Session>('/sessions', 'POST', { identityId: identity.id })
    select(next)
    return next
  }
  const onCreate = () => { setCreateAgent(true); openPage('agents') }
  const error = identities.error || sessions.error || runtimes.error || snapshot.error
  return <div className="app">
    <header className="appbar">
      <a href="#chat" className="wordmark" aria-label="Namica Nexus 对话"><Brand /><span>Namica <strong>Nexus</strong></span></a>
      <nav aria-label="主导航">{pages.map(({ id, label, icon: Icon }) => <a key={id} href={'#' + id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined}>
        <Icon size={17} /><span>{label}</span></a>)}</nav>
      <span className={'connection ' + connection}><i />{connection === 'online' ? '本地 Host 已连接' : connection === 'connecting' ? '连接 Host…' : 'Host 重连中'}</span>
    </header>
    {error && <div className="fetch-error" role="alert"><Cable size={16} />读取 Host 数据失败 · {error}<button onClick={() => callbacks.current.open()}>重试</button></div>}
    {page === 'chat' ? <div className="workspace">
      <button className={'shade ' + (drawer ? 'open' : '')} aria-label="关闭会话列表" onClick={() => setDrawer(false)} />
      <aside className={'chat-sidebar ' + (drawer ? 'open' : '')}>
        <button aria-label="关闭会话列表" className="mobile-close icon-button" onClick={() => setDrawer(false)}><X size={17} /></button>
        <Sidebar identities={identities.data ?? []} identity={identity} sessions={list} selected={selected}
          runtime={runtimes.data?.find(r => r.id === identity?.runtimeConfigId)}
          selectIdentity={setIdentityId} selectSession={select} onCreate={onCreate} newSession={() => action.perform(async () => { await startSession() })} pending={action.pending} />
      </aside>
      <main className="chat-pane">
        <div className="chat-top"><button className="open-drawer icon-button" aria-label="打开身份和会话列表" onClick={() => setDrawer(true)}><PanelLeftOpen size={20}/></button>
          <span className="chat-top-icon"><AudioLines size={17}/></span><h1>{selected?.title || '对话工作台'}</h1>
          {selected && <span className="version">人格 v{selected.personalityVersion}</span>}
        </div>
        <Notice notice={action.notice} />
        <Chat key={selected?.sessionId ?? identity?.id ?? 'welcome'} identity={identity} selected={selected} snapshot={snapshot.data}
          loading={!identities.data || !sessions.data || Boolean(selected && !snapshot.data)} loadFailed={Boolean(identities.error || sessions.error || snapshot.error)}
          connection={connection} startSession={startSession} refresh={() => { sessions.refresh(); snapshot.refresh() }}
          onCreate={onCreate} />
      </main>
    </div> :
      <Agents identities={identities.data} sessions={sessions.data ?? []} runtimes={runtimes.data ?? []}
        newRequested={createAgent} clearRequest={() => setCreateAgent(false)} refresh={identities.refresh}
        chat={id => { setIdentityId(id); openPage('chat') }} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
