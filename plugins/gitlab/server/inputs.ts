// The inputs of the six tools, by tool name, as their inputSchema in tools.ts declares them (`SchemaFor` checks the two
// agree). Types only: Node strips the imports of this file.
export interface ToolInputs {
  gitlab_mr: {
    action: 'list' | 'get' | 'status' | 'create' | 'update' | 'diff' | 'commits' | 'approve' | 'unapprove' | 'rebase' | 'merge'
    host?: string
    project?: string | number
    iid?: number
    state?: 'opened' | 'merged' | 'closed' | 'all'
    scope?: 'created_by_me' | 'assigned_to_me' | 'all'
    author?: string
    assignee?: string
    reviewer?: string
    search?: string
    allProjects?: boolean
    page?: number
    perPage?: number
    title?: string
    description?: string
    sourceBranch?: string
    targetBranch?: string
    labels?: string[]
    addLabels?: string[]
    removeLabels?: string[]
    createMissingLabels?: boolean
    assignees?: string[]
    reviewers?: string[]
    draft?: boolean
    stateEvent?: 'close' | 'reopen'
    removeSourceBranch?: boolean
    squash?: boolean
    files?: string[]
    sha?: string
    whenPipelineSucceeds?: boolean
    allowOthers?: boolean
    allowProtectedTarget?: boolean
  }
  gitlab_mr_comment: {
    action: 'list' | 'unresolved' | 'drafts' | 'comment' | 'reply' | 'line' | 'edit' | 'resolve' | 'unresolve' | 'publish'
    host?: string
    project?: string | number
    iid?: number
    body?: string
    discussionId?: string
    noteId?: number
    draft?: boolean
    path?: string
    line?: number
    oldLine?: number
    unresolvedOnly?: boolean
    page?: number
    perPage?: number
    allowOthers?: boolean
  }
  gitlab_pipeline: {
    action: 'list' | 'jobs' | 'wait' | 'run' | 'retry' | 'cancel' | 'play' | 'artifacts'
    host?: string
    project?: string | number
    iid?: number
    ref?: string
    pipelineId?: number
    jobId?: number
    failedOnly?: boolean
    minutes?: number
    variables?: string[]
    page?: number
    perPage?: number
    allowOthers?: boolean
  }
  gitlab_job_log: {
    jobId: number
    host?: string
    project?: string | number
    mode?: 'errors' | 'tail' | 'full'
    lines?: number
    pattern?: string
  }
  gitlab_label: {
    action: 'list' | 'create'
    host?: string
    project?: string | number
    name?: string
    color?: string
    description?: string
    search?: string
    page?: number
    perPage?: number
  }
  gitlab_user: {
    host?: string
    username?: string
  }
}
