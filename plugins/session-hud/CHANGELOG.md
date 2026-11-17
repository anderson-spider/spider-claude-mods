# Changelog

## 0.16.0 (2026-11-17)

### ⚠ BREAKING CHANGES

* `/session-hud-panel` and the session panel are removed, and the card no longer shows the running subagents or the tokens they used ([#441](https://github.com/anderson-spider/spider-claude-mods/pull/441))

### Features

* count edits and errors from the transcript, with no `tool.call` or `agent.spawn` hook, so Code Mode stays available ([#441](https://github.com/anderson-spider/spider-claude-mods/pull/441))

## [0.15.0](https://github.com/anderson-spider/spider-claude-mods/compare/session-hud-v0.14.0...session-hud-v0.15.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* migrate the agent-skills skills into plugins named by function ([#432](https://github.com/anderson-spider/spider-claude-mods/issues/432))

### Features

* migrate the agent-skills skills into plugins named by function ([#432](https://github.com/anderson-spider/spider-claude-mods/issues/432)) ([8b3faa1](https://github.com/anderson-spider/spider-claude-mods/commit/8b3faa1c548c1303fedee99b069e74b785d84c1f))
