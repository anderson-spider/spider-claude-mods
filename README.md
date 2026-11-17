# Spider Marketplace

Marketplace of [Claude Code](https://claude.com/claude-code) plugins made by anderson-spider. Each plugin lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. The plugins are function hooks mods ([mods overview](https://code.claude.com/docs/en/plugins/mods)), an early-access API that may change between Claude Code versions.

## Plugins

| Plugin | What it does |
| --- | --- |
| [file-explorer](plugins/file-explorer/README.md) | A file tree pane beside the conversation: git status per file and folder, a mark on each file Claude reads, edits, creates, removes, finds or commits, search across unopened folders, preview, and `@path` into the prompt. |
| [gchat](plugins/gchat/README.md) | Skills that read, summarize and reply in Google Chat and post merge request review requests through Claude in Chrome, sending only a text and a recipient you approved; the default space and account come from plugin options. |
| [github](plugins/github/README.md) | A skill for GitHub work with the `gh` CLI in the main agent: pull requests, pending reviews, Actions runs and workflow logs, issues and comments, never waiting on a run or writing what you did not ask for. |
| [gitlab](plugins/gitlab/README.md) | Opens, edits, comments on (directly or as draft notes to publish later), reviews and (when asked, behind guards) merges GitLab merge requests, lists yours across projects, lists open review threads, lists and creates labels, runs, retries and cancels pipelines and jobs, waits for and reads pipelines, jobs and job errors, lists a job's artifacts with their URLs, picking the host and its token from the git remote or a host you name. The skill `gitlab:gitlab` has Claude work from a GitLab URL with these tools. The tools come from the plugin's MCP server, run with `node` (22.18 or later), and it has no hooks, so Code Mode stays available. |
| [image-preview](plugins/image-preview/README.md) | Shows images in the terminal: thumbnails of what you paste above the prompt, and each image Claude reads under its row in the transcript, as the desktop app does. |
| [secrets](plugins/secrets/README.md) | Claude asks you for a token or password in a card and gets a private file it can use inside a command but not read, while a fence and a scrubber keep the value out of the conversation |
| [session-hud](plugins/session-hud/README.md) | A card above the prompt: model, the repository, folder and branch, context and cache; the five-hour and seven-day limits with their pace; what the last turn sent and added, edits and errors; and, with the `nextSteps` option on, up to four next prompts from a fork of the session to pick one into the prompt box. It hooks no tool call, so Code Mode stays available. |
| [sonarqube](plugins/sonarqube/README.md) | Lets Claude diagnose SonarQube 9.x analyses through the read-only Web API: the quality gate of a branch or pull request, its measures and issues, an issue's rule, security hotspots, and the analyzed branches and pull requests, finding the project in `sonar-project.properties`, with the server and token from the `url` and `token` plugin options or the `SONARQUBE_*` or `SONAR_*` environment variables. |
| [subagent-effort](plugins/subagent-effort/README.md) | Sets the reasoning effort of every native subagent call from Jev's rating of its task, held to a per-type cap (read-only agents such as Explore at medium by default), leaving the model as it was, and keeps local records to compare efforts. |
| [tailscale](plugins/tailscale/README.md) | Lets Claude query and modify your tailnet through the Tailscale API, with the key in the sensitive `apiKey` plugin option. |
| [verification-planning](plugins/verification-planning/README.md) | A skill that plans, before non-trivial coding work, the project-specific evidence that will establish or refute the change, and closes that path after implementation. |

Each plugin README covers its setup, what it reads, sends and saves, and what its tests do and do not prove. Read it before sending private context or granting write access.

## Install

Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.322 (`claude --version`).

```
/plugin marketplace add anderson-spider/claude-mods
/plugin install file-explorer@spider-claude-mods
/plugin install gchat@spider-claude-mods
/plugin install github@spider-claude-mods
/plugin install gitlab@spider-claude-mods
/plugin install image-preview@spider-claude-mods
/plugin install secrets@spider-claude-mods
/plugin install session-hud@spider-claude-mods
/plugin install sonarqube@spider-claude-mods
/plugin install subagent-effort@spider-claude-mods
/plugin install tailscale@spider-claude-mods
/plugin install verification-planning@spider-claude-mods
```

From a local copy: `/plugin marketplace add /path/to/claude-mods`.


### Update

Refresh the marketplace, then update each plugin you installed; run `/reload-plugins` or start a new session afterwards:

```
claude plugin marketplace update spider-claude-mods
claude plugin update <plugin>@spider-claude-mods
```

## Contributing

Rules for changing the code and the done definition are in [AGENTS.md](AGENTS.md). Setup: Node 24 (`.nvmrc`) and pnpm (`corepack enable`), then `pnpm install`, which installs the pinned Claude Code CLI and TypeScript.

Pull requests from forks run CI without secrets and are merged only after a maintainer reads the whole diff: the code runs on every installed copy. Use placeholders, never real hosts, project names, paths or tokens, in code, tests and examples. Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes.

Load a plugin from its folder so edits reload automatically, with `claude --plugin-dir plugins/<name>` or in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/<name>" } }
```

| Command | What it does |
| --- | --- |
| `pnpm check` | `validate`, `test` and `typecheck` below, in that order. |
| `pnpm validate` | `claude plugin validate --strict` on the marketplace and every plugin. |
| `pnpm test` | `claude plugin test` on every plugin with hooks, plus the Node tests of the plugins that have them. |
| `pnpm typecheck` | `tsc` on every plugin with TypeScript. It needs the plugin's typings, which Claude Code writes when you load the plugin once with `claude --plugin-dir plugins/<name>`. |
| `pnpm --filter <name> <command>` | One of the three above, on one plugin. |

CI runs `pnpm validate` and `pnpm test` on every pull request.

`/reload-plugins` and `claude plugin details` report `0 hooks` for every plugin here, because they count only `hooks.json` command hooks and these plugins ship hooks modules. `claude plugin validate plugins/<name>` lists a module's events and `$` calls; a module that fails to load leaves a line in `claude --debug`.

Unit tests run against host fakes: a Claude Code update can break a plugin without a test failing here. Check real behavior in a session that loads the plugin from its folder (`claude --plugin-dir plugins/<name>`).

## Acknowledgments

These projects inspired or are the base of plugins in this marketplace:

- [claude-image-view](https://github.com/jarrodwatts/claude-image-view) by Jarrod Watts (MIT): [image-preview](plugins/image-preview/README.md) is a copy of it with fixes.

## License

[MIT](LICENSE).
