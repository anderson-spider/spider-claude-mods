import type { McpToolInputs } from 'claude-code'
import type { Effort } from '../types'
import { allOf, type SchemaFor } from './schema'

/** The reasoning efforts `agy --effort` takes. */
export const EFFORTS = allOf<Effort>()('low', 'medium', 'high', 'xhigh', 'max')

// `as const` keeps each `type` a literal, which the SchemaFor check below needs.
const MODEL = {
  type: 'string',
  description:
    "agy model id, as `agy models` lists it (such as gemini-4-argon-high); omit it and the plugin's defaultModel, else agy's default, applies. " +
    'Prefer a Gemini model: agy also offers Claude models, whose opinion adds little to yours.',
} as const

const EFFORT = {
  type: 'string',
  enum: EFFORTS,
  description: "Reasoning effort for this run; omit it and agy's default applies.",
} as const

const WAIT = {
  type: 'boolean',
  description: 'Default true. false starts a background job; completion sends a message. Use jobs to check it.',
} as const

// Each inputSchema satisfies SchemaFor of its McpToolInputs entry in types/index.d.ts: tsc fails when they differ.
export const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The question, with its goal and the output wanted.' },
    conversationId: { type: 'string', description: 'Continue the agy conversation an earlier call returned; omit for a new one.' },
    model: MODEL,
    effort: EFFORT,
    files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths agy should read.' },
    wait: WAIT,
    out: { type: 'string', description: 'Absolute Markdown output path.' },
    maxChars: { type: 'number', description: 'Inline excerpt length; default 3000. The file keeps the full answer.' },
  },
  required: ['prompt'],
} satisfies SchemaFor<McpToolInputs['mcp__antigravity__ask']>

export const REVIEW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'Review the branch against this base branch. With no target, the base is the default branch (origin/HEAD, else main or master).' },
    commit: { type: 'string', description: 'Review the changes of this commit instead.' },
    focus: { type: 'string', description: 'An extra concern for the review, in a sentence.' },
    model: MODEL,
    effort: EFFORT,
    wait: WAIT,
    out: { type: 'string', description: 'Absolute Markdown output path.' },
    maxChars: { type: 'number', description: 'Inline excerpt length; default 3000. The file keeps the full review.' },
  },
} satisfies SchemaFor<McpToolInputs['mcp__antigravity__review']>

export const JOBS_DESCRIPTION =
  'Find the background agy requests of this project, of every session, which outlive a plugin reload: status, conversation id and saved files, newest first. Local only; runs nothing.'

export const JOBS_INPUT_SCHEMA = { type: 'object', properties: {} } satisfies SchemaFor<McpToolInputs['mcp__antigravity__jobs']>

export const ASK_COMMAND_DESCRIPTION = 'Ask Antigravity (agy): /agy-ask <question>'
export const REVIEW_COMMAND_DESCRIPTION = 'Have agy review the branch: /agy-review [--base <branch> | --commit <ref>] [focus]'
export const DOCTOR_COMMAND_DESCRIPTION = 'Check the agy CLI, its version, sign-in, models and quota: /agy-doctor'

export const ASK_USAGE = 'Usage: /agy-ask <question>'
export const REVIEW_USAGE = 'Usage: /agy-review [--base <branch> | --commit <ref>] [focus], one target at most'
