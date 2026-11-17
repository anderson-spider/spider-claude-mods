// The six tools as the MCP server lists them: name, description and inputSchema, each schema checked against its
// input type by `SchemaFor`, and the function that answers it.
import { comment } from './comments.ts'
import type { ToolInputs } from './inputs.ts'
import { jobLog } from './joblog.ts'
import { label } from './labels.ts'
import { mr } from './mr.ts'
import { pipeline } from './pipelines.ts'
import type { Tool } from './run.ts'
import { allOf, type SchemaFor } from './schema.ts'
import { user } from './users.ts'

type Inputs = ToolInputs

const MR_ACTIONS = allOf<Inputs['gitlab_mr']['action']>()(
  'list', 'get', 'status', 'create', 'update', 'diff', 'commits', 'approve', 'unapprove', 'rebase', 'merge',
)
const COMMENT_ACTIONS = allOf<Inputs['gitlab_mr_comment']['action']>()(
  'list', 'unresolved', 'drafts', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve', 'publish',
)
const PIPELINE_ACTIONS = allOf<Inputs['gitlab_pipeline']['action']>()(
  'list', 'jobs', 'wait', 'run', 'retry', 'cancel', 'play', 'artifacts',
)

const IID = { type: 'integer', description: 'MR !iid. Default: the open MR of the current branch.' } as const
const NAMES = { type: 'array', items: { type: 'string' } } as const
const PROJECT = { type: ['string', 'integer'], description: 'group/project or numeric id.' } as const
const HOST = { type: 'string', description: "Default: the remote's host." } as const
const PAGE = { type: 'integer' } as const
const PER_PAGE = { type: 'integer', description: 'Max 100.' } as const
const ALLOW_OTHERS = { type: 'boolean', description: "Write on someone else's MR; only when the user asked." } as const

export type ToolSpec = { name: keyof ToolInputs; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: readonly string[] } }

export const SPECS: readonly ToolSpec[] = [
  {
    name: 'gitlab_mr',
    description:
      "Merge requests of the repo's GitLab project. list (allProjects: every project; next = more " +
      'pages), get, status (pipeline, approvals, discussions, conflicts, blockers), diff, commits, create, update, ' +
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
    } satisfies SchemaFor<Inputs['gitlab_mr']>,
  },
  {
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
    } satisfies SchemaFor<Inputs['gitlab_mr_comment']>,
  },
  {
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
    } satisfies SchemaFor<Inputs['gitlab_pipeline']>,
  },
  {
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
    } satisfies SchemaFor<Inputs['gitlab_job_log']>,
  },
  {
    name: 'gitlab_label',
    description:
      "Labels of the current repo's GitLab project (its own and its groups'): list (name, colour, description; " +
      'search; next = more pages); create (name, color default #428BCA, description), which answers the existing ' +
      'label when the name is taken.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: allOf<Inputs['gitlab_label']['action']>()('list', 'create') },
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
    } satisfies SchemaFor<Inputs['gitlab_label']>,
  },
  {
    name: 'gitlab_user',
    description: "A user of the current repo's GitLab host: the token's own user by default (or @me), else the one with username.",
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        username: { type: 'string', description: 'Default: the token owner.' },
      },
      required: [],
    } satisfies SchemaFor<Inputs['gitlab_user']>,
  },
]

/** What answers each tool. */
export const TOOLS: Readonly<Record<keyof ToolInputs, Tool>> = {
  gitlab_mr: mr,
  gitlab_mr_comment: comment,
  gitlab_pipeline: pipeline,
  gitlab_job_log: jobLog,
  gitlab_label: label,
  gitlab_user: user,
}
