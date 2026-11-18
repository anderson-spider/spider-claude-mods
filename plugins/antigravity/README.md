# antigravity

Lets Claude delegate work to Google's [Antigravity CLI](https://antigravity.google/) (`agy`), a second model family, through the `antigravity-delegate` command the plugin puts on the Bash tool's `PATH`.

```text
/plugin install antigravity@spider-claude-mods
```

## Skill

`antigravity:delegate` tells Claude when to delegate (an independent review, a read-heavy analysis or web research it can run while working, a self-contained change), how to write a brief agy can act on alone, and to run the command in the background. Claude verifies findings before reporting them, asks you before going on in a broader mode or doing a failed task itself, and reads a patch before applying it. The skill allows `Bash(antigravity-delegate *)` while it runs and passes the `agyPath` and `defaultModel` options as flags.

## Setup

Install the agy CLI (`curl -fsSL https://antigravity.google/cli/install.sh | bash`) and sign in once by running `agy`; the plugin is measured on agy 1.5.11 and needs Node 22.18 or later on `PATH` as `node`. It finds `agy` on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; the `agyPath` option names another one.

| Command | Use |
| --- | --- |
| `antigravity-delegate doctor` | Checks Node, the agy executable, its version, the sign-in (through `agy models`), the plugin's private agy home and the quota. |
| `antigravity-delegate models` | Lists the models agy offers, Gemini first; the Claude and GPT models agy also offers are marked third party. |
| `antigravity-delegate quota` | Shows the quota left in each window, with when it resets. It spends none. |

| `antigravity-delegate run` | Delegates one task, written to a brief file, and prints agy's answer when it ends. |
| `antigravity-delegate follow` | Goes on with a finished task in the same agy session. |

Each command takes `--json` for machine-readable output and `--agy-path <path>`. Exit codes: 0 done, 1 the task or a check failed, 2 bad usage, 3 agy is missing or signed out, 4 the task stopped at actions its mode refuses, 130 the task was stopped.

## Tasks

```text
antigravity-delegate run --mode read-only --role ask|search|analysis|review --brief-file <file> [--model <id>] [--effort <level>]
antigravity-delegate run --mode implement --brief-file <file>
antigravity-delegate follow --task <id> --brief-file <file> [--mode read-only|implement]
```

agy runs over ACP (`agy acp`) in the private home below and asks before every read, edit and command; the plugin answers each request by the task's mode:

| Mode | agy may | Where |
| --- | --- | --- |
| `read-only` | read files in its folder; search the web | the checkout, or for `review` a throwaway worktree at the reviewed commit |
| `implement` | read and edit files in its folder | a throwaway worktree at `HEAD`; the edits come back as `patch.diff` |

No mode lets agy run a command: an allowed command would run with no confinement and with network. Reads and edits outside the folder are refused, symlinks resolved, as are paths with `..`, requests that name no file, and edits of `.git` or `.gitattributes`. When refusals leave agy with no answer, the task ends `needs approval` with the list of what was refused.

- `review` covers the branch against `--base <ref>` (default `origin/HEAD`, then `main` or `master`) or one `--commit <sha>` against its first parent, and ends with findings ranked P0 to P3, checked and saved as `findings.json`. Untracked files are not reviewed.
- `implement` starts from `HEAD`, without your uncommitted changes (the summary says how many), and prints the command that applies the patch: `git -C <project> apply --3way <patch>`. A stopped or failed task keeps the changes made so far. Files `.gitignore` covers are not in the patch.
- `follow` resumes the agy session, which keeps the earlier turns; a follow-up of an `implement` task rebuilds its worktree with the earlier patch applied, and in `implement` mode its patch holds both changes. One session runs one turn at a time.
- Before each task the quota is checked: under 30% left in a window the summary warns, under 10% the task does not start unless `--force` is given. A task stops after `--minutes` (30) or when agy sends nothing for `--idle-minutes` (15); stopping the command (SIGTERM or SIGINT) ends it as cancelled.

Each task has a folder under `~/.local/state/spider-antigravity/tasks/<id>/` with `brief.md`, `task.json`, `answer.md` and, when there is one, `findings.json` or `patch.diff`. The newest 50 tasks of the last 7 days are kept.

## Private agy home

Delegated work runs agy with its own home, `~/.local/state/spider-antigravity/gemini/` (`$XDG_STATE_HOME/spider-antigravity/gemini/` when set), passed as `--gemini-dir`. Your agy sign-in still works from it, while your own agy MCP servers, hooks, plugins and skills stay out: agy's `--cli_dir_name` and `--include-default-customizations=false` do not keep them out. Before each use the plugin makes the folders readable by you only (refusing a symlink or a folder another user owns), writes its agy settings there (`toolPermission: request-review`, `allowNonWorkspaceAccess: false`) and turns agy's multi-agent `swarm` plugin off, and refuses to go on when that home configures MCP servers, hooks, plugins or skills. agy also runs without the `GEMINI_*`, `GOOGLE_*`, `AGY_*` and `CLOUDSDK_*` variables of your environment.

`quota` and `doctor` run `agy -p /usage` in your own agy profile, since agy's print mode takes no `--gemini-dir`; agy starts the MCP servers of that profile for it.

## Privacy

agy runs with your Google sign-in: what a task sends and the files agy reads go to Google under your account's terms. The plugin keeps its state under the folder above.

## Tests

`node --test` runs the command against a fake agy (`tests/fake-agy.ts`), a shell script that answers `--version`, `models` and `/usage` as agy 1.5.11 does and runs a scripted ACP agent (`tests/fake-acp.mjs`) for `agy acp`; nothing reaches agy or the network. For editing pointers, see [AGENTS.md](AGENTS.md).
