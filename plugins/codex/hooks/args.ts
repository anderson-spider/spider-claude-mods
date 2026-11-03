import type { Request, ReviewTarget } from './model'

/** The label `--thread-source` records in each new Codex session, so the person can tell the plugin's runs apart. */
export const THREAD_SOURCE = 'claude-code-codex-plugin'

// Read-only whatever the user's config says (theirs may grant full access), never asking for approval (nobody could
// answer it). `codex exec resume` takes no --sandbox, so both forms set it through the config.
const LOCKED = ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']

// The web search an ask uses and an image run or a review (about the local code) leaves out.
const WEB_SEARCH = { ask: 'live', image: 'disabled', review: 'disabled' } as const

// What the image run is told before the person's request: it is there to draw, not to work on files.
export const IMAGE_PREFIX =
  'Generate the image described below with your image generation tool. Do not run shell commands or edit files. ' +
  'Once it is generated, reply with one short line describing it.\n\nRequest:\n'

/**
 * The options every run shares: the read-only lock, the kind's web search, the model and effort when given, and the
 * file Codex writes its last message to (`-o`), which a detached run's answer is read from.
 */
function tuningArgs(request: Request, answer?: string): string[] {
  return [
    ...(answer ? ['-o', answer] : []),
    ...LOCKED,
    '-c',
    `web_search="${WEB_SEARCH[request.kind]}"`,
    ...(request.model ? ['-m', request.model] : []),
    ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
  ]
}

/** The prompt Codex gets: the request, the files it should read named after it, and the image instructions first. */
export function promptOf(request: Request): string {
  const files = request.files.length ? `\n\nFiles to read (absolute paths):\n${request.files.map(path => `- ${path}`).join('\n')}` : ''
  const text = `${request.prompt}${files}`
  return request.kind === 'image' ? `${IMAGE_PREFIX}${text}` : text
}

/**
 * The arguments after the `codex` executable for one run: `exec` for a new session, in `cwd` when given (else the
 * child's own folder), `exec resume` for a follow-up (which takes no `-C`: the child is started in `cwd` instead).
 * `--` ends the options, since `--image` takes several values.
 */
export function argsOf(request: Request, cwd?: string, answer?: string): string[] {
  if (request.kind === 'review') return reviewArgsOf(request, answer)
  const options = [
    '--json',
    '--skip-git-repo-check',
    ...tuningArgs(request, answer),
    ...request.images.flatMap(path => ['--image', path]),
  ]
  const prompt = promptOf(request)
  if (request.threadId) return ['exec', 'resume', ...options, '--', request.threadId, prompt]
  return ['exec', ...options, '--thread-source', THREAD_SOURCE, ...(cwd ? ['-C', cwd] : []), '--', prompt]
}

// The flags of each review target; free instructions are the prompt, which Codex cannot combine with a target flag.
const targetArgs = (target: ReviewTarget): string[] => {
  if ('base' in target) return ['--base', target.base]
  if ('commit' in target) return ['--commit', target.commit]
  if ('uncommitted' in target) return ['--uncommitted']
  return ['--', target.instructions]
}

/**
 * `codex exec review` in the child's folder (the session's, a repository register.tsx has checked): it takes no `-C`.
 * Read-only and without web search like an image run; a follow-up question goes through an ask on its thread.
 */
function reviewArgsOf(request: Request, answer?: string): string[] {
  // resolveReview (review.ts) gives every review its target; without one this would be no review at all.
  if (!request.review) throw new Error('A review needs its target resolved before it runs.')
  return ['exec', 'review', '--json', ...tuningArgs(request, answer), '--thread-source', THREAD_SOURCE, ...targetArgs(request.review)]
}
