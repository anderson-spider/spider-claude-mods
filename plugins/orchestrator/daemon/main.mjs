// The orchestrator daemon: one per user and plugin version, shared by every Claude Code session. The MCP server of a
// session starts it when its socket does not answer; it serves the tools over that socket, runs the tasks, and exits
// once it has had no task and no client for IDLE_MS. Started as `node daemon/main.mjs`, detached, its output in
// daemon.log of the state folder.
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stateDirOf } from '../hooks/paths.ts'
import { probe, runTurn } from './acp.mjs'
import { acpArgv, locateAgy, prepareProfile } from './agy.mjs'
import { peer } from './jsonrpc.mjs'
import { createOrchestrator } from './orchestrator.mjs'
import { isAlive, socketPathOf, versionOf } from './socket.mjs'
import { createStore } from './store.mjs'

/** @import { Caller } from './orchestrator.mjs' */

const IDLE_MS = 15 * 60_000

/** Whether something answers on the socket. @param {string} path */
const answers = (path) =>
  new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

const log = (/** @type {string} */ text) => process.stderr.write(`${new Date().toISOString()} ${text}\n`)

async function main() {
  const home = process.env.HOME || homedir()
  const stateDir = stateDirOf(home, process.env.XDG_STATE_HOME)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  const version = await versionOf()
  const store = createStore(stateDir)
  await store.init()
  const probeDir = join(stateDir, 'probe')
  await mkdir(probeDir, { recursive: true, mode: 0o700 })
  const orchestrator = createOrchestrator({
    store,
    runTurn,
    probe,
    locate: (agyPath) => locateAgy(agyPath, process.env),
    argvOf: acpArgv,
    prepare: () => prepareProfile(home),
    probeDir,
    version,
    pid: process.pid,
    isAlive,
    log,
  })

  const path = socketPathOf(stateDir, version)
  let clients = 0
  let idleSince = Date.now()
  const server = createServer((socket) => {
    clients++
    socket.setEncoding('utf8')
    const rpc = peer({
      write: (line) => void (socket.writable && socket.write(line)),
      log,
      async onRequest(method, params) {
        idleSince = Date.now()
        /** @type {Caller} */
        const caller = params?.caller
        const input = params?.input ?? {}
        switch (method) {
          case 'hello':
            return { version, pid: process.pid }
          case 'orchestrator_capabilities':
            return orchestrator.capabilities(caller)
          case 'delegate_task':
            return orchestrator.delegate(caller, input)
          case 'task_status':
            return orchestrator.status(caller, input)
          case 'task_cancel':
            return orchestrator.cancel(caller, input)
          case 'thread_send':
            return orchestrator.threadSend(caller, input)
          default:
            throw new Error(`Unknown method ${method}`)
        }
      },
    })
    socket.on('data', (chunk) => rpc.feed(String(chunk)))
    socket.on('error', () => {})
    socket.on('close', () => {
      clients--
      idleSince = Date.now()
      rpc.close(new Error('client gone'))
    })
  })

  // A socket left by a daemon that died is removed; one that answers belongs to a live daemon, which serves instead.
  await new Promise((resolve, reject) => {
    server.once('error', async (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE') return reject(error)
      if (await answers(path)) {
        log('another daemon serves this socket; exiting')
        process.exit(0)
      }
      await rm(path, { force: true })
      server.listen(path, () => resolve(undefined))
    })
    server.listen(path, () => resolve(undefined))
  })
  await chmod(path, 0o600)
  log(`daemon ${version} listening on ${path} (pid ${process.pid})`)
  await orchestrator.recover()

  const stop = async (/** @type {string} */ why) => {
    log(`stopping: ${why}`)
    server.close()
    await orchestrator.stopAll()
    await rm(path, { force: true })
    process.exit(0)
  }
  setInterval(() => {
    if (clients === 0 && orchestrator.busy() === 0 && Date.now() - idleSince > IDLE_MS) void stop('idle')
  }, 30_000).unref()
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch((error) => {
  log(`daemon failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
