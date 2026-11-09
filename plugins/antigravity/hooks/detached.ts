import type { ProcessRunner, RunFiles } from './model'

// Starts an agy run that outlives the plugin: `$.process.spawn` children die with the module on a reload, and the
// host has no detach option. The outer shell makes the folder, moves to the working folder and starts the inner one
// under nohup with every stream redirected, so `$.process.run` returns at once. The inner shell starts agy in the
// background with stdin from /dev/null (`agy -p` waits on an open stdin), writes its pid, waits for it and writes its
// exit status and the time it ended. Arguments travel as positional parameters, never inside the script, so no
// quoting reaches them.
//   $1 run folder, $2 working folder, then the agy argv
export const LAUNCH =
  'd=$1; c=$2; shift 2; mkdir -p "$d" || exit 1; cd "$c" || exit 1; ' +
  'nohup sh -c \'d=$1; shift; "$@" >"$d/events.jsonl" 2>"$d/stderr.txt" </dev/null & echo $! >"$d/pid"; wait $!; echo "$? $(date +%s)" >"$d/exit"\' ' +
  'sh "$d" "$@" >/dev/null 2>&1 </dev/null &'

// The most of the events read at the start (the `init` event and its conversation), and the lines read at the end:
// the `result` event is the last line, and holds the whole answer however long the run's output grew.
const HEAD_BYTES = 8_192
const TAIL_LINES = 3

/** What the runs need from the host: processes and text files. */
export type DetachedHost = {
  run: ProcessRunner
  /** A text file's content, or undefined when there is none. */
  read(path: string): Promise<string | undefined>
  exists(path: string): Promise<boolean>
}

/**
 * An agy process as `ps` shows it: the executable, then the print-mode flags the plugin passes. Another program that
 * took over a reused pid does not match, so it is never killed.
 */
export const isAgyRun = (command: string) => /(^|\/)agy\s.*--output-format=stream-json/.test(command)

/** The run's `exit` file: its exit status and, in seconds, when it ended; undefined while it is not a status. */
export function parseExit(text: string | undefined): { exit: number; endedAt?: number } | undefined {
  const [status, seconds] = (text ?? '').trim().split(/\s+/)
  const exit = Number.parseInt(status ?? '', 10)
  if (Number.isNaN(exit)) return undefined
  const at = Number.parseInt(seconds ?? '', 10)
  return Number.isNaN(at) ? { exit } : { exit, endedAt: at * 1000 }
}

/** The runs as files on this machine. */
export function detachedRuns(host: DetachedHost): RunFiles {
  const pidOf = async (dir: string) => (await host.read(`${dir}/pid`))?.trim() || undefined
  const output = async (args: string[]) => {
    const done = await host.run(args, { timeoutMs: 10_000 }).catch(() => undefined)
    return done?.exitCode === 0 ? done.stdout : ''
  }

  async function alive(dir: string): Promise<boolean> {
    const pid = await pidOf(dir)
    // The pid is written a moment after the start; until then the run counts as alive.
    if (!pid) return parseExit(await host.read(`${dir}/exit`)) === undefined
    const ps = await host.run(['ps', '-o', 'command=', '-p', pid], { timeoutMs: 5_000 })
    return ps.exitCode === 0 && isAgyRun(ps.stdout)
  }

  return {
    launch: async (dir, argv, cwd) => {
      const done = await host.run(['sh', '-c', LAUNCH, 'sh', dir, cwd, ...argv], { timeoutMs: 10_000 })
      if (done.exitCode !== 0) throw new Error(done.stderr.trim() || `the launch shell exited with code ${done.exitCode}`)
    },
    read: async dir => {
      if (!(await host.exists(dir))) return undefined
      const events = `${dir}/events.jsonl`
      const head = await output(['head', '-c', String(HEAD_BYTES), events])
      const ended = parseExit(await host.read(`${dir}/exit`))
      if (!ended) return { head }
      const [tail, stderr] = await Promise.all([output(['tail', '-n', String(TAIL_LINES), events]), output(['tail', '-c', '4096', `${dir}/stderr.txt`])])
      return { head, tail, stderr, ...ended }
    },
    alive,
    stop: async dir => {
      if (!(await alive(dir))) return false
      const pid = await pidOf(dir)
      if (!pid) return false
      return (await host.run(['kill', '-TERM', pid], { timeoutMs: 5_000 })).exitCode === 0
    },
    remove: async dir => void (await host.run(['rm', '-rf', dir], { timeoutMs: 10_000 })),
  }
}
