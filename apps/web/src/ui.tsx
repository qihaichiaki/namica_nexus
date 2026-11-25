import { useId } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
import type { Action, Session } from './data'

export function Brand({ large = false }: { large?: boolean }) {
  return <span className={'brand-icon' + (large ? ' large' : '')} aria-hidden="true"><i /><i /><i /></span>
}

export function Avatar({ seed, large = false }: { seed: string; large?: boolean }) {
  let hash = 19
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const shape = Array.from({ length: 25 }, (_, i) => {
    const column = i % 5
    const bit = Math.floor(i / 5) * 3 + (column > 2 ? 4 - column : column)
    return <i key={i} className={(hash >>> bit) % 2 ? 'lit' : ''} />
  })
  return <span aria-hidden="true" className={'avatar tone-' + (Math.abs(hash) % 4) + (large ? ' large' : '')}>{shape}</span>
}

export function Field({ title, hint, children }: { title: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return <div className="field"><label htmlFor={id}>{title}</label>{children(id)}{hint && <small>{hint}</small>}</div>
}

export function Notice({ notice }: { notice: Action['notice'] }) {
  if (!notice) return null
  return <div role={notice.error ? 'alert' : 'status'} className={'notice ' + (notice.error ? 'error' : 'success')}>
    {notice.error ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}{notice.text}
  </div>
}

export const statuses: Record<Session['status'], string> = {
  idle: '待命', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '意外中断',
}

export function State({ value }: { value: Session['status'] }) {
  return <span className={'state ' + value}><i />{statuses[value]}</span>
}

export function timestamp(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
