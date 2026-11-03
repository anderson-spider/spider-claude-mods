import { expect, test } from 'claude-code/testing'
import { eventReader } from '../hooks/events'

const THREAD = '01a1a17a-b0ba-7770-b825-59aacf6e9f6d'
const line = (event: unknown) => `${JSON.stringify(event)}\n`

test('a run reads its thread id and its last agent message, even across cut pieces', () => {
  const reader = eventReader()
  const out = line({ type: 'thread.started', thread_id: THREAD }) + line({ type: 'turn.started' }) +
    line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'first' } }) +
    line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } }) +
    line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  reader.push('stdout', out.slice(0, 30))
  expect(reader.threadId).toBe(undefined)
  reader.push('stdout', out.slice(30))
  expect(reader.threadId).toBe(THREAD)
  expect(reader.end({ code: 0, signal: null })).toEqual({ threadId: THREAD, message: 'OK' })
})

test('a failed turn is the error, whatever came before it', () => {
  const reader = eventReader()
  reader.push('stdout', line({ type: 'thread.started', thread_id: THREAD }))
  reader.push('stdout', line({ type: 'error', message: 'Reconnecting... 1/5' }))
  reader.push('stdout', line({ type: 'turn.failed', error: { message: "The 'x' model is not supported" } }))
  expect(reader.end({ code: 1, signal: null })).toEqual({ threadId: THREAD, error: "The 'x' model is not supported" })
})

test('an error event before an answer does not fail a run that answers', () => {
  const reader = eventReader()
  reader.push('stdout', line({ type: 'error', message: 'Reconnecting... 1/5' }))
  reader.push('stdout', line({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }))
  expect(reader.end({ code: 0, signal: null })).toEqual({ message: 'done' })
})

test('a run that ends without an answer explains itself from its last error, else from stderr, else its exit', () => {
  const withError = eventReader()
  withError.push('stdout', line({ type: 'error', message: 'stream disconnected' }))
  expect(withError.end({ code: 1, signal: null }).error).toBe('Codex ended without an answer: stream disconnected')

  const withStderr = eventReader()
  withStderr.push('stderr', 'Not inside a trusted directory\n')
  withStderr.push('stdout', 'not json\n')
  expect(withStderr.end({ code: 1, signal: null }).error).toBe('Codex ended without an answer: Not inside a trusted directory')

  expect(eventReader().end({ code: null, signal: 'SIGTERM' }).error).toBe('Codex ended without an answer: stopped by SIGTERM')
  expect(eventReader().end({ code: 0, signal: null }).error).toBe('Codex ended without an answer: exit code 0')
})

test('the last line is read even without its newline', () => {
  const reader = eventReader()
  reader.push('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'tail' } }))
  expect(reader.end({ code: 0, signal: null }).message).toBe('tail')
})

test('a child ended by a signal says so, before an older error event', () => {
  const reader = eventReader()
  reader.push('stdout', line({ type: 'error', message: 'Reconnecting... 1/5' }))
  expect(reader.end({ code: null, signal: 'SIGKILL' }).error).toBe('Codex ended without an answer: stopped by SIGKILL')
})

test('a failed exit after an answer keeps the answer and names the exit', () => {
  const reader = eventReader()
  reader.push('stdout', line({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }))
  expect(reader.end({ code: 2, signal: null })).toEqual({ message: 'partial', error: 'Codex exited with code 2 after answering' })
})
