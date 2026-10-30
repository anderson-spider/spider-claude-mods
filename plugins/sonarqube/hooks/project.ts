// Which SonarQube project a call is about when it names none: `sonar.projectKey` of the nearest
// sonar-project.properties, from the session's folder up to the root of its git working tree (the folder holding
// `.git`, a directory or a worktree's file); outside a working tree, the session's folder only. Pure: the reads are
// injected.

export const PROPERTIES_FILE = 'sonar-project.properties'

export type ProjectIo = {
  /** The session's folder, absolute. */
  cwd: () => Promise<string>
  /** Whether a path exists. */
  exists: (path: string) => Promise<boolean>
  /** A file's text, or undefined when it cannot be read. */
  read: (path: string) => Promise<string | undefined>
}

const LEADING_SPACE = /^[ \t\f]+/
const ESCAPED: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' }

/** A key or value with its escapes decoded: `\t`, `\n`, `\r`, `\f`, `\uXXXX`, and any other character as itself (`\:` is `:`). */
function unescape(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : (ESCAPED[c] ?? c)))
}

/**
 * The logical lines of a properties text: blank and comment (`#`, `!`) lines dropped, and a line ending in an odd
 * number of backslashes joined with the next, whose leading spaces are dropped.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = []
  let pending: string | undefined
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(LEADING_SPACE, '')
    if (pending === undefined && (!line || line[0] === '#' || line[0] === '!')) continue
    const joined = (pending ?? '') + line
    if ((/\\*$/.exec(joined)?.[0].length ?? 0) % 2 === 1) {
      pending = joined.slice(0, -1)
      continue
    }
    lines.push(joined)
    pending = undefined
  }
  if (pending !== undefined) lines.push(pending)
  return lines
}

/** A logical line's key and value: the key ends at the first unescaped `=`, `:` or space, and one `=` or `:` may follow the spaces. */
function entry(line: string): [string, string] {
  let end = 0
  while (end < line.length && !/[=:\s]/.test(line[end]!)) end += line[end] === '\\' ? 2 : 1
  let rest = line.slice(end).replace(LEADING_SPACE, '')
  if (rest[0] === '=' || rest[0] === ':') rest = rest.slice(1).replace(LEADING_SPACE, '')
  return [unescape(line.slice(0, end)), unescape(rest)]
}

/** The value of `sonar.projectKey` in a Java properties text, the last one when it repeats, as Java reads it; undefined when absent or empty. */
export function propertyKey(text: string): string | undefined {
  let value: string | undefined
  for (const line of logicalLines(text)) {
    const [key, found] = entry(line)
    if (key === 'sonar.projectKey') value = found
  }
  return value?.trim() || undefined
}

const trimEnd = (dir: string) => (dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir)

/** The parent of an absolute folder (`/a` or `C:\a`), or undefined at its top (`/`, `C:\`). */
export function parentOf(dir: string): string | undefined {
  const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
  if (cut < 0 || cut === dir.length - 1) return undefined
  const parent = dir.slice(0, cut)
  // a top keeps its separator: `/a` goes to `/`, `C:\a` to `C:\`
  return parent === '' || /^[A-Za-z]:$/.test(parent) ? dir.slice(0, cut + 1) : parent
}

const inFolder = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`

/** `cwd` and each folder above it up to the one holding `.git`, nearest first; only `cwd` when none holds it. */
export async function foldersUp(cwd: string, exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const folders: string[] = []
  for (let dir: string | undefined = trimEnd(cwd); dir !== undefined; dir = parentOf(dir)) {
    folders.push(dir)
    if (await exists(inFolder(dir, '.git'))) return folders
  }
  return folders.slice(0, 1)
}

/** The nearest `sonar.projectKey` and the file that gives it, or undefined when no folder has one. */
export async function findProjectKey(io: ProjectIo): Promise<{ key: string; file: string } | undefined> {
  for (const dir of await foldersUp(await io.cwd(), io.exists)) {
    const file = inFolder(dir, PROPERTIES_FILE)
    const text = await io.read(file)
    const key = text === undefined ? undefined : propertyKey(text)
    if (key) return { key, file }
  }
  return undefined
}
