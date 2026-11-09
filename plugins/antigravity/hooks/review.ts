import type { Request, ReviewTarget } from './model'
import { errorText } from './presentation'

/** Runs `git <args>` in the session's folder; any exit code resolves, and git that cannot run rejects. */
export type Git = (args: string[]) => Promise<{ exitCode: number; stdout: string }>

export const NOT_A_REPOSITORY = 'Not a git repository: a review needs the session to run inside one.'

// The bases tried when origin/HEAD names none, as in a clone without that ref or a repository without a remote.
const FALLBACK_BASES = ['main', 'master']

export const NO_BASE = 'No default branch found (origin/HEAD, main or master): pass the base to review against.'

/** The name a review goes by in file names, the saved file's first line and the jobs list. */
export function reviewName(target: ReviewTarget): string {
  return 'base' in target ? `review against ${target.base}` : `review of commit ${target.commit}`
}

/** What a review leaves out: it runs in a worktree at a commit, so files git does not track never reach it. */
export const untrackedNote = (count: number) =>
  `${count} untracked ${count === 1 ? 'file was' : 'files were'} not reviewed; commit ${count === 1 ? 'it' : 'them'} to include ${count === 1 ? 'it' : 'them'}.`

/**
 * Makes a review request runnable in the session's repository: refuses outside one, gives a request without a target
 * the branch against the base origin/HEAD names (else `main` or `master`), and notes the untracked files it leaves out.
 */
export async function resolveReview(request: Request, git: Git): Promise<Request | string> {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return NOT_A_REPOSITORY
    const target = request.review ?? (await defaultBase(git))
    if (!target) return NO_BASE
    // One line per file, a new folder's files included, whatever status.showUntrackedFiles says.
    const listed = await git(['ls-files', '--others', '--exclude-standard'])
    const untracked = listed.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean).length : 0
    return { ...request, review: target, prompt: reviewName(target), ...(untracked ? { note: untrackedNote(untracked) } : {}) }
  } catch (error) {
    return `git could not run (${errorText(error)}), so the review did not start.`
  }
}

// The base origin/HEAD names, else the first of the usual default branches that exists here.
async function defaultBase(git: Git): Promise<ReviewTarget | undefined> {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head.exitCode === 0 && head.stdout.trim()) return { base: head.stdout.trim() }
  for (const branch of FALLBACK_BASES) {
    if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0) return { base: branch }
  }
  return undefined
}

/**
 * `/agy-review` arguments as review input: an optional `--base <branch>` or `--commit <ref>` (also with `=`) first,
 * then any text as the focus. Another flag, or a target flag without its value, is `undefined`, for the usage, so a
 * target the person meant is never sent to agy as focus.
 */
export function reviewCommandInput(args: string): Record<string, unknown> | undefined {
  const text = args.trim()
  const flag = /^--(base|commit)(?:=|\s+)(?!-)(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (flag) return { [flag[1]!]: flag[2], ...(flag[3]?.trim() ? { focus: flag[3].trim() } : {}) }
  if (text.startsWith('-')) return undefined
  return text ? { focus: text } : {}
}
