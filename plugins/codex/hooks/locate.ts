// Finds the `codex` executable. A hook's PATH may lack the folders a login shell adds, so after PATH come the
// places the Codex installers put it.

/** Where the installers put `codex`, `~` being HOME: the standalone installer, Homebrew, npm's usual prefixes. */
export const KNOWN_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']

export const NOT_FOUND =
  'The Codex CLI was not found on PATH or in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin. ' +
  'Install it (https://developers.openai.com/codex/cli) or set the plugin\'s codexPath option ' +
  '(claude plugin configure codex@spider-claude-mods).'

export type LocateDeps = { exists(path: string): Promise<boolean>; path?: string; home?: string }

/** The configured path when it is set (it must exist), else the first `codex` on PATH or in the known folders. */
export async function locateCodex(configured: string | undefined, deps: LocateDeps): Promise<string | { error: string }> {
  if (configured) {
    return (await deps.exists(configured)) ? configured : { error: `The codexPath option names ${configured}, which does not exist.` }
  }
  const dirs = [...(deps.path ?? '').split(':').filter(dir => dir.startsWith('/')), ...KNOWN_DIRS]
    .map(dir => (dir.startsWith('~/') ? (deps.home ? `${deps.home}${dir.slice(1)}` : '') : dir))
    .filter(Boolean)
  for (const dir of new Set(dirs)) {
    const candidate = `${dir.replace(/\/$/, '')}/codex`
    if (await deps.exists(candidate)) return candidate
  }
  return { error: NOT_FOUND }
}
