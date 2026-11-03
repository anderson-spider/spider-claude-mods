import { expect, test } from 'claude-code/testing'
import { commandRequestOf, requestOf, reviewRequestOf } from '../hooks/input'

const THREAD = '01a1a17a-b0ba-7770-b825-59aacf6e9f6d'

test('a tool input becomes a request, images among the files going to Codex as images', () => {
  expect(requestOf('ask', { prompt: ' Review ', threadId: THREAD, model: 'gpt-6', effort: 'LOW', files: ['/r/a.ts', '/r/shot.PNG', ''], out: '/o/a.md', maxChars: 10.5 })).toEqual({
    kind: 'ask',
    prompt: 'Review',
    threadId: THREAD,
    model: 'gpt-6',
    effort: 'low',
    images: ['/r/shot.PNG'],
    files: ['/r/a.ts'],
    out: '/o/a.md',
    maxChars: 10,
  })
})

test('an image reference goes first among the images', () => {
  const request = requestOf('image', { prompt: 'p', reference: '/r/ref.webp', files: ['/r/b.png'] })
  expect(typeof request !== 'string' && request.images).toEqual(['/r/ref.webp', '/r/b.png'])
})

test('a bad input is answered before anything runs', () => {
  expect(requestOf('ask', { prompt: ' ' })).toBe('Give a non-empty prompt.')
  expect(requestOf('ask', { prompt: 'p', threadId: 'https://chatgpt.com/c/1' })).toMatch(/is not a Codex thread id/)
  expect(requestOf('ask', { prompt: 'p', model: 'gpt "6"' })).toBe('gpt "6" is not a model name.')
  expect(requestOf('ask', { prompt: 'p', effort: 'very high' })).toMatch(/is not an effort level/)
  expect(requestOf('image', { prompt: 'p', reference: '/r/ref.pdf' })).toBe('/r/ref.pdf must be a PNG, JPEG, WebP or GIF image.')
  expect(requestOf('ask', { prompt: 'p', files: ['a.ts'] })).toBe('a.ts must be an absolute path.')
  expect(requestOf('ask', { prompt: 'p', out: 'a.md' })).toBe('a.md must be an absolute path.')
})

test('a command text is the whole prompt; a blank one answers the usage', () => {
  expect(commandRequestOf('ask', ' why? ', 'usage')).toEqual({ kind: 'ask', prompt: 'why?', images: [], files: [] })
  expect(commandRequestOf('image', '  ', 'usage')).toBe('usage')
})

test('a review input takes one target at most; none means the branch against its default base, resolved later', () => {
  expect(reviewRequestOf({ effort: 'low' })).toEqual({ kind: 'review', prompt: '', images: [], files: [], effort: 'low' })
  expect(reviewRequestOf({ base: ' release/2 ' })).toMatchObject({ review: { base: 'release/2' } })
  expect(reviewRequestOf({ commit: 'ABC1234' })).toMatchObject({ review: { commit: 'ABC1234' } })
  expect(reviewRequestOf({ uncommitted: true })).toMatchObject({ review: { uncommitted: true } })
  expect(reviewRequestOf({ instructions: ' Look for races ' })).toMatchObject({ review: { instructions: 'Look for races' } })
  expect(reviewRequestOf({ commit: 'HEAD~1' })).toMatchObject({ review: { commit: 'HEAD~1' } })
  expect(reviewRequestOf({ commit: 'v1.2.0' })).toMatchObject({ review: { commit: 'v1.2.0' } })
  expect(reviewRequestOf({ base: 'correção' })).toMatchObject({ review: { base: 'correção' } })
})

test('a review input with two targets, or a target Codex could misread, is answered before anything runs', () => {
  expect(reviewRequestOf({ base: 'main', uncommitted: true })).toBe('Give one review target at most: base, commit, uncommitted or instructions (got base, uncommitted).')
  expect(reviewRequestOf({ commit: '-p' })).toBe('-p is not a commit.')
  expect(reviewRequestOf({ commit: 'abc def' })).toBe('abc def is not a commit.')
  expect(reviewRequestOf({ base: '--help' })).toBe('--help is not a branch name.')
  expect(reviewRequestOf({ instructions: '-' })).toBe('Give the review instructions as text; "-" would make Codex read them from stdin.')
  expect(reviewRequestOf({ model: 'gpt "6"' })).toBe('gpt "6" is not a model name.')
})
