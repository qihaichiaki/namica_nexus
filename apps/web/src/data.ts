import { useCallback, useEffect, useState } from 'react'

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.message || data.error || `Host 返回 HTTP ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

// Keep one request in flight per resource, including during bursts of SSE updates.
// A trailing request covers notifications received after the current query started.
export function useResource<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path: null })
  const [refresh, setRefresh] = useState<() => void>(() => () => {})
  useEffect(() => {
    if (!path) {
      setRefresh(() => () => {})
      return
    }
    let active = true
    let loading = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fetchResource = async () => {
      if (!active) return
      if (loading) {
        pending = true
        return
      }
      loading = true
      try {
        const data = await api<T>(path)
        if (active) setState({ path, data })
      } catch (error) {
        if (active) setState(previous => ({ path, data: previous.path === path ? previous.data : undefined, error: String(error instanceof Error ? error.message : error) }))
      } finally {
        loading = false
        if (active && pending) {
          pending = false
          schedule()
        }
      }
    }
    function schedule() {
      if (!active || timer) return
      timer = setTimeout(() => { timer = undefined; void fetchResource() }, 60)
    }
    setRefresh(() => schedule)
    void fetchResource()
    return () => { active = false; clearTimeout(timer) }
  }, [path])
  return { data: state.path === path ? state.data : undefined, error: state.path === path ? state.error : undefined, refresh }
}

export function useAction() {
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const perform = useCallback(async (task: () => Promise<void>, success?: string) => {
    setPending(true)
    setNotice(null)
    try {
      await task()
      if (success) setNotice({ text: success, error: false })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setPending(false)
    }
  }, [])
  return { pending, notice, perform }
}

export type Action = ReturnType<typeof useAction>
export type * from '../../../packages/protocol/src/index.js'
