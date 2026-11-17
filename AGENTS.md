# AGENTS.md

Claude Code **function hooks mods** marketplace. User-facing setup is in [README.md](README.md); this file holds the rules for changing the code.

## Where to look

- Plugin work: read `plugins/<name>/AGENTS.md` before changing files under `plugins/<name>/`. Keep plugin guidance there: a plugin-root `CLAUDE.md` draws a validation warning.
- Second opinions and reviews from another model family through Google's Antigravity CLI (agy): `plugins/antigravity/AGENTS.md`.
- Second opinions and images through the Codex CLI, and native Mac app control through Codex computer use: `plugins/codex/AGENTS.md`.
- File tree pane with git status and Claude's activity: `plugins/file-explorer/AGENTS.md`.
- Google Chat skills (read, reply, MR review requests) through Claude in Chrome: `plugins/gchat/AGENTS.md`.
- GitHub work skill with the gh CLI: `plugins/github/AGENTS.md`.
- GitLab merge requests and pipelines of the current repository: `plugins/gitlab/AGENTS.md`.
- Thumbnails of pasted images above the prompt: `plugins/image-preview/AGENTS.md`.
- Secrets Claude asks for in a private card, kept out of the conversation: `plugins/secrets/AGENTS.md`.
- Session card above the prompt: `plugins/session-hud/AGENTS.md`.
- SonarQube 9.x Web API tools (quality gate, measures, issues, rules, hotspots, branches): `plugins/sonarqube/AGENTS.md`.
- Jev-routed reasoning effort for native subagent calls: `plugins/subagent-effort/AGENTS.md`.
- Tailscale API tools: `plugins/tailscale/AGENTS.md`.
- Verification planning skill for non-trivial changes: `plugins/verification-planning/AGENTS.md`.
- Hooks authoring or debugging: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm.

## Commands

- Setup: Node 24 (`.nvmrc`; any version manager that reads it works) and pnpm (`corepack enable` gives the version `packageManager` in `package.json` names), then `pnpm install`. The root `package.json` and `pnpm-lock.yaml` pin the Claude Code CLI and TypeScript; pnpm puts them on PATH for every script.
- Each folder under `plugins/` is a workspace package (`pnpm-workspace.yaml`) whose `package.json` holds only its scripts: `validate` (`claude plugin validate --strict .`), `test` (`claude plugin test .`, absent for a plugin that ships only skills; gitlab, an MCP server with no hooks, runs `node --test`) and `typecheck` (`tsc`, only with a `tsconfig.json`).
- From the root: `pnpm validate` (the marketplace, then every plugin), `pnpm test`, `pnpm typecheck`, and `pnpm check` for all three. One plugin: `pnpm --filter <name> test` (or `validate`, `typecheck`).
- Typings: `tsconfig.json` extends the git-ignored `.claude-plugin/types/`, which Claude Code writes when an interactive session loads the plugin from its folder. Before the first `pnpm typecheck` of a plugin, and after a Claude Code update or a change to your MCP integrations, open `claude --plugin-dir plugins/<name>` once and `/exit`.
- codex's computer use helper runs on the ChatGPT app's Node: `pnpm --filter codex test:helper`, on a Mac with that app.

## Code rules

- Registration: one entry module (`register.tsx`) in `hooks.json`. Keep `on(...)` and `$.noun.method(...)` calls visible to the engine's source analysis: pass `$` only to a top-level function in the same file, never across an import. Subfolder registrars may own their hooks and `$` calls; pure modules take injected host access. Tests mirror modules.
- Tool inputs: each `mcp__<plugin>__<name>` entry in `types/index.d.ts` must match its `inputSchema` (`SchemaFor`, `hooks/schema.ts`; keep that file and `tests/schema-types.ts` identical in every plugin that has them, but for the import path in `tests/schema-types.ts`; gitlab keeps them in `server/` and its tool inputs in `server/inputs.ts`, by short tool name; secrets checks its one MCP server tool in `server/tool.mjs` with a JSDoc `@satisfies`; codex's computer use tool has its keys checked in `hooks/computer-use/prompts.ts` instead).

## Done for a plugin change

1. `pnpm --filter <name> validate` and `pnpm --filter <name> test` pass, and so does `pnpm --filter <name> typecheck` when the plugin has TypeScript.
2. A plugin that ships the change has its `version` in `.claude-plugin/plugin.json` raised (semver: patch for a fix, minor for a feature) and a line in its `CHANGELOG.md`; installed copies update only when the version changes.
3. The root README and the plugin's AGENTS.md match the new behavior.

## Adding or removing a plugin

- `claude plugin init <name>` in `plugins/` scaffolds a plugin; add its `package.json` with the scripts above, an entry in `.claude-plugin/marketplace.json` with the manifest's description, a row and install line in the root README, and a line under "Where to look" here. A plugin that ships only skills has no `hooks/` and no `tsconfig.json`.
- Unlisted plugins: a name in `.claude-plugin/unlisted.json` (a JSON array) has no marketplace entry, README row or install line, and is still validated and tested. Load it with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`, which reads its options from `pluginConfigs["<name>@inline"]`.
- Removing a plugin: its folder, its marketplace entry, its README row and install line, and its line here.

## CI

- `.github/workflows/ci.yml` runs on every pull request and push to `main`: `pnpm install --frozen-lockfile`, `pnpm validate` and `pnpm test`, with Node from `.nvmrc`. Typecheck stays local, since the typings need an interactive session.

## Conventions

- README, docs, code comments and user-facing plugin messages in English.
- Names a person types or Claude calls start with the plugin's full name: mod commands are `<plugin>-<action>` (`$.command.register` refuses `:`), skills are `skills/<skill>/` shown as `<plugin>:<skill>`, never the marketplace's name. Why: `docs/adr/0002-command-and-skill-names-carry-the-plugin-name.md`.
- Conventional Commits in English for commits and PR titles; English PR descriptions (`.github/pull_request_template.md`).
- Docs describe current behavior and how to use or contribute; history lives in git, and a rule explaining one line of code goes in a comment there.
- Issues live in this repository's GitHub Issues; use the `gh` CLI.
