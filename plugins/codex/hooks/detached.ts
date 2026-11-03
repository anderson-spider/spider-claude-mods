import type { ProcessRunner, RunFiles } from './model'

// Starts a Codex run that outlives the plugin: `$.process.spawn` children die with the module on a reload, and the
// host has no detach option. The outer shell makes the folder, moves to the run's folder when one is given and starts
// the inner one under nohup with every stream redirected, so `$.process.run` returns at once. The inner shell starts
// Codex in the background, writes its pid, waits for it and writes its exit status and the time it ended. Arguments
// travel as positional parameters, never inside the script, so no quoting reaches them.
//   $1 run folder, $2 working folder or '', then the Codex argv
export const LAUNCH =
  'd=$1; c=$2; shift 2; mkdir -p "$d" || exit 1; if [ -n "$c" ]; then cd "$c" || exit 1; fi; ' +
  'nohup sh -c \'d=$1; shift; "$@" >"$d/events.jsonl" 2>"$d/stderr.txt" </dev/null & echo $! >"$d/pid"; wait $!; echo "$? $(date +%s)" >"$d/exit"\' ' +
  'sh "$d" "$@" >/dev/null 2>&1 </dev/null &'

/** The file `-o` writes the run's last message to, in its folder. */
export const answerPath = (dir: string) => `${dir}/answer.md`

// The most of the events read at either end: the start holds the thread, the end why a run failed. Neither ever reads
// the whole file, which a long run's command output can grow past what a host read takes.
const HEAD_BYTES = 8_192
const TAIL_BYTES = 65_536

/** What the runs need from the host: processes, text files, and Codex's own folder. */
export type DetachedHost = {
  run: ProcessRunner
  /** A text file's content, or undefined when there is none. */
  read(path: string): Promise<string | undefined>
  exists(path: string): Promise<boolean>
  codexHome: string
}

/**
 * A Codex process as `ps` shows it: the executable, then `exec` (a new run, a follow-up or a review). Another program
 * that took over a reused pid does not match, so it is never killed.
 */
export const isCodexRun = (command: string) => /codex\S*\s+exec\b/.test(command)

/** The run's `exit` file: its exit status and, in seconds, when it ended; undefined while it is not a status. */
export function parseExit(text: string | undefined): { exit: number; endedAt?: number } | undefined {
  const [status, seconds] = (text ?? '').trim().split(/\s+/)
  const exit = Number.parseInt(status ?? '', 10)
  if (Number.isNaN(exit)) return undefined
  const at = Number.parseInt(seconds ?? '', 10)
  return Number.isNaN(at) ? { exit } : { exit, endedAt: at * 1000 }
}

/**
 * Codex's last answer in a rollout since `sinceMs`: the newest `task_complete` event's `last_agent_message` stamped at
 * or after it, so a follow-up that died is never given the answer of an earlier turn of its thread.
 */
export function lastAnswerOf(rollout: string, sinceMs: number): string | undefined {
  const lines = rollout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i]?.trim()
    if (!text) continue
    try {
      const event = JSON.parse(text) as { timestamp?: unknown; type?: unknown; payload?: { type?: unknown; last_agent_message?: unknown } }
      if (event.type !== 'event_msg' || event.payload?.type !== 'task_complete') continue
      const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN
      if (!(at >= sinceMs)) return undefined
      return typeof event.payload.last_agent_message === 'string' ? event.payload.last_agent_message : undefined
    } catch {
      // A line cut short, or one that is not an event.
    }
  }
  return undefined
}

/** The runs as files on this machine. */
export function detachedRuns(host: DetachedHost): RunFiles {
  const pidOf = async (dir: string) => (await host.read(`${dir}/pid`))?.trim() || undefined
  const ends = async (args: string[]) => {
    const done = await host.run(args, { timeoutMs: 10_000 }).catch(() => undefined)
    return done?.exitCode === 0 ? done.stdout : ''
  }

  async function alive(dir: string): Promise<boolean> {
    const pid = await pidOf(dir)
    // The pid is written a moment after the start; until then the run counts as alive.
    if (!pid) return parseExit(await host.read(`${dir}/exit`)) === undefined
    const ps = await host.run(['ps', '-o', 'command=', '-p', pid], { timeoutMs: 5_000 })
    return ps.exitCode === 0 && isCodexRun(ps.stdout)
  }

  return {
    launch: async (dir, argv, cwd) => {
      const done = await host.run(['sh', '-c', LAUNCH, 'sh', dir, cwd ?? '', ...argv], { timeoutMs: 10_000 })
      if (done.exitCode !== 0) throw new Error(done.stderr.trim() || `the launch shell exited with code ${done.exitCode}`)
    },
    read: async dir => {
      if (!(await host.exists(dir))) return undefined
      const events = `${dir}/events.jsonl`
      const head = await ends(['head', '-c', String(HEAD_BYTES), events])
      const ended = parseExit(await host.read(`${dir}/exit`))
      if (!ended) return { head }
      const [tail, stderr, answer] = await Promise.all([
        ends(['tail', '-c', String(TAIL_BYTES), events]),
        ends(['tail', '-c', '4096', `${dir}/stderr.txt`]),
        host.read(answerPath(dir)),
      ])
      return { head, tail, stderr, ...ended, ...(answer === undefined ? {} : { answer }) }
    },
    alive,
    stop: async dir => {
      if (!(await alive(dir))) return false
      const pid = await pidOf(dir)
      if (!pid) return false
      return (await host.run(['kill', '-TERM', pid], { timeoutMs: 5_000 })).exitCode === 0
    },
    remove: async dir => void (await host.run(['rm', '-rf', dir], { timeoutMs: 10_000 })),
    recover: async (threadId, sinceMs) => {
      // Codex keeps each thread as sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, compressed to .zst once cold,
      // and moves archived threads to archived_sessions/.
      const found = await host.run(
        ['find', `${host.codexHome}/sessions`, `${host.codexHome}/archived_sessions`, '-name', `rollout-*-${threadId}.jsonl*`],
        { timeoutMs: 10_000 },
      )
      const path = found.stdout.split('\n').find(Boolean)
      if (!path) return undefined
      if (path.endsWith('.zst')) {
        const unpacked = await host.run(['zstd', '-dcq', path], { timeoutMs: 10_000 })
        return unpacked.exitCode === 0 ? lastAnswerOf(unpacked.stdout, sinceMs) : undefined
      }
      const text = await host.read(path)
      return text === undefined ? undefined : lastAnswerOf(text, sinceMs)
    },
  }
}
