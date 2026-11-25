// Windows integration check for the compiled launcher, with only the browser and dialog replaced.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { compileLauncher } from '../scripts/windows/build.mjs'

if (process.platform !== 'win32') {
  console.log('Skipped Windows launcher tests on ' + process.platform)
  process.exit(0)
}

const root = await mkdtemp(join(await realpath(tmpdir()), 'Namica 启动 测试 '))
const data = '测试 Data'
const dataDirectory = join(root, data)
const starter = join(root, 'Namica Nexus.exe')
const host = join(root, 'dist/apps/host/src/main.js')
const web = join(root, 'apps/web/dist/index.html')
const consolePage = join(root, 'apps/web/dist/console/index.html')
const buildNode = join(root, 'dist/windows-node.txt')
const starts = join(root, 'started.jsonl')
const testMain = join(root, 'TestMain.cs')
const statusPath = '/api/manage/host/status'
const status = {
  service: 'namica-nexus', status: 'running', address: '127.0.0.1',
  dataDirectory, activeTurns: 0,
}
const startedHosts = new Set()
const foreignServers = new Set()

async function serve(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  foreignServers.add(server)
  return server
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  foreignServers.delete(server)
}

async function launch(port, directory = data, { path = join(root, 'empty-path'), failBoot = false } = {}) {
  const resultPath = join(root, randomUUID() + '.result')
  const env = {
    ...process.env, NEXUS_PORT: String(port), NEXUS_DATA_DIR: directory,
    NEXUS_TEST_RESULT: resultPath, NEXUS_TEST_FAIL_BOOT: failBoot ? '1' : '',
  }
  const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'Path'
  env[pathKey] = path
  const child = spawn(starter, [], {
    cwd: tmpdir(), env, stdio: 'ignore', windowsHide: true, signal: AbortSignal.timeout(30_000),
  })
  const [code] = await once(child, 'exit')
  assert.ok(code === 0 || code === 1, 'unexpected launcher exit ' + code)
  const output = await readFile(resultPath, 'utf8')
  return { code, stdout: code === 0 ? output : '', stderr: code === 1 ? output : '' }
}

function base(port) {
  return 'http://127.0.0.1:' + port
}

function fetchLocal(port, path, init = {}) {
  return fetch(base(port) + path, { ...init, signal: AbortSignal.timeout(3_000) })
}

function assertOpen(result, port) {
  assert.deepEqual(result, { code: 0, stdout: base(port) + '/console/', stderr: '' })
}

async function stopHost(port) {
  assert.equal((await fetchLocal(port, '/stop', { method: 'POST' })).status, 202)
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await fetchLocal(port, statusPath)
    } catch {
      startedHosts.delete(port)
      return
    }
    await sleep(50)
  }
  throw new Error('Test Host did not stop on port ' + port)
}

