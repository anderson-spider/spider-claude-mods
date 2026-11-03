# codex

Ask your [Codex CLI](https://developers.openai.com/codex/cli) for a second opinion, have it review your branch's changes or generate an image, and save the result locally. On macOS it can also control native Mac apps through Codex computer use (see [Computer use](#computer-use-macos)).

```text
/plugin install codex --marketplace anderson-spider/claude-mods
```

## Setup and use

Install the Codex CLI and sign in once (`codex login`). The plugin finds `codex` on PATH, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; set the `codexPath` option to use another one. `/codex-doctor` shows the executable, its version, its login and the default model and effort from `~/.codex/config.toml` (`$CODEX_HOME`).

| Command | Use |
| --- | --- |
| `/codex-ask <question>` | Ask Codex and show the answer. Claude also reaches for `mcp__codex__ask` on its own for a second opinion on code or a plan, a hard question, or one that needs a web search. |
| `/codex-image <prompt>` | Generate an image; it spends your OpenAI usage. The command takes only a prompt; the `image` tool also takes a `reference` to edit from. |
| `/codex-review [--base <branch> \| --commit <sha> \| --uncommitted \| <instructions>]` | Have Codex review the repository's changes (`codex exec review`); Claude uses `mcp__codex__review` when you ask for a Codex review, never on its own. |
| `/codex-doctor` | Check the Codex CLI, its login and its defaults. |

Each request runs `codex exec --json`. An ask runs in the session's working directory, so Codex can read the repository and any listed `files`; it can also search the web. Every run is read-only and never asks for approval, whatever your Codex config says, so Codex reads but never writes or runs anything that changes files. An image runs in an empty folder of the plugin's (`$TMPDIR/codex/.work`), without web search.

A review runs `codex exec review` in the session's working directory, which must be a git repository, without web search, on one target: the branch against a base (`base`), one commit (`commit`), the staged, unstaged and untracked changes (`uncommitted`), or free `instructions`, with which Codex picks what to diff. With no target it reviews the branch against the default branch (`origin/HEAD`, else `main` or `master`). A base review diffs against the merge base and so leaves out files git does not track yet: the saved review then starts with how many, and `uncommitted` includes them. The findings come as Codex wrote them (`[P1] title — path:lines`), in the language of your Codex config; ask a follow-up with `mcp__codex__ask` on the review's `threadId`.

Without `model` or `effort`, a run uses your Codex defaults; the tool descriptions ask Claude to pass a low effort for a quick question. Each result carries a `threadId`: pass it back to follow up in the same Codex session (`codex exec resume`). Requests run side by side, each in its own detached process. A request waits six minutes in the foreground, then keeps going as a background job until thirty minutes from its start, when it is stopped; `wait: false` starts a job at once, a message arrives when a job ends, and `mcp__codex__jobs` lists the project's jobs, of any session, meanwhile. Change the limits with `claude plugin configure codex@spider-claude-mods`. Jobs survive a plugin reload, and the session: after a reload the session watches its jobs again, and a job no session has watched for a minute (its session ended) is taken over, and its message sent, by the next session to start in the same project. A job whose process died without an answer gets it back from Codex's session files when Codex saved one during that run; else it shows as lost with its thread, and is never re-run (a follow-up `ask` on the thread goes on). Finished jobs are kept seven days, fifty at most.

## Computer use (macOS)

Claude can control native Mac apps through Codex computer use, bundled with the ChatGPT desktop app: Claude chooses the task, and Codex clicks and types in the background without taking over your mouse. The `computer_use` tool and `/codex-cu` exist only on macOS; elsewhere the plugin registers neither.

It needs a local helper (a per-user LaunchAgent) that talks to Codex, and the [ChatGPT desktop app](https://openai.com/chatgpt/download/) with Computer Use turned on in Codex; the helper runs on the Node.js bundled with it.

### Install the helper

One command installs or updates the plugin and the helper:

```sh
curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh -s -- --only codex
```

Add `--check` after `--only codex` for a dry run that changes nothing. Or, from a clone of the repository, run `plugins/codex/helper/install.sh` (`--check` only checks the prerequisites). The helper goes to `~/.claude/mcp/codex-cu` and starts at login; rerun the install after updating the plugin so the helper matches it. Neither script edits Claude settings. To remove it, run `~/.claude/mcp/codex-cu/uninstall.sh`: it unloads the LaunchAgent and keeps the code, approvals and logs.

**Coming from the `codex-computer-use` plugin:** it is now part of this plugin. `scripts/bootstrap.sh` uninstalls the old plugin; by hand, run `/plugin uninstall codex-computer-use@spider-claude-mods`. The helper keeps its LaunchAgent, folder and approvals, so it needs no reinstall. The tool is now `mcp__codex__computer_use`, and computer use starts off: turn it on with `/codex-cu on`.

### Use

```text
/codex-cu on | off | status
/codex-cu forget
/codex-cu forget <app>
/codex-cu auto-approve on | off
```

Computer use starts off. `/codex-cu on` turns it on until `/codex-cu off`, across sessions. While on, native desktop control uses `mcp__codex__computer_use` and Claude's own desktop tools are blocked; browsers, CLIs and purpose-built tools remain available. A new or reset Codex session must start with one documented entry call on its own, such as `cua.getState()` or `cua.getApp(...)`; Claude reads the documentation that call returns before further actions.

New apps ask in a band: **This session**, **Always** or **No**. Auto-approve defaults off; organization/safety blocks remain in force when it is on. A refusal is final for that caller. Questions expire five minutes from before entering the queue, including queue time; failures/timeouts do not approve. `forget` ends this session's Codex sessions and drops its app answers; `forget <app>` removes always-allow in both the helper and Codex.

Each Claude session/subagent gets a persistent Codex session. App ownership lasts two minutes after its last use, and `/codex-cu status` lists only apps still held. Literal `cua.getApp(...)` names are checked before calls; an app reached through a variable is owned only after its first reported result. Read and act in one call to avoid Codex's stale-state refusal. These ownership checks are not an isolation sandbox.

### Troubleshooting

- `/codex-cu status` says `Helper: not reachable`: the helper is missing or stopped. Rerun the install command above; it prints what is missing, such as the ChatGPT app.
- While on, Claude's own desktop tools stay blocked even when the helper is down. `/codex-cu off` gives them back until the helper works.

## Privacy

- **Sent:** prompts, and the files and images Codex reads, go to OpenAI through your Codex login. Tool descriptions exclude credentials, secrets and private personal data, and work data unless you ask.
- **Saved:** answers and images go to `$TMPDIR/codex/` (`/tmp/codex/` if unset), unless an output path is supplied. Answer files begin with the thread id; on macOS, `sips` makes a small JPEG of each image for Claude to see with the result, and the JPEG is deleted afterwards. Codex keeps each run as a session of its own (`~/.codex/sessions/`, labelled with the thread source `claude-code-codex-plugin`) and the images under `~/.codex/generated_images/`. Image results call them AI concept images, and Claude is asked to present them as such, never as evidence of real or in-game states.
- **Read/kept:** `TMPDIR`, `HOME`, `PATH`, `CODEX_HOME`, `~/.codex/config.toml` (for `/codex-doctor`), the `/codex-cu` switch and the jobs (request, thread, paths, run folder) in the plugin's store, and each run's output in `$TMPDIR/codex/runs/<id>/` until its job is pruned. To recover a lost job's answer, the plugin reads that thread's session file under `~/.codex/sessions/`.
- **Computer use (macOS):** the helper reads the newest Codex `unified-computer-use` bundle's `.mcp.json` to launch `cua_repl` with the desktop surface, without printing environment values. Requested screen and app content passes through the computer-use server to Codex; the helper keeps none of it. Helper `state/approvals.json` and `state/helper.log` record always-allow apps and approval choices and bundle ids. Codex saves its own `ComputerUseAppApprovals.json`; the helper only removes from that file. Helper directories are 0700 and its Unix socket (`run/helper.sock`) 0600, which protects against other local users, not processes running as you.

## Tests

Plugin tests run a scripted Codex child (its `--json` lines) against fake output folders and a fake host; they cover the arguments, the event reading, foreground and background runs, saving answers and images, and registration. They do not run the real CLI: `/codex-doctor`, then a short `/codex-ask`, checks it live. Computer use tests use the test host and injected clocks; helper tests use fake dependencies, an isolated installation and a fake MCP server, covering routing, approvals and deadlines, ownership, protocol contracts and installer flags without touching installed run or state directories. No test runs the real desktop-control runtime.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).

## Credits

Computer use is inspired by [claude-mods-computer-use-threads](https://github.com/promptadvisers/claude-mods-computer-use-threads) by Prompt Advisers (MIT). The idea of routing Claude's desktop control through Codex computer use, the `/codex-cu` command and the guidance the plugin gives Claude for driving Codex follow that project; the code here was written separately.
