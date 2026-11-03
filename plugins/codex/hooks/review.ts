import type { Request, ReviewTarget } from './model'
import { errorText } from './presentation'

/** Runs `git <args>` in the session's folder; any exit code resolves, and git that cannot run rejects. */
export type Git = (args: string[]) => Promise<{ exitCode: number; stdout: string }>

export const NOT_A_REPOSITORY = 'Not a git repository: a review needs the session to run inside one.'

// The bases tried when origin/HEAD names none, as in a clone without that ref or a repository without a remote.
const FALLBACK_BASES = ['main', 'master']

export const NO_BASE = 'No default branch found (origin/HEAD, main or master): pass the base to review against.'

/** The name a review goes by in file names and the jobs list. */
export function reviewName(target: ReviewTarget): string {
  if ('base' in target) return `review against ${target.base}`
  if ('commit' in target) return `review of commit ${target.commit}`
  if ('uncommitted' in target) return 'review of uncommitted changes'
  return target.instructions
}

/** What a base review leaves out: files git does not track yet, which `git diff <merge-base>` never shows. */
export const untrackedNote = (count: number) =>
  `${count} untracked ${count === 1 ? 'file was' : 'files were'} not reviewed; use \`uncommitted\` to include them.`

/**
 * Makes a review request runnable in the session's repository: refuses outside one, gives a request without a target
 * the branch against the base origin/HEAD names (else `main` or `master`), and notes the untracked files a base review leaves out.
 */
export async function resolveReview(request: Request, git: Git): Promise<Request | string> {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return NOT_A_REPOSITORY
    const target = request.review ?? (await defaultBase(git))
    if (!target) return NO_BASE
    let note: string | undefined
    if ('base' in target) {
      // One line per file, a new folder's files included, whatever status.showUntrackedFiles says.
      const listed = await git(['ls-files', '--others', '--exclude-standard'])
      const untracked = listed.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean).length : 0
      if (untracked) note = untrackedNote(untracked)
    }
    return { ...request, review: target, prompt: reviewName(target), ...(note ? { note } : {}) }
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
 * `/codex-review` arguments as a review target: nothing for the default, `--uncommitted`, `--base <branch>` or
 * `--commit <ref>` (also with `=`), alone; text that does not start with `--` is the review's instructions. Anything
 * else is `undefined`, for the usage, so a target the person meant is never sent to Codex as instructions.
 */
export function reviewCommandInput(args: string): Record<string, unknown> | undefined {
  const text = args.trim()
  if (!text) return {}
  if (text === '--uncommitted') return { uncommitted: true }
  const flag = /^--(base|commit)(?:=|\s+)(\S+)$/.exec(text)
  if (flag) return { [flag[1]!]: flag[2] }
  return text.startsWith('-') ? undefined : { instructions: text }
}
