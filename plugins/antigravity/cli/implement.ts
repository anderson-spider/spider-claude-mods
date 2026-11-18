// The implement mode's workspace: a throwaway worktree at the checkout's HEAD where agy may edit, and the patch its
// edits come back as. The checkout is never touched; the person (or Claude) applies the patch. A follow-up rebuilds the
// worktree at the same commit with the earlier patch applied, so agy goes on from its own changes.
import { DIFF, git } from './review.ts'

const why = (result: { code: number | null; stderr: string }) => result.stderr.trim().split('\n')[0] || `exit code ${result.code}`

/** The commit HEAD points at, or an error outside a repository or before the first commit. */
export async function headOf(project: string): Promise<string | { error: string }> {
  const head = await git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : { error: 'The implement mode needs a git repository with at least one commit.' }
}

/** How many tracked files the checkout changed since HEAD: the worktree starts without those changes. */
export async function uncommittedOf(project: string): Promise<number> {
  const status = await git(project, ['status', '--porcelain', '--untracked-files=no'])
  return status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 0
}

/**
 * Makes a detached, locked worktree at `base`, with `patch` (a file) applied when given. Resolves the worktree's git
 * folder, read before agy runs: every later git call names it, so a `.git` file agy rewrote is never followed.
 */
export async function makeTaskWorktree(project: string, path: string, base: string, patch?: string): Promise<{ gitDir: string } | { error: string }> {
  const added = await git(project, ['worktree', 'add', '--detach', '--lock', path, base], 300_000)
  if (added.code !== 0) return { error: `git could not make the task's worktree: ${why(added)}` }
  const dir = await git(path, ['rev-parse', '--absolute-git-dir'])
  if (dir.code !== 0 || !dir.stdout.trim()) return { error: `git could not find the worktree's git folder: ${why(dir)}` }
  const gitDir = dir.stdout.trim()
  if (!patch) return { gitDir }
  const applied = await git(path, ['apply', '--index', '--binary', patch], 120_000, gitDir)
  return applied.code === 0 ? { gitDir } : { error: `The earlier task's patch did not apply: ${why(applied)}` }
}

export interface Patch {
  /** The binary diff of every change since `base`, new files included (ignored ones are not). */
  diff: string
  /** One `<status>\t<path>` line per changed file, as git's --name-status prints it. */
  changed: string[]
}

/** Everything agy changed in the worktree, against the commit it started at. */
export async function patchOf(worktree: string, gitDir: string, base: string): Promise<Patch | { error: string }> {
  const staged = await git(worktree, ['add', '-A'], 120_000, gitDir)
  if (staged.code !== 0) return { error: `git could not collect the changes: ${why(staged)}` }
  const names = await git(worktree, ['diff', '--cached', ...DIFF, '--name-status', base, '--'], 60_000, gitDir)
  if (names.code !== 0) return { error: `git could not list the changes: ${why(names)}` }
  const diff = await git(worktree, ['diff', '--cached', ...DIFF, '--binary', base, '--'], 120_000, gitDir)
  if (diff.code !== 0) return { error: `git could not diff the changes: ${why(diff)}` }
  return { diff: diff.stdout, changed: names.stdout.split('\n').filter(Boolean) }
}
