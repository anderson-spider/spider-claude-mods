import { expect, test } from 'claude-code/testing'
import { isRunOf, lastAnswerOf, parseExit } from '../hooks/detached'
import { line } from './fakes'

test('only the process carrying the run’s answer file counts as the run, whatever the executable is called', () => {
  const dir = '/tmp/codex/runs/j1'
  expect(isRunOf(`/Users/me/.local/bin/codex exec --json -o ${dir}/answer.md hello`, dir)).toBe(true)
  expect(isRunOf(`node /opt/tools/cdx-wrapper exec review --json -o ${dir}/answer.md`, dir)).toBe(true)
  expect(isRunOf('/Users/me/.local/bin/codex exec --json -o /tmp/codex/runs/j2/answer.md hello', dir)).toBe(false)
  expect(isRunOf('/usr/bin/vim notes.md', dir)).toBe(false)
  expect(isRunOf('', dir)).toBe(false)
})

test('the exit file gives the status and when the run ended; anything else is no status yet', () => {
  expect(parseExit('0 1762171200\n')).toEqual({ exit: 0, endedAt: 1_762_171_200_000 })
  expect(parseExit('143')).toEqual({ exit: 143 })
  expect(parseExit('')).toBe(undefined)
  expect(parseExit(undefined)).toBe(undefined)
})

test('a rollout gives its newest task_complete answer only when it is from this run, never an earlier turn', () => {
  const at = (iso: string, answer: string) => line({ timestamp: iso, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: answer } })
  const rollout = [
    at('2026-11-03T10:00:00.000Z', 'First turn.'),
    line({ timestamp: '2026-11-03T10:05:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'And now?' } }),
    at('2026-11-03T10:06:00.000Z', 'Second turn.'),
    '{"timestamp":"2026-11-03T10:07',
  ].join('')
  expect(lastAnswerOf(rollout, Date.parse('2026-11-03T10:05:00.000Z'))).toBe('Second turn.')
  // A follow-up started at 10:07 that died has no answer of its own: the 10:06 one is the earlier turn's.
  expect(lastAnswerOf(rollout, Date.parse('2026-11-03T10:07:00.000Z'))).toBe(undefined)
  expect(lastAnswerOf('', 0)).toBe(undefined)
})
