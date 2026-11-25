import { join, resolve } from 'node:path'

export function resolveDataDirectory(override = process.env.NEXUS_DATA_DIR) {
  return resolve(override || 'data')
}

export function codexHomeFor(dataDirectory: string) {
  return join(dataDirectory, 'codex-home')
}
