// Run after npm run build. All service data and launcher files live in a disposable installation.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { compileLauncher } from '../scripts/windows/build.mjs'

const main = resolve('dist/apps/host/src/main.js')
await access(main)
const root = await mkdtemp(join(await realpath(tmpdir()), 'nexus-production-deployment-'))
const source = join(root, 'source'), target = join(root, '迁移 data')
let processHost
let guard
let serviceUrl
const receipts = '/api/manage/host/restart-result/'
async function reserve(address) {
  const server = createServer()
  server.listen(0, address)
  await once(server, 'listening')
  return server
}
async function close(server) { await new Promise(resolve => server.close(resolve)) }
async function port(address) {
  const reservation = await reserve(address), port = reservation.address().port
  await close(reservation)
  return port
}
function get(base, route, method, body, headers) {
  return fetch(base + route, {method, headers: {...(body && {'content-type': 'application/json'}), ...headers},
    body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(1500)})
}
// Browser navigation sends Fetch Metadata that fetch() implementations may overwrite.
function navigation(base, path, headers = {}) {
  return new Promise((accept, reject) => {
    const req = httpGet(new URL(path, base), {headers: {
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers,
    }}, res => {
      const parts = []
      res.on('data', chunk => parts.push(chunk))
      res.on('end', () => accept({status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString()}))
      res.on('error', reject)
    })
    req.setTimeout(1500, () => req.destroy(new Error('navigation timed out')))
    req.on('error', reject)
  })
}
async function waitStatus(base, condition = () => true) {
  for (let i = 0; i < 100; ++i) {
    try {
      const res = await get(base, '/api/manage/host/status')
      if (res.ok) {
        const status = await res.json()
        if (condition(status)) return status
      }
    } catch {}
    await delay(75)
  }
  throw new Error('Host readiness timed out on ' + base)
}

