# spider-claude-mods

A marketplace of Claude Code plugins that extend Claude's interface and tools through function hooks.

## Marketplace

**Shipped file**:
A file of a plugin that reaches whoever installs it: everything in the plugin's folder except its tests and docs.
_Avoid_: Source file, plugin file

**Release**:
One published version of one plugin: its version number, its changelog entry and its tag, covering the shipped-file changes since the previous one.
_Avoid_: Bump, deploy, publish

**Release pull request**:
The pull request, kept open by the release app, that holds the next release of every plugin with unreleased changes; merging it publishes them.
_Avoid_: Version PR, bump PR

## Codex

**Ask**:
A request that sends Codex a question, with optional files, and returns its written answer.
_Avoid_: Query, prompt

**Review**:
A request that has Codex review one review target of the current repository and returns its findings as written.
_Avoid_: Code review, advisor, audit

**Review target**:
The changes a review covers: the branch against its base, a single commit, the uncommitted changes, or free instructions.
_Avoid_: Scope, diff

**Thread**:
One Codex conversation, named by its id; a follow-up ask continues it.
_Avoid_: Session, conversation id

**Run**:
One execution of Codex for an ask, an image request or a review.
_Avoid_: Execution, call

**Job**:
A run that outlived the foreground wait and goes on in the background, across plugin reloads, until it ends or hits the background limit.
_Avoid_: Task, background run

**Lost**:
The state of a job that ended without an answer that can be recovered.
_Avoid_: Failed, orphaned

**Computer use**:
Claude controlling native Mac apps through Codex's desktop server, one approved app at a time.
_Avoid_: CUA, codex-cu, desktop control

**Helper**:
The per-user macOS background service that holds computer use sessions, app ownership and app approvals between Claude sessions.
_Avoid_: Daemon, bridge, server

**App approval**:
The person's yes to letting computer use drive one named app, which expires.
_Avoid_: Permission, grant

## Antigravity

**Conversation**:
One agy conversation, named by its id; a follow-up ask continues it. The Codex counterpart is the thread.
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
