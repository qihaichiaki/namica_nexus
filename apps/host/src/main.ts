import { buildHost } from './app.js'

const port = Number(process.env.NEXUS_PORT ?? 8080)
const host = await buildHost({ port, dev: process.argv.includes('--dev') })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void host.close().catch(error => { console.error(error); process.exitCode = 1 }) })
}
try {
  const address = await host.listen({ host: '127.0.0.1', port })
  console.log('Namica Nexus listening at ' + address)
} catch (error) {
  await host.close()
  throw error
}
