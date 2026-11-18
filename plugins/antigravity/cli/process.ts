// A child process with a hard bound: its own process group, stdin from /dev/null (agy -p waits on an open stdin), and
// SIGTERM then SIGKILL to the whole group when the bound passes, since agy ignores SIGTERM.
import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the executable could not be started at all. */
  spawnError?: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  /** How long after SIGTERM the group gets SIGKILL. */
  killGraceMs?: number
  /** What is kept of each stream, from its end. */
  maxBytes?: number
}

export function runProcess(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const [command = '', ...args] = argv
  const keep = options.maxBytes ?? 1_000_000
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const bound = setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), options.killGraceMs ?? 3_000)
    }, options.timeoutMs)
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(bound)
      clearTimeout(killTimer)
      resolve(result)
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout = (stdout + chunk).slice(-keep)))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-keep)))
    child.once('error', error => finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error.message }))
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut }))
  })
}