try {
  await mkdir(dirname(host), { recursive: true })
  await mkdir(dirname(consolePage), { recursive: true })
  await mkdir(dataDirectory)
  await writeFile(web, '<title>Test Client</title>')
  await writeFile(consolePage, '<title>Test Console</title>')
  await writeFile(buildNode, process.execPath)
  await writeFile(testMain, [
    'using System;',
    'using System.IO;',
    'internal static class TestMain {',
    '    private static int Main() {',
    '        string output = Environment.GetEnvironmentVariable("NEXUS_TEST_RESULT");',
    '        Action<string> write = message => File.WriteAllText(output, message);',
    '        return Launcher.Run(write, write);',
    '    }',
    '}',
  ].join('\n'))
  compileLauncher(starter, { entry: 'TestMain', sources: [testMain] })
  await writeFile(host, [
    "const { appendFileSync } = require('node:fs')",
    "const { createServer } = require('node:http')",
    "if (process.env.NEXUS_TEST_FAIL_BOOT) process.exit(42)",
    "const port = Number(process.env.NEXUS_PORT)",
    "const dataDirectory = process.env.NEXUS_DATA_DIR",
    "appendFileSync('started.jsonl', JSON.stringify({ cwd: process.cwd(), dataDirectory }) + '\\n')",
    "const server = createServer((request, response) => {",
    "  if (request.method === 'POST' && request.url === '/stop') {",
    "    response.writeHead(202, { connection: 'close' }).end()",
    "    server.close()",
    "  } else if (request.url === '/api/manage/host/status') {",
    "    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({",
    "      service: 'namica-nexus', status: 'running', address: '127.0.0.1', port, dataDirectory, activeTurns: 0",
    "    }))",
    "  } else response.writeHead(404).end()",
    "})",
    "setTimeout(() => server.listen(port, '127.0.0.1'), 450)",
    "setTimeout(() => process.exit(), 30_000).unref()",
  ].join('\n'))

  const reservation = await serve()
  const port = reservation.address().port
  await close(reservation)
  startedHosts.add(port)
  for (const result of await Promise.all([launch(port), launch(port)])) assertOpen(result, port)
  assertOpen(await launch(port, '测试 data'), port)
  const start = JSON.parse((await readFile(starts, 'utf8')).trim())
  assert.equal(await realpath(start.cwd), root)
  assert.equal(start.dataDirectory, dataDirectory)
  assert.deepEqual(await (await fetchLocal(port, statusPath)).json(), { ...status, port })
  console.log('PASS simultaneous cold launch, single Host start without Node on PATH, repeated reuse and Unicode paths')

  const otherData = await launch(port, '其他 数据')
  assert.equal(otherData.code, 1)
  assert.equal(otherData.stdout, '')
  assert.match(otherData.stderr, new RegExp('端口 ' + port + ' 已占用'))
  assert.deepEqual(await (await fetchLocal(port, statusPath)).json(), { ...status, port })
  console.log('PASS rejected another data directory without stopping the existing Host')

  await stopHost(port)
  startedHosts.add(port)
  assertOpen(await launch(port), port)
  await stopHost(port)
  assert.equal((await readFile(starts, 'utf8')).trim().split('\n').length, 2)
  console.log('PASS restart on the same port after the Host exits')

  let seenPath
  const foreign = await serve((request, response) => {
    seenPath = request.url
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ...status, service: 'foreign', port: foreign.address().port,
    }))
  })
  const foreignPort = foreign.address().port
  const occupied = await launch(foreignPort)
  assert.equal(occupied.code, 1)
  assert.equal(occupied.stdout, '')
  assert.match(occupied.stderr, new RegExp('端口 ' + foreignPort + ' 已占用'))
  assert.equal(seenPath, statusPath)
  assert.equal((await (await fetchLocal(foreignPort, statusPath)).json()).service, 'foreign')
  assert.equal((await readFile(starts, 'utf8')).trim().split('\n').length, 2)
  console.log('PASS foreign port collision without launching a Host or stopping the listener')

  const failure = await launch(port, data, { failBoot: true })
  assert.equal(failure.code, 1)
  assert.equal(failure.stdout, '')
  assert.match(failure.stderr, /42.*npm start/)
  console.log('PASS actionable Host startup failure without opening the browser')

  await writeFile(buildNode, join(root, 'old-install', 'node.exe'))
  startedHosts.add(port)
  assertOpen(await launch(port, data, { path: dirname(process.execPath) }), port)
  await stopHost(port)
  console.log('PASS Node on PATH remains usable after the recorded installation moves')

  await rm(consolePage)
  const missingConsole = await launch(port, data, { path: dirname(process.execPath) })
  assert.equal(missingConsole.code, 1)
  assert.equal(missingConsole.stdout, '')
  assert.match(missingConsole.stderr, /npm run build/)
  assert.equal((await readFile(starts, 'utf8')).trim().split('\n').length, 3)
  console.log('PASS actionable error for a missing Console build before Host start')
} finally {
  await Promise.allSettled([...startedHosts].map(stopHost))
  await Promise.all([...foreignServers].map(close))
  await rm(root, { recursive: true, force: true, maxRetries: 8 })
}
