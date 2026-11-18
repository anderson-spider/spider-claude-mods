# Changelog

## 3.0.0 (2026-11-18)

### ⚠ BREAKING CHANGES

* the plugin returns as an `antigravity-delegate` command in its `bin/` folder instead of an MCP server and hooks module: the `ask`, `image`, `review` and `jobs` tools and the `/antigravity-*` commands are gone

### Features

* `antigravity-delegate doctor`, `models` and `quota`: the agy CLI, its version and sign-in, a private agy home (`--gemini-dir`) that keeps the user's own MCP servers, hooks, plugins and skills out of delegated tasks, and the quota left with its reset times
* `antigravity-delegate run` drives `agy acp` and answers each read, edit and command agy asks for by the task's mode: `read-only` (roles `ask`, `search`, `analysis`, and `review`, which runs in a throwaway worktree and returns checked P0–P3 findings) or `implement`, which edits a throwaway worktree at HEAD and returns a patch; commands are always refused
* `antigravity-delegate follow` resumes a task's agy session, one turn at a time, starting from the earlier task's patch
* the `antigravity:delegate` skill tells Claude when a task is worth delegating, how to write the brief, to run it in the background, and what to do with each outcome: verify findings, ask the user before a broader mode or a native fallback, and review a patch before applying it
* a quota gate before each task (`--force` overrides it), time and idle limits, and failures classed as quota, sign-in, model, idle or time limit without the Google Cloud project or region

## 2.0.0 (2026-11-17)

### ⚠ BREAKING CHANGES

* the skills `antigravity:code-review` and `antigravity:review-publish` are removed: the plugin ships its tools and commands only, and a review is asked of the `review` tool directly

## 1.0.0 (2026-11-17)

### ⚠ BREAKING CHANGES

* the tools are named `mcp__plugin_antigravity_antigravity__<tool>` instead of `mcp__antigravity__<tool>`, so permission rules need the new name, and the plugin needs `node` 22.18 or later on `PATH` ([#446](https://github.com/anderson-spider/spider-claude-mods/pull/446))

### Features

* serve the ask, image, review and jobs tools from an MCP server of the plugin and keep the jobs as files, with the hooks module left to the commands, the system prompt section and the job notices, so Code Mode stays available ([#446](https://github.com/anderson-spider/spider-claude-mods/pull/446))

## 0.4.1 (2026-11-17)

### Bug Fixes

* name the gitlab tools by their MCP server name in review-publish ([#443](https://github.com/anderson-spider/spider-claude-mods/pull/443))

## [0.4.0](https://github.com/anderson-spider/spider-claude-mods/compare/antigravity-v0.3.1...antigravity-v0.4.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* migrate the agent-skills skills into plugins named by function ([#432](https://github.com/anderson-spider/spider-claude-mods/issues/432))

### Features

* migrate the agent-skills skills into plugins named by function ([#432](https://github.com/anderson-spider/spider-claude-mods/issues/432)) ([8b3faa1](https://github.com/anderson-spider/spider-claude-mods/commit/8b3faa1c548c1303fedee99b069e74b785d84c1f))
