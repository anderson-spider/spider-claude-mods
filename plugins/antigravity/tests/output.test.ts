import { expect, test } from 'claude-code/testing'
import { findingsOf, reviewMarkdown } from '../hooks/output'

test('findings come most severe first, with paths relative to the repository, whether agy named them in its worktree or with ./', () => {
  const findings = findingsOf(
    {
      findings: [
        { priority: 'P3', title: ' Typo ', path: '/tmp/agy/worktrees/j1/docs/a.md', line: 1, detail: 'Spelled wrong.' },
        { priority: 'P0', title: 'Data loss', path: './src/db.ts', line: 40, detail: 'Deletes every row.' },
      ],
    },
    '/tmp/agy/worktrees/j1',
  )
  expect(findings).toEqual([
    { priority: 'P0', title: 'Data loss', path: 'src/db.ts', line: 40, detail: 'Deletes every row.' },
    { priority: 'P3', title: 'Typo', path: 'docs/a.md', line: 1, detail: 'Spelled wrong.' },
  ])
  expect(reviewMarkdown(findings!)).toBe('[P0] Data loss — src/db.ts:40\nDeletes every row.\n\n[P3] Typo — docs/a.md:1\nSpelled wrong.')
  expect(reviewMarkdown([])).toBe('No findings.')
})

test('output that is not the review schema gives no findings, so the review keeps agy\'s text', () => {
  expect(findingsOf(undefined)).toBeUndefined()
  expect(findingsOf({ findings: 'none' })).toBeUndefined()
  expect(findingsOf({ findings: [{ priority: 'P9', title: 't', path: 'a', line: 1, detail: '' }] })).toBeUndefined()
  expect(findingsOf({ findings: [{ priority: 'P1', title: 't', path: 'a', line: 0, detail: '' }] })).toBeUndefined()
  expect(findingsOf({ findings: [] })).toEqual([])
})
