// Where a saved secret lives and when it goes. Pure: the host's environment and clock are passed in.

/** A saved secret is deleted after this long, counted from its last write. */
export const TTL_MS = 24 * 60 * 60 * 1000

/** A name followed by the random suffix that keeps two saves of one name apart. */
const FILE = /^([A-Za-z_][A-Za-z0-9_.-]{0,63})\.([0-9a-f]{16})$/

/** The owner-only folder: beside the Claude Code settings (`CLAUDE_CONFIG_DIR`, else `~/.claude`), never in a project. */
export function secretsDir(env: { home?: string; configDir?: string }): string | undefined {
  const base = env.configDir || (env.home ? `${env.home.replace(/\/+$/, '')}/.claude` : undefined)
  return base ? `${base.replace(/\/+$/, '')}/secrets` : undefined
}

export function fileName(name: string, random: string): string {
  return `${name}.${random}`
}

/** The name a stored file was saved under, or undefined for a file this plugin did not write (a partial, a stray). */
export function nameOf(file: string): string | undefined {
  return FILE.exec(file)?.[1]
}

export function isExpired(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > TTL_MS
}

/** 16 random hex digits, from the engine's crypto. */
export function randomSuffix(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Writes stdin to `$2` inside the folder `$1`, readable by the owner alone: `umask 077` makes the
 * folder 0700 and the file 0600 from the first byte, `set -C` refuses to write over an existing
 * file, and the rename shows the file only once it is whole. The value travels on stdin, never in argv.
 */
export const WRITE_SCRIPT =
  'umask 077; set -C; mkdir -p "$1" && chmod 700 "$1" && rm -f "$2.partial" && cat > "$2.partial" && mv "$2.partial" "$2"'

export function writeArgv(dir: string, file: string): string[] {
  return ['sh', '-c', WRITE_SCRIPT, 'sh', dir, `${dir}/${file}`]
}
