// Fakes of what the runner is handed: the runs it starts detached (each launch plays the next script into a memory
// folder; a script with a gate keeps running until released, and `dead` makes its process vanish without an exit
// status), `$.store` in memory, and the git workspaces with the worktrees they made and removed.
import type { JobStore, RunFiles, RunState, Workspace, Workspaces } from '../hooks/model'

export type Run = { stdout: string; exit?: number; stderr?: string; gate?: Promise<unknown> }

export function fakeRuns(scripts: Run[]) {
  const launched: { dir: string; argv: string[]; cwd: string }[] = []
  const states = new Map<string, RunState>()
  const dead = new Set<string>()
  const stopped: string[] = []
  const removed: string[] = []
  const files: RunFiles = {
    launch: async (dir, argv, cwd) => {
      launched.push({ dir, argv, cwd })
      const script = scripts.shift() ?? { stdout: '', exit: 1 }
      // The conversation starts at once; the rest arrives when the run ends.
      const state: RunState = { head: script.stdout.split('\n')[0] ?? '' }
      states.set(dir, state)
      void (async () => {
        if (script.gate) await script.gate
        if (stopped.includes(dir) || dead.has(dir)) return
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
  }
  return { files, launched, states, dead, stopped, removed }
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

/** Git workspaces in memory: an ask's folder is a repository whose fingerprint stays `t1`; reviews make worktrees. */
export function fakeWorkspaces(init: { left?: string[] } = {}) {
  const made: string[] = []
  const removed: { project: string; worktree: string }[] = []
  const left = new Set(init.left ?? [])
  const pathOf = (id: string) => `/tmp/agy/worktrees/${id}`
  const workspaces: Workspaces = {
    pathOf,
    ask: async project => ({ cwd: project, before: 't1' }),
    review: async (_project, id) => {
      const worktree = pathOf(id)
      made.push(worktree)
      left.add(id)
      return { cwd: worktree, worktree, before: 'w1', diff: { path: `${worktree}/.agy-review.diff`, files: ['a.ts'] } } satisfies Workspace
    },
    changed: async () => undefined,
    remove: async (project, worktree) => {
      removed.push({ project, worktree })
      left.delete(worktree.split('/').pop()!)
    },
    left: async () => [...left],
  }
  return { workspaces, made, removed, left }
}
