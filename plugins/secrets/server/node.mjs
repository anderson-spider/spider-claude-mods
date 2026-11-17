// What request_secret needs from outside, on Node: owner-only files, a clock and random ids.
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

/** @import { AskDeps } from './ask.mjs' */

/**
 * Makes `dir` and the folders above it that are missing, each owner-only, and tightens `dir` if it was there.
 * @param {string} dir
 */
async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

/**
 * @param {AskDeps['env']} env
 * @param {number} pid
 * @returns {AskDeps}
 */
export function nodeDeps(env, pid) {
  return {
    env,
    pid,
    async write(dir, file, text) {
      await privateDir(dir)
      const partial = `${dir}/${file}.partial`
      // `wx` refuses a file that is there; the rename shows the request only once it is whole
      await writeFile(partial, text, { mode: 0o600, flag: 'wx' })
      await rename(partial, `${dir}/${file}`)
    },
    read: (path) => readFile(path, 'utf8').catch(() => undefined),
    async remove(path) {
      try {
        await rm(path)
        return true
      } catch {
        return false
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: () => randomBytes(8).toString('hex'),
  }
}
