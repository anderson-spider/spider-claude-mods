# codex

Ask your [Codex CLI](https://developers.openai.com/codex/cli) for a second opinion, or have it generate an image, and save the result locally.

```text
/plugin install codex --marketplace anderson-spider/claude-mods
```

## Setup and use

Install the Codex CLI and sign in once (`codex login`). The plugin finds `codex` on PATH, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; set the `codexPath` option to use another one. `/codex-doctor` shows the executable, its version, its login and the default model and effort from `~/.codex/config.toml` (`$CODEX_HOME`).

| Command | Use |
| --- | --- |
| `/codex-ask <question>` | Ask Codex and show the answer. Claude also reaches for `mcp__codex__ask` on its own for a second opinion on code or a plan, a hard question, or one that needs a web search. |
| `/codex-image <prompt>` | Generate an image; it spends your OpenAI usage. The command takes only a prompt; the `image` tool also takes a `reference` to edit from. |
| `/codex-doctor` | Check the Codex CLI, its login and its defaults. |

Each request runs `codex exec --json`. An ask runs in the session's working directory, so Codex can read the repository and any listed `files`; it can also search the web. Every run is read-only and never asks for approval, whatever your Codex config says, so Codex reads but never writes or runs anything that changes files. An image runs in an empty folder of the plugin's (`$TMPDIR/codex/.work`), without web search.

Without `model` or `effort`, a run uses your Codex defaults; the tool descriptions ask Claude to pass a low effort for a quick question. Each result carries a `threadId`: pass it back to follow up in the same Codex session (`codex exec resume`). Requests run side by side, each in its own process. A request waits six minutes in the foreground, then keeps going as a background job until thirty minutes from its start, when it is stopped; `wait: false` starts a job at once, a message arrives when a job ends, and `mcp__codex__jobs` lists them meanwhile. Change the limits with `claude plugin configure codex@spider-claude-mods`. Jobs disappear on reload.

## Privacy

- **Sent:** prompts, and the files and images Codex reads, go to OpenAI through your Codex login. Tool descriptions exclude credentials, secrets and private personal data, and work data unless you ask.
- **Saved:** answers and images go to `$TMPDIR/codex/` (`/tmp/codex/` if unset), unless an output path is supplied. Answer files begin with the thread id; on macOS, `sips` makes a small JPEG of each image for Claude to see with the result, and the JPEG is deleted afterwards. Codex keeps each run as a session of its own (`~/.codex/sessions/`, labelled with the thread source `claude-code-codex-plugin`) and the images under `~/.codex/generated_images/`. Image results call them AI concept images, and Claude is asked to present them as such, never as evidence of real or in-game states.
- **Read/kept:** `TMPDIR`, `HOME`, `PATH`, `CODEX_HOME`, `~/.codex/config.toml` (for `/codex-doctor`), and a session-local list of background jobs.

## Tests

Plugin tests run a scripted Codex child (its `--json` lines) against fake output folders and a fake host; they cover the arguments, the event reading, foreground and background runs, saving answers and images, and registration. They do not run the real CLI: `/codex-doctor`, then a short `/codex-ask`, checks it live.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
