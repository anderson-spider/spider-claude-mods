// Fakes the plugin's pure tests share: a Codex child scripted by its JSONL output, and output deps over a memory folder.
import type { Chunk, Exit, FsEntry, OutputDeps, Spawn } from '../hooks/model'

export const THREAD = '01a1a17a-b0ba-7770-b825-59aacf6e9f6d'
export const line = (event: unknown) => `${JSON.stringify(event)}\n`

/** What `codex exec --json` prints for a run that answers `text` in `thread`. */
export const answered = (text: string, thread = THREAD) =>
  line({ type: 'thread.started', thread_id: thread }) +
  line({ type: 'turn.started' }) +
  line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }) +
  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })

export type Script = { stdout: string; exit?: Exit; stderr?: string; gate?: Promise<unknown>; onRun?: () => void }

/** A spawn that plays `scripts` in turn, recording each argv and folder; a gate holds the child before it ends. */
export function fakeSpawn(scripts: Script[]) {
  const runs: { argv: string[]; cwd: string | undefined }[] = []
  let stopped = 0
  const spawn: Spawn = (argv, cwd) => {
    runs.push({ argv, cwd })
    const script = scripts.shift() ?? { stdout: '' }
    const child = (async function* (): AsyncGenerator<Chunk, Exit> {
      if (script.stderr) yield { stream: 'stderr', text: script.stderr }
      const cut = Math.min(script.stdout.length, 80)
      if (cut) yield { stream: 'stdout', text: script.stdout.slice(0, cut) }
      if (script.gate) await script.gate
      if (script.stdout.length > cut) yield { stream: 'stdout', text: script.stdout.slice(cut) }
      script.onRun?.()
      return script.exit ?? { code: 0, signal: null }
    })()
    // Closing the stream is how the host kills the child: count it (a generator held at an await would never get there).
    const counted = {
      next: (...args: [] | [unknown]) => child.next(...args),
      return: (value: Exit | PromiseLike<Exit>) => (stopped++, child.return(value)),
      throw: (error: unknown) => child.throw(error),
      [Symbol.asyncIterator]() {
        return counted
      },
    }
    return counted as unknown as ReturnType<Spawn>
  }
  return { spawn, runs, stopped: () => stopped }
}

/** Output deps over a memory folder: `dirs` lists entries by folder, `written` keeps the text files, `ran` every command. */
export function fakeOutput(init: { dirs?: Record<string, FsEntry[]>; previews?: boolean } = {}) {
  const dirs = init.dirs ?? {}
  const written: { path: string; text: string }[] = []
  const ran: string[][] = []
  const output: OutputDeps = {
    run: async argv => {
      ran.push(argv)
      if (argv[0] === 'sips') return { exitCode: init.previews ? 0 : 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    write: async (path, text) => void written.push({ path, text }),
    readBytes: async () => ({ base64: 'SlBH' }),
    list: async path => {
      const entries = dirs[path]
      if (!entries) throw new Error(`ENOENT: ${path}`)
      return entries
    },
    outDir: '/tmp/codex',
    codexHome: '/h/.codex',
  }
  return { output, dirs, written, ran }
}

export const file = (name: string, mtimeMs = 1): FsEntry => ({ name, kind: 'file', mtimeMs })
