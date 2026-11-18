// What the client answers each permission request of agy (ACP `session/request_permission`), by the task's mode.
// Measured on agy 1.5.11 with a private agy home: every read, edit and command arrives as a request, with absolute
// `locations` for reads and edits, outside the workspace too, and a refusal is honored. Ported from T3 Code's ACP
// client policy (packages/provider-acp/src/server/clientPolicy.ts), narrowed: reads are confined too, and no mode
// allows a command, since an allowed command runs unconfined (network included, even under --sandbox).
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const MODES = ['read-only', 'implement'] as const
export type Mode = (typeof MODES)[number]
export const isMode = (value: unknown): value is Mode => typeof value === 'string' && (MODES as readonly string[]).includes(value)

export interface Scope {
  /** The folder the session runs in (the checkout, or the task's worktree); relative locations resolve against it. */
  cwd: string
  /** Folders agy may read: the session's folder, and agy's own home for its built-in skills. */
  readRoots: string[]
  /** Folders agy may edit in `implement`: the task's worktree only. */
  writeRoots: string[]
}

export interface Decision {
  allow: boolean
  /** Why it was refused, for the task's result. */
  reason?: string
}

const READ_KINDS = new Set(['read', 'search'])
const FREE_KINDS = new Set(['think', 'fetch'])
const MUTATION_KINDS = new Set(['edit', 'delete', 'move'])

/**
 * Where a path lands with symlinks resolved, a path not there yet through its nearest existing folder; undefined when
 * it cannot be told (fail closed).
 */
export function canonicalPath(path: string): string | undefined {
  let candidate = path
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync.native(candidate), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    try {
      // A dangling symlink: where it points is unknown.
      lstatSync(candidate)
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    missing.unshift(basename(candidate))
    candidate = parent
  }
}

export const isWithin = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The paths a tool call names, `undefined` when one is malformed. */
function pathsOf(locations: unknown): string[] | undefined {
  if (locations === undefined || locations === null) return []
  if (!Array.isArray(locations)) return undefined
  const paths: string[] = []
  for (const location of locations) {
    const path = typeof location?.path === 'string' ? location.path.trim() : ''
    if (!path) return undefined
    paths.push(path)
  }
  return paths
}

/** Whether every path lies inside one of the roots, by realpath; failing closed. */
function allInside(cwd: string, paths: string[], roots: string[], canonical: (path: string) => string | undefined): boolean {
  const real = roots.map(root => canonical(root)).filter((root): root is string => root !== undefined)
  return paths.every(path => {
    const target = canonical(isAbsolute(path) ? path : resolve(cwd, path))
    return target !== undefined && real.some(root => isWithin(target, root))
  })
}

export function decide(mode: Mode, scope: Scope, toolCall: { kind?: unknown; locations?: unknown } | undefined, canonical = canonicalPath): Decision {
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : 'other'
  if (FREE_KINDS.has(kind)) return { allow: true }
  const paths = pathsOf(toolCall?.locations)
  if (READ_KINDS.has(kind)) {
    if (paths === undefined) return { allow: false, reason: 'a read with a malformed location' }
    return allInside(scope.cwd, paths, scope.readRoots, canonical) ? { allow: true } : { allow: false, reason: 'a read outside the task folder' }
  }
  if (MUTATION_KINDS.has(kind)) {
    if (mode !== 'implement') return { allow: false, reason: 'read-only' }
    if (!paths || paths.length === 0) return { allow: false, reason: 'an edit that names no file' }
    return allInside(scope.cwd, paths, scope.writeRoots, canonical) ? { allow: true } : { allow: false, reason: 'an edit outside the worktree' }
  }
  if (kind === 'execute') return { allow: false, reason: 'commands are not allowed' }
  return { allow: false, reason: `a ${kind} action is not allowed` }
}

/**
 * The answer to session/request_permission: the agent's allow-once or reject-once option, else the first of its kind,
 * else cancelled (the agent then treats it as refused).
 */
export function outcomeOf(allow: boolean, options: unknown) {
  const list: any[] = Array.isArray(options) ? options : []
  const prefix = allow ? 'allow' : 'reject'
  const pick = list.find(option => option?.kind === `${prefix}_once`) ?? list.find(option => typeof option?.kind === 'string' && option.kind.startsWith(prefix))
  return pick && typeof pick.optionId === 'string' ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } }
}
