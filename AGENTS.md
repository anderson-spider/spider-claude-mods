# AGENTS.md

Claude Code **function hooks mods** marketplace. User-facing setup is in [README.md](README.md); this file holds the rules for changing the code.

## Where to look

- Plugin work: read `plugins/<name>/AGENTS.md` before changing files under `plugins/<name>/`. Keep plugin guidance there: a plugin-root `CLAUDE.md` draws a validation warning.
- Second opinions and reviews from another model family through Google's Antigravity CLI (agy): `plugins/antigravity/AGENTS.md`.
- Second opinions and images through the Codex CLI, and native Mac app control through Codex computer use: `plugins/codex/AGENTS.md`.
- File tree pane with git status and Claude's activity: `plugins/file-explorer/AGENTS.md`.
- GitLab merge requests and pipelines of the current repository: `plugins/gitlab/AGENTS.md`.
- Thumbnails of pasted images above the prompt: `plugins/image-preview/AGENTS.md`.
- Session card above the prompt: `plugins/session-hud/AGENTS.md`.
- SonarQube 9.x Web API tools (quality gate, measures, issues, rules, hotspots, branches): `plugins/sonarqube/AGENTS.md`.
- Jev-routed reasoning effort for native subagent calls: `plugins/subagent-effort/AGENTS.md`.
- Tailscale API tools: `plugins/tailscale/AGENTS.md`.
- Hooks authoring or debugging: load the `plugin-authoring` skill first. The `claude-code` module is host-provided, not on npm.

## Commands

Node 24 (`.nvmrc`; any version manager that reads it works), then `npm ci` once. `package.json` and its lockfile own the tool versions (the Claude Code CLI and TypeScript, exact) and name the tasks; `npm run` lists them and runs them with `node_modules/.bin` first on PATH. Task bodies live in `scripts/tasks/`; pass arguments after `--` (`npm run plugins:types -- gitlab`). The checks (`check`, `plugins:validate`, `plugins:test`) run the pinned CLI, as CI does: from this checkout's `node_modules`, else the main checkout's (a fresh worktree has none), and they stop when neither has it. `plugins:types` runs your own `claude` instead, so the typings carry the version your sessions match; on a CI runner (`CI` set), which has only the pinned one, it runs that (`scripts/tasks/lib.sh`). The folders under `plugins/` are the one list of plugins every task runs on (`plugin_dirs` there); `check-consistency` keeps them equal to `marketplace.json` plus `unlisted.json`. `npm run typecheck [-- <name>]` runs the pinned `tsc` on one plugin or all of them. `plugins:validate`, `plugins:test` and `typecheck` take an optional plugin name, run every target even after a failure, and fail at the end naming what failed; `npm run check [-- <name>]` runs the release rules that need no pull request (`check-release.mjs --worktree`: no plugin version edited by hand) against `origin/main` as last fetched, then those three, the same way. `bash scripts/tasks/install-test.sh` (needs Docker; the CI `install` job runs it) installs the marketplace from the checkout on a clean Linux image the way a new user does, through `scripts/bootstrap.sh`, and checks that each plugin is listed at its source version, passes its tests from the installed copy and loads in a session without login, codex without its macOS-only computer use tool (`scripts/install-test/`). Plugin-specific checks are in each plugin's AGENTS.md.

## Code rules

