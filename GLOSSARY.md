# spider-claude-mods

A marketplace of Claude Code plugins that extend Claude's interface and tools through function hooks.

## Marketplace

**Shipped file**:
A file of a plugin that reaches whoever installs it: everything in the plugin's folder except its tests and docs.
_Avoid_: Source file, plugin file

**Release**:
One version of one plugin: the `version` in its `.claude-plugin/plugin.json` and its `CHANGELOG.md` line, raised by hand in the pull request that ships the shipped-file change.
_Avoid_: Bump, deploy, publish

## Second opinions

**Ask**:
A request that sends agy a question, with optional files, and returns its written answer.
_Avoid_: Query, prompt

**Review**:
A request that has agy review one review target of the current repository and returns its findings as written.
_Avoid_: Code review, advisor, audit

**Review target**:
The changes a review covers: the branch against its base, a single commit, the uncommitted changes, or free instructions.
_Avoid_: Scope, diff

**Run**:
One execution of agy for an ask, an image request or a review.
_Avoid_: Execution, call

**Job**:
A run that outlived the foreground wait and goes on in the background, across plugin reloads, until it ends or hits the background limit.
_Avoid_: Task, background run

**Lost**:
The state of a job that ended without an answer that can be recovered.
_Avoid_: Failed, orphaned

## Antigravity

**Conversation**:
One agy conversation, named by its id; a follow-up ask continues it.
_Avoid_: Thread, session

**Review worktree**:
The throwaway git worktree an agy review runs in, at the reviewed commit, holding the diff; it is removed when the review ends.
_Avoid_: Sandbox, checkout

**Image request**:
A request that has agy generate or edit an image, in an empty work folder of the plugin's, and saves the images the run added.
_Avoid_: Image job, generation

**Artifacts folder**:
agy's own folder for one Conversation (`~/.gemini/antigravity-cli/brain/<conversation>/`), where its image-generator subagent saves images.
_Avoid_: Brain, output folder

## Orchestrator

**Delegated task**:
One task the orchestrator hands to another CLI's agent, which works in its own session and returns a result; a task outlives the session that started it.
_Avoid_: Job, run, subagent call

**Runtime mode**:
What a delegated task's agent may do, answered by the client to each of its permission requests: read-only (reads only, the rest refused at once), approval-required (reads only, the rest refused as needing approval), auto-accept-edits (edits inside the folder) or full-access; never broader than the session's ceiling.
_Avoid_: Permission level, sandbox

**Thread**:
The agent session a delegated task opens, with its folder, role, model and runtime mode fixed; follow-ups are later tasks on it that resume the session, one running at a time and the rest queued.
_Avoid_: Conversation, chat

**Notice**:
The message a delegated task's end leaves for the session that started it, submitted as a prompt once, unless a wait or a status read already returned the result.
_Avoid_: Notification, callback
