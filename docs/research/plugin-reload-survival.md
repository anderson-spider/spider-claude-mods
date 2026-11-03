# What survives a plugin reload

Question (issue #371): when the codex plugin reloads (`/reload-plugins`, a plugin update, a new session), what survives: a child started through `$.process.spawn`, the plugin's in-memory state, any host-provided persistent storage? Can `codex exec resume <thread>` reattach to or recover the result of a run whose child died, and where does Codex keep a thread's last answer on disk?

Sources:

- The host's own contract for Claude Code 2.1.317: the generated typings `plugins/codex/.claude-plugin/types/claude-code/index.d.ts` (git-ignored, written by the engine; the `plugin-authoring` skill writes the same file as `types/claude-code.d.ts`) and the skill's `reference.md` (sections "Running a plugin under development" and "Work that outlives a dispatch").
- The plugin code: `plugins/codex/hooks/runner.ts`, `register.tsx`, `events.ts`, `args.ts`, `plugins/codex/AGENTS.md`.
- Prior art in this repository: `plugins/codex-computer-use/hooks/register.tsx` (`$.store` for `/codex-cu on|off`), `plugins/file-explorer` and `plugins/image-preview` (`$.state` atoms), and the removed spider-team plugin at commit `8024664` (`hooks/saved.ts`: a run saved to `$.store` and restored after a reload or restart).
- Codex: `codex exec --help` and `codex exec resume --help` of the installed `codex-cli 0.166.0`, the files under `~/.codex`, and the openai/codex source at tag `rust-v0.166.0`:
  [`codex-rs/protocol/src/protocol.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/protocol/src/protocol.rs) (`EventMsg::TurnComplete`, `TurnCompleteEvent`),
  [`codex-rs/rollout/src/rollout_file_name.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/rollout/src/rollout_file_name.rs),
  [`codex-rs/rollout/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/rollout/src/lib.rs) (`SESSIONS_SUBDIR`, `ARCHIVED_SESSIONS_SUBDIR`),
  [`codex-rs/rollout/src/compression.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/rollout/src/compression.rs),
  [`codex-rs/exec/src/event_processor.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/exec/src/event_processor.rs) (`handle_last_message`).
- Live checks on 2026-11-03 (below): a throwaway mod run with `claude -p --plugin-dir` and `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, and three tiny read-only `codex exec` runs.

## Answer

- **A `$.process.spawn` child dies on every reload and at session end.** The host kills it when the module unloads, and a reload unloads the old module. Verified live.
- **Module variables start over** on a reload (the codex plugin's `jobs` list, `nextJob`, `active`, settings). **`$.state` survives a reload** but belongs to the session. **`$.store` survives reloads, updates and new sessions.** It is a JSON file per plugin under `~/.claude/plugins/store/`.
- **A child started detached through `$.process.run` (`nohup … &`) survives** both a reload and the end of the session. It is reparented to `launchd`. Verified live.
- **`codex exec resume` cannot reattach to a run, and it does not recover a lost answer.** It needs a new prompt, and it always runs a new turn on the same thread. A run killed before it answered has no answer on disk. A run that finished, even with nobody reading its stdout, has its answer in its rollout file: in the `task_complete` event's `last_agent_message`, and in the `-o` file when one was passed.

## Claude Code host (2.1.317)

### What a reload does

- `reference.md`: on a hot reload "`register` runs again in a fresh environment and the previous environment's timers are dropped". `$.clock`'s doc in the typings says the same: "a hot reload of the plugin cancels its pending waits with the old environment".
- `session.start` "Fires once per process for each loaded plugin, before the first prompt, then once per fresh load of one (never `/clear`) … A later one runs its hooks alone: an enable, a worker respawn, or a reload (changed modules only …)" (typings, `'session.start'`). So the codex plugin's `session.start` registers its tools again after a reload, and a reload hook can recover saved jobs there.
- `/reload-plugins` re-reads an installed plugin from its folder or its install copy (`reference.md`). An update of an installed plugin loads new code the same way, so it is a reload with new code. Not tested live: whether an update reaches a running session without `/reload-plugins` or a restart.
- If the hooks worker is lost (the engine replaces the plugin's copy without a code change), the hook runs again in a fresh copy, "its timers and state gone" (`reference.md`, "Work that outlives a dispatch"). For a plugin, this is a reload by another name.

### `$.process.spawn` children

The typings, `process.spawn`: "The loop is the child's life: leaving it, `return()` on the stream, `next.signal` aborting or the module unloading kills the child, and nothing else does, a hook's return included." `ProcessSpawnRequest` has no option to detach, to set a process group or to redirect output. The child's stdout and stderr always come back to the module through the stream.

Live check: a throwaway mod's `session.start` spawned `sh -c 'echo $$ >> log; exec sleep 300'` through `$.process.spawn`, and started `nohup sleep 301 >/dev/null 2>&1 </dev/null &` through `$.process.run`. Its `ping` tool logged which pids were alive. A `claude -p` turn called `ping`, appended a line to the module's file (which reloads the module before the plugin's next tool call), and called `ping` again. The log:

```
start module=1793727401591
spawn 92877
nohup 92880
ping module=1793727401591 pings=1
alive 92877
alive 92880
start module=1793727408661      <- reload: session.start ran again, new module instance
spawn 93324
nohup 93327
ping module=1793727408661 pings=1   <- module variable reset (pings back to 1)
dead 92877                      <- the spawned child of the old module was killed
alive 92880                     <- the nohup child survived
alive 93324
alive 93327
```

When the `claude -p` process exited, the second spawned child (93324) was dead too. Both `nohup` children (92880 and 93327) were still alive. An earlier run without the reload step showed the same thing at session end: the spawned child was gone, and the `nohup` child was alive with PPID 1. So a new session, or a quit and restart, also kills every running Codex job of the current plugin. The probe ran on macOS. Linux was not tested. Untested inference: a child that is not detached may get SIGHUP when its terminal closes, so `nohup` matters there.

`$.process.run` is one shot. It waits for the child's stdout and stderr to close ("a background process left writing holds the call until the timeout", 30 s by default, ten minutes at most). A detached child must therefore redirect all three streams. Its output then has to go to files, because no stream reaches the plugin.

### In-memory state of the codex plugin

`plugins/codex/hooks/register.tsx` keeps `foregroundMs`, `backgroundMs`, `codexPath`, `active` and the `runner` (`createRunner`) as module variables. `runner.ts` keeps `jobs` and `nextJob` in a closure. All of these start over on a reload. `plugins/codex/AGENTS.md` already says so: "The jobs list lives in memory and is lost on a reload." On top of that, a job's `adopt` loop belongs to the old environment. Its child is killed, so its toast and its `prompt.submit` notice never come. After a reload, a running job is gone without a trace: its process, its list entry and its end notice.

### Host-provided storage

| Store | Survives a reload | Survives a new session | API | Limits |
| --- | --- | --- | --- | --- |
| Module variables | no | no | plain JS | none |
| `$.state` | yes | no: "named values held by the host for the session" | `$.state.get(ref)` resolves `{ value, version }`, `$.state.set(ref, value)`; with the state library, `atom(ref, initial)`, `read`, `update` | plain data; each key declared in `interface PluginState` in the plugin's `types/index.d.ts`, `plugin` and `key` as literals in source; the owner alone writes, any plugin reads; `atom`'s `shape` tag makes a reload whose code names another tag read the value as absent |
| `$.store` | yes | yes: "kept between sessions and hot reloads" | `get(key)`, `set(key, value)`, `delete(key)`, `keys()`, all async | JSON data only; "Rejects a function, a cycle, or a store over 4 MiB of JSON text in all" |
| `$.fs` | yes | yes | `read`, `write`, `list`, `stat`, `exists` on any path | the plugin picks the folder; no plugin data dir is provided |

- **Where `$.store` lives** (observed): `~/.claude/plugins/store/<plugin>_<marketplace>-<hash>.json`, mode 0600, a pretty-printed JSON object of the keys. For example, `codex-computer-use_spider-claude-mods-a540452536b8.json` holds `{"enabled": true}`, and the probe's own was `reload-probe_inline-20195b8c8f69.json`. The typings say only "A JSON file of the plugin's own under the user's Claude Code configuration directory". The file name is an observation, not a contract. The key includes the source: a `--plugin-dir` copy (`_inline-`) and the marketplace copy have separate stores. The marketplace store kept its value through the plugin's version bumps. That is an inference from `codex-computer-use`'s `enabled` file, which is older than its last updates.
- **No plugin data directory.** `$.plugin` has only `name` and `root` (the plugin's own folder, which is replaced on update). The host typings expose no data-dir noun or variable for function hooks. The codex plugin already writes to `$TMPDIR/codex/` through `$.fs.write` and `$.process.run`. That survives reloads, but the OS may clean it.
- **Prior art:** spider-team (commit `8024664`) wrote its open run to `$.store` under `run:<session id>` after each change. It tagged the value with a `STATE_SHAPE`, pruned entries older than 7 days or beyond the newest 20 sessions, saved one change at a time, and restored the run in `session.start` when `$.state` had none.

## Codex CLI (0.166.0)

### `codex exec resume`

```
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
  [SESSION_ID]  Conversation/session id (UUID) or thread name. …
  [PROMPT]      Prompt to send after resuming the session. If `-` is used, read from stdin
```

- **It does not reattach.** It loads the thread's recorded history and runs one new turn with a new prompt. With no prompt and stdin closed, it exits with code 1: `Reading prompt from stdin...` / `No prompt provided via stdin.` (live check).
- **It does not recover a lost turn's answer.** Live check: a run (`Write the numbers from 1 to 300 …`) was sent SIGTERM after `turn.started`. Its stdout held only `thread.started` and `turn.started`, and its `-o` file was never written. Its rollout file ended with the user message (`item_completed` `UserMessage`), with no agent message, no `task_complete` and no `turn_aborted`. `codex exec resume <thread> "<new prompt>"` then answered from the same thread, with the interrupted request in its history, and reused the prompt cache (`cached_input_tokens: 23552` of `23782`). It appended its turn to the same rollout file and reported the same `thread_id` in `thread.started`. Getting the lost answer back means asking again: resume with a prompt such as "answer my previous request". That is a new, paid turn, but it is cheaper than a fresh `exec` because the thread's context is cached.
- `codex exec` also has `fork` ("Fork a previous session by id into a new session") and `--ephemeral` ("Run without persisting session files to disk"). The plugin must never pass `--ephemeral`, or nothing would be left to read back.

### Where Codex records a thread

- **Rollout file:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl`. The date and time are local time, when the thread started (`rollout-2026-11-03T14-37-49-…` for a thread whose first line has `2026-11-03T17:37:49Z` in UTC-3). The source renders `rollout-{timestamp}-{thread_id}.jsonl`, or `rollout-{timestamp}-{thread_id}_{rollout_id}.jsonl` when the rollout id differs from the thread id (`rollout_file_name.rs`, `render`). A resumed thread keeps writing to its original file, even on a later day.
- **Compressed and archived files:** a background worker "compresses cold local rollout files" to `<same name>.jsonl.zst` (zstd), in place (`compression.rs`). 51 of the 220 files under `~/.codex/sessions` here were `.zst`. `codex archive <thread>` moves a thread to `$CODEX_HOME/archived_sessions/` (`ARCHIVED_SESSIONS_SUBDIR`), compressed too. A reader must accept `.jsonl` and `.jsonl.zst`, as Codex's own `open_rollout_line_reader` does.
- **Index:** `$CODEX_HOME/state_5.sqlite`, table `threads`, column `rollout_path`, keyed by `id` (the thread id). It also has `thread_source` (`claude-code-codex-plugin` for the plugin's runs), `cwd`, `cli_version`, `model`, `reasoning_effort`, `archived` and `updated_at_ms`. This is an internal, versioned database (`_5`). `$CODEX_HOME/session_index.jsonl` lists only named threads (`id`, `thread_name`, `updated_at`); the probe threads were not in it. Finding the file with `find $CODEX_HOME/sessions -name "*<thread id>*"` works with no database.
- **Format:** JSON Lines. Each line is `{"timestamp", "ordinal", "type", "payload"}`. The `type` values seen: `session_meta` (first line: `id`, `session_id`, `cwd`, `originator: "codex_exec"`, `cli_version`, `source: "exec"`, `thread_source`, `base_instructions`, `history_mode: "paginated"`), `event_msg`, `response_item`, `turn_context`, `world_state`, `token_usage_record`.
- **The last agent message:** at the end of a turn, an `event_msg` line with `payload.type == "task_complete"`, and its `payload.last_agent_message`:

  ```json
  {"timestamp":"2026-11-03T17:37:53.770Z","ordinal":17,"type":"event_msg","payload":{"type":"task_complete","root_turn_id":"01a1a27d-…","turn_id":"01a1a27d-…","last_agent_message":"probe-ok","started_at":1793727469,"completed_at":1793727473,"duration_ms":4215,"time_to_first_token_ms":4088}}
  ```

  In the source this is `EventMsg::TurnComplete(TurnCompleteEvent)`, serialized as `task_complete` (alias `turn_complete`). `TurnCompleteEvent` has `turn_id`, `last_agent_message: Option<String>` and an optional `error: Option<ErrorEvent>` ("Terminal error details when the turn completed unsuccessfully") (`protocol.rs`). Each answer also appears before that as `event_msg` `item_completed` with `item.type == "AgentMessage"`, `item.phase == "final_answer"` and `item.content[].text`, and as `response_item` `message` with `role: "assistant"`. The last `task_complete` in the file is the thread's latest answer. A turn whose `task_complete` comes after the turn the plugin started is that run's answer.
- **`-o, --output-last-message <FILE>`:** at the end of the turn, `codex exec` writes the last agent message to that file. When there is none, it writes an empty file and warns on stderr (`handle_last_message`). The file is written only when the turn completes, so a killed run leaves none (live check).
- **Images** are already read from `$CODEX_HOME/generated_images/<thread id>/` by `output.ts`. That folder is on disk, independent of the child.

## What follows for the codex plugin

These are inferences from the facts above, for the "How jobs persist and resume" ticket (#372):

1. As built today, a job cannot survive a reload: `$.process.spawn` ties the child to the module. For a job to outlive a reload, the plugin would need a detached child started through `$.process.run` (`nohup codex exec --json … -o <answer file> -- <prompt> >events.jsonl 2>stderr.txt </dev/null & echo $!`). It then reads the outcome from files instead of a stream: the `-o` file, the redirected `--json` events, or the rollout's `task_complete`. Such a child also outlives the Claude Code session. The plugin would then need its own pid record to stop it past `backgroundMinutes`, and a decision on what happens to a job whose session ended.
2. The jobs list goes in `$.store` (it survives reloads and new sessions), keyed so a session finds its own, with a shape tag and pruning as spider-team did. `$.state` alone would cover reloads but not a restart.
3. After a reload, the jobs saved in `$.store` and the thread id (from `thread.started`, stored as soon as it arrives) are enough to settle each job without re-running it: find the rollout file by thread id, accept `.jsonl.zst`, and read the last `task_complete` after the job's start. If there is none and the process is gone, the run died before answering. `codex exec resume <thread> "<prompt>"` can then ask again on the same thread, as a new turn.
4. The end notice (`prompt.submit`) and the toast need a living watcher. After a reload, `session.start` must restart the polling (`$.clock.every`, or `$.process.run` `sleep` steps as `within` does) for the jobs still running.
