// A fake SonarQube for the tool modules' tests: a Ctx whose `sonar` answers each endpoint from `answers` and records
// every call, and whose `detect` finds `detected`.
import { SonarError, type Endpoint, type Params } from '../hooks/api'
import type { Ctx } from '../hooks/input'

export type Call = { endpoint: Endpoint; params: Params }

/** Without `params` keys left undefined, as the query omits them. */
const defined = (params: Params = {}): Params => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))

export function fakeCtx(answers: Partial<Record<Endpoint, unknown>> = {}, detected?: string) {
  const calls: Call[] = []
  const ctx: Ctx = {
    sonar: async (endpoint, params) => {
      calls.push({ endpoint, params: defined(params) })
      const answer = answers[endpoint]
      if (answer instanceof SonarError) throw answer
      return answer ?? {}
    },
    detect: async () => (detected ? { key: detected, file: '/proj/sonar-project.properties' } : undefined),
  }
  return { ctx, calls }
}

export const parsed = (text: string) => JSON.parse(text) as Record<string, unknown>
