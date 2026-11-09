import type { ProcessRunner, ReviewTarget, Workspace, Workspaces } from './model'

/** The diff file a review's worktree holds, named in the review prompt. */
export const DIFF_FILE = '.agy-review.diff'

export const NO_REPO_NOTE = 'Not a git repository: edits by agy could not be checked.'

// The working tree's fingerprint, one hash: of `git status` (which files differ from HEAD and how, deleted and untracked
// ones included, ignored ones not) and of the content of each modified or untracked file that still exists, so a
// second edit to an already changed file shows too. A deleted file is in the status, and has no content to hash.
// `git hash-object` without `-w` writes nothing, so the repository, its index and the person's staging stay as they were.
export const FINGERPRINT =
  's=$(git status --porcelain -uall) || exit 1; ' +
  "{ printf '%s\\n' \"$s\"; git ls-files --modified --others --exclude-standard | " +
  "while IFS= read -r f; do [ -f \"$f\" ] && printf '%s\\n' \"$f\"; done | git hash-object --stdin-paths; } | git hash-object --stdin"

// Writes the diff of a range ($2) in the repository ($1) to a file ($3) without passing it through the host's output,
// which a large diff could pass.
const WRITE_DIFF = 'git -C "$1" diff "$2" >"$3"'

/** The git range a review target covers: the branch since its merge base with the base, or one commit. */
const rangeOf = (target: ReviewTarget) => ('base' in target ? `${target.base}...HEAD` : `${target.commit}^!`)

export type WorkspaceHost = {
  run: ProcessRunner
  /** The names in a folder, or none when it is missing. */
  list(path: string): Promise<string[]>
  /** Where review worktrees go: `$TMPDIR/agy/worktrees`. */
  dir: string
}

/** The git side of the runs: an ask's edit check and a review's throwaway worktree. */
export function workspaces(host: WorkspaceHost): Workspaces {
  const git = (cwd: string, args: string[]) => host.run(['git', '-C', cwd, ...args], { timeoutMs: 60_000 })

  async function fingerprint(cwd: string): Promise<string | undefined> {
    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']).catch(() => undefined)
    if (inside?.exitCode !== 0 || inside.stdout.trim() !== 'true') return undefined
    const done = await host.run(['sh', '-c', FINGERPRINT], { cwd, timeoutMs: 120_000 }).catch(() => undefined)
    return done?.exitCode === 0 ? done.stdout.trim() || undefined : undefined
  }

  const pathOf = (id: string) => `${host.dir}/${id}`

  async function remove(project: string, worktree: string) {
    const removed = await git(project, ['worktree', 'remove', '--force', worktree]).catch(() => undefined)
    // A worktree of another repository, or one git no longer knows: its folder goes all the same.
    if (removed?.exitCode !== 0) await host.run(['rm', '-rf', worktree], { timeoutMs: 30_000 })
    await git(project, ['worktree', 'prune']).catch(() => undefined)
  }

  return {
    pathOf,
    ask: async project => ({ cwd: project, before: await fingerprint(project) }),
    review: async (project, id, target) => {
      const worktree = pathOf(id)
      const range = rangeOf(target)
      const files = await git(project, ['diff', '--name-only', range])
      if (files.exitCode !== 0) return { error: `git could not diff ${range}: ${files.stderr.trim() || `exit code ${files.exitCode}`}` }
      const changed = files.stdout.split('\n').filter(Boolean)
      if (!changed.length) return { error: `Nothing to review: ${range} changes no file.` }
      const added = await git(project, ['worktree', 'add', '--detach', worktree, 'commit' in target ? target.commit : 'HEAD'])
      if (added.exitCode !== 0) return { error: `git could not make the review worktree: ${added.stderr.trim() || `exit code ${added.exitCode}`}` }
      const path = `${worktree}/${DIFF_FILE}`
      const written = await host.run(['sh', '-c', WRITE_DIFF, 'sh', project, range, path], { timeoutMs: 60_000 })
      if (written.exitCode !== 0) {
        await remove(project, worktree)
        return { error: `git could not write the diff of ${range}: ${written.stderr.trim() || `exit code ${written.exitCode}`}` }
      }
      return { cwd: worktree, worktree, before: await fingerprint(worktree), diff: { path, files: changed } } satisfies Workspace
    },
    changed: async workspace => {
      if (workspace.before === undefined) return undefined
      const now = await fingerprint(workspace.cwd)
      if (now === undefined || now === workspace.before) return undefined
      return workspace.worktree
        ? 'Warning: agy edited its review worktree, against its instructions; the worktree was removed and your checkout was not touched.'
        : 'Warning: the working tree changed during this run (agy was told not to edit); check `git status` and `git diff`.'
    },
    remove,
    left: async () => host.list(host.dir).catch(() => []),
  }
}
