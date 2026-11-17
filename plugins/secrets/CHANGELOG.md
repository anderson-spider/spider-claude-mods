# Changelog

## 2.0.0 (2026-11-17)

### ⚠ BREAKING CHANGES

* the tool is named `mcp__plugin_secrets_secrets__request_secret` instead of `mcp__secrets__request_secret`, so permission rules need the new name, and the plugin needs `node` 22.18 or later on `PATH` ([#445](https://github.com/anderson-spider/spider-claude-mods/pull/445))

### Features

* serve `request_secret` from an MCP server of the plugin, with the requests in a file queue the hooks module shows as a card, and fence tool calls with a `PreToolUse` command hook, so Code Mode stays available ([#445](https://github.com/anderson-spider/spider-claude-mods/pull/445))

## [1.0.1](https://github.com/anderson-spider/spider-claude-mods/compare/secrets-v1.0.0...secrets-v1.0.1) (2026-11-16)


### Bug Fixes

* **secrets:** look at the pane again before calling the terminal too narrow ([#436](https://github.com/anderson-spider/spider-claude-mods/issues/436)) ([d27efe0](https://github.com/anderson-spider/spider-claude-mods/commit/d27efe079179081fb6bed37b5de2f6f99e4edee5))

## 1.0.0 (2026-11-16)


### Features

* **secrets:** add a plugin that asks for secrets in a private card ([#434](https://github.com/anderson-spider/spider-claude-mods/issues/434)) ([bd783b7](https://github.com/anderson-spider/spider-claude-mods/commit/bd783b72e4ca142b38f8320fb9f82defc997f6a7))
