import { afterEach, expect, test, vi } from 'vitest'
import { runtimeEnv } from '../packages/agent-codex/src/proxy.js'

afterEach(() => vi.unstubAllEnvs())

test('a saved proxy overrides inherited routing only in the child and preserves bypass rules', async () => {
  vi.stubEnv('http_proxy', 'http://old.example.test:8080')
  vi.stubEnv('ALL_PROXY', 'http://fallback.example.test:8080')
  vi.stubEnv('NO_PROXY', 'localhost,.internal.test')
  const selected = 'http://127.0.0.1:7890'
  const env = await runtimeEnv(selected)
  expect(Object.keys(env).filter(key => /^(https?|all)_proxy$/i.test(key)).sort()).toEqual(['HTTPS_PROXY','HTTP_PROXY'])
  expect(env.HTTP_PROXY).toBe(selected)
  expect(env.HTTPS_PROXY).toBe(selected)
  const byName = (environment: NodeJS.ProcessEnv, name: string) =>
    Object.entries(environment).find(([key]) => key.toLowerCase() === name)?.[1]
  expect(byName(env, 'no_proxy')).toBe('localhost,.internal.test')
  const fallback = await runtimeEnv('')
  expect(byName(fallback, 'http_proxy')).toBe('http://old.example.test:8080')
  expect(byName(fallback, 'all_proxy')).toBe('http://fallback.example.test:8080')
})
