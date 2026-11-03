// A fake of the runs the runner starts detached: each launch plays the next script into a memory folder. A script
// with a gate keeps running until released; `dead` makes its process vanish without an exit status.
import type { JobStore, RunFiles, RunState } from '../hooks/model'

export type Run = { stdout: string; exit?: number; stderr?: string; gate?: Promise<unknown>; onEnd?: () => void }

export function fakeRuns(scripts: Run[]) {
  const launched: { dir: string; argv: string[]; cwd: string | undefined }[] = []
  const states = new Map<string, RunState>()
  const dead = new Set<string>()
  const stopped: string[] = []
  const removed: string[] = []
  const rollouts: Record<string, { since: number; answer: string }> = {}
  const files: RunFiles = {
    launch: async (dir, argv, cwd) => {
      launched.push({ dir, argv, cwd })
      const script = scripts.shift() ?? { stdout: '', exit: 1 }
      // The thread starts at once; the rest arrives when the run ends.
      const state: RunState = { head: script.stdout.split('\n')[0] ?? '' }
      states.set(dir, state)
      void (async () => {
        if (script.gate) await script.gate
        if (stopped.includes(dir) || dead.has(dir)) return
        script.onEnd?.()
        Object.assign(state, { tail: script.stdout, stderr: script.stderr ?? '', exit: script.exit ?? 0 })
      })()
    },
    read: async dir => {
      const state = states.get(dir)
      return state && { ...state }
    },
    alive: async dir => states.has(dir) && !dead.has(dir) && !stopped.includes(dir) && states.get(dir)!.exit === undefined,
    stop: async dir => {
      if (!(await files.alive(dir))) return false
      stopped.push(dir)
      Object.assign(states.get(dir)!, { exit: 143, tail: '', stderr: '' })
      return true
    },
    remove: async dir => void (removed.push(dir), states.delete(dir)),
    recover: async (threadId, sinceMs) => {
      const rollout = rollouts[threadId]
      return rollout && rollout.since >= sinceMs ? rollout.answer : undefined
    },
  }
  return { files, launched, states, dead, stopped, removed, rollouts }
}

/** `$.store` in memory. */
export function memoryStore(init: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(init))
  const store: JobStore = {
    get: async key => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async key => void data.delete(key),
    keys: async () => [...data.keys()],
  }
  return { store, data }
}
