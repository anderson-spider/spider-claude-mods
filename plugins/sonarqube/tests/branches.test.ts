import { expect, test } from 'claude-code/testing'
import { SonarError } from '../hooks/api'
import { LISTED_MAX, branches } from '../hooks/branches'
import { fakeCtx, parsed } from './fake-api'

const BRANCHES = {
  branches: [
    { name: 'old', isMain: false, type: 'BRANCH', status: { qualityGateStatus: 'OK' }, analysisDate: '2025-01-01T00:00:00+0000' },
    { name: 'master', isMain: true, type: 'BRANCH', status: { qualityGateStatus: 'OK' }, analysisDate: '2024-01-01T00:00:00+0000' },
    { name: 'feature/x', isMain: false, type: 'BRANCH', status: { qualityGateStatus: 'ERROR' }, analysisDate: '2026-06-18T12:37:00+0000' },
  ],
}
const PULL_REQUESTS = {
  pullRequests: [
    { key: '733', title: 'renovate/all', branch: 'renovate/all', base: 'master', target: 'master', status: { qualityGateStatus: 'OK', bugs: 0, vulnerabilities: 0, codeSmells: 0 }, analysisDate: '2025-07-29T18:47:40+0000' },
    { key: '929', title: 'X', branch: 'feature/x', base: 'master', status: { qualityGateStatus: 'ERROR', bugs: 1, vulnerabilities: 0, codeSmells: 2 }, analysisDate: '2026-06-18T12:00:00+0000' },
  ],
}

test('branches lists the main branch first, then the newest analyses, and the pull requests with their gates', async () => {
  const { ctx, calls } = fakeCtx({ branches: BRANCHES, pullRequests: PULL_REQUESTS })

  const answer = parsed(await branches(ctx, { projectKey: 'app' }))

  expect(calls).toEqual([
    { endpoint: 'branches', params: { project: 'app' } },
    { endpoint: 'pullRequests', params: { project: 'app' } },
  ])
  expect(answer).toEqual({
    projectKey: 'app',
    branches: {
      total: 3,
      listed: [
        { name: 'master', isMain: true, qualityGate: 'OK', analysisDate: '2024-01-01T00:00:00+0000' },
        { name: 'feature/x', qualityGate: 'ERROR', analysisDate: '2026-06-18T12:37:00+0000' },
        { name: 'old', qualityGate: 'OK', analysisDate: '2025-01-01T00:00:00+0000' },
      ],
    },
    pullRequests: {
      total: 2,
      listed: [
        { key: '929', title: 'X', branch: 'feature/x', target: 'master', qualityGate: 'ERROR', bugs: 1, vulnerabilities: 0, codeSmells: 2, analysisDate: '2026-06-18T12:00:00+0000' },
        { key: '733', title: 'renovate/all', branch: 'renovate/all', target: 'master', qualityGate: 'OK', bugs: 0, vulnerabilities: 0, codeSmells: 0, analysisDate: '2025-07-29T18:47:40+0000' },
      ],
    },
  })
})

test('branch keeps only that branch and the pull requests from it', async () => {
  const { ctx } = fakeCtx({ branches: BRANCHES, pullRequests: PULL_REQUESTS })

  const answer = parsed(await branches(ctx, { projectKey: 'app', branch: 'feature/x' })) as { branches: { listed: { name: string }[] }; pullRequests: { listed: { key: string }[] } }

  expect(answer.branches.listed.map((b) => b.name)).toEqual(['feature/x'])
  expect(answer.pullRequests.listed.map((p) => p.key)).toEqual(['929'])
})

test(`branches lists at most ${LISTED_MAX} of each, and says why pull requests are missing when the server refuses them`, async () => {
  const many = { branches: Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, analysisDate: `2026-01-${String(i % 28 + 1).padStart(2, '0')}` })) }
  const { ctx } = fakeCtx({ branches: many, pullRequests: new SonarError('Not found in SonarQube (HTTP 404): /api/project_pull_requests/list') })

  const answer = parsed(await branches(ctx, { projectKey: 'app' })) as { branches: { total: number; listed: unknown[] }; pullRequests: unknown }

  expect(answer.branches.total).toBe(40)
  expect(answer.branches.listed.length).toBe(LISTED_MAX)
  expect(answer.pullRequests).toEqual({ error: 'Not found in SonarQube (HTTP 404): /api/project_pull_requests/list' })
})
