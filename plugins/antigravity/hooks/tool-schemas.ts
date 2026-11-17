import type { Effort } from '../types'
import { allOf, type SchemaFor } from './schema'

// What the model sends to each tool of the MCP server, as mcp__plugin_antigravity_antigravity__<name>.
export type AskInput = {
  prompt: string
  conversationId?: string
  model?: string
  effort?: Effort
  files?: string[]
  wait?: boolean
  out?: string
  maxChars?: number
}
export type ImageInput = {
  prompt: string
  reference?: string
  conversationId?: string
  model?: string
  effort?: Effort
  wait?: boolean
  out?: string
}
export type ReviewInput = {
  base?: string
  commit?: string
  focus?: string
  model?: string
  effort?: Effort
  wait?: boolean
  out?: string
  maxChars?: number
}
export type JobsInput = {}

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
  description:
    "Reasoning effort for this run; omit it and agy's default applies. A model id that ends in its effort (such as gemini-4-argon-high) takes none: pick the id with the effort you want instead.",
} as const

const WAIT = {
  type: 'boolean',
  description: 'Default true. false starts a background job; completion sends a message. Use jobs to check it.',
} as const

// Each inputSchema satisfies SchemaFor of its input type above: tsc fails when they differ.
export const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The question, with its goal and the output wanted.' },
    conversationId: { type: 'string', description: 'Continue the agy conversation an earlier call returned; omit for a new one.' },
    model: MODEL,
    effort: EFFORT,
    files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths agy should read.' },
    wait: WAIT,
    out: { type: 'string', description: 'Absolute Markdown output path, inside the project or the answers folder and outside .git.' },
    maxChars: { type: 'number', description: 'Inline excerpt length; default 3000. The file keeps the full answer.' },
  },
  required: ['prompt'],
} satisfies SchemaFor<AskInput>

export const IMAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Self-contained image request: the scene, its style and what to keep from the reference.' },
    reference: { type: 'string', description: 'Absolute PNG/JPEG/WebP/GIF path to edit from.' },
    conversationId: { type: 'string', description: 'Continue the agy conversation an earlier image call returned, to refine its image; omit for a new one.' },
    model: MODEL,
    effort: EFFORT,
    wait: WAIT,
    out: { type: 'string', description: 'Absolute image output path, inside the project or the answers folder and outside .git; several images add -1, -2.' },
  },
  required: ['prompt'],
} satisfies SchemaFor<ImageInput>

export const REVIEW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'Review the branch against this base branch. With no target, the base is the default branch (origin/HEAD, else main or master).' },
    commit: { type: 'string', description: 'Review the changes of this commit instead.' },
    focus: { type: 'string', description: 'An extra concern for the review, in a sentence.' },
    model: MODEL,
    effort: EFFORT,
    wait: WAIT,
    out: { type: 'string', description: 'Absolute Markdown output path, inside the project or the answers folder and outside .git.' },
    maxChars: { type: 'number', description: 'Inline excerpt length; default 3000. The file keeps the full review.' },
  },
} satisfies SchemaFor<ReviewInput>

export const JOBS_DESCRIPTION =
  'Find the background agy requests of this project, of every session, which outlive a plugin reload: status, conversation id and saved files, newest first. Local only; runs nothing.'

export const JOBS_INPUT_SCHEMA = { type: 'object', properties: {} } satisfies SchemaFor<JobsInput>

export const ASK_COMMAND_DESCRIPTION = 'Ask Antigravity (agy): /antigravity-ask <question>'
export const IMAGE_COMMAND_DESCRIPTION = 'Generate and save an image with agy: /antigravity-image <prompt>'
export const REVIEW_COMMAND_DESCRIPTION = 'Have agy review the branch: /antigravity-review [--base <branch> | --commit <ref>] [focus]'
export const DOCTOR_COMMAND_DESCRIPTION = 'Check the agy CLI, its version, sign-in, models and quota: /antigravity-doctor'

export const ASK_USAGE = 'Usage: /antigravity-ask <question>'
export const IMAGE_USAGE = 'Usage: /antigravity-image <prompt>'
export const REVIEW_USAGE = 'Usage: /antigravity-review [--base <branch> | --commit <ref>] [focus], one target at most'
