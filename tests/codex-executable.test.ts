import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveCodexExecutable } from '../packages/agent-codex/src/executable.js'

const { stat, query } = vi.hoisted(() => ({ stat: vi.fn(), query: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: query })
}))

const desktop = 'D:\\商店 应用\\OpenAI.Codex_1'
const desktopCli = desktop + '\\app\\resources\\codex.exe'
const files = new Set<string>()
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('PATH', '.;;tools;C:relative;\\rooted')
  files.clear()
  stat.mockReset().mockImplementation(async (path: string) => ({ isFile: () => files.has(path) }))
  query.mockReset().mockResolvedValue({ stdout: desktop + '\r\n' })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('uses the first file on an absolute PATH entry before querying Desktop', async () => {
  vi.stubEnv('PATH', process.env.PATH + ';C:\\missing;"D:\\用户 Tools";D:\\other')
  files.add('D:\\用户 Tools\\codex.exe')
  files.add('D:\\other\\codex.exe')
  await expect(resolveCodexExecutable('codex')).resolves.toBe('D:\\用户 Tools\\codex.exe')
  expect(stat.mock.calls).toEqual([['C:\\missing\\codex.exe'], ['D:\\用户 Tools\\codex.exe']])
  expect(query).not.toHaveBeenCalled()
})

test('uses the registered Desktop CLI with an isolated PATH and picks up Store updates', async () => {
  files.add(desktopCli)
  await expect(resolveCodexExecutable('CODEX.EXE')).resolves.toBe(desktopCli)
  const [powershell, args, options] = query.mock.calls[0]
  expect(powershell).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(args.at(-1)).toContain('OpenAI.Codex_2p2nqsd0c76g0')
  expect(options).toMatchObject({ windowsHide: true, timeout: expect.any(Number) })
  expect(stat.mock.calls).toEqual([[desktopCli]])

  const updated = desktop + '.1'
  const updatedCli = updated + '\\app\\resources\\codex.exe'
  query.mockResolvedValue({ stdout: updated + '\r\n' })
  files.add(updatedCli)
  await expect(resolveCodexExecutable('codex')).resolves.toBe(updatedCli)
})

test('keeps explicit executables and only searches PATH for a custom command', async () => {
  const custom = 'D:\\自定义 工具\\custom.exe'
  await expect(resolveCodexExecutable(custom)).resolves.toBe(custom)
  await expect(resolveCodexExecutable('.\\codex.exe')).rejects.toThrow(/absolute path/)
  expect(stat).not.toHaveBeenCalled()
  vi.stubEnv('PATH', 'D:\\自定义 工具')
  files.add(custom)
  await expect(resolveCodexExecutable('custom')).resolves.toBe(custom)
  await expect(resolveCodexExecutable('missing')).rejects.toThrow(/PATH/)
  expect(query).not.toHaveBeenCalled()
})

test('reports a missing CLI when the package is unavailable or only has the desktop GUI', async () => {
  files.add(desktop + '\\app\\Codex.exe')
  query.mockResolvedValueOnce({ stdout: '.\\workspace\r\n' + desktop + '\r\n' })
  await expect(resolveCodexExecutable('codex')).rejects.toThrow(/完整路径/)
  expect(stat.mock.calls).toEqual([[desktopCli]])
  query.mockRejectedValueOnce(new Error('Appx unavailable'))
  await expect(resolveCodexExecutable('codex')).rejects.toThrow(/完整路径/)
})

test('passes cancellation through a pending package query', async () => {
  const controller = new AbortController()
  query.mockImplementationOnce(async (_exe, _args, { signal }) => {
    expect(signal).toBe(controller.signal)
    controller.abort(new Error('Check interrupted'))
    throw new Error('Aborted')
  })
  await expect(resolveCodexExecutable('codex', controller.signal)).rejects.toThrow('Check interrupted')
  expect(stat).not.toHaveBeenCalled()
})

test('preserves command lookup on other platforms', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  await expect(resolveCodexExecutable('codex')).resolves.toBe('codex')
  await expect(resolveCodexExecutable('./local/codex')).resolves.toBe('./local/codex')
  expect(stat).not.toHaveBeenCalled()
  expect(query).not.toHaveBeenCalled()
})
