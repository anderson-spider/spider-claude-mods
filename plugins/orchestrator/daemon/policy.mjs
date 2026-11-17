// What the client answers an agent's permission request, by runtime mode, ported from T3 Code's ACP client policy
// (packages/provider-acp/src/server/clientPolicy.ts): reads always pass, a mutation in auto-accept-edits passes only
// inside the work folder (symlinks resolved, failing closed), full-access passes everything, and the rest would need a
// person's approval. Pure but for the file system's realpath, which is injected in tests.
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** The runtime modes, narrowest first: a child may never run in a broader one than its ceiling. */
export const RUNTIME_MODES = /** @type {const} */ (['approval-required', 'auto-accept-edits', 'full-access'])

/** @typedef {typeof RUNTIME_MODES[number]} RuntimeMode */
/** @typedef {'allow' | 'ask' | 'deny'} Disposition */

const READ_KINDS = new Set(['read', 'search', 'think'])
const MUTATION_KINDS = new Set(['edit', 'delete', 'move'])

/** @param {unknown} mode @returns {mode is RuntimeMode} */
export const isRuntimeMode = (mode) => typeof mode === 'string' && /** @type {readonly string[]} */ (RUNTIME_MODES).includes(mode)

/** @param {RuntimeMode} mode */
export const rankOf = (mode) => RUNTIME_MODES.indexOf(mode)

/**
 * Where a path lands with symlinks resolved, a path not there yet through its nearest existing folder; undefined when
 * it cannot be told (fail closed).
 * @param {string} path
 * @returns {string | undefined}
 */
export function canonicalPath(path) {
  let candidate = path
  /** @type {string[]} */
  const missing = []
  for (;;) {
    try {
      return resolve(realpathSync.native(candidate), ...missing)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return undefined
    }
    try {
      // A dangling symlink: where it points is unknown.
      lstatSync(candidate)
      return undefined
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return undefined
    }
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    missing.unshift(basename(candidate))
    candidate = parent
  }
}

/**
 * @param {string} path
 * @param {string} root
 */
const isWithin = (path, root) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Whether every location of a mutation is inside the work folder; none listed fails closed.
 * @param {string} cwd
 * @param {unknown} locations
 * @param {(path: string) => string | undefined} canonical
 */
function writesInside(cwd, locations, canonical) {
  const root = canonical(cwd)
  if (!root || !Array.isArray(locations) || locations.length === 0) return false
  return locations.every((location) => {
    const path = typeof location?.path === 'string' ? location.path.trim() : ''
    if (!path) return false
    const real = canonical(isAbsolute(path) ? path : resolve(cwd, path))
    return real !== undefined && isWithin(real, root)
  })
}

/**
 * What a permission request gets in a runtime mode.
 * @param {RuntimeMode} mode
 * @param {string} cwd the task's work folder
 * @param {{ kind?: unknown, locations?: unknown } | undefined} toolCall
 * @param {(path: string) => string | undefined} [canonical]
 * @returns {Disposition}
 */
export function dispositionOf(mode, cwd, toolCall, canonical = canonicalPath) {
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : 'other'
  if (READ_KINDS.has(kind)) return 'allow'
  if (mode === 'full-access') return 'allow'
  if (mode === 'auto-accept-edits' && MUTATION_KINDS.has(kind)) return writesInside(cwd, toolCall?.locations, canonical) ? 'allow' : 'deny'
  return 'ask'
}

/**
 * The answer to session/request_permission: the agent's own allow-once or reject-once option, else the first of its
 * kind, else cancelled (the agent then treats it as refused).
 * @param {Disposition} disposition
 * @param {unknown} options
 */
export function outcomeOf(disposition, options) {
  const list = Array.isArray(options) ? options : []
  const prefix = disposition === 'allow' ? 'allow' : 'reject'
  const pick = list.find((option) => option?.kind === `${prefix}_once`) ?? list.find((option) => typeof option?.kind === 'string' && option.kind.startsWith(prefix))
  return pick && typeof pick.optionId === 'string' ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } }
}
