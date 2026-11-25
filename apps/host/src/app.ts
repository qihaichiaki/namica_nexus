import Fastify from 'fastify'
import staticFiles from '@fastify/static'
import { existsSync, mkdirSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { AgentAdapter } from '../../../packages/agent-core/src/index.js'
import { createCodexAdapter } from '../../../packages/agent-codex/src/index.js'
import type { HostEvent, HostStatus, Runtime } from '../../../packages/protocol/src/index.js'
import { HttpError, Store } from './store.js'
import { Tasks } from './tasks.js'
import { codexHomeFor, resolveDataDirectory } from './paths.js'

const text = (max: number) => z.string().max(max)
const requiredText = (max: number) => z.string().trim().min(1).max(max)
const directory = text(32767).trim().refine(s => !s || isAbsolute(s), 'Workspace must be an absolute path.')
// Check the original spelling too: URL normalizes dot segments, backslashes and empty userinfo.
const proxyUrl = text(2048).trim().refine(value => {
  if (!value) return true
  if (!/^https?:\/\/[^/@?#\\\s]+\/?$/i.test(value) || !URL.canParse(value)) return false
  return new URL(value).port !== '0'
}, '请输入 HTTP(S) 代理地址，例如 http://127.0.0.1:7890。地址只包含协议、主机和可选端口。')
const identitySchema = z.strictObject({
  name: requiredText(120), description: text(4096), personality: text(32000),
  avatar: text(2048), runtimeConfigId: requiredText(120), workspace: directory,
})
const runtimePatch = z.strictObject({
  executable: requiredText(32767), workspace: directory,
  model: text(300), enabled: z.boolean(), proxyUrl,
}).partial()
const configPatch = z.strictObject({
  logLevel: z.enum(['debug','info','warn','error']),
  executionTimeoutSeconds: z.number().int().min(5).max(86400), defaultRuntimeId: requiredText(120),
}).partial()

export interface HostOptions {
  dataDirectory?: string
  port?: number
  dev?: boolean
  webDirectory?: string
  adapterFactory?: (runtime: Runtime) => AgentAdapter
}
export async function buildHost(options: HostOptions = {}) {
  const dataDirectory = resolveDataDirectory(options.dataDirectory)
  const configuredPort = options.port ?? Number(process.env.NEXUS_PORT ?? 8080)
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('Invalid Host port.')
  const store = new Store(dataDirectory)
  const app = Fastify({
    logger: {level: store.config().logLevel},
    bodyLimit: 1024 * 1024,
    logController: new Fastify.LogController({disableRequestLogging: true}),
  })
  const codexAdapter = createCodexAdapter(codexHomeFor(dataDirectory))
  const adapterFor = options.adapterFactory ?? ((runtime: Runtime) => {
    if (runtime.type !== codexAdapter.type) throw new HttpError(400, 'Unknown runtime type.')
    return codexAdapter
  })
  const bootTime = Date.now()
  const clients = new Set<ServerResponse>()
  const pendingEvents = new Map<string, HostEvent>()
  let flushTimer: NodeJS.Timeout | undefined
  let closing = false
  function publish(event: HostEvent) {
    if (!clients.size || closing) return
    pendingEvents.set(event.type + (event.sessionId ?? ''), event)
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined
      for (const event of pendingEvents.values()) {
        const packet = 'data: ' + JSON.stringify(event) + '\n\n'
        for (const client of clients) {
          // EventSource will reconnect and fetch a snapshot if its reader has stalled.
          if (!client.write(packet)) client.destroy()
        }
      }
      pendingEvents.clear()
    }, 35)
  }
  const tasks = new Tasks(store, adapterFor, publish, app.log)
  const port = () => {
    const listening = app.server.address()
    return listening && typeof listening === 'object' ? listening.port : configuredPort
  }
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host
    const addresses = ['127.0.0.1', 'localhost'].map(name => port() === 80 ? name : name + ':' + port())
    if (!host || !addresses.includes(host)) throw new HttpError(403, 'Unrecognized Host.')
    const origin = request.headers.origin
    const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']
    const devRequest = options.dev && origin !== undefined && devOrigins.includes(origin)
    if ((origin !== undefined && origin !== 'http://' + host && !devRequest) ||
        (request.headers['sec-fetch-site'] === 'cross-site' && !devRequest)) throw new HttpError(403, 'Unrecognized Origin.')
    if (closing) throw new HttpError(503, 'Host is shutting down.')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  })
  app.setErrorHandler((error: Error & {statusCode?: number}, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({error: error.issues.map(i => i.path.join('.') + ' ' + i.message).join(', ')})
    const status = error.statusCode ?? 500
    if (status >= 500) app.log.error({err: error}, 'Host request failed')
    return reply.code(status).send({error: status >= 500 ? 'Host request failed.' : error.message})
  })

  app.get('/api/host/status', (): HostStatus => ({
    version: '0.1.0', status: 'running', uptimeSeconds: Math.floor((Date.now()-bootTime)/1000),
    address: '127.0.0.1', port: port(), dataDirectory, logLevel: store.config().logLevel,
  }))
  app.get('/api/host/config', () => store.config())
  app.patch('/api/host/config', req => {
    const config = store.saveConfig({...store.config(), ...configPatch.parse(req.body)})
    app.log.level = config.logLevel
    publish({type: 'config.changed'})
    return config
  })

  type IdRoute = { Params: {id: string} }
  const checks = new Set<string>()
  app.get('/api/runtimes', () => store.runtimes().map(r => tasks.runtimeState(r)))
  app.patch<IdRoute>('/api/runtimes/:id', req => {
    const runtime = tasks.runtimeState(store.runtime(req.params.id))
    if (checks.has(runtime.id) || runtime.processState === 'running') throw new HttpError(409, 'Runtime is busy.')
    const result = store.saveRuntime({...runtime, ...runtimePatch.parse(req.body), version: null, available: null, detail: ''})
    publish({type: 'runtimes.changed'})
    return result
  })
  app.post<IdRoute>('/api/runtimes/:id/check', async req => {
    const runtime = store.runtime(req.params.id)
    if (checks.has(runtime.id)) throw new HttpError(409, 'Check already in progress.')
    checks.add(runtime.id)
    try {
      mkdirSync(runtime.workspace, {recursive: true})
      const result = await adapterFor(runtime).checkAvailability(runtime)
      return tasks.runtimeState(store.saveRuntime({...runtime, ...result}))
    } catch (err) {
      return tasks.runtimeState(store.saveRuntime({...runtime, available: false, version: null,
        detail: err instanceof Error ? err.message : 'Check failed.'}))
    } finally { checks.delete(runtime.id); publish({type: 'runtimes.changed'}) }
  })

  app.get('/api/identities', () => store.identities())
  app.post('/api/identities', (req, reply) => {
    const body = identitySchema.partial().required({name: true}).parse(req.body)
    const identity = store.saveIdentity({description: '', personality: '', avatar: '', workspace: '',
      runtimeConfigId: store.config().defaultRuntimeId, ...body})
    publish({type: 'identities.changed'})
    return reply.code(201).send(identity)
  })
  app.patch<IdRoute>('/api/identities/:id', req => {
    const identity = store.identity(req.params.id)
    const updated = store.saveIdentity({...identity, ...identitySchema.partial().parse(req.body)}, identity)
    publish({type: 'identities.changed'})
    return updated
  })
  app.get<{Querystring: {identityId?: string}}>('/api/sessions', req => {
    const {identityId} = z.object({identityId: z.string().optional()}).parse(req.query)
    return store.sessions(identityId)
  })
  app.post('/api/sessions', (req, reply) => {
    const input = z.strictObject({identityId: requiredText(120), title: requiredText(200).optional()}).parse(req.body)
    const session = store.createSession(input.identityId, input.title)
    publish({type: 'session.changed', sessionId: session.sessionId})
    return reply.code(201).send(session)
  })
  app.get<IdRoute>('/api/sessions/:id', req => tasks.snapshot(req.params.id))
  app.get<IdRoute>('/api/sessions/:id/messages', req => store.snapshot(req.params.id).messages)
  app.post<IdRoute>('/api/sessions/:id/messages', (req, reply) => {
    const {content} = z.strictObject({content: text(128000).refine(s => !!s.trim(), 'Message cannot be empty.')}).parse(req.body)
    return reply.code(202).send(tasks.start(req.params.id, content))
  })
  app.post<IdRoute>('/api/sessions/:id/cancel', (req, reply) => {
    tasks.cancel(req.params.id)
    return reply.code(202).send({ok: true})
  })
  app.post<{Params: {id: string; approvalId: string}}>('/api/sessions/:id/approvals/:approvalId', (req, reply) => {
    const {decision} = z.strictObject({decision: z.enum(['accept','decline'])}).parse(req.body)
    tasks.respond(req.params.id, req.params.approvalId, decision === 'accept')
    return reply.send({ok: true})
  })
  app.get('/api/events', (_req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})
    res.write('retry: 1000\n: connected\n\n')
    clients.add(res)
    const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy() }, 15000)
    res.once('close', () => { clients.delete(res); clearInterval(heartbeat) })
  })
  const webDirectory = resolve(options.webDirectory ?? 'apps/web/dist')
  if (existsSync(join(webDirectory, 'index.html'))) {
    await app.register(staticFiles, {root: webDirectory})
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.headers.accept?.includes('text/html'))
        return reply.sendFile('index.html')
      return reply.code(404).send({error: 'Resource not found.'})
    })
  }
  app.addHook('preClose', async () => {
    closing = true
    clearTimeout(flushTimer)
    for (const client of clients) client.end()
    await tasks.stop()
  })
  app.addHook('onClose', async () => store.close())
  return app
}