- Registration: one entry module (`register.tsx`) in `hooks.json`. Keep `on(...)` and `$.noun.method(...)` calls visible to the engine's source analysis: pass `$` only to a top-level function in the same file, never across an import. Subfolder registrars may own their hooks and `$` calls; pure modules take injected host access. Tests mirror modules.
- Tool inputs: each `mcp__<plugin>__<name>` entry in `types/index.d.ts` must match its `inputSchema` (`SchemaFor`, `hooks/schema.ts`, identical in every plugin that has one and in `scripts/plugin-template/`; codex's computer use tool has its keys checked in `hooks/computer-use/prompts.ts` instead).
- Typings: loading a plugin writes its git-ignored `.claude-plugin/types/`, which its `tsconfig.json` extends (`noEmit` is required). `npm run typecheck` (and `check`) fills in a plugin that has none, as in a fresh worktree: it copies them from the same plugin in the main checkout, else generates them with your own `claude`, as `plugins:types` does. After a new Claude Code version, run `npm run plugins:types [-- <name>...]`. Regenerate after changing MCP integrations: cached `claude-code-mcp` declarations reflect the main checkout's last connected tools.
- Scripts in `scripts/` have a `*.test.mjs` beside them; the task shells in `scripts/tasks/` are thin wrappers over them and the `claude` CLI, and `scripts/install-test/` is itself a test (`bash scripts/tasks/install-test.sh`), so neither has tests of its own.

## Done for a plugin change

1. `claude plugin validate --strict plugins/<name>` passes, and `claude plugin test plugins/<name>` passes unless the plugin ships only skills.
2. `node scripts/check-consistency.mjs` passes.
3. `version` in `plugin.json` is left alone, and the pull request title says what the change is to whoever installed the plugin (see Releases).
4. The root README and the plugin's AGENTS.md match the new behavior.

## Releases

Nobody edits a plugin's `version` or `CHANGELOG.md`: `.github/workflows/release.yml` runs release-please (`release-please-config.json`, `.release-please-manifest.json`) on every push to `main`, which keeps one release pull request open with the next version and changelog of each plugin that has unreleased changes. That pull request merges by itself once its checks pass, and each plugin in it is then tagged `<name>-v<version>` and gets a GitHub release. Why this shape: `docs/adr/0001-releases-from-pull-request-titles.md`.

- A pull request is squashed into one commit named by its title, and that title is all release-please reads: `fix`, `perf`, `refactor` and `revert` raise the patch, `feat` the minor, and so does a `!` while the plugin is below 1.0.0. `build`, `chore`, `ci`, `docs`, `style` and `test` open no release.
- A commit counts for every plugin whose folder it changed, whatever its scope says. A pull request that changes two plugins releases both with the same title, so split it when they deserve different ones.
- `scripts/check-release.mjs` (the `checks` job) fails a pull request that edits a `version`, and one whose title type releases without a shipped file changed or changes a shipped file without releasing. A releasing pull request may not change only the tests or docs of some other plugin either: release-please would release that plugin too, so they go in a pull request of their own. `NOT_SHIPPED` in that script is the one list of plugin files that do not ship. Only the release pull request is exempt: the one the release app (`vars.RELEASE_BOT`) opens from release-please's branch.
- What the repository must have for this to work, all outside the code: squash as the only merge method, with the pull request title as the commit title and an empty body; a GitHub App installed on the repository with read and write access to contents, issues and pull requests; its client id in the variable `RELEASE_APP_CLIENT_ID`, its private key in the secret `RELEASE_APP_PRIVATE_KEY` and its login (`<slug>[bot]`) in the variable `RELEASE_BOT`. Without `RELEASE_BOT` the release pull request fails `checks` and never merges.
- To pick a version, such as 1.0.0, add `"release-as": "<version>"` to the plugin's entry in `release-please-config.json` in a pull request that changes the plugin, and remove it once that release is out.

## Adding or removing a plugin

- Before adding, removing, unlisting or publishing a plugin, read `docs/agents/adding-a-plugin.md`: the scaffold, plugins that ship only skills, the check-consistency checklist and unlisted plugins.
- Cite tests in a plugin AGENTS.md as `` `tests/<file>.test.ts` (`name`, `name`) `` or `` `tests/<file>.test.ts`: `name` `` (same for `helper/test/<file>.test.mjs`); the check fails on a missing file or undeclared name. A backticked support file under `tests/` or `helper/test/` must exist.

## CI

`.github/workflows/ci.yml` runs the consistency and release checks and the script and helper tests in `checks`. Its `plugins` job calls the same tasks as `npm run check`, with the Claude Code CLI that `package.json` pins and `npm ci` installs: `plugins:validate` and `plugins:test` on the checkout, then, in a copy with a scaffolded `ci-sample`, those two on the sample and `typecheck` on every plugin and the sample, which generates the typings in a session without login. The loops live in `scripts/tasks/` only: change what a check runs there, not in the workflow. That exact version must equal the one the root README says the repository is checked with (`check-consistency`). Node comes from `.nvmrc`. The same job runs again on the latest CLI as `plugins-latest`, which may fail without failing the run: it shows what a newer CLI breaks before the pin moves. The pin moves by itself: `.github/workflows/cli-pin.yml` runs `node scripts/bump-cli.mjs` once a day, which sets the version npm serves as `latest`, when that is newer than the pin, in `package.json`, its lockfile and the README, and opens a `build:` pull request from `cli-pin/v<version>` with the release app's token, so the checks run on it. A person merges it, after fixing on that branch what the new CLI breaks; a newer version opens a new pull request and closes the older one. To pick the version, older ones included, run the workflow by hand with its `version` input, or run the script with a version, then `npm ci` and `npm run plugins:types`. The `install` job runs `scripts/tasks/install-test.sh`. A pull request runs all of it again when its title is edited, since the release check reads the title. The required check is `checks`.

## Conventions

- README, docs, code comments and user-facing plugin messages in English.
- Conventional Commits in English for commits and PR titles; English PR descriptions (`.github/pull_request_template.md`).
- Docs describe current behavior and how to use or contribute; history lives in git, and a rule explaining one line of code goes in a comment there.
- Issues live in this repository's GitHub Issues; use the `gh` CLI.
