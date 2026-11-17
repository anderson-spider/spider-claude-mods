---
name: gitlab
description: GitLab work (merge requests, pipelines, jobs, job logs, labels, MR comments and draft notes) done by the main agent with this plugin's mcp__plugin_gitlab_gitlab__* tools. Use automatically whenever the user pastes a GitLab URL or mentions an MR, merge request, pipeline, job, CI failure, "abre a MR", "vê o pipeline" or "comenta na MR", even without saying GitLab. Never for GitHub.
---

# GitLab

Do this yourself in the main agent; do not delegate to a subagent.

## Tools

- Use this plugin's tools: `mcp__plugin_gitlab_gitlab__gitlab_mr`, `mcp__plugin_gitlab_gitlab__gitlab_mr_comment`, `mcp__plugin_gitlab_gitlab__gitlab_pipeline`, `mcp__plugin_gitlab_gitlab__gitlab_job_log`, `mcp__plugin_gitlab_gitlab__gitlab_label` and `mcp__plugin_gitlab_gitlab__gitlab_user`. Never use them for GitHub.
- Work from the full MR, pipeline or job URL when the user gives one. It holds the host, the project path and the id: `https://<host>/<group>/<project>/-/merge_requests/<iid>`, `.../-/pipelines/<id>`, `.../-/jobs/<id>`.
  - Inside a clone of that project, the tools read the host and project from the git remote: pass only the id (`iid`, `pipelineId`, `jobId`).
  - Elsewhere, pass `host` (the host name, never the URL) and `project` (`group/subgroup/project`, or the numeric id), plus `iid` for any MR action: with `project` there is no current-branch MR.
- Without an `iid`, MR actions work on the open MR of the current branch.
- If a call is refused (token, host, permission, a guard), show the error to the user and what it says to do; do not guess, retry with other inputs, or work around it with another tool.
- Use git and the code to understand what happened (failing job, MR diff, branch state); edit files only when the task requires a fix.
- Never merge, close, rebase, approve or cancel anything unless the user explicitly asked. On someone else's MR, pass `allowOthers: true` only when the user asked to write there: that request is the authorization.

## Reading first

Read before writing: get the state the write depends on, then act on it.

- MR: `gitlab_mr` `get` (with description), `diff` (`files` to narrow it), `commits`. Whether it can merge and why not: `status` (merge status, conflicts, blocking discussions, draft, head pipeline, approvals, `sha`, `blockers`).
- Comments: `gitlab_mr_comment` `list` (`unresolvedOnly` to narrow it), or `unresolved` for the open threads in brief.
- Labels: `gitlab_label` `list` (`search` to narrow it) before applying any. Apply only existing labels, with `gitlab_mr` `update` and `addLabels`/`removeLabels`; a missing one is refused by name. Pass `createMissingLabels: true`, or `gitlab_label` `create`, only when the user asked for a new label.
- Current user: `gitlab_user` with no input (or `username: "@me"`); another user with `username`.

## Creating a merge request

- Push the branch with git first; the tools do not push.
- Title in English, Conventional Commits: `type(scope): description`.
- Description in Brazilian Portuguese, in `description`.
- `gitlab_mr` `create` with `title`, `targetBranch` and `description` (`sourceBranch` defaults to the current branch). It opens ready and assigned to `@me` by default: do not pass `draft: true` unless the user asks for a draft.
- The repository's own rules (CLAUDE.md/AGENTS.md, CONTRIBUTING, MR templates, commit-lint) win over these defaults.

## Comments on MRs

Write review comments in pt-BR and run them through the `humanizer` skill (installed separately; skip this step if it is not available and say so) before posting. Post a visible comment (`gitlab_mr_comment` `comment`, `reply` with `discussionId`, `line`) only when the user asked for one; review findings go as draft notes.

## Draft notes

Draft notes are visible only to their author, who edits and publishes them. All of them go through `gitlab_mr_comment` with `draft: true`:

- List: `drafts`.
- Summary, not tied to a line: `comment` with `body`.
- On a diff line: `line` with `body`, `path` and `line` (new-side line, for an added line), `oldLine` (old-side line, for a removed one) or both (an unchanged line). The tool builds the position from the MR's diff refs. One call per note.
- Reply in a thread: `reply` with `discussionId`. Change one: `edit` with `noteId`.
- Never `publish` them for the user unless the user explicitly asks to publish.
- Deleting a draft is not offered by the tools. Only when the user explicitly said to replace or delete one, fall back to `glab api -X DELETE projects/<url-encoded path>/merge_requests/<iid>/draft_notes/<id>` (`--hostname <host>` off the remote's host); if `glab` is not installed or fails, show the error.

## Pipelines and jobs

- Status: `gitlab_pipeline` `list` (an MR's pipelines, or those of `ref`) and `jobs` (the latest pipeline by default, or `pipelineId`; `failedOnly: true` for the failed jobs and failed downstream pipelines).
- Check once and report the state as it is (queued, running, passed, failed). Use `wait` (polls every 15 seconds, `minutes` up to 30) only when the user asked to wait for the result or the task cannot go on without it.
- Job log: `gitlab_job_log` with `jobId`; `mode` `errors` (the default, `pattern` to match other lines), `tail` (`lines`) or `full`. Show the relevant raw excerpts (errors, failing step, last lines) plus your diagnosis, not only a paraphrase.
- `run`, `retry`, `cancel` and `play` only when the user asked. `artifacts` lists a job's artifacts and their URLs; downloading them is left to the user.

## Not covered by the tools

The tools cover MRs, their comments and draft notes, pipelines, jobs, labels and users. For anything else, such as issues, deleting a draft note, files or branches on the server, or downloading artifacts, say that this plugin does not cover it and fall back to the `glab` CLI (`glab issue ...`, `glab api ...`, with `-R <full project URL>` or `--hostname <host>` off the remote's host), if it is installed, or to git for branch state. Never invent a tool or an action.
