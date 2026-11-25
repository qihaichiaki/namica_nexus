import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const source = fileURLToPath(new URL('./Launcher.cs', import.meta.url))

export function compileLauncher(output, { entry = 'Launcher', sources = [], target = 'winexe' } = {}) {
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const compiler = ['Framework64', 'Framework']
    .map(arch => join(windows, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe'))
    .find(existsSync)
  if (!compiler) throw new Error('The Windows .NET Framework C# compiler (csc.exe) is required to build Namica Nexus.exe.')

  const result = spawnSync(compiler, [
    '/nologo', '/utf8output', '/codepage:65001', '/optimize+',
    '/reference:System.Net.Http.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll',
    '/target:' + target, '/main:' + entry, '/out:' + output, source, ...sources,
  ], { cwd: root, windowsHide: true, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stdout + result.stderr).trim() || 'The Windows launcher failed to compile.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.platform === 'win32') {
  writeFileSync(join(root, 'dist', 'windows-node.txt'), process.execPath)
  compileLauncher(join(root, 'Namica Nexus.exe'))
}
