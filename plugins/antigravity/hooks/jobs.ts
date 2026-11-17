import type { JobStore, ProcessRunner } from './model'

// The jobs as files, one JSON file a key in `$TMPDIR/agy/jobs`, so the MCP server (which serves the tools) and the
// hooks module (which watches background jobs and sends their notices) share them. A write makes the plugin's folder
// private first, as ROOT_CHECK does, and shows the file only once whole (a rename), so a reader never sees half a job.
//   $1 the plugin's folder, $2 the file; the text on stdin
export const STORE_WRITE =
  'umask 077; r=$1; f=$2; mkdir -p "$r" && [ ! -L "$r" ] && [ -O "$r" ] && chmod 700 "$r" && mkdir -p "${f%/*}" && ' +
  'cat >"$f.$$" && mv -f "$f.$$" "$f"'

const SUFFIX = '.json'

/** What the store needs from the host: processes (the write takes stdin) and text files. */
export type StoreHost = {
  run: ProcessRunner
  /** A text file's content, or undefined when there is none. */
  read(path: string): Promise<string | undefined>
  /** A folder's file names; rejects when it is missing. */
  list(path: string): Promise<string[]>
}

/** A key as a file name, and back: `job:abc` is `job%3Aabc.json`. */
export const fileOf = (key: string) => `${encodeURIComponent(key)}${SUFFIX}`
export const keyOf = (file: string) => (file.endsWith(SUFFIX) && !file.startsWith('.') ? decodeURIComponent(file.slice(0, -SUFFIX.length)) : undefined)

/** The jobs in `dir`, inside the plugin's folder `root`. A file that does not parse reads as missing. */
export function fileStore(host: StoreHost, root: string, dir: string): JobStore {
  const pathOf = (key: string) => `${dir}/${fileOf(key)}`
  return {
    get: async key => {
      const text = await host.read(pathOf(key))
      if (text === undefined) return undefined
      try {
        return JSON.parse(text) as unknown
      } catch {
        return undefined
      }
    },
    set: async (key, value) => {
      const done = await host.run(['sh', '-c', STORE_WRITE, 'sh', root, pathOf(key)], { timeoutMs: 10_000, stdin: JSON.stringify(value) })
      if (done.exitCode !== 0) throw new Error(done.stderr.trim() || `the job could not be saved (exit code ${done.exitCode})`)
    },
    delete: async key => void (await host.run(['rm', '-f', pathOf(key)], { timeoutMs: 10_000 })),
    keys: async () => (await host.list(dir).catch(() => [])).flatMap(name => keyOf(name) ?? []),
  }
}
