# orchestrator

Modeled on T3 Code's orchestrator MCP server (`docs/orchestration-v2/orchestrator-mcp-server.md` and `packages/contracts/src/orchestratorMcp.ts` there) and its ACP client policy (`packages/provider-acp/src/server/clientPolicy.ts`): keep names, statuses and the `next` text as T3 Code has them. T3 Code's nested `target` is flattened to `providerInstanceId`, `model` and `effort`, since `SchemaFor` types no nested object.

Three processes: an MCP server per session, a daemon per user and plugin version (tasks outlive the session), and a hooks module that delivers task notices. No module hook on tool calls, so Code Mode stays available.

## agy over ACP (measured on agy 1.5.10)

- `session/resume` replays no history and keeps the session's memory; `session/load` replays it.
- agy ends its turn at each refused permission, so a turn that ends empty after a new refusal is re-prompted.
- `--sandbox` blocks writes, even inside the folder, and network; reads outside the folder pass.
- agy asks no questions over ACP; it writes them in its answer.
- A second `session/prompt` during a turn is queued by agy itself; ACP takes no prompt mid-turn, so `steer` is refused.

## Invariants

- One running task per thread; two agents on one session would clash, so a thread whose task another live daemon runs is `thread_busy`.
- In `auto-accept-edits` a mutation passes only with every location inside the work folder by realpath, failing closed; `read-only` refuses all but reads.
- A thread's runtime mode is capped by the caller's current `maxRuntimeMode` ceiling.
- An agy profile whose `config/hooks.json` or `config/mcp_config.json` sets anything is refused.
- Tasks are scoped to their parent session.

## Checks

`server.test.mjs` runs server, daemon and fake agent under a temporary HOME in `/tmp`: a socket path has a length limit a macOS temporary folder can pass. `typecheck` also runs `tsc -p tsconfig.node.json`. Live, spending agy quota: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --plugin-dir plugins/orchestrator` in a scratch git repository; delegate a small task async and end the turn; the result arrives as a prompt. Then stop the daemon (`daemon.log` names its pid) so the next session runs the current code.
