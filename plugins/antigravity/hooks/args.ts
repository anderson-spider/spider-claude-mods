import type { Request, Workspace } from './model'

// How much sooner than the plugin's limit agy's own print timeout ends a run.
const TIMEOUT_MARGIN_MS = 30_000

/** What every prompt ends with: agy has no read-only mode, so the sandbox, this line and the edit check stand for one. */
export const NO_EDIT = 'Do not edit, create or delete any file and do not run commands that change anything; answer in text only.'

/** Whether a path is the folder `dir` or lies within it. */
export const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir.replace(/\/$/, '')}/`)

/** The folder a file is in. */
export const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

/** The folders of the listed files that lie outside `cwd`, each once: agy reads only its working folder and these. */
function outsideDirs(files: string[], cwd: string): string[] {
  return [...new Set(files.filter(path => !within(path, cwd)).map(folderOf))]
}

/** The review's instructions: the diff file and its files, the severity scale, and the person's focus when given. */
export function reviewPrompt(request: Request, workspace: Workspace): string {
  const diff = workspace.diff
  const files = diff?.files.length ? diff.files.map(path => `- ${path}`).join('\n') : '- (none)'
  return [
    `Review the code changes of this git repository (${request.prompt}). The full diff is in ${diff?.path ?? 'the diff file'}; the changed files are:`,
    files,
    '',
    'Read the diff, then the surrounding code in this folder as needed. Report only real problems, most severe first, each as:',
    '[P0|P1|P2|P3] short title — path:line',
    'then one or two sentences on what goes wrong and when. P0 breaks the build, loses data or opens a security hole; P1 is a bug users hit;',
    'P2 a bug in an edge case or a missing check at a real boundary; P3 a minor correctness or clarity issue worth fixing.',
    'Put correctness and security first. Leave out style, naming and formatting comments. If you find nothing, say "No findings." and stop: that is a valid answer.',
    ...(request.focus ? ['', `Also look closely at: ${request.focus}`] : []),
  ].join('\n')
}

/** The prompt agy gets: the request (or the review's instructions), the files to read, then the no-edit line. */
export function promptOf(request: Request, workspace: Workspace): string {
  const text = request.kind === 'review' ? reviewPrompt(request, workspace) : request.prompt
  const files = request.files.length ? `\n\nFiles to read (absolute paths):\n${request.files.map(path => `- ${path}`).join('\n')}` : ''
  return `${text}${files}\n\n${NO_EDIT}`
}

/**
 * The arguments after the `agy` executable for one run, in print mode with stream-json events. Never
 * `--dangerously-skip-permissions`: reads pass without it (measured on agy 1.5.3), and an edit stays behind the
 * sandbox's prompts. Never `--mode plan` either: agy ignores it under `--disable-slash-commands`, which keeps a prompt
 * that starts with `/` from running as a command. Every value is fused to its flag (`--flag=value`), so a value that
 * starts with `-` is never read as a flag. `--print-timeout` is the background limit less a margin, so agy ends on its
 * own, with its own reason, before the plugin's deadline (counted from just before the launch) stops it.
 */
export function argsOf(request: Request, workspace: Workspace, timeoutMs: number): string[] {
  return [
    '--output-format=stream-json',
    '--disable-slash-commands',
    '--sandbox',
    `--print-timeout=${Math.max(1, Math.floor((timeoutMs - TIMEOUT_MARGIN_MS) / 1000))}s`,
    ...(request.model ? [`--model=${request.model}`] : []),
    ...(request.effort ? [`--effort=${request.effort}`] : []),
    ...(request.conversationId ? [`--conversation=${request.conversationId}`] : []),
    ...outsideDirs(request.files, workspace.cwd).map(dir => `--add-dir=${dir}`),
    `--print=${promptOf(request, workspace)}`,
  ]
}
