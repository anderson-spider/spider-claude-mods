import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { GitlabError, NoProjectError, gitlab } from './api'
import { comment } from './comments'
import { InputError, makeCtx, type Ctx } from './context'
import { errorText } from './errors'
import { jobLog } from './joblog'
import { label } from './labels'
import { mr } from './mr'
import { pipeline } from './pipelines'
import { currentBranch, hostName, locate, projectPath, sshHostname, type Git, type Ssh } from './remote'
import { allOf, type SchemaFor } from './schema'
import { DEFAULT_HOST_ENV, isSet, offText, resolveToken, type TokenIo } from './tokens'
import { user } from './users'

type Inputs = McpToolInputs

const MR_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_mr']['action']>()(
  'list', 'get', 'status', 'create', 'update', 'diff', 'commits', 'approve', 'unapprove', 'rebase', 'merge',
)
const COMMENT_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_mr_comment']['action']>()(
  'list', 'unresolved', 'drafts', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve', 'publish',
)
const PIPELINE_ACTIONS = allOf<Inputs['mcp__gitlab__gitlab_pipeline']['action']>()(
  'list', 'jobs', 'wait', 'run', 'retry', 'cancel', 'play', 'artifacts',
)

const IID = { type: 'integer', description: 'MR !iid. Default: the open MR of the current branch.' } as const
const NAMES = { type: 'array', items: { type: 'string' } } as const
const PROJECT = { type: 'string', description: 'group/project or numeric id.' } as const
const HOST = { type: 'string', description: "Default: the remote's host." } as const
const PAGE = { type: 'integer' } as const
const PER_PAGE = { type: 'integer', description: 'Max 100.' } as const
const ALLOW_OTHERS = { type: 'boolean', description: "Write on someone else's MR; only when the user asked." } as const

/** Shapes a call's output for the host: `isError` is set only when true (the host rejects `false`). */
function reply(text: string, isError = false): { result: string } | { result: string; isError: true } {
  return isError ? { result: text, isError: true as const } : { result: text }
}

/** The repository's settings, which decide whether the tokens may be used, and the environment variable that is their second source. */
function tokenIo($: EngineInterface): TokenIo {
  return {
    settings: async (source) => {
      const settings = await $.settings.read({ source })
      return { pluginConfigs: settings?.pluginConfigs, env: settings?.env }
    },
    env: () => $.env.get('SPIDER_PLUGIN_OPTION_GITLAB_TOKENS'),
  }
}

/** Where a call goes: the host, its token and, when the host is the remote's, the remote's project. */
type Target = { host: string; token: string; current?: string } | { error: string }

/** The remote's host (an SSH alias resolved through `ssh -G`) and its token. */
async function fromRemote(git: Git, ssh: Ssh, io: TokenIo, tokens: unknown): Promise<Target> {
  const where = await locate(git)
  if ('error' in where) return where
  let host = where.host
  let access = await resolveToken(io, tokens, host)
  if (access.off === 'no-host' && where.ssh) {
    // an SSH remote may name a ~/.ssh/config alias (`git@work:group/app.git`): its token is the real host's
    const real = await sshHostname(ssh, host)
    if (real && real !== host) {
      access = await resolveToken(io, tokens, real)
      if (access.off === 'no-host') return { error: `The remote's host ${host} is an SSH alias for ${real}. ${offText('no-host', real)}` }
      host = real
    } else if (!host.includes('.')) {
      return { error: `${offText('no-host', host)} If ${host} is an SSH alias from ~/.ssh/config, ssh -G could not resolve it: give the remote the real host name.` }
    }
  }
  if (access.off !== undefined) return { error: offText(access.off, host) }
  return { host, token: access.token, current: where.project }
}

/** A host named by the `host` input or the defaultHost option, and its token; the remote's project only when the remote is on it. */
async function onHost(git: Git, ssh: Ssh, io: TokenIo, tokens: unknown, host: string): Promise<Target> {
  const access = await resolveToken(io, tokens, host)
  if (access.off !== undefined) return { error: offText(access.off, host) }
  const where = await locate(git)
  if ('error' in where) return { host, token: access.token }
  const same = where.host === host || (!!where.ssh && (await sshHostname(ssh, where.host)) === host)
  return { host, token: access.token, current: same ? where.project : undefined }
}

/**
 * The host wiring every tool shares: picks the host (the `host` input, else the remote's, else the defaultHost option
 * when the remote gives none with a token) and its token, switches to `project` when given and runs the tool.
 */
