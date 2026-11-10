import { expect, test } from 'claude-code/testing'
import { argsOf } from '../hooks/args'
import { isAgyRun } from '../hooks/detached'

test('the process carrying the plugin’s print-mode flags counts as the run, whatever the executable is called', () => {
  const args = argsOf({ kind: 'ask', prompt: 'hello', files: [] }, { cwd: '/proj' }, 600_000).join(' ')
  expect(isAgyRun(`/Users/me/.local/bin/agy ${args}`)).toBe(true)
  expect(isAgyRun(`node /opt/tools/agy-nightly ${args}`)).toBe(true)
  expect(isAgyRun('/Users/me/.local/bin/agy --output-format=stream-json --print=hello')).toBe(false)
  expect(isAgyRun('/usr/bin/vim notes.md')).toBe(false)
  expect(isAgyRun('')).toBe(false)
})
