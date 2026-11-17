# spider-claude-mods

A marketplace of Claude Code plugins that extend Claude's interface and tools through function hooks.

## Marketplace

**Shipped file**:
A file of a plugin that reaches whoever installs it: everything in the plugin's folder except its tests and docs.
_Avoid_: Source file, plugin file

**Release**:
One version of one plugin: the `version` in its `.claude-plugin/plugin.json` and its `CHANGELOG.md` line, raised by hand in the pull request that ships the shipped-file change.
_Avoid_: Bump, deploy, publish
