# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. The plugins are function hooks mods ([mods overview](https://code.claude.com/docs/en/plugins/mods)), an early-access API that may change between Claude Code versions.

## Plugins

| Plugin | What it does |
| --- | --- |
| [antigravity](plugins/antigravity/README.md) | Lets Claude ask your Antigravity CLI (`agy`) for a second opinion from another model family, have it review the branch's changes in a throwaway worktree before a PR, or generate an image in a folder of its own, and saves the result locally; agy runs sandboxed, is told not to edit, and any edit it makes is reported. |
| [codex](plugins/codex/README.md) | Lets Claude ask your Codex CLI for a second opinion (it reads the repository read-only and can search the web), have it review the branch's changes, or generate an image, and saves the result locally. On macOS it can also route native Mac app control through Codex computer use from the ChatGPT app instead of Claude's own computer use, asking before each new app. |
| [file-explorer](plugins/file-explorer/README.md) | A file tree pane beside the conversation: git status per file and folder, a mark on each file Claude reads, edits, creates, removes, finds or commits, search across unopened folders, preview, and `@path` into the prompt. |
| [gitlab](plugins/gitlab/README.md) | Opens, edits, comments on (directly or as draft notes to publish later), reviews and (when asked, behind guards) merges GitLab merge requests, lists yours across projects, lists open review threads, lists and creates labels, runs, retries and cancels pipelines and jobs, waits for and reads pipelines, jobs and job errors, lists a job's artifacts with their URLs, picking the host and its token from the git remote or a host you name. |
| [image-preview](plugins/image-preview/README.md) | Shows images in the terminal: thumbnails of what you paste above the prompt, and each image Claude reads under its row in the transcript, as the desktop app does. |
| [session-hud](plugins/session-hud/README.md) | A card above the prompt: model, the repository, folder and branch, context and cache; the five-hour and seven-day limits with their pace; the running subagents with their type, model and effort, and the tokens they used; what the last turn sent and added, edits and errors; with the `nextSteps` option on, up to four next prompts from a fork of the session to pick one into the prompt box; and `/session-panel`, a pane with the main session, every agent it ran (type, model, effort, time, latest tools and tokens) and the last 15 minutes by agent type, kept across a resume. |
| [sonarqube](plugins/sonarqube/README.md) | Lets Claude diagnose SonarQube 9.x analyses through the read-only Web API: the quality gate of a branch or pull request, its measures and issues, an issue's rule, security hotspots, and the analyzed branches and pull requests, finding the project in `sonar-project.properties`, with the server and token from the `url` and `token` plugin options or the `SONARQUBE_*` or `SONAR_*` environment variables. |
| [subagent-effort](plugins/subagent-effort/README.md) | Sets the reasoning effort of every native subagent call from Jev's rating of its task, held to a per-type cap (read-only agents such as Explore at medium by default), leaving the model as it was, and keeps local records to compare efforts. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |

Each plugin README covers its setup, what it reads, sends and saves, and what its tests do and do not prove. Read it before sending private context or granting write access.