try {
  const initial = await port('127.0.0.1'), ipv6Port = await port('::1')
  const old = 'http://127.0.0.1:' + initial, next = 'http://[::1]:' + ipv6Port
  const env = {...process.env, NEXUS_PORT: String(initial), NEXUS_ADDRESS: '127.0.0.1', NEXUS_DATA_DIR: source}
  delete env.NEXUS_DEPLOYMENT_FILE
  serviceUrl = old
  await mkdir(join(root, 'apps/web/dist/console'), {recursive: true})
  for (const file of ['apps/web/dist/index.html', 'apps/web/dist/console/index.html']) await writeFile(join(root, file), '<title>Fixture</title>')
  processHost = spawn(process.execPath, [main], {env, cwd: root, windowsHide: true, stdio: 'ignore'})
  const status = await waitStatus(old)
  const {id} = await (await get(old, '/api/identities', 'POST', {name: 'Synthetic identity'})).json()
  const authFile = join(source, 'codex-home', 'auth.json')
  await mkdir(join(source, 'codex-home'), {recursive: true})
  await writeFile(authFile, 'SYNTHETIC FILE ONLY')
  await copyFile(new URL('./fixtures/codex-account.cjs', import.meta.url), join(source, 'app-server'))
  await writeFile(join(source, 'codex-home', 'synthetic-account'), 'fixture')
  assert.equal((await get(old, '/api/manage/runtimes/codex', 'PATCH', {executable: process.execPath})).status, 200)
  const account = '/api/manage/auth/codex'
  assert.equal((await (await get(old, account + '/login', 'POST', {method: 'device'})).json()).state, 'pending')
  const loginProcess = Number(await readFile(join(source, 'account-pid'), 'utf8'))
  const restart = '/api/manage/host/restart', deploy = '/api/manage/deployment'
  const confirmation = {instanceId: status.instanceId, activeTurns: 0}
  assert.equal((await get(old, restart, 'POST', {activeTurns: 0})).status, 400)
  assert.equal((await get(old, restart, 'POST', {...confirmation, activeTurns: 1})).status, 409)
  assert.equal((await get(old, deploy, 'PATCH', {address: '0.0.0.0'})).status, 400)
  assert.equal((await get(old, deploy, 'PATCH', {port: ipv6Port}, {Origin: 'https://foreign.example'})).status, 403)
  guard = await reserve('127.0.0.1')
  const collision = guard.address().port
  assert.equal((await get(old, deploy, 'PATCH', {port: collision})).status, 200)
  assert.equal((await get(old, restart, 'POST', confirmation)).status, 409)
  assert.equal((await waitStatus(old)).instanceId, status.instanceId)
  await close(guard)
  guard = undefined
  const pending = {address: '::1', port: ipv6Port, dataDirectory: target}
  assert.equal((await get(old, deploy, 'PATCH', pending)).status, 200)
  assert.equal((await get(old, restart, 'POST', {...confirmation, expectedPending: {...pending, dataDirectory: source}})).status, 409)
  const res = await get(old, restart, 'POST', {...confirmation, expectedPending: pending}, {Origin: old})
  assert.equal(res.status, 202, await res.clone().text())
  const receipt = await res.json()
  assert.equal(receipt.consoleUrl, next + '/console/')
  serviceUrl = next
  const current = await waitStatus(next)
  assert.notEqual(current.instanceId, status.instanceId)
  assert.equal(current.dataDirectory, target)
  assert.throws(() => process.kill(loginProcess, 0))
  const confirm = await get(next, receipts + receipt.restartId, 'GET', undefined, {Origin: old, 'sec-fetch-site': 'cross-site'})
  assert.equal(confirm.headers.get('access-control-allow-origin'), old)
  assert.deepEqual(await confirm.json(), {status: 'ready', consoleUrl: next + '/console/', instanceId: current.instanceId})
  const landing = '/console/?restart=' + receipt.restartId
  const document = await navigation(next, landing)
  assert.equal(document.status, 200, document.body)
  assert.match(document.body, /<title>Fixture<\/title>/)
  assert.equal(document.headers['access-control-allow-origin'], undefined)
  for (const [path, headers] of [
    ['/console/', {}], [landing + 'wrong', {}], [landing + '&extra=1', {}],
    [landing, {Origin: 'https://foreign.example'}], [landing, {'sec-fetch-mode': 'cors'}],
    [landing, {'sec-fetch-dest': 'iframe'}], ['/api/identities?restart=' + receipt.restartId, {}],
  ]) assert.equal((await navigation(next, path, headers)).status, 403)
  assert.equal((await get(next, receipts + receipt.restartId, 'GET', undefined, {Origin: 'https://foreign.example'})).status, 403)
  assert.equal((await get(next, '/api/identities', 'GET', undefined, {Origin: old})).status, 403)
  assert.equal((await (await get(next, '/api/identities')).json())[0].id, id)
  assert.equal(await readFile(join(target, 'codex-home', 'auth.json'), 'utf8'), 'SYNTHETIC FILE ONLY')
  assert.equal(await readFile(authFile, 'utf8'), 'SYNTHETIC FILE ONLY')
  const cli = spawn(process.execPath, [resolve('dist/apps/host/src/codex-login.js'), 'status'], {env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
  let summary = ''
  cli.stdout.on('data', chunk => { summary += chunk })
  cli.stderr.on('data', chunk => { summary += chunk })
  assert.equal((await once(cli, 'exit'))[0], 0, summary)
  assert.match(summary, /已登录.*ChatGPT/)
  console.log('PASS running CLI status follows the migrated deployment and pending authorization drains on restart')
  console.log('PASS production IPv4→IPv6 restart, instance/tasks/settings guards, private receipt, identity/login copy and backup')

  // Saving now and stopping must apply on the next ordinary start. Introduce an unrelated file after save.
  const unrelated = join(root, 'occupied')
  assert.equal((await get(next, deploy, 'PATCH', {dataDirectory: unrelated})).status, 200)
  await mkdir(unrelated)
  await writeFile(join(unrelated, 'keep'), 'unrelated')
  const stopped = once(processHost, 'exit')
  await get(next, '/api/manage/host/shutdown', 'POST', {instanceId: current.instanceId, activeTurns: 0})
  await stopped
  processHost = undefined
  if (process.platform === 'win32') {
    // Use the real launcher and production Host; redirect only the browser and modal-dialog callbacks.
    for (const dir of ['dist/apps/host/src', 'apps/web/dist/console']) await mkdir(join(root, dir), {recursive: true})
    await writeFile(join(root, 'dist/windows-node.txt'), process.execPath)
    await writeFile(join(root, 'dist/apps/host/src/main.js'), 'import(' + JSON.stringify(pathToFileURL(main).href) + ').catch(() => { process.exitCode = 1 })')
    const testMain = join(root, 'TestMain.cs'), launcher = join(root, 'test-launcher.exe'), result = join(root, 'launcher-result')
    await writeFile(testMain, 'using System; using System.IO; class TestMain { static int Main() { Action<string> output = s => File.WriteAllText(Environment.GetEnvironmentVariable("NEXUS_TEST_OUTPUT"), s); return Launcher.Run(output, output); } }')
    compileLauncher(launcher, {entry: 'TestMain', sources: [testMain]})
    async function launch() {
      const child = spawn(launcher, [], {cwd: tmpdir(), env: {...env, NEXUS_TEST_OUTPUT: result}, windowsHide: true, stdio: 'ignore'})
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, await readFile(result, 'utf8').catch(() => 'launcher'))
      assert.equal(await readFile(result, 'utf8'), next + '/console/')
    }
    await launch()
    const recovered = await waitStatus(next)
    const deployed = await (await get(next, deploy)).json()
    assert.equal(deployed.active.dataDirectory, target)
    assert.deepEqual(deployed.active, deployed.pending)
    assert.match(deployed.lastError, /目标/)
    assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'unrelated')
    await launch()
    assert.equal((await waitStatus(next)).instanceId, recovered.instanceId)
    console.log('PASS compiled launcher applies saved settings, falls back safely and reuses the recovered IPv6 Host')
  }
} finally {
  if (serviceUrl) {
    try {
      const status = await (await get(serviceUrl, '/api/manage/host/status')).json()
      if ([source, target].includes(status.dataDirectory)) await get(serviceUrl, '/api/manage/host/shutdown', 'POST', {instanceId: status.instanceId, activeTurns: 0})
    } catch {}
  }
  if (processHost?.exitCode === null) processHost.kill()
  if (guard) await close(guard)
  await rm(root, {recursive: true, force: true, maxRetries: 15, retryDelay: 100})
}
