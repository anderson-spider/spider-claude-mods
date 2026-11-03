import { expect, test } from 'claude-code/testing'
import { IMAGE_PREFIX, THREAD_SOURCE, argsOf, promptOf } from '../hooks/args'
import type { Request } from '../hooks/model'

const THREAD = '01a1a17a-b0ba-7770-b825-59aacf6e9f6d'
const ask = (more: Partial<Request> = {}): Request => ({ kind: 'ask', prompt: 'Review it', images: [], files: [], ...more })

test('a new ask runs read-only, never asks for approval, searches the web and records its source', () => {
  expect(argsOf(ask())).toEqual([
    'exec', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'web_search="live"',
    '--thread-source', THREAD_SOURCE, '--', 'Review it',
  ])
})

test('model, effort and images come before the end of the options; a folder is named with -C', () => {
  const args = argsOf(ask({ model: 'gpt-6', effort: 'low', images: ['/a.png', '/b.jpg'] }), '/work')
  expect(args.slice(args.indexOf('-m'), args.indexOf('--thread-source'))).toEqual([
    '-m', 'gpt-6', '-c', 'model_reasoning_effort="low"', '--image', '/a.png', '--image', '/b.jpg',
  ])
  expect(args.slice(-4)).toEqual(['-C', '/work', '--', 'Review it'])
})

test('a follow-up resumes its thread, keeps the read-only lock and takes no folder or source', () => {
  const args = argsOf(ask({ threadId: THREAD }), '/work')
  expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
  expect(args).toContain('sandbox_mode="read-only"')
  expect(args).not.toContain('-C')
  expect(args).not.toContain('--thread-source')
  expect(args.slice(-3)).toEqual(['--', THREAD, 'Review it'])
})

test('an image run leaves web search out and is told to draw', () => {
  const request: Request = { kind: 'image', prompt: 'A red fox', images: [], files: [] }
  expect(argsOf(request, '/work')).toContain('web_search="disabled"')
  expect(promptOf(request)).toBe(`${IMAGE_PREFIX}A red fox`)
})

test('the files Codex should read are listed after the prompt', () => {
  expect(promptOf(ask({ files: ['/repo/a.ts', '/repo/b.md'] }))).toBe('Review it\n\nFiles to read (absolute paths):\n- /repo/a.ts\n- /repo/b.md')
})
