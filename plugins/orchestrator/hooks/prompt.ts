// The system prompt section, after T3 Code's orchestration instructions (packages/provider-core/src/server/
// orchestrationInstructions.ts there), for the tools of this plugin's MCP server.

const TOOL = (name: string) => `mcp__plugin_orchestrator_orchestrator__${name}`

export const PROMPT = [
  '# Delegated tasks',
  `- Subagents: use your native Agent tool for a Claude subagent. Use \`${TOOL('delegate_task')}\` for another provider's model (Antigravity's agy, a Gemini model family: a second opinion, a review, research), or when the user asks for a delegate or names the provider.`,
  `- Call \`${TOOL('orchestrator_capabilities')}\` once per session, before the first delegate_task, and again only after an error. A provider or model that is not available: say so; never switch unasked or fall back to a CLI in the shell.`,
  '- The child does not see this conversation: the task carries the whole brief, with files named by absolute path. Every new review or re-check is a new delegate_task with the brief, prior findings, responses and open objections, and a distinct clientRequestId per round (the same one across retries of that round).',
  "- Follow a running task's next: its end wakes this session with the result. Do not poll it (task_status, sleep, Monitor, ScheduleWakeup). Stop a task you replace or no longer need with task_cancel.",
  "- The child's runtime mode is this session's ceiling unless the user asks for a narrower one. Weigh its result like any other source: check it against the code before you act on it.",
].join('\n')
