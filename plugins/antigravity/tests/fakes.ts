// What `agy -p --output-format=stream-json` prints, as the plugin's tests script it (shapes measured on agy 1.5.3).
export const CONVERSATION = '0d338672-6179-4c99-8838-b9f12fc351fe'
export const line = (event: unknown) => `${JSON.stringify(event)}\n`

export const init = (conversation = CONVERSATION, model = 'gemini-4-argon-medium') =>
  line({ event: 'init', conversation_id: conversation, init: { model, cwd: '/proj' } })

/** A run that answers `text` in `conversation`. */
export const answered = (text: string, conversation = CONVERSATION) =>
  init(conversation) +
  line({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } }) +
  line({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: text, num_turns: 1 } })

/** A run whose `result` event reports an error, with its `finished_reason` when given. */
export const failed = (error: string, finished_reason?: string, conversation = CONVERSATION) =>
  init(conversation) + line({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', error, ...(finished_reason ? { finished_reason } : {}) } })

/** The structured error line agy writes to stderr on an API failure (exit code 3). */
export const agyError = (status: string, short_error: string) =>
  `AGY_ERROR: ${JSON.stringify({ short_error, status, retryable: status !== 'INVALID_ARGUMENT', error_id: 'e-123' })}\n`

/** A run that hands the image request to agy's image-generator subagent, then answers `text` (shapes measured on agy 1.5.3). */
export const imaged = (text: string, conversation = CONVERSATION) =>
  init(conversation) +
  line({
    event: 'step_update',
    step_update: { conversation_id: conversation, step_index: 2, state: 'DONE', step_type: 'subagent', tool_name: 'invoke_subagent', subagent_info: { subagents: [{ type_name: 'image-generator' }] } },
  }) +
  line({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: text, num_turns: 1 } })
