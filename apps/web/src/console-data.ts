import { api } from './data'
import type { HostStatus } from './data'

export const statusPath = '/manage/host/status'
export const deploymentPath = '/manage/deployment'
export const requestTimeout = 6000

export interface LaunchSettings {
  address: '127.0.0.1' | '::1'
  port: number
  dataDirectory: string
}

export interface Deployment {
  active: LaunchSettings
  pending: LaunchSettings
  lastError?: string
}

export function formatListener(address: string, port: number) {
  return (address.includes(':') ? '[' + address + ']' : address) + ':' + port
}

export function readConsoleResource<T>(path: string) {
  return api<T>(path, 'GET', undefined, AbortSignal.timeout(requestTimeout))
}

export async function readHostStatus() {
  const status = await readConsoleResource<HostStatus>(statusPath)
  if (status?.service !== 'namica-nexus' || !status.instanceId || status.status !== 'running' ||
      !Number.isInteger(status.activeTurns) || status.activeTurns < 0) {
    throw new Error('无法确认此端口上的 Namica Nexus Host。')
  }
  return status
}
