# orchestrator

Delegate a task to another CLI's agent as a subagent, the way [T3 Code](https://github.com/pingdotgg/t3code) orchestrates its providers: Claude hands the task to Google's [Antigravity CLI](https://antigravity.google/) (`agy`) over the Agent Client Protocol (ACP), the agent works in its own session in your folder, and when it ends the result comes back to Claude as a new message. The plugin, not the agent, decides what the agent may do.

```text
/plugin install orchestrator --marketplace anderson-spider/claude-mods
```

## Setup

Install the agy CLI (`curl -fsSL https://antigravity.google/cli/install.sh | bash`) and sign in once by running `agy`; the plugin was measured on agy 1.5.10 (it runs `agy acp`), and needs Node 22.18 or later on PATH as `node`. It finds `agy` on PATH, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; set the `agyPath` option to use another one.

| Option | Default | Use |
| --- | --- | --- |
| `maxRuntimeMode` | `auto-accept-edits` | The broadest runtime mode a task may run in, and the one it gets when it names none. |
| `taskMinutes` | 30 | How long a task may run before it is stopped. |
| `agyPath` | empty | Absolute path of the agy executable. |

## Use

Ask Claude to delegate ("ask agy to review this", "get a second opinion from Gemini", "delegate the research to agy"). Claude calls the plugin's tools, `mcp__plugin_orchestrator_orchestrator__<name>`, which follow T3 Code's orchestrator contract:

| Tool | What it does |
| --- | --- |
| `orchestrator_capabilities` | The providers, with their models (as `agy` lists them), the `effort` option (agy's thinking level) and availability, the runtime modes this session allows and the `thread_send` modes. |
| `delegate_task` | Starts a task: `task` (the whole brief, since the agent does not see the conversation), `title`, `role`, `model`, `effort`, `runtimeMode`, `clientRequestId` (a retry with the same one returns the same task), and `mode`: `async` (the default) returns at once with `next`, `wait` holds the call up to 45 s. |
| `task_status` | A task's status, what the agent is doing while it runs, and its result once it ends. |
| `task_cancel` | Stops a running task, or takes a queued one off its thread's queue; its end then sends no message. |
| `thread_send` | Sends a follow-up on a task's thread: `threadId`, `message`, `title`, `mode` (`auto`, `queue` or `restart`), `freshContext` and `clientRequestId` (a retry on the same thread returns the same task; an id another call used is refused). Returns the new task at once with `next` and a `delivery` of `started`, `queued` or `restarted`. |

A task's end wakes the session: its result arrives as a prompt ("Delegated task … (thread …) completed. Its result: …"), once, unless a `wait` or a `task_status` already returned it. Claude neither waits on a running task nor polls it.

### Threads

Each `delegate_task` opens a thread: one agent session, with the task's folder, role, model, effort and runtime mode fixed for good. Results and notices carry its `threadId`. A `thread_send` is a new task on the thread that resumes the agent's session (ACP `session/resume`), so the agent remembers its earlier turns and gets the message alone; with `freshContext`, or when the thread has no agent session yet, it starts a new session and the message must carry the whole brief. An earlier task's result never changes.

One task runs on a thread at a time; a later one waits as `queued` (`workState: "queued"`). `auto` and `queue` both run the message after the thread's running and queued tasks. `restart` stops the running task, which ends as `interrupted` with no message, and runs the new one next (after any earlier restart still waiting, so restarts run in the order sent). `steer` (a message into the running turn) is not offered: an ACP agent takes no prompt during a turn. A thread whose task runs in another daemon (an earlier version of the plugin) refuses a `thread_send` with `thread_busy` until that task ends.

agy asks no questions over ACP: when it needs something from you, it writes the question in its answer, and Claude answers with `thread_send`.

## Runtime modes

The agent asks the client before every edit and command, and the plugin answers by the task's runtime mode, as T3 Code's ACP client does. Reads and searches always pass.

| Mode | Edits | Commands |
| --- | --- | --- |
| `read-only` | refused | refused |
| `approval-required` | refused (needs approval) | refused (needs approval) |
| `auto-accept-edits` | inside the session's folder only (symlinks resolved); elsewhere refused | refused |
| `full-access` | allowed | allowed |

A task never runs in a broader mode than `maxRuntimeMode`. Refused actions are listed with the task's result. agy ends its turn at each refused action, so the plugin prompts it on (up to four times) to finish with what it can do. `read-only` refuses every action but reads at once; `approval-required` refuses them as needing approval, since in this version a refused action is not routed to you for approval. A task runs in the session's folder (`isolation: "shared"`; `worktree` is refused).

agy runs as `agy acp --cli_dir_name=spider-orchestrator --sandbox`, with its own settings in `~/.gemini/antigravity-cli/spider-orchestrator/` (your sign-in is shared): the plugin writes `toolPermission: "request-review"` there before every task, so your own agy settings (such as `always-proceed`) never apply, and it refuses to run when that profile configures hooks or MCP servers (`config/hooks.json`, `config/mcp_config.json`), which would run outside these checks. The agent offers no file system or terminal to the client. agy's `--sandbox` (measured on agy 1.5.10) blocks writes, even inside the folder, and network access, while reads outside the folder pass. So an edit or command the runtime mode allows can still fail in the sandbox, and the agent can read files outside the folder, which neither the sandbox nor the runtime mode stops.

## How it runs

The MCP server of each session forwards the calls to one daemon shared by all your sessions (`node daemon/main.mjs`, started on the first call, stopping after 15 minutes with no task and no session). The daemon runs each task's agent in its own process group, keeps the tasks and threads as files, runs each thread's tasks in order and leaves a finished task's message in the session's inbox, which the plugin's hooks module submits. A task outlives the session that started it; its message waits until that session is open again. When the daemon stops while a task runs, the task ends as `interrupted`; a call that reaches a daemon while it stops fails with `orchestrator_stopping`, and the next call starts a new daemon. The plugin registers no hook on tool calls, so Code Mode stays available.

## Privacy

A task's brief and whatever the agent reads in your folder go to Google through your agy account, under its terms; the agent's conversations show in your agy history (`~/.gemini/antigravity-cli/`). The plugin keeps the tasks (brief or message, and result) and threads under `~/.local/state/spider-orchestrator/` (or `$XDG_STATE_HOME/spider-orchestrator/`), readable by you only, with the daemon's log there.
