// The fence: keeps the model's own tools away from the saved secret files. Best effort, like
// any command check: the scrubber (scrub.ts) is what keeps a value out of the conversation.
// A file may be used inside a command, as "$(cat FILE)", and in no other way.

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const SEARCH_TOOLS = ['Grep', 'Glob']

/** The deny text: says what to do instead, so the model does not look for another way in. */
export const DENY =
  'The secrets folder is private. Use a saved secret only inside a command, as "$(cat <file>)": ' +
  'never read, print, copy or search it. Ask the user again with mcp__secrets__request_secret if you lost the path.'

const TRACES = /(?:^|[\s;&|(])(?:set\s+-[a-z]*x|(?:ba|z|da)?sh\s+(?:-[a-z]+\s+)*-[a-z]*x)\b/

// A search that walks a folder: it reads every file below it, the secrets folder's among them
const RECURSIVE = /(?:^|[\s;&|(])(?:rg|ug|ugrep|find|bfs|fd|tree)\b|\b(?:e|f)?grep\b[^;&|\n]*\s(?:-[a-zA-Z]*[rR]|--recursive)|\bls\b[^;&|\n]*\s-[a-zA-Z]*R/

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every way a command may spell the folder: the absolute path, and under home `~`, `$HOME` and `${HOME}`. */
export function forms(dir: string, home: string | undefined): string[] {
  const out = [dir]
  const base = home?.replace(/\/+$/, '')
  if (base && dir.startsWith(`${base}/`)) {
    const rest = dir.slice(base.length)
    out.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`)
  }
  return out
}

/** The folders above the folder, each as the ways a command may spell them: `/home/me/.claude`, `~/.claude`, `$HOME`, `~`, `/`. */
export function ancestors(dir: string, home: string | undefined): string[] {
  const out: string[] = []
  const base = home?.replace(/\/+$/, '')
  const parts = dir.split('/').slice(1, -1)
  for (let n = parts.length; n >= 0; n--) {
    const path = `/${parts.slice(0, n).join('/')}`
    out.push(path)
    if (base && (path === base || path.startsWith(`${base}/`))) {
      const rest = path.slice(base.length)
      out.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`)
    }
  }
  return out
}

/** The command with each safe use cut out: a file of the folder read by a command substitution. */
function withoutSafeUses(command: string, spellings: string[]): { text: string; found: boolean } {
  let found = false
  let text = command
  for (const form of spellings) {
    const path = `["']?${escape(form)}/[A-Za-z0-9_.-]+["']?`
    const substitution = new RegExp(`\\$\\(\\s*(?:cat\\s+|<\\s*)${path}\\s*\\)|\`\\s*cat\\s+${path}\\s*\``, 'g')
    text = text.replace(substitution, () => ((found = true), 'SECRET'))
  }
  return { text, found }
}

/** Why a Bash command may not run, or undefined. */
export function bashReason(command: string, spellings: string[], above: string[] = []): string | undefined {
  const { text, found } = withoutSafeUses(command, spellings)
  // The two patterns catch a relative or variable spelling of the folder: `.claude/secrets/x`, `$CLAUDE_CONFIG_DIR/secrets/x`
  if (spellings.some((form) => text.includes(form)) || /\.claude\/secrets\b/.test(text) || /CONFIG_DIR\}?\/secrets\b/.test(text)) {
    return 'it touches the secrets folder'
  }
  if (RECURSIVE.test(text) && above.some((path) => new RegExp(`(?:^|[\\s"'=])${escape(path)}/?(?=$|[\\s"';&|)])`).test(text))) {
    return 'it searches a folder that holds the secrets folder'
  }
  if (found && TRACES.test(text)) return 'it traces the command, which would print the value'
  return undefined
}

function resolve(path: string, home: string | undefined, cwd: string | undefined): string {
  const base = home?.replace(/\/+$/, '')
  let full = path
  if (full === '~' || full.startsWith('~/')) full = base ? `${base}${full.slice(1)}` : full
  else if (!full.startsWith('/') && cwd) full = `${cwd.replace(/\/+$/, '')}/${full}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Why a file or search tool may not run on `input`, or undefined. */
export function toolReason(
  tool: string,
  input: Record<string, unknown>,
  dir: string,
  home: string | undefined,
  cwd: string | undefined,
): string | undefined {
  const inside = (path: string) => path === dir || path.startsWith(`${dir}/`)
  // A search rooted at the folder or above it walks into the folder
  const reaches = (path: string) => inside(path) || dir.startsWith(`${path === '/' ? '' : path}/`)
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

  if (FILE_TOOLS.includes(tool)) {
    const path = text(input.file_path) ?? text(input.notebook_path)
    return path && inside(resolve(path, home, cwd)) ? `it opens ${path}` : undefined
  }
  if (SEARCH_TOOLS.includes(tool)) {
    const path = text(input.path)
    if (path && reaches(resolve(path, home, cwd))) return `it searches ${path}`
    const pattern = text(input.pattern)
    if (tool === 'Glob' && pattern?.startsWith('/') && reaches(resolve(pattern.replace(/[*?{[].*$/, ''), home, cwd))) {
      return `its pattern reaches ${pattern}`
    }
  }
  return undefined
}
