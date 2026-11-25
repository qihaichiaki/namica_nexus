const restartFragment = '#restart='
const restartLifetime = 5 * 60 * 1000

export interface RestartAttempt {
  restartId: string
  consoleUrl: string
  instanceId: string
  startedAt: number
}

interface RestartResult {
  status: 'ready' | 'failed'
  consoleUrl: string
  instanceId: string
  error?: string
}

export function consoleUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
        !url.username && !url.password && url.pathname === '/console/' && !url.search && !url.hash) return url
  } catch {
    // The restart destination must be an absolute loopback Console URL.
  }
}

export function restartNavigationUrl(attempt: RestartAttempt) {
  const url = consoleUrl(attempt.consoleUrl)
  if (!url) return
  if (url.origin !== location.origin) url.searchParams.set('restart', attempt.restartId)
  return url.href
}

export function clearRestartNavigation() {
  const url = new URL(location.href)
  if (!url.searchParams.has('restart')) return
  url.searchParams.delete('restart')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
}

export function restoreRestart(): RestartAttempt | undefined {
  if (!location.hash.startsWith(restartFragment)) return
  try {
    const saved = JSON.parse(decodeURIComponent(location.hash.slice(restartFragment.length))) as RestartAttempt
    if (saved && typeof saved.restartId === 'string' && typeof saved.instanceId === 'string' &&
        typeof saved.consoleUrl === 'string' && consoleUrl(saved.consoleUrl) &&
        Number.isFinite(saved.startedAt) && Date.now() - saved.startedAt < restartLifetime &&
        saved.startedAt <= Date.now()) return saved
  } catch {
    // Ignore an invalid or expired fragment.
  }
}

export function rememberRestart(attempt?: RestartAttempt) {
  if (!attempt && !location.hash.startsWith(restartFragment)) return
  const hash = attempt ? restartFragment + encodeURIComponent(JSON.stringify(attempt)) : ''
  history.replaceState(history.state, '', location.pathname + location.search + hash)
}

export function restartExpired(attempt: RestartAttempt) {
  return Date.now() - attempt.startedAt >= restartLifetime
}

export async function readRestartResult(attempt: RestartAttempt) {
  const target = consoleUrl(attempt.consoleUrl)
  if (!target) return
  const transport = new URL(target)
  // Browsers can enforce CSP differently for IPv6 literals in cross-origin fetches.
  if (transport.hostname === '[::1]') transport.hostname = 'localhost'
  const origins = new Set([location.origin, transport.origin])
  const path = '/api/manage/host/restart-result/' + encodeURIComponent(attempt.restartId)
  const results = await Promise.allSettled([...origins].map(async origin => {
    const response = await fetch(origin + path, { cache: 'no-store', signal: AbortSignal.timeout(2500) })
    if (!response.ok) return
    const result = await response.json() as RestartResult
    const destination = consoleUrl(result.consoleUrl)
    if (result.status === 'ready' && destination?.href === target.href && result.instanceId && result.instanceId !== attempt.instanceId) return result
    if (result.status === 'failed' && origin === location.origin && destination) return result
  }))
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value
  }
}