async function run(
  $: EngineInterface,
  tool: (ctx: Ctx, input: Record<string, unknown>) => Promise<string>,
  input: Record<string, unknown>,
  options: { tokens?: unknown; defaultHost?: unknown },
): Promise<ReturnType<typeof reply>> {
  const git: Git = (args) => $.process.run(['git', ...args], { timeoutMs: 10_000 })
  const ssh: Ssh = (args) => $.process.run(['ssh', ...args], { timeoutMs: 5_000 })
  const io = tokenIo($)
  let target: Target
  if (input.host !== undefined) {
    const named = hostName(input.host)
    if (!named) return reply('host must be a GitLab host name (gitlab.example.com), not a URL.', true)
    target = await onHost(git, ssh, io, options.tokens, named)
  } else {
    target = await fromRemote(git, ssh, io, options.tokens)
    if ('error' in target) {
      const fallback = isSet(options.defaultHost) ? options.defaultHost : await $.env.get('SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST')
      if (isSet(fallback)) {
        const named = hostName(fallback)
        if (!named) return reply(`The gitlab defaultHost option (or ${DEFAULT_HOST_ENV}) is not a host name (gitlab.example.com).`, true)
        target = await onHost(git, ssh, io, options.tokens, named)
      }
    }
  }
  if ('error' in target) return reply(target.error, true)
  const { host, token, current } = target
  let project = current
  if (input.project !== undefined) {
    const named = projectPath(input.project)
    if (!named) return reply(`project must be a project path (group/project) or numeric id on ${host}, not a URL: name another GitLab with host.`, true)
    project = named
  }
  // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
  const api = gitlab((url, init) => $.http.fetch(url, init), host, project, token)
  // an answer can echo what the request carried (a proxy's error page, a fetch error), so the token is masked in every output
  const masked = (text: string, isError = false) => reply(text.split(token).join('[token]'), isError)
  const foreign = project === undefined || current === undefined || project.toLowerCase() !== current.toLowerCase()
  try {
    const clock = {
      now: () => Date.now(),
      // a host process waits without spending the hook's own time, as a timer would
      sleep: async (ms: number) => {
        await $.process.run(['sleep', String(ms / 1000)], { timeoutMs: ms + 5_000 })
      },
    }
    return masked(await tool(makeCtx(api, () => currentBranch(git), clock, foreign), input))
  } catch (err) {
    if (err instanceof NoProjectError) return masked(`Name the project (group/project or its numeric id): the repository's remote is not on ${host}.`, true)
    if (err instanceof InputError) return masked(err.message, true)
    if (err instanceof GitlabError) return masked(errorText(err, project ?? host, host), true)
    return masked(`Call to ${host} failed: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/** A hook that threw (a bug, not an API answer) still ends the call with an error instead of leaving it unanswered. */
const failed = () => reply('The gitlab tool failed before it could answer. Try again; if it repeats, run claude --debug.', true)

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'gitlab_mr',
      description:
        "Merge requests of the repo's GitLab project. list (allProjects: every project; next = more " +
        'pages), get, status (pipeline, approvals, discussions, conflicts, blockers), diff, commits, create (draft by ' +
        'default), update, ' +
        'approve, unapprove, rebase, merge (only when the user asks; iid and head sha required; refused for drafts, ' +
        'conflicts, blocking discussions, release* or protected targets besides main/master/develop unless ' +
        'allowProtectedTarget). Labels must exist unless createMissingLabels. Writes on MRs by others are refused without allowOthers.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: MR_ACTIONS },
          host: HOST,
          project: PROJECT,
          iid: IID,
          state: { type: 'string', enum: allOf<'opened' | 'merged' | 'closed' | 'all'>()('opened', 'merged', 'closed', 'all') },
          scope: { type: 'string', enum: allOf<'created_by_me' | 'assigned_to_me' | 'all'>()('created_by_me', 'assigned_to_me', 'all') },
          author: { type: 'string', description: 'list: username or @me.' },
          assignee: { type: 'string' },
          reviewer: { type: 'string' },
          search: { type: 'string' },
          allProjects: { type: 'boolean' },
          page: PAGE,
          perPage: PER_PAGE,
          title: { type: 'string' },
          description: { type: 'string' },
          sourceBranch: { type: 'string' },
          targetBranch: { type: 'string' },
          labels: { ...NAMES, description: 'list filter; create/update: all labels.' },
          addLabels: NAMES,
          removeLabels: NAMES,
          createMissingLabels: { type: 'boolean' },
          assignees: { ...NAMES, description: '@me=owner; create default' },
          reviewers: NAMES,
          draft: { type: 'boolean' },
          stateEvent: { type: 'string', enum: allOf<'close' | 'reopen'>()('close', 'reopen') },
          removeSourceBranch: { type: 'boolean' },
          squash: { type: 'boolean' },
          files: { ...NAMES, description: 'diff: paths with these.' },
          sha: { type: 'string', description: 'merge: full head sha from status.' },
          whenPipelineSucceeds: { type: 'boolean', description: 'merge: auto-merge on pipeline success.' },
          allowOthers: ALLOW_OTHERS,
          allowProtectedTarget: { type: 'boolean' },
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_mr']>,
    })
    await $.tool.register({
      name: 'gitlab_mr_comment',
      description:
        'Discussions of a merge request: list (ids, authors, file/line, resolved; next = more pages), unresolved (open ' +
        'threads: place, author, ask, last reply; up to 2,000 discussions), comment, reply ' +
        'to a discussion, line (a diff comment on path at line, or oldLine for a removed line), edit a note, resolve, ' +
        'unresolve; draft: true does these as private draft notes, drafts lists them, publish posts one (noteId) or ' +
        'all. Writes on MRs by others are refused without allowOthers.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: COMMENT_ACTIONS },
          host: HOST,
          project: PROJECT,
          iid: IID,
          body: { type: 'string', description: 'Markdown text.' },
          discussionId: { type: 'string' },
          noteId: { type: 'integer', description: 'edit; publish: one draft, default all.' },
          draft: { type: 'boolean', description: 'comment, reply, line, edit: a draft note.' },
          path: { type: 'string', description: 'line: file path as in the diff.' },
          line: { type: 'integer', description: 'line: new-side line number.' },
          oldLine: { type: 'integer', description: 'line: old-side line number (both for an unchanged line).' },
          unresolvedOnly: { type: 'boolean' },
          page: PAGE,
          perPage: PER_PAGE,
          allowOthers: ALLOW_OTHERS,
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_mr_comment']>,
    })
    await $.tool.register({
      name: 'gitlab_pipeline',
      description:
        "Pipelines of a merge request (iid, or the current branch's MR) or of a ref: list; jobs of a pipeline " +
        '(default the latest) with downstream pipelines; wait for one to end (at most minutes; failed jobs with log ' +
        'excerpts); run (an MR pipeline, or a ref pipeline with variables); ' +
        'retry or cancel a job or pipeline; play a manual job; artifacts of a job (names, sizes, URL). ' +
        'Read a failed job with gitlab_job_log.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: PIPELINE_ACTIONS },
          host: HOST,
          project: PROJECT,
          iid: IID,
          ref: { type: 'string', description: 'Branch or tag instead of an MR.' },
          pipelineId: { type: 'integer' },
          jobId: { type: 'integer' },
          failedOnly: { type: 'boolean', description: 'jobs: only failed jobs.' },
          minutes: { type: 'integer', description: 'wait: at most this long (default 10, max 30).' },
          variables: { ...NAMES, description: 'run with ref: KEY=value.' },
          page: PAGE,
          perPage: PER_PAGE,
          allowOthers: ALLOW_OTHERS,
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_pipeline']>,
    })
    await $.tool.register({
      name: 'gitlab_job_log',
      description:
        "A CI job's log without terminal codes. errors (default): lines matching error words or pattern, with " +
        'context, then the last 30 lines; tail: the last lines; full: everything, cut at 60k characters.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'integer' },
          host: HOST,
          project: PROJECT,
          mode: { type: 'string', enum: allOf<'errors' | 'tail' | 'full'>()('errors', 'tail', 'full') },
          lines: { type: 'integer', description: 'tail: how many lines (default 100).' },
          pattern: { type: 'string', description: 'errors: a case-insensitive regex instead of the error words.' },
        },
        required: ['jobId'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_job_log']>,
    })
    await $.tool.register({
      name: 'gitlab_label',
      description:
        "Labels of the current repo's GitLab project (its own and its groups'): list (name, colour, description; " +
        'search; next = more pages); create (name, color default #428BCA, description), which answers the existing ' +
        'label when the name is taken.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: allOf<Inputs['mcp__gitlab__gitlab_label']['action']>()('list', 'create') },
          host: HOST,
          project: PROJECT,
          name: { type: 'string' },
          color: { type: 'string', description: 'Hex, like #428BCA.' },
          description: { type: 'string' },
          search: { type: 'string' },
          page: PAGE,
          perPage: PER_PAGE,
        },
        required: ['action'],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_label']>,
    })
    await $.tool.register({
      name: 'gitlab_user',
      description: "A user of the current repo's GitLab host: the token's own user by default (or @me), else the one with username.",
      inputSchema: {
        type: 'object',
        properties: {
          host: HOST,
          username: { type: 'string', description: 'Default: the token owner.' },
        },
        required: [],
      } satisfies SchemaFor<Inputs['mcp__gitlab__gitlab_user']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__gitlab__gitlab_mr' }, async ($, e) => run($, mr, e, options)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_mr_comment' }, async ($, e) => run($, comment, e, options)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_pipeline' }, async ($, e) => run($, pipeline, e, options)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_job_log' }, async ($, e) => run($, jobLog, e, options)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_label' }, async ($, e) => run($, label, e, options)).catch(failed)
  on('tool.call', { tool: 'mcp__gitlab__gitlab_user' }, async ($, e) => run($, user, e, options)).catch(failed)
}