## Install

Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.322 (`claude --version`).

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install antigravity@spider-claude-mods
/plugin install codex@spider-claude-mods
/plugin install file-explorer@spider-claude-mods
/plugin install gitlab@spider-claude-mods
/plugin install image-preview@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install sonarqube@spider-claude-mods
/plugin install subagent-effort@spider-claude-mods
/plugin install tailscale@spider-claude-mods
```

From a local copy: `/plugin marketplace add /path/to/claude-mods`.

Computer use in codex also needs a local helper on the Mac: follow [its install steps](plugins/codex/README.md#install-the-helper), or use the one-step setup below. It replaces the former codex-computer-use plugin: uninstall that one with `/plugin uninstall codex-computer-use@spider-claude-mods`.

### One step

`scripts/bootstrap.sh` adds the marketplace and installs or updates every plugin. On macOS it also installs the helper of codex's computer use (a LaunchAgent); on Linux codex is installed without it, since computer use controls native Mac apps:

```
curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh
```

Add `-s -- --check` after `sh` for a dry run, or `-s -- --only tailscale,codex` to limit the plugins. It is safe to rerun, skips the helper when the ChatGPT app is missing and never sets secrets: use `claude plugin configure gitlab` for its `tokens` (or set `SPIDER_PLUGIN_OPTION_GITLAB_TOKENS`), `claude plugin configure tailscale` for its `apiKey` (or set `SPIDER_PLUGIN_OPTION_TAILSCALE_API_KEY`), and `claude plugin configure subagent-effort` for its `apiKey` (or set `SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY`, or `JEV_API_KEY`), and `claude plugin configure sonarqube` for its `url` and `token` (or set `SPIDER_PLUGIN_OPTION_SONARQUBE_URL` and `SPIDER_PLUGIN_OPTION_SONARQUBE_TOKEN`).

### Update

Refresh the marketplace, then update each plugin you installed; run `/reload-plugins` or start a new session afterwards:

```
claude plugin marketplace update spider-claude-mods
claude plugin update <plugin>@spider-claude-mods
```

Rerunning the one-step command does both for every plugin.

## Contributing

Rules for changing the code and the done definition are in [AGENTS.md](AGENTS.md). Setup: Node 24 (`.nvmrc`), then `npm ci`, which installs the pinned Claude Code CLI and TypeScript; `npm run` puts them first on PATH.

Pull requests from forks run CI without secrets and are merged only after a maintainer reads the whole diff: the code runs on every installed copy. Use placeholders, never real hosts, project names, paths or tokens, in code, tests and examples. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes.

Load a plugin from its folder so edits reload automatically, with `claude --plugin-dir plugins/<name>` or in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/<name>" } }
```

| Task | What it does |
| --- | --- |
| `npm run plugin:new -- <name> [description]` | Scaffold a plugin that passes the consistency checks, then generate its typings. |
| `npm run plugins:types [-- <name>...]` | Generate the `claude-code` typings the named plugins' (or every plugin's) `tsconfig.json` extends. |
| `npm run check [-- <name>]` | The required CI checks in one run: no plugin version edited by hand among the committed, uncommitted and untracked changes against `origin/main` as last fetched (CI also checks the pull request title), then `plugins:validate`, `plugins:test` and `typecheck` (skipped for a plugin that ships only skills), for every plugin or one. Every step runs, and a summary names the failed ones. The output of a target that passes is hidden; `QUIET=0 npm run check` prints everything. |
| `npm run plugins:validate [-- <name>]` | `validate --strict` the marketplace and every plugin, or one plugin, then `check-consistency`. |
| `npm run typecheck [-- <name>]` | Run the pinned `tsc` on one plugin, or every plugin with TypeScript; a plugin without typings gets them copied from the main checkout, else generated (`plugins:types`). |
| `npm run plugins:test [-- <name>]` | Script tests, every plugin's tests (a plugin that ships only skills has none), and, with the ChatGPT app installed, the codex computer use helper tests; with a name, only that plugin's tests and its helper's. |

`/reload-plugins` and `claude plugin details` report `0 hooks` for every plugin here, because they count only `hooks.json` command hooks and these plugins ship hooks modules. `claude plugin validate plugins/<name>` lists a module's events and `$` calls; a module that fails to load leaves a line in `claude --debug`.

Unit tests run against host fakes: a Claude Code update can break a plugin without a test failing here. Check real behavior in a session that loads the plugin from its folder (`claude --plugin-dir plugins/<name>`).

## Acknowledgments

These projects inspired or are the base of plugins in this marketplace:

- [claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads) by Prompt Advisers: the Codex computer-use bridge behind codex's [computer use](plugins/codex/README.md#computer-use-macos).
- [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts (MIT): [image-preview](plugins/image-preview/README.md) is a copy of it with fixes.

## License

[MIT](LICENSE).
