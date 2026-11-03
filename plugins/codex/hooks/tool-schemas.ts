import type { McpToolInputs } from 'claude-code'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION } from './prompts'
import type { SchemaFor } from './schema'

// `as const` keeps each `type` a literal, which the SchemaFor check below needs.
const COMMON_PROPERTIES = {
  threadId: {
    type: 'string',
    description: 'Continue the Codex thread an earlier call returned; omit for a new thread.',
  },
  model: {
    type: 'string',
    description: "Codex model name for this run; omit it and the user's Codex default applies.",
  },
  effort: {
    type: 'string',
    description: "Reasoning effort for this run (low, medium, high, ...); omit it and the user's Codex default applies.",
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Absolute paths Codex should read; images among them are attached as images.',
  },
  wait: {
    type: 'boolean',
    description: 'Default true. false starts a background job; completion sends a message. Use jobs to check it.',
  },
} as const

// Each inputSchema satisfies SchemaFor of its McpToolInputs entry in types/index.d.ts: tsc fails when they differ.
export const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The question, with its goal and the output wanted.' },
    ...COMMON_PROPERTIES,
    out: { type: 'string', description: 'Absolute Markdown output path.' },
    maxChars: {
      type: 'number',
      description: 'Inline excerpt length; default 3000. The file keeps the full answer.',
    },
  },
  required: ['prompt'],
} satisfies SchemaFor<McpToolInputs['mcp__codex__ask']>

export const IMAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Self-contained image request.' },
    reference: {
      type: 'string',
      description: 'Absolute PNG/JPEG/WebP/GIF reference path to edit from.',
    },
    ...COMMON_PROPERTIES,
    out: { type: 'string', description: 'Absolute image output path; variants add -1, -2.' },
  },
  required: ['prompt'],
} satisfies SchemaFor<McpToolInputs['mcp__codex__image']>

export const JOBS_DESCRIPTION =
  "Find this session's background Codex requests: status, thread id and saved files, newest first. Local only; runs nothing."

export const JOBS_INPUT_SCHEMA = { type: 'object', properties: {} } satisfies SchemaFor<McpToolInputs['mcp__codex__jobs']>

export const ASK_COMMAND_DESCRIPTION = 'Ask Codex: /codex-ask <question>'
export const IMAGE_COMMAND_DESCRIPTION = 'Generate and save an image with Codex: /codex-image <prompt>'
export const DOCTOR_COMMAND_DESCRIPTION = 'Check the Codex CLI, its login and its default model: /codex-doctor'

export const ASK_USAGE = 'Usage: /codex-ask <question>'
export const IMAGE_USAGE = 'Usage: /codex-image <prompt>'
