// The session's line to the shared daemon: one socket connection, opened on the first call and again after it drops;
// when nothing answers, the daemon is started detached (it outlives this server) and waited for.
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { peer } from '../daemon/jsonrpc.mjs'

const DAEMON = fileURLToPath(new URL('../daemon/main.mjs', import.meta.url))
// How long a start of the daemon is waited for.
const START_MS = 10_000

/**
 * @param {string} path
 * @returns {Promise<ReturnType<typeof peer>>}
 */
function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.setEncoding('utf8')
    const rpc = peer({ write: (line) => void (socket.writable && socket.write(line)) })
    socket.once('connect', () => resolve(rpc))
    socket.once('error', reject)
    socket.on('data', (chunk) => rpc.feed(String(chunk)))
    socket.on('close', () => rpc.close(new Error('The orchestrator daemon closed the connection.')))
    socket.on('error', () => {})
  })
}

/**
 * @param {{ stateDir: string, socketPath: string, env: Record<string, string | undefined> }} at
 */
export function daemonClient(at) {
  /** @type {Promise<ReturnType<typeof peer>> | undefined} */
  let connection

  async function start() {
    await mkdir(at.stateDir, { recursive: true, mode: 0o700 })
    const logFile = await open(join(at.stateDir, 'daemon.log'), 'a', 0o600)
    const child = spawn(process.execPath, [DAEMON], { cwd: at.stateDir, env: at.env, detached: true, stdio: ['ignore', logFile.fd, logFile.fd] })
    child.unref()
    await logFile.close()
    const deadline = Date.now() + START_MS
    for (;;) {
      try {
        return await connect(at.socketPath)
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`The orchestrator daemon did not start: see ${join(at.stateDir, 'daemon.log')}.`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }

  async function line() {
    connection ??= connect(at.socketPath).catch(start)
    try {
      return await connection
    } catch (error) {
      connection = undefined
      throw error
    }
  }

  return {
    /**
     * @param {string} method
     * @param {unknown} params
     */
    async request(method, params) {
      const rpc = await line()
      try {
        return await rpc.request(method, params)
      } catch (error) {
        // A connection the daemon dropped (it stopped while idle) is opened again, once.
        if (!(error instanceof Error) || !/closed the connection/.test(error.message)) throw error
        connection = undefined
        return (await line()).request(method, params)
      }
    },
  }
}
