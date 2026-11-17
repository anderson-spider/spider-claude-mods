# Changelog

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
