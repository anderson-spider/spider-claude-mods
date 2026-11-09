// Finds the `agy` executable. A hook's PATH may lack the folders a login shell adds, so after PATH come the places
// the installers put it.

/** Where `agy` usually is, `~` being HOME: its own installer's folder first, then Homebrew's and the usual prefix. */
export const KNOWN_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']

export const NOT_FOUND =
  'The Antigravity CLI (agy) was not found on PATH or in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin. ' +
  'Install it (curl -fsSL https://antigravity.google/cli/install.sh | bash), sign in once by running `agy`, ' +
  "or set the plugin's agyPath option (claude plugin configure antigravity@spider-claude-mods)."

export type LocateDeps = { exists(path: string): Promise<boolean>; path?: string; home?: string }

/** The configured path when it is set (it must exist), else the first `agy` on PATH or in the known folders. */
export async function locateAgy(configured: string | undefined, deps: LocateDeps): Promise<string | { error: string }> {
  if (configured) {
    return (await deps.exists(configured)) ? configured : { error: `The agyPath option names ${configured}, which does not exist.` }
  }
  const dirs = [...(deps.path ?? '').split(':').filter(dir => dir.startsWith('/')), ...KNOWN_DIRS]
    .map(dir => (dir.startsWith('~/') ? (deps.home ? `${deps.home}${dir.slice(1)}` : '') : dir))
    .filter(Boolean)
  for (const dir of new Set(dirs)) {
    const candidate = `${dir.replace(/\/$/, '')}/agy`
    if (await deps.exists(candidate)) return candidate
  }
  return { error: NOT_FOUND }
}
