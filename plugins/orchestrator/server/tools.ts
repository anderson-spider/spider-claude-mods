// The tools the server lists, after T3 Code's orchestrator MCP server (docs/orchestration-v2/orchestrator-mcp-server.md
// there): each input type, and its schema checked against that type by `SchemaFor`. T3 Code nests the provider,
// model and options in `target`; here they are top-level, since SchemaFor types no nested object.
// TypeScript that Node runs by stripping its types (erasable syntax only).
import { allOf, type SchemaFor } from '../hooks/schema.ts'

export type RuntimeMode = 'read-only' | 'approval-required' | 'auto-accept-edits' | 'full-access'
export type CapabilitiesInput = {}
export type DelegateTaskInput = {
  task: string
  title?: string
  role?: 'implementation' | 'research' | 'review' | 'design' | 'test' | 'general'
  providerInstanceId?: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  isolation?: 'shared' | 'worktree'
  mode?: 'async' | 'wait'
  timeoutMs?: number
  clientRequestId?: string
  runtimeMode?: 'inherit' | RuntimeMode
}
export type TaskStatusInput = { taskId: string }
export type TaskCancelInput = { taskId: string; reason?: string }
export type ThreadSendInput = {
  threadId: string
  message: string
  title?: string
  mode?: 'auto' | 'queue' | 'restart'
  freshContext?: boolean
  clientRequestId?: string
}

const CAPABILITIES_SCHEMA = { type: 'object', properties: {} } as const satisfies SchemaFor<CapabilitiesInput>

const DELEGATE_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'The whole brief: the child does not see this conversation. Name files by absolute path.' },
    title: { type: 'string', description: 'A short title for the task, shown in its notice.' },
    role: { type: 'string', enum: allOf<DelegateTaskInput['role']>()('implementation', 'research', 'review', 'design', 'test', 'general'), description: "Default 'general'." },
    providerInstanceId: { type: 'string', description: "Provider instance id from orchestrator_capabilities. Default 'agy'." },
    model: { type: 'string', description: "A model id orchestrator_capabilities lists; omit for the provider's default." },
    effort: { type: 'string', enum: allOf<DelegateTaskInput['effort']>()('low', 'medium', 'high'), description: 'Thinking level, when orchestrator_capabilities lists the effort option.' },
    isolation: { type: 'string', enum: allOf<DelegateTaskInput['isolation']>()('shared', 'worktree'), description: "'shared' (default): this session's folder. 'worktree' is not available yet." },
    mode: { type: 'string', enum: allOf<DelegateTaskInput['mode']>()('async', 'wait'), description: "Default 'async'. 'wait' only if this turn needs the result." },
    timeoutMs: { type: 'number', description: "Mode 'wait' only. At most 45000. A timeout does not cancel the child." },
    clientRequestId: { type: 'string', description: 'Stable across retries of one call, distinct per round: a retry returns the same task.' },
    runtimeMode: {
      type: 'string',
      enum: allOf<DelegateTaskInput['runtimeMode']>()('inherit', 'read-only', 'approval-required', 'auto-accept-edits', 'full-access'),
      description: "Omit (inherit) unless the user asks. read-only and approval-required: reads only; auto-accept-edits: edits inside the folder; full-access: edits and commands. Above this session's ceiling is rejected.",
    },
  },
  required: ['task'],
} as const satisfies SchemaFor<DelegateTaskInput>

const STATUS_SCHEMA = {
  type: 'object',
  properties: { taskId: { type: 'string', description: 'The taskId delegate_task returned.' } },
  required: ['taskId'],
} as const satisfies SchemaFor<TaskStatusInput>

const CANCEL_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'The taskId delegate_task returned.' },
    reason: { type: 'string', description: 'Why, kept with the task.' },
  },
  required: ['taskId'],
} as const satisfies SchemaFor<TaskCancelInput>

const THREAD_SEND_SCHEMA = {
  type: 'object',
  properties: {
    threadId: { type: 'string', description: 'The threadId a delegate_task result returned.' },
    message: { type: 'string', description: "The follow-up: the agent's session still has the task and its own answers, not this conversation." },
    title: { type: 'string', description: 'A short title for the follow-up, shown in its notice.' },
    mode: {
      type: 'string',
      enum: allOf<ThreadSendInput['mode']>()('auto', 'queue', 'restart'),
      description: "Default 'auto': run now, or after the thread's running and queued tasks (as 'queue'). 'restart' stops the running task and runs this one next.",
    },
    freshContext: { type: 'boolean', description: 'Start a new agent session for this message, without the earlier turns; the message then carries the whole brief.' },
    clientRequestId: { type: 'string', description: 'Stable across retries of one call, distinct per message and from every delegate_task id: a retry on the same thread returns the same task.' },
  },
  required: ['threadId', 'message'],
} as const satisfies SchemaFor<ThreadSendInput>

export const TOOLS = [
  {
    name: 'orchestrator_capabilities',
    description:
      'Lists the providers a task can be delegated to (another CLI\'s agent, such as Antigravity\'s agy), with their models, options and availability, and the runtime modes this session allows. Call it once before the first delegate_task, and again only after an error.',
    inputSchema: CAPABILITIES_SCHEMA,
  },
  {
    name: 'delegate_task',
    description:
      "Delegates a task to another CLI's agent as a subagent: it runs in its own session, in this session's folder, under a runtime mode no broader than this session's ceiling. Use it for another provider's model (a second opinion from another model family, a review, research), or when the user names it; use your native Agent tool for a Claude subagent. A new, independent review is a new call with the full brief; to follow up on a child's result (an objection, a question about its findings, the next step), use thread_send with the result's threadId instead. Mode 'async' (default) returns at once; 'wait' waits up to 45 s. When the result has next, follow it: the task's end wakes this session with its result.",
    inputSchema: DELEGATE_SCHEMA,
  },
  {
    name: 'task_status',
    description:
      "Reads a delegated task of this session: status (queued: waiting behind its thread's running task; starting, running, completed, failed, cancelled, interrupted), workState, the agent's current action while it runs, and its result (summary) once it ends. Do not poll a running task: its end wakes this session.",
    inputSchema: STATUS_SCHEMA,
  },
  {
    name: 'task_cancel',
    description: 'Stops a delegated task of this session that you replace or no longer need, or takes a queued one off its thread\'s queue; its end then sends no notice.',
    inputSchema: CANCEL_SCHEMA,
  },
  {
    name: 'thread_send',
    description:
      "Sends a follow-up to a delegated task's thread: a new task on the same agent session, which remembers the earlier turns, under the thread's runtime mode. Use it to answer the child's result (an objection, a question about its findings, the next step); the earlier task's result stays as it was. Returns the new taskId at once with next: its end wakes this session.",
    inputSchema: THREAD_SEND_SCHEMA,
  },
] as const

export type ToolName = (typeof TOOLS)[number]['name']
