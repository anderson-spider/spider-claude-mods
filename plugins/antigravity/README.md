# antigravity

Ask Google's [Antigravity CLI](https://antigravity.google/) (`agy`) for a second opinion from another model family, or have it review your branch's changes, and save the result locally. agy never edits your checkout through this plugin.

```text
/plugin install antigravity --marketplace anderson-spider/claude-mods
```

## Setup and use

Install the agy CLI (`curl -fsSL https://antigravity.google/cli/install.sh | bash`) and sign in once by running `agy`; the plugin needs agy 1.5 or later. It finds `agy` on PATH, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; set the `agyPath` option to use another one. `/agy-doctor` shows the executable, its version, whether you are signed in (through `agy models`), the models and your remaining quota (through `/usage`, which spends none).

| Command | Use |
| --- | --- |
| `/agy-ask <question>` | Ask agy and show the answer. Claude also reaches for `mcp__antigravity__ask` on its own for a second opinion from another model family. |
| `/agy-review [--base <branch> \| --commit <sha>] [focus]` | Have agy review the repository's changes; Claude uses `mcp__antigravity__review` before opening a PR or when you ask for an agy review. |
| `/agy-doctor` | Check the agy CLI, its version, sign-in, models and quota. |

Each request runs `agy -p --output-format=stream-json --disable-slash-commands --sandbox` and never `--dangerously-skip-permissions`. agy has no read-only mode, so the plugin stands for one: the sandbox, an instruction not to edit at the end of every prompt, and a check of the working tree afterwards. An ask runs in the session's working directory, so agy can read the repository and any listed `files` (one outside it adds its folder with `--add-dir`); if the working tree changed during the run (any tracked or untracked file, compared through a copy of the git index), the answer starts with a warning. Outside a git repository that check cannot run, and the answer says so.

A review runs on one target: the branch against a base (`base`) or one commit (`commit`). With none it reviews the branch against the default branch (`origin/HEAD`, else `main` or `master`). It runs in a throwaway git worktree under `$TMPDIR/agy/worktrees/`, at `HEAD` or at the commit, holding the diff as `.agy-review.diff`, so your checkout is never touched; the worktree is removed when the review ends. Uncommitted and untracked changes are not reviewed: the saved review starts with how many untracked files it left out. The findings come ranked P0 to P3 with `path:line`, correctness and security first, without style comments; "No findings." is a valid answer, and `focus` adds a concern of yours. Ask a follow-up with `mcp__antigravity__ask` on the review's `conversationId`.

Without `model`, a run uses the `defaultModel` option, else agy's default; a model must be an id `agy models` lists (the tool descriptions steer Claude away from the Claude models agy also offers). `effort` is `low`, `medium`, `high`, `xhigh` or `max`. Each result carries a `conversationId`: pass it back to continue the same agy conversation (`--conversation`). Two turns at once on one conversation hang agy, so a follow-up on a conversation that is still running is refused until its job ends. Requests run side by side, each in its own detached process. A request waits six minutes in the foreground, then keeps going as a background job until thirty minutes from its start (agy's own `--print-timeout` is set to that limit), when it is stopped; `wait: false` starts a job at once, a message arrives when a job ends, and `mcp__antigravity__jobs` lists the project's jobs, of any session, meanwhile. Change the limits with `claude plugin configure antigravity@spider-claude-mods`. Jobs survive a plugin reload, and the session: after a reload the session watches its jobs again, and a job no session has watched for a minute is taken over by the next session to start in the same project. A job whose process died without an answer shows as lost and is never re-run. Finished jobs are kept seven days, fifty at most.

A failure says why, as one of: quota exhausted, timed out, interrupted, local error (exit code 1, such as a bad flag), agy error (an API failure). agy's error line names your Google Cloud project and region; the plugin never shows that part.

## Privacy

agy runs with your own Google sign-in: prompts and the files it reads go to Google under your account's terms. Answers are saved under `$TMPDIR/agy/` (or the `out` path you give), each run's events under `$TMPDIR/agy/runs/` until its job is pruned. agy loads the repository's `AGENTS.md` and `.agents/hooks.json` and starts the MCP servers of its own config on every run.

## Tests

Host tests run the plugin against a fake host (`tests/host.ts`) that scripts agy's stream-json output and git; the runner's tests drive its jobs with in-memory runs, store and worktrees. Nothing reaches agy or the network. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
