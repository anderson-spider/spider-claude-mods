# Changelog

## 0.2.0 (2026-11-17)

### Features

* threads: each `delegate_task` opens a thread, one agent session with a fixed folder, role, model, options and runtime mode; results and notices carry its `threadId`, and the thread's tasks run one at a time, later ones `queued`
* `thread_send` sends a follow-up on a thread as a new task that resumes the agent session (ACP `session/resume`), with mode `auto`, `queue` or `restart` (which interrupts the running task) and `freshContext` for a new session; `steer` is refused, since ACP takes no prompt mid-turn
* a daemon that is stopping refuses `delegate_task` and `thread_send` with `orchestrator_stopping` and spawns no agent
* runtime mode `read-only`, narrower than `approval-required`: every action but reads is refused at once

## 0.1.0 (2026-11-17)

### Features

* delegate tasks to Antigravity's agy over ACP as subagents, after T3 Code's orchestrator contract (`orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`), with runtime modes the client enforces, a shared daemon that keeps the tasks, and the session woken when a task ends
