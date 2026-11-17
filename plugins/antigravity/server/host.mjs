// The host the plugin's pure modules run on in the MCP server: processes, files and the session, on Node. It has no
// status line, toast or new turn: a background job it starts is handed off to the hooks module (hooks/runner.ts).
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @import { Host } from '../hooks/service'
 * @import { Entry, ProcessRunner } from '../hooks/model'
 */

// A process's output kept in memory: an agy run's own output goes to files (hooks/detached.ts), so what comes here is small.
const MAX_OUTPUT = 16 * 1024 * 1024

/**
 * Runs `argv` without a shell, `stdin` fed in when given; resolves with its exit code and output, and rejects only
 * when it cannot start, as the hooks engine's process.run does. Past `timeoutMs` it is killed and exits 124.
 * @type {ProcessRunner}
 */
export function run(argv, init = {}) {
  return new Promise((resolve, reject) => {
    const [command = '', ...args] = argv
    const child = spawn(command, args, { cwd: init.cwd, env: { ...process.env, ...init.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => void (stdout.length < MAX_OUTPUT && (stdout += chunk)))
    child.stderr.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => void (stderr.length < MAX_OUTPUT && (stderr += chunk)))
    const timer = init.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), init.timeoutMs) : undefined
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(init.stdin ?? '')
  })
}

/**
 * @param {string} path
 * @returns {Promise<Entry[]>}
 */
async function list(path) {
  const entries = await readdir(path, { withFileTypes: true })
  return Promise.all(
    entries.map(async (entry) => {
      const info = await stat(`${path}/${entry.name}`).catch(() => undefined)
      /** @type {Entry['kind']} */
      const kind = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'
      return { name: entry.name, kind, mtimeMs: info?.mtimeMs ?? 0 }
    }),
  )
}

/**
 * @param {{ project: string, pid: number | undefined, sessionId: string, progress: (message: string) => void }} session
 * @returns {Host}
 */
export function nodeHost(session) {
  return {
    run,
    env: async (name) => process.env[name] || undefined,
    exists: (path) => access(path).then(() => true, () => false),
    read: (path) => readFile(path, 'utf8').catch(() => undefined),
    readBytes: async (path) => ({ base64: (await readFile(path)).toString('base64') }),
    async write(path, text) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    list,
    sessionId: async () => session.sessionId,
    project: () => session.project,
    pid: () => session.pid,
    // A wait keeps the call alive with a progress beat on its token
    sleep: (ms) => {
      session.progress('agy is working')
      return new Promise((resolve) => setTimeout(resolve, ms))
    },
  }
}
