import { expect, test } from 'claude-code/testing'
import { InputError } from '../hooks/input'
import { measures, qualityGate } from '../hooks/quality'
import { fakeCtx, parsed } from './fake-api'

const GATE = {
  projectStatus: {
    status: 'ERROR',
    ignoredConditions: false,
    conditions: [
      { status: 'ERROR', metricKey: 'new_branch_coverage', comparator: 'LT', periodIndex: 1, errorThreshold: '90', actualValue: '83.5' },
      { status: 'OK', metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '0' },
    ],
  },
}

test('the quality gate answers every condition with its actual value and threshold, for the given pull request', async () => {
  const { ctx, calls } = fakeCtx({ qualityGate: GATE })

  const answer = parsed(await qualityGate(ctx, { projectKey: 'app', pullRequest: '259' }))

  expect(calls).toEqual([{ endpoint: 'qualityGate', params: { projectKey: 'app', pullRequest: '259' } }])
  expect(answer).toEqual({
    projectKey: 'app',
    pullRequest: '259',
    status: 'ERROR',
    ignoredConditions: false,
    conditions: [
      { status: 'ERROR', metricKey: 'new_branch_coverage', comparator: 'LT', errorThreshold: '90', actualValue: '83.5' },
      { status: 'OK', metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '0' },
    ],
  })
})

test('branch and pullRequest together are refused before any request', async () => {
  const { ctx, calls } = fakeCtx()

  await expect(qualityGate(ctx, { projectKey: 'app', branch: 'b', pullRequest: '1' })).rejects.toThrow('mutually exclusive')
  expect(calls).toEqual([])
})

test('a call with no projectKey uses the detected one, and is refused when none is found', async () => {
  const detected = fakeCtx({ qualityGate: GATE }, 'from-file')
  await qualityGate(detected.ctx, { branch: 'main' })
  expect(detected.calls[0]!.params).toEqual({ projectKey: 'from-file', branch: 'main' })

  const none = fakeCtx()
  const error = await qualityGate(none.ctx, {}).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(InputError)
  expect((error as Error).message).toContain('Pass projectKey')
  expect(none.calls).toEqual([])
})

test('measures prefer the new-code period value, and list metrics with no value', async () => {
  const { ctx, calls } = fakeCtx({
    measures: {
      component: {
        key: 'app',
        name: 'App',
        measures: [
          { metric: 'new_bugs', periods: [{ index: 1, value: '0' }], period: { index: 1, value: '0', bestValue: true } },
          { metric: 'coverage', value: '97.4', bestValue: false },
        ],
      },
    },
  })

  const answer = parsed(await measures(ctx, { projectKey: 'app', metricKeys: ['new_bugs', 'coverage', 'new_coverage'], branch: 'dev' }))

  expect(calls).toEqual([{ endpoint: 'measures', params: { component: 'app', metricKeys: 'new_bugs,coverage,new_coverage', branch: 'dev' } }])
  expect(answer).toEqual({
    projectKey: 'app',
    name: 'App',
    branch: 'dev',
    measures: [
      { metric: 'new_bugs', value: '0', bestValue: true },
      { metric: 'coverage', value: '97.4', bestValue: false },
    ],
    noValue: ['new_coverage'],
  })
})

test('measures need one to 20 metric keys', async () => {
  const { ctx, calls } = fakeCtx()

  await expect(measures(ctx, { projectKey: 'app' })).rejects.toThrow('metricKeys is required')
  await expect(measures(ctx, { projectKey: 'app', metricKeys: [] })).rejects.toThrow('non-empty list')
  await expect(measures(ctx, { projectKey: 'app', metricKeys: Array.from({ length: 21 }, (_, i) => `m${i}`) })).rejects.toThrow('at most 20')
  expect(calls).toEqual([])
})
