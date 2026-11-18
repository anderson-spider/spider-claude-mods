// The tasks a person delegated: one private folder each under the state folder, holding the brief, the task record, the
// answer and, for a review, its findings. A follow-up is a new task on the same agy session, and one session runs one
// turn at a time (two turns at once on one session hang agy), so a lock per session guards it.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Refusal } from './acp.ts'
import type { Reason } from './errors.ts'
import type { Mode } from './policy.ts'
import type { Finding } from './review.ts'

export const ROLES = ['ask', 'search', 'analysis', 'review'] as const
export type Role = (typeof ROLES)[number]
export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value)

export type Status = 'running' | 'completed' | 'needs_approval' | 'failed' | 'cancelled'

export interface Task {
  id: string
  /** The task this one follows up, on the same session. */
  parent?: string
  mode: Mode
  role: Role
  /** The repository (or folder) the task was started from. */
  project: string
  /** Where agy ran: the project, or the task's worktree. */
  cwd: string
  /** What a review covered, as git names it. */
  range?: string
  /** The commit an implement task's worktree started at, which its patch applies to. */
  base?: string
  /** The files an implement task's patch changes, as `<status>\t<path>`. */
  changed?: string[]
  model?: string
  effort?: string
  status: Status
  /** The process running the task, while it runs. */
  pid?: number
  startedAt: string
  endedAt?: string
  sessionId?: string
  executedModel?: string | null
  refused: Refusal[]
  error?: string
  reason?: Reason
  /** Notes for the person: untracked or uncommitted files left out, a removed worktree. */
  notes: string[]
  findings?: Finding[]
  /** Files in the task folder. */
  files: { brief: string; answer?: string; findings?: string; patch?: string; record: string }
}

/** A task id: when it started, then random, so names sort by time and never collide. */
export function newTaskId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`
}

export const TASK_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/

export async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function saveTask(task: Task): Promise<void> {
  await writeJson(task.files.record, task)
}

export async function loadTask(tasksDir: string, id: string): Promise<Task | { error: string }> {
  if (!TASK_ID.test(id)) return { error: `${id} is not a task id (antigravity-delegate prints one per task).` }
  try {
    return JSON.parse(await readFile(join(tasksDir, id, 'task.json'), 'utf8')) as Task
  } catch {
    return { error: `No task ${id} under ${tasksDir}.` }
  }
}

/** Creates the task's folder and writes its brief there. */
export async function createTaskDir(tasksDir: string, id: string, brief: string): Promise<Task['files']> {
  const dir = join(tasksDir, id)
  await mkdir(dir, { mode: 0o700 })
  const files = { brief: join(dir, 'brief.md'), record: join(dir, 'task.json') }
  await writeFile(files.brief, brief, { mode: 0o600 })
  return files
}

/** Whether a process is running (one another user owns counts). */
export const alive = (pid: number | undefined) => {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A takeover's guard older than this was left by a process that died during it.
const GUARD_STALE_MS = 10_000

const createExclusive = (path: string, text: string) =>
  writeFile(path, text, { flag: 'wx', mode: 0o600 }).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return false
      throw error
    },
  )

/**
 * Takes the session's lock, or says which task holds it. A lock whose process is gone is taken over under a guard
 * file, so two processes that both find it stale cannot each remove the other's new lock. Resolves a release function.
 */
export async function lockSession(locksDir: string, sessionId: string, taskId: string): Promise<(() => Promise<void>) | { error: string }> {
  await mkdir(locksDir, { recursive: true, mode: 0o700 })
  const path = join(locksDir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.lock`)
  const guard = `${path}.takeover`
  const mine = JSON.stringify({ pid: process.pid, task: taskId })
  const release = () => rm(path, { force: true })
  const holder = () => readFile(path, 'utf8').then(text => JSON.parse(text) as { pid?: number; task?: string }, () => undefined)
  const busy = (task?: string) => ({ error: `Task ${task ?? '?'} is still running on this agy session; follow up once it ends.` })
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(path, mine)) return release
    const held = await holder()
    if (held && alive(held.pid)) return busy(held.task)
    if (!(await createExclusive(guard, mine))) {
      const info = await stat(guard).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > GUARD_STALE_MS) await rm(guard, { force: true })
      else await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }
    try {
      // Under the guard, the lock is checked again: another process may have taken it over meanwhile.
      const again = await holder()
      if (again && alive(again.pid)) return busy(again.task)
      await rm(path, { force: true })
      if (await createExclusive(path, mine)) return release
    } finally {
      await rm(guard, { force: true })
    }
  }
  return { error: 'Could not take the session lock; try again.' }
}

/** Removes task folders past the newest `keep` or older than `maxAgeMs`, but never those `spare` names. */
export async function pruneTasks(tasksDir: string, now: number, spare: string[] = [], keep = 50, maxAgeMs = 7 * 24 * 3_600_000): Promise<void> {
  const names = (await readdir(tasksDir).catch(() => [] as string[])).filter(name => TASK_ID.test(name)).sort().reverse()
  for (const [index, name] of names.entries()) {
    const info = await stat(join(tasksDir, name)).catch(() => undefined)
    if (!info || spare.includes(name)) continue
    if (index >= keep || now - info.mtimeMs > maxAgeMs) await rm(join(tasksDir, name), { recursive: true, force: true })
  }
}
