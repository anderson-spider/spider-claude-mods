# antigravity

The hooks module and the MCP server (`server/`) share the pure modules in `hooks/`. Tools come from the MCP server and the module hooks no tool call, so Code Mode stays available.

## agy behavior this code relies on (measured)

- Reads pass without `--dangerously-skip-permissions`; never pass it. `--mode plan` is ignored under `--disable-slash-commands`.
- `agy -p` waits on an open stdin: launch with stdin from `/dev/null`.
- `--json-schema` returns a review's findings as `structured_output` in the `result` line (agy 1.5.10).
- agy's stream does not name the images it writes: find them by name and time in `~/.gemini/antigravity-cli/brain/<conversation>/`.
- Two turns at once on one conversation hang agy, so a follow-up on a running conversation is refused.
- The `init` line lists every tool and can exceed the bytes read; read it by pattern.
- `-p=/usage` needs slash commands on; with `--disable-slash-commands` it would be a real prompt that spends quota.

## Invariants

- agy never edits: every ask and review prompt ends with `NO_EDIT`, a review runs in a throwaway worktree, and an ask's edits are detected by fingerprint and reported.
- `short_error` is never shown, and `redact` blanks Google Cloud project and region names.
- The plugin's temp folder must be private (mode 700, owned by the user, not a symlink) or the run is refused.
- A file whose folder is the home folder or above is refused, since its `--add-dir` would open it all.
- A process is stopped only while `ps` still shows it is that agy run; a run gone without an exit status is `lost` and never re-run.
- Git runs with `core.fsmonitor` off and diffs without external diff or textconv, since the host turns off only repository hooks.

## Checks

`typecheck` also runs `tsc -p tsconfig.node.json`. A new tool also needs its name in `tests/register.test.ts` and `tests/node/server.test.mjs`. Live, spending agy quota: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --plugin-dir plugins/antigravity`, confirm Code Mode is on, then `/antigravity-doctor`, one `/antigravity-ask`, `/antigravity-image` and `/antigravity-review` on a small branch.
