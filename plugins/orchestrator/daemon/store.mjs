// The daemon's files: one JSON file a task, and the notices waiting for a session (one file a finished task, which
// that session's hooks module submits and removes). Every write is a temp file and a rename, in folders only the user
// can read.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_ID, inboxDirOf } from '../hooks/paths.ts'

/** @import { Task } from './orchestrator.mjs' */

/** A task id: `task_` and lowercase letters and digits, so it is a file name. */
export const TASK_ID = /^task_[a-z0-9]{6,40}$/

/**
 * @param {string} path
 * @param {string} text
 */
async function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, path)
}

/** @param {string} stateDir */
export function createStore(stateDir) {
  const tasksDir = join(stateDir, 'tasks')
  return {
    async init() {
      await mkdir(tasksDir, { recursive: true, mode: 0o700 })
      await mkdir(join(stateDir, 'inbox'), { recursive: true, mode: 0o700 })
    },
    /** @param {Task} task */
    save: (task) => writeAtomic(join(tasksDir, `${task.taskId}.json`), `${JSON.stringify(task, null, 2)}\n`),
    /** @param {string} taskId @returns {Promise<Task | undefined>} */
    async load(taskId) {
      if (!TASK_ID.test(taskId)) return undefined
      const text = await readFile(join(tasksDir, `${taskId}.json`), 'utf8').catch(() => undefined)
      try {
        return text === undefined ? undefined : JSON.parse(text)
      } catch {
        return undefined
      }
    },
    /** @returns {Promise<Task[]>} */
    async all() {
      const names = await readdir(tasksDir).catch(() => /** @type {string[]} */ ([]))
      const tasks = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => this.load(name.slice(0, -5))))
      return tasks.filter((task) => task !== undefined)
    },
    /**
     * A notice for a session's hooks module to submit as a prompt.
     * @param {string} sessionId
     * @param {string} taskId
     * @param {string} text
     */
    async notify(sessionId, taskId, text) {
      if (!SESSION_ID.test(sessionId)) return
      const dir = inboxDirOf(stateDir, sessionId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeAtomic(join(dir, `${taskId}.json`), `${JSON.stringify({ taskId, text })}\n`)
    },
    /** A notice no longer needed, as the result was read first. @param {string} sessionId @param {string} taskId */
    async unnotify(sessionId, taskId) {
      if (SESSION_ID.test(sessionId)) await rm(join(inboxDirOf(stateDir, sessionId), `${taskId}.json`), { force: true })
    },
  }
}

/** @typedef {ReturnType<typeof createStore>} Store */
