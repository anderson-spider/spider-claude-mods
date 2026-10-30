import { expect, test } from 'claude-code/testing'
import { hotspots } from '../hooks/hotspots'
import { fakeCtx, parsed } from './fake-api'

const HOTSPOT = {
  key: 'H1',
  component: 'app:src/WebView.kt',
  project: 'app',
  securityCategory: 'xss',
  vulnerabilityProbability: 'HIGH',
  status: 'TO_REVIEW',
  line: 32,
  message: 'Make sure that enabling JavaScript support is safe here.',
  assignee: 'x',
  author: 'dev@example.com',
}

test('hotspots lists those to review by default, paged', async () => {
  const { ctx, calls } = fakeCtx({ hotspots: { paging: { pageIndex: 1, pageSize: 20, total: 11 }, hotspots: [HOTSPOT] } })

  const answer = parsed(await hotspots(ctx, { projectKey: 'app' }))

  expect(calls).toEqual([{ endpoint: 'hotspots', params: { projectKey: 'app', status: 'TO_REVIEW', p: 1, ps: 20 } }])
  expect(answer).toEqual({
    projectKey: 'app',
    status: 'TO_REVIEW',
    total: 11,
    page: 1,
    pageSize: 20,
    hotspots: [
      {
        key: 'H1',
        component: 'app:src/WebView.kt',
        line: 32,
        message: 'Make sure that enabling JavaScript support is safe here.',
        vulnerabilityProbability: 'HIGH',
        securityCategory: 'xss',
        status: 'TO_REVIEW',
      },
    ],
  })
})

test('hotspots passes REVIEWED and the scope, and refuses another status before any request', async () => {
  const { ctx, calls } = fakeCtx()

  await hotspots(ctx, { projectKey: 'app', status: 'reviewed', branch: 'dev', page: 3, pageSize: 5 })
  expect(calls[0]!.params).toEqual({ projectKey: 'app', status: 'REVIEWED', p: 3, ps: 5, branch: 'dev' })

  await expect(hotspots(ctx, { projectKey: 'app', status: 'SAFE' })).rejects.toThrow('status takes TO_REVIEW, REVIEWED')
  expect(calls.length).toBe(1)
})
