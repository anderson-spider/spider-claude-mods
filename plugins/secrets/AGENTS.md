# secrets

The plugin's one promise: the secret's value is on screen only in the paste field (the engine's `Input` has no mask), and in memory only in the scrubber's index and one fence call's `liveValues`. Never in argv, a prompt, a toast, a queue file or a message to Claude. `tests/register.test.ts` checks argv and the messages. The transcript's `toolUseResult` side field is out of a hook's reach (README, Limits).

- Code Mode stays available: the module registers no event that turns it off (`session.append` is fine). The fence is a `PreToolUse` command hook in `hooks/hooks.json`, not a module hook (measured: Code Mode starts, and the hook sees and can deny each call the code makes). Keep it that way.
- The fence fails open (`onFailure: continue`): the scrubber is the guarantee.
- The value is written on stdin under `umask 077` and `set -C`, never in argv.
- The pure modules in `hooks/` are shared with Node and import no value from each other (Node needs a file extension the validator refuses); type imports are fine.
- `bashReason` also refuses a recursive search from any folder above the secrets folder, since some builds have no Grep or Glob tool and search through Bash.

## Checks

`typecheck` runs `tsc` and `tsc -p tsconfig.node.json`. Live: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --plugin-dir plugins/secrets` with the installed copy off; look for `Code Mode (experimental) is on`; ask for a test secret and paste it; from code, `Read` and `cat` the file (refused) and `echo "$(cat <file>)"` (scrubbed).
