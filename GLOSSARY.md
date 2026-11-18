# spider-claude-mods

A marketplace of Claude Code plugins that extend Claude's interface and tools through function hooks.

## Marketplace

**Shipped file**:
A file of a plugin that reaches whoever installs it: everything in the plugin's folder except its tests and docs.
_Avoid_: Source file, plugin file

**Release**:
One version of one plugin: the `version` in its `.claude-plugin/plugin.json` and its `CHANGELOG.md` line, raised by hand in the pull request that ships the shipped-file change.
_Avoid_: Bump, deploy, publish

## Antigravity

**Task**:
One piece of work Claude hands to agy with `antigravity-delegate run`, from its brief to its answer, kept in its own folder; a follow-up is a new task on the same session.
_Avoid_: Job, run, delegation

**Brief**:
The file that holds everything agy is told about a task; agy never sees the conversation.
_Avoid_: Prompt, instructions

**Mode**:
What the plugin answers to each of agy's permission requests in a task: `read-only` (reads inside the task's folder) or `implement` (reads and edits inside its worktree); no mode allows a command.
_Avoid_: Permission level, sandbox

**Role**:
The kind of read-only task (`ask`, `search`, `analysis` or `review`), which sets how its brief is introduced to agy.
_Avoid_: Type, task type

**Session**:
The agy ACP session a task runs on; a follow-up resumes it, one turn at a time.
_Avoid_: Conversation, thread

**Task worktree**:
The throwaway, detached git worktree a review or an implement task runs in, under the plugin's state folder; it is removed when the task ends, and the checkout is never written.
_Avoid_: Sandbox, checkout, copy

**Patch**:
Every change an implement task made in its worktree, against the commit it started at, saved as `patch.diff` for Claude or the person to apply.
_Avoid_: Diff, result

**Finding**:
One problem a review reports, ranked P0 to P3, with a path and line, checked against the findings format.
_Avoid_: Issue, comment

**Needs approval**:
The end of a task whose refused actions left agy with no answer; it goes on only in a broader mode the person agrees to.
_Avoid_: Blocked, pending

**agy home**:
The plugin's private agy folder (`--gemini-dir`), with no MCP servers, hooks, plugins or skills of the person's.
_Avoid_: Profile, config folder
