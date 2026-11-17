# Changelog

## 0.9.0 (2026-11-17)

### ⚠ BREAKING CHANGES

* the tools are named `mcp__plugin_gitlab_gitlab__<tool>` instead of `mcp__gitlab__<tool>`, so permission rules need the new name, and the plugin needs `node` 22.18 or later on `PATH` ([#442](https://github.com/anderson-spider/spider-claude-mods/pull/442))

### Features

* serve the tools from an MCP server of the plugin, with no hooks, so Code Mode stays available ([#442](https://github.com/anderson-spider/spider-claude-mods/pull/442))

## [0.8.0](https://github.com/anderson-spider/spider-claude-mods/compare/gitlab-v0.7.1...gitlab-v0.8.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* migrate the agent-skills skills into plugins named by function ([#432](https://github.com/anderson-spider/spider-claude-mods/issues/432))

### Features

* migrate the agent-skills skills into plugins named by function ([#432](https://github.com/anderson-spider/spider-claude-mods/issues/432)) ([8b3faa1](https://github.com/anderson-spider/spider-claude-mods/commit/8b3faa1c548c1303fedee99b069e74b785d84c1f))
