import { useState } from 'react'
import { ArrowUp, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { readConsoleResource } from './console-data'
import { useResource } from './data'
import { Field, Modal, Notice } from './ui'

interface DirectoryListing {
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
}

function DirectoryBrowser({ initial, select, close }: { initial: string; select: (path: string) => void; close: () => void }) {
  const [path, setPath] = useState(initial)
  const directory = useResource<DirectoryListing>('/manage/directories?path=' + encodeURIComponent(path), readConsoleResource)
  const listing = directory.error ? undefined : directory.data
  return <Modal title="选择本机文件夹" close={close}>
    <div className="form-body browser-body">
      <div className="browser-tools">
        <button type="button" className="secondary" disabled={!path} onClick={() => setPath('')}><HardDrive size={15}/>磁盘</button>
        <button type="button" className="secondary" disabled={!listing?.path} onClick={() => setPath(listing?.parent ?? '')}><ArrowUp size={15}/>上一级</button>
      </div>
      <p className="browser-path"><code>{listing?.path || path || '此电脑'}</code></p>
      {directory.error && <>
        <Notice notice={{ text: directory.error, error: true }}/>
        <button type="button" className="secondary browser-retry" onClick={directory.refresh}>重试</button>
      </>}
      {!directory.error && !listing && <p className="console-load" role="status">正在读取文件夹…</p>}
      {listing && <ul className="browser-list">
        {listing.entries.map(entry => <li key={entry.path}>
          <button type="button" className="directory-entry" onClick={() => setPath(entry.path)} title={entry.path}>
            {listing.path ? <Folder size={16}/> : <HardDrive size={16}/>}<span>{entry.name}</span>
          </button>
        </li>)}
        {listing.entries.length === 0 && <li className="directory-empty">没有可显示的子文件夹。</li>}
      </ul>}
    </div>
    <div className="modal-actions">
      <button type="button" className="secondary" onClick={close}>取消</button>
      <button type="button" className="primary" disabled={!listing?.path} onClick={() => { if (listing?.path) select(listing.path) }}>选择当前文件夹</button>
    </div>
  </Modal>
}

export function DirectoryField({ title, hint, name, defaultValue, required = false, placeholder, disabled = false }: {
  title: string
  hint: string
  name: string
  defaultValue: string
  required?: boolean
  placeholder?: string
  disabled?: boolean
}) {
  const [value, setValue] = useState(defaultValue)
  const [open, setOpen] = useState(false)
  return <Field title={title} hint={hint}>{id => <>
    <div className="directory-field">
      <input className="mono-input" id={id} name={name} value={value} placeholder={placeholder}
        required={required} disabled={disabled} spellCheck={false} autoComplete="off" onChange={event => setValue(event.currentTarget.value)}/>
      <button type="button" className="secondary" aria-label={title + '，浏览文件夹'} disabled={disabled} onClick={() => setOpen(true)}>
        <FolderOpen size={16}/>浏览
      </button>
    </div>
    {open && <DirectoryBrowser initial={value.trim()} close={() => setOpen(false)} select={path => { setValue(path); setOpen(false) }}/>}
  </>}</Field>
}
