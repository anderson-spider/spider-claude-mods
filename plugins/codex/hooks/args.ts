import type { Request } from './model'

/** The label `--thread-source` records in each new Codex session, so the person can tell the plugin's runs apart. */
export const THREAD_SOURCE = 'claude-code-codex-plugin'

// Read-only whatever the user's config says (theirs may grant full access), never asking for approval (nobody could
// answer it). `codex exec resume` takes no --sandbox, so both forms set it through the config.
const LOCKED = ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']

// The web search an ask uses and an image run leaves out.
const WEB_SEARCH = { ask: 'live', image: 'disabled' } as const

// What the image run is told before the person's request: it is there to draw, not to work on files.
export const IMAGE_PREFIX =
  'Generate the image described below with your image generation tool. Do not run shell commands or edit files. ' +
  'Once it is generated, reply with one short line describing it.\n\nRequest:\n'

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
export function argsOf(request: Request, cwd?: string): string[] {
  const options = [
    '--json',
    '--skip-git-repo-check',
    ...LOCKED,
    '-c',
    `web_search="${WEB_SEARCH[request.kind]}"`,
    ...(request.model ? ['-m', request.model] : []),
    ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ...request.images.flatMap(path => ['--image', path]),
  ]
  const prompt = promptOf(request)
  if (request.threadId) return ['exec', 'resume', ...options, '--', request.threadId, prompt]
  return ['exec', ...options, '--thread-source', THREAD_SOURCE, ...(cwd ? ['-C', cwd] : []), '--', prompt]
}
