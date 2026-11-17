// What the daemon and its clients agree on: the socket's path, named by the plugin's version, and the check of a pid.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The plugin's version, which names the socket: a session of a newer version starts its own daemon. */
export async function versionOf() {
  const manifest = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  return String(manifest.version)
}

/** @param {string} stateDir @param {string} version */
export const socketPathOf = (stateDir, version) => join(stateDir, `daemon-${version}.sock`)

/** Whether a process is alive (one of another user's counts). @param {number} pid */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}
