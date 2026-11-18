# antigravity

A `bin/` executable with no hooks and no MCP server, so Code Mode stays available. Node 22.18 or later runs `cli/main.ts` by stripping types: imports carry `.ts`, and only erasable syntax is allowed. Plugin options never reach a `bin/` executable, so `skills/delegate/SKILL.md` passes them as flags from `${user_config.*}`; Claude Code can leave those placeholders unfilled (it does under `--plugin-dir`), so `cli/main.ts` counts a value holding `${user_config.` as not given. Tests run with `node --test`, since `claude plugin test` needs a hooks module.

## agy behavior this code relies on (measured on 1.5.11)

- Print mode (`agy -p`): `--sandbox` confines nothing; agy writes outside the workspace and runs shell commands with network. Never rely on it, and never pass `--dangerously-skip-permissions`.
- `agy -p` waits on an open stdin: launch it with none.
- agy ignores SIGTERM: a bound kills the process group with SIGKILL after a grace.
- `-p /usage --output-format json` spends no quota only with slash commands on.
- `--cli_dir_name` and `--include-default-customizations=false` still load the user's MCP servers and skills; a private `--gemini-dir` loads neither, keeps the sign-in, and asks permission for every read, edit and command even with no settings file.
- ACP (`agy acp`): agy rejects the `yolo` and `auto_edit` modes; in `default` it sends `session/request_permission` for every read, edit and command, with absolute `locations`, outside the workspace too, and honors a refusal. After a refusal it often ends the turn with no text, so `cli/acp.ts` prompts it on (up to 4 times).
- `session/resume` keeps the conversation's memory, also with a different `cwd`; conversations live in the `--gemini-dir`, so it must stay the same path. Two turns at once on one session hang agy, hence the session lock.
- An allowed command runs unconfined, with network: no mode allows one.
- `agy models` prints `id<TAB>name` lines after a "Fetching available models..." line.

## Invariants

- The plugin's state folder and agy home are private (mode 700, owned by the user, not a symlink) or the command refuses.
- The agy home must configure no MCP servers, hooks, plugins or skills (`config/`), since those run outside the permission checks.
- agy never inherits `GEMINI_*`, `GOOGLE_*`, `AGY_*` or `CLOUDSDK_*`.
- Errors name the failing check, never a Google Cloud project or region.
- `cli/policy.ts` decides every permission request: reads inside the task folder and the agy home, edits only in `implement` and only inside its worktree, by realpath, failing closed; `execute` and unknown kinds are refused.
- The person's checkout is never written: reviews and changes run in a detached, locked worktree under the state folder, removed when the task ends whatever happens.
- Git runs with `core.fsmonitor` off, no hooks, and diffs without external diff or textconv (`cli/review.ts`).
