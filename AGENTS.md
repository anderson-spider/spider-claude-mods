# AGENTS.md

Claude Code plugin marketplace; one plugin per `plugins/<name>/`. Most are function hooks mods, an early-access API that may change between Claude Code versions. Before changing a plugin, read its `AGENTS.md`; plugin guidance lives there because a plugin-root `CLAUDE.md` draws a validation warning. Use the terms in `GLOSSARY.md`.

## Commands

- Setup: Node from `.nvmrc`, `corepack enable`, `pnpm install` (pins the Claude Code CLI and TypeScript). Root: `pnpm check` = `validate` + `test` + `typecheck`; one plugin: `pnpm --filter <name> <script>`.
- One Node test: `node --test --test-name-pattern=<regex> <file>` from the plugin folder.
- Typecheck needs the git-ignored `.claude-plugin/types/`, which only an interactive session writes: run `claude --plugin-dir plugins/<name>` and `/exit` before the first typecheck, after a Claude Code update, or after an MCP integration change. That is also why CI skips typecheck.
- `/reload-plugins` and `claude plugin details` report `0 hooks` for module plugins (they count only `hooks.json` command hooks); `claude plugin validate plugins/<name>` lists a module's events and `$` calls; a module that fails to load leaves a line in `claude --debug`.
- Tests run against host fakes, so a Claude Code update can break a plugin with every test green. Check real behavior with `claude --plugin-dir plugins/<name>`.

## Code rules

- Hooks work: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm.
- The engine finds `on(...)` and `$.noun.method(...)` calls by source analysis: pass `$` only to top-level functions of the same file, never across an import, and write `$.env.get` names as literals. Pure modules take injected host access.
- Any module hook on tool calls (`tool.call`, `tool.run`, `tool.check`, `tool.judge`, `agent.spawn`, `agent.offer`, `session.send`, classic `PreToolUse`/`PostToolUse` inside a module) turns Code Mode off. Plugins that must keep Code Mode expose tools through an MCP server or read the transcript instead.
- `claude plugin validate` type-checks any TypeScript a plugin runs as hooks-module code, without Node types; Node-side code is therefore JSDoc-typed `.mjs` checked by `tsconfig.node.json` (gitlab instead runs `.ts` through Node's type stripping).
- MCP servers get plugin options as `SPIDER_<PLUGIN>_OPTION_*` from `${user_config.*}` in `.mcp.json` and delete them from their environment, so child processes do not inherit them.
- `hooks/schema.ts` and `tests/schema-types.ts` (gitlab: `server/`) are identical copies in every plugin that has them, except the import path in `tests/schema-types.ts`: edit one, copy to all. Each tool's `inputSchema` must satisfy `SchemaFor` of its input type.
- Credentials: an option or environment source counts only whole, never mixed with another; a source the project or local settings declare is refused, since anyone with commit access could plant it; messages name the option or variable, never the value.
- Names a person types or Claude calls start with the plugin's full name, never the marketplace's: commands `<plugin>-<action>` (`$.command.register` refuses `:`), skills shown as `<plugin>:<skill>` without repeating the plugin name.
- Placeholders only (`gitlab.example.com/group/project`), never real hosts, projects, paths or tokens: the code runs on every installed copy.

## Done for a plugin change

1. `validate` and `test` pass for the plugin, and `typecheck` when it has TypeScript.
2. A change to a shipped file (anything in the plugin folder except tests and docs) raises `version` in `.claude-plugin/plugin.json` (semver) and adds a `CHANGELOG.md` line; installed copies update only when the version changes.
3. The root `README.md`, the plugin's `README.md` and its `AGENTS.md` match the new behavior.

## Adding or removing a plugin

- Add: `claude plugin init <name>` in `plugins/`; a `package.json` with only `validate`, `test` and `typecheck` scripts; a `.claude-plugin/marketplace.json` entry with the manifest's description; a README row and install line.
- Unlisted: a name in `.claude-plugin/unlisted.json` gets no marketplace entry, README row or install line, and is still validated and tested; load it with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`, with options under `pluginConfigs["<name>@inline"]`.
- Remove: the folder, the marketplace entry, the README row and install line.

## Conventions

- English for code, comments, docs and plugin messages; Conventional Commits for commits and PR titles; PR bodies follow `.github/pull_request_template.md`. A breaking rename ships under a `!` title.
- Docs state current behavior; history lives in git. A rule that explains one line of code goes in a comment there.
- Issues: this repository's GitHub Issues, through `gh`.
