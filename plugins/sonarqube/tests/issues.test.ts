import { expect, test } from 'claude-code/testing'
import { htmlText, issue, issues, rule } from '../hooks/issues'
import { fakeCtx, parsed } from './fake-api'

const ISSUE = {
  key: 'AY1',
  rule: 'kotlin:S3776',
  severity: 'CRITICAL',
  component: 'app:src/Main.kt',
  project: 'app',
  line: 239,
  hash: 'h',
  textRange: { startLine: 239, endLine: 241, startOffset: 16, endOffset: 43 },
  flows: [{ locations: [] }],
  status: 'OPEN',
  message: 'Refactor this function.',
  effort: '9min',
  tags: ['brain-overload'],
  author: 'dev@example.com',
  creationDate: '2026-10-05T18:19:25+0000',
  type: 'CODE_SMELL',
}

const SHAPED = {
  key: 'AY1',
  rule: 'kotlin:S3776',
  severity: 'CRITICAL',
  type: 'CODE_SMELL',
  status: 'OPEN',
  project: 'app',
  component: 'app:src/Main.kt',
  line: 239,
  endLine: 241,
  message: 'Refactor this function.',
  effort: '9min',
  tags: ['brain-overload'],
  author: 'dev@example.com',
  creationDate: '2026-10-05T18:19:25+0000',
}

test('issues lists open issues by default, paged, without flows or hashes', async () => {
  const { ctx, calls } = fakeCtx({ issues: { total: 88, p: 1, ps: 20, issues: [ISSUE] } })

  const answer = parsed(await issues(ctx, { projectKey: 'app' }))

  expect(calls).toEqual([{ endpoint: 'issues', params: { componentKeys: 'app', p: 1, ps: 20, statuses: 'OPEN,CONFIRMED,REOPENED' } }])
  expect(answer).toEqual({ projectKey: 'app', total: 88, page: 1, pageSize: 20, issues: [SHAPED] })
})

test('issues passes statuses, severities, type, paging and scope, upper-casing the filters', async () => {
  const { ctx, calls } = fakeCtx({ issues: { total: 0, p: 2, ps: 50, issues: [] } })

  await issues(ctx, { projectKey: 'app', statuses: ['resolved'], severities: ['blocker', 'CRITICAL'], type: 'bug', page: 2, pageSize: 50, pullRequest: '259' })

  expect(calls[0]!.params).toEqual({ componentKeys: 'app', p: 2, ps: 50, statuses: 'RESOLVED', severities: 'BLOCKER,CRITICAL', types: 'BUG', pullRequest: '259' })
})

test('issues refuses unknown filters and a page size over 100 before any request', async () => {
  const { ctx, calls } = fakeCtx()

  await expect(issues(ctx, { projectKey: 'app', severities: ['HIGH'] })).rejects.toThrow('severities takes BLOCKER')
  await expect(issues(ctx, { projectKey: 'app', type: 'SECURITY_HOTSPOT' })).rejects.toThrow('type takes BUG')
  await expect(issues(ctx, { projectKey: 'app', pageSize: 101 })).rejects.toThrow('pageSize must be a whole number from 1 to 100')
  await expect(issues(ctx, { projectKey: 'app', page: 0 })).rejects.toThrow('page must be')
  expect(calls).toEqual([])
})

test('issue finds an open issue by key with its project, and answers null when it is resolved, closed or absent', async () => {
  const found = fakeCtx({ issues: { issues: [ISSUE] } })
  expect(parsed(await issue(found.ctx, { issueKey: 'AY1' }))).toEqual({ issue: SHAPED })
  expect(found.calls).toEqual([{ endpoint: 'issues', params: { issues: 'AY1', statuses: 'OPEN,CONFIRMED,REOPENED' } }])

  const absent = fakeCtx({ issues: { issues: [] } })
  expect(parsed(await issue(absent.ctx, { issueKey: 'AY2' }))).toEqual({ issue: null })
})

test('issue of a pull request or branch sends its project, the given or the detected one', async () => {
  const given = fakeCtx({ issues: { issues: [ISSUE] } })
  await issue(given.ctx, { issueKey: 'AY1', projectKey: 'app', pullRequest: '259' })
  expect(given.calls[0]!.params).toEqual({ issues: 'AY1', componentKeys: 'app', statuses: 'OPEN,CONFIRMED,REOPENED', pullRequest: '259' })

  const detected = fakeCtx({ issues: { issues: [] } }, 'from-file')
  await issue(detected.ctx, { issueKey: 'AY1', branch: 'dev' })
  expect(detected.calls[0]!.params).toEqual({ issues: 'AY1', componentKeys: 'from-file', statuses: 'OPEN,CONFIRMED,REOPENED', branch: 'dev' })
})

test('issue needs issueKey', async () => {
  const { ctx, calls } = fakeCtx()

  await expect(issue(ctx, {})).rejects.toThrow('issueKey is required')
  await expect(issue(ctx, { issueKey: '  ' })).rejects.toThrow('issueKey must be a non-empty string')
  expect(calls).toEqual([])
})

test('rule answers its name, type, severity, tags and description as text', async () => {
  const { ctx, calls } = fakeCtx({
    rule: {
      rule: {
        key: 'kotlin:S3776',
        name: 'Cognitive Complexity of functions should not be too high',
        htmlDesc: '<p>Hard to <b>understand</b> &amp; maintain.</p>\n<h2>See</h2>\n<ul>\n  <li> <a href="https://x">Paper</a> </li>\n</ul>',
        severity: 'CRITICAL',
        type: 'CODE_SMELL',
        lang: 'kotlin',
        langName: 'Kotlin',
        tags: ['team'],
        sysTags: ['brain-overload'],
        gapDescription: 'per complexity point over the threshold',
      },
    },
  })

  const answer = parsed(await rule(ctx, { ruleKey: 'kotlin:S3776' }))

  expect(calls).toEqual([{ endpoint: 'rule', params: { key: 'kotlin:S3776' } }])
  expect(answer).toEqual({
    key: 'kotlin:S3776',
    name: 'Cognitive Complexity of functions should not be too high',
    type: 'CODE_SMELL',
    severity: 'CRITICAL',
    language: 'Kotlin',
    tags: ['brain-overload', 'team'],
    effortPer: 'per complexity point over the threshold',
    description: 'Hard to understand & maintain.\n\n## See\n\n- Paper',
  })
})

test('htmlText keeps code as written and decodes entities', () => {
  expect(htmlText('<pre>if (a &lt; b) {\n  x()\n}</pre><p>Use &#39;x&#x27;&nbsp;now</p>')).toBe("if (a < b) {\n  x()\n}\nUse 'x' now")
})
