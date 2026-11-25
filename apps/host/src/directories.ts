import { execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { promisify } from 'node:util'
import { HttpError } from './store.js'

interface DirectoryEntry { name: string; path: string }
interface DirectoryPage { path: string; parent: string | null; entries: DirectoryEntry[] }

const windows = process.platform === 'win32'
const execute = promisify(execFile)
const driveQuery = [
  '[System.IO.DriveInfo]::GetDrives()',
  "Where-Object { $_.DriveType -in 'Fixed','Removable','CDRom','Ram' -and $_.IsReady }",
  'ForEach-Object { $_.Name }',
].join(' | ')
const drivePath = /^[a-z]:[/\\]/i
const reservedName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i

async function localRoots() {
  if (!windows) return ['/']
  const system = process.env.SystemRoot
  if (!system || !drivePath.test(system)) throw new HttpError(422, '无法读取本机磁盘列表。')
  try {
    const powerShell = win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await execute(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', driveQuery], {
      cwd: system, windowsHide: true, timeout: 5000, maxBuffer: 2048,
    })
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-z]:\\$/i.test(line)).sort()
  } catch { throw new HttpError(422, '无法读取本机磁盘列表。') }
}

function localPath(input: string, roots: string[]) {
  if (!isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input)) throw new HttpError(400, '请输入本机目录的绝对路径。')
  if (windows && (!drivePath.test(input) || input.slice(3).split(/[/\\]/).some(segment =>
    (segment !== '.' && segment !== '..') && (/[<>:"|?*]|[ .]$/.test(segment) || reservedName.test(segment))
  ))) throw new HttpError(400, '仅可浏览本机磁盘中的目录。')
  const path = resolve(input)
  const { root } = parse(path)
  if (!roots.some(value => relative(root, value) === '')) throw new HttpError(400, '仅可浏览本机磁盘中的目录。')
  return path
}

async function confirmDirectory(path: string) {
  // Do not traverse reparse points that could redirect a drive-rooted path to a share.
  let { root } = parse(path)
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    root = join(root, segment)
    const entry = await lstat(root)
    if (entry.isSymbolicLink()) throw new HttpError(403, '文件夹选择器无法浏览符号链接或目录联接。')
    if (!entry.isDirectory()) throw new HttpError(404, '目录不存在或已不可用。')
  }
}

export async function browseDirectories(input = ''): Promise<DirectoryPage> {
  const roots = await localRoots()
  if (!input) {
    const entries = roots.map(root => ({ name: root, path: root }))
    try {
      const home = localPath(homedir(), roots)
      await confirmDirectory(home)
      if (home !== parse(home).root) entries.unshift({name: '用户主目录', path: home})
    } catch { /* A redirected or unavailable home is optional. */ }
    return { path: '', parent: null, entries }
  }
  const path = localPath(input, roots)
  try {
    await confirmDirectory(path)
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { path, parent: dirname(path) === path ? '' : dirname(path), entries }
  } catch (error) {
    if (error instanceof HttpError) throw error
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, '目录不存在或已不可用。')
    if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, '没有权限读取该目录。')
    throw new HttpError(422, '无法读取该目录。')
  }
}
