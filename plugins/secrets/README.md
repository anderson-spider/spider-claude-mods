# secrets

Claude asks you for a token or password in a card and gets a private file it can use inside a command but not read, while a fence and a scrubber keep the value out of the conversation.

```text
/plugin install secrets --marketplace anderson-spider/claude-mods
```

## Use

When Claude needs a secret only you have (an API token, a `sudo` password, a pairing code), it calls `mcp__plugin_secrets_secrets__request_secret` instead of asking in chat. A card opens in a pane with what it is for, the steps to find it, the page, and what a valid value looks like. Paste the value and press Enter, or press **decline**.

```
╭──────────────────────────────────────────────────────╮
│ Claude needs a secret                                │
│                                                      │
│ Cloudflare API token (CF_API_TOKEN)                  │
│ Wrangler deploys the worker                          │
│                                                      │
│ 1. Open the Cloudflare dashboard                     │
│ 2. Go to My Profile > API Tokens                     │
│ 3. Copy the token                                    │
│                                                      │
│ https://dash.cloudflare.com/profile/api-tokens       │
│ Looks like: 40 characters                            │
│                                                      │
│ Paste ▸ ____________________________________  save  │
│ decline                                              │
╰──────────────────────────────────────────────────────╯
```

The request does not block: Claude is told to stop, and hears back in a message when you save or decline (or close the pane). A saved value goes to an owner-only file (`0600`, in a `0700` folder) and Claude is sent only its path. It then uses the value inside the command that needs it:

```sh
CF_API_TOKEN="$(cat ~/.claude/secrets/CF_API_TOKEN.<random>)" npx wrangler deploy
```

A file is deleted 24 hours after it was written. `/secrets` opens the pane yourself; closing it while a request waits declines it. A terminal too narrow for the pane shows the card above the prompt instead; the request looks again for about a second first, since a surface can seat the pane just after it was opened, and tells Claude the card is above the prompt only if the pane is still undrawn.

The plugin works in Code Mode (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`): the tool comes from an MCP server in the plugin, the fence is a `PreToolUse` command hook, which checks each tool call Code Mode's code makes, and the hooks module registers no event that turns Code Mode off. The server and the fence run on `node` (22.18 or later) from your `PATH`.

## What keeps the value out of the conversation

1. **The fence.** Claude's `Read`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit` cannot open the folder, `Grep` and `Glob` cannot search it or a folder above it, and a `Bash` command may name a saved file only inside `$(cat <file>)` or `$(< <file>)`. `cat <file>`, `ls`, `cp` and the like are refused, and so is tracing (`set -x`, `bash -x`) a command that uses one. Any of these tools, and `SendMessage` to another agent, is also refused when its input holds a saved value. The folder is `~/.claude/secrets`, or `secrets` under `CLAUDE_CONFIG_DIR`.
2. **The scrubber.** Any saved value of 8 or more characters that reaches a message, a tool result (Code Mode's code output included) or a prompt is replaced with `[secret:NAME]` in the row before it is stored and sent to Claude. That catches the indirect leaks, such as a script that prints its environment. The fence is best effort; the scrubber is the guarantee.

## Limits

- The paste field is not masked: the value is visible on your screen until you press Enter.
- Values shorter than 8 characters, numbers and booleans are not scrubbed, and neither is an encoded copy (base64, URL, hex) of a value.
- The fence reads the command's text: a glob or a variable that builds the folder's path (`cat ~/.claude/s*/*`) is not caught. The scrubber is what stops the value then.
- Do not paste a secret into the chat box: it is scrubbed only once saved through a card.
- A file saved by another session is scrubbed too, from the next hour or session start on.
- The transcript file keeps a tool's raw output in a side field (`toolUseResult`) that hooks cannot rewrite: a command that prints a value leaves it there, on your disk, though Claude reads only the scrubbed message.
- The fence fails open: without `node`, or when the hook errors or passes its 10 seconds, the call goes on, and the scrubber still holds.
- The pane draws on the terminal and desktop surfaces. Elsewhere there is no card: when none is drawn within 5 seconds, the tool withdraws the request and tells Claude no card could be shown.

## Privacy

Values never leave the machine: they are written to the folder above and read back only by commands you let Claude run. The plugin makes no network request. The messages Claude receives name a secret and its file, never its value.

## Tests

Pure logic tests call `hooks/{store,guard,scrub,request}.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network and mount the card on the terminal and desktop surfaces; Node tests (`tests/node/`) drive the MCP server and run the fence against a temporary home folder. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
