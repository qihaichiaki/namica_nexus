import { once } from 'node:events'
import { buildHost } from '../../apps/host/src/app.js'
import type { AgentAdapter } from '../../packages/agent-core/src/index.js'

// Deterministic events allow the parent to terminate the Host at a known persistence boundary.
const adapter: AgentAdapter = {
  type: 'test',
  capabilities: { resume: true, stream: true, cancel: true, approvals: true },
  async checkAvailability(_options, signal) {
    process.send?.('check-started')
    await once(signal!, 'abort')
    const release = once(process, 'message')
    process.send?.('check-aborted')
    await release
    return {available: false, version: null, detail: 'stopped'}
  },
  run(_input, publish) {
    let finish!: (status: 'completed' | 'cancelled') => void
    const done = new Promise<'completed' | 'cancelled'>(resolve => { finish = resolve })
    const approvalId = 'fixture-approval'
    publish({type: 'session.ready', runtimeSessionId: 'fixture-thread'})
    publish({type: 'message.updated', content: 'Partial reply'})
    publish({type: 'tool.started', itemId: 'fixture-tool', label: 'Read fixture'})
    publish({type: 'approval.requested', approvalId, label: 'Read fixture?'})
    return {
      done,
      cancel() {
        publish({type: 'tool.completed', itemId: 'fixture-tool', label: 'Read fixture', failed: true})
        finish('cancelled')
      },
      respondApproval(id, allow) {
        if (id !== approvalId) return false
        publish({type: 'approval.resolved', approvalId})
        publish({type: 'tool.completed', itemId: 'fixture-tool', label: 'Read fixture', failed: !allow,
          detail: allow ? 'exit 0' : 'declined'})
        publish({type: 'message.updated', content: allow ? 'Accepted' : 'Declined'})
        finish('completed')
        return true
      },
    }
  },
}

const host = await buildHost({ dataDirectory: process.argv[2], port: 0, adapterFactory: () => adapter })
const address = await host.listen({port: Number(process.argv[3]), host: '127.0.0.1'})
process.send?.(address)
