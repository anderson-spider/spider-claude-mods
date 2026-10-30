// sonarqube_branches: a project's analyzed branches and pull requests, with the gate of each, newest analysis first.
import { SonarError } from './api'
import { type Ctx, type Input, arrayOf, isObject, json, projectKey, text } from './input'

/** How many branches and how many pull requests an answer lists. */
export const LISTED_MAX = 30

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const newestFirst = (a: { analysisDate?: string }, b: { analysisDate?: string }) => (b.analysisDate ?? '').localeCompare(a.analysisDate ?? '')

export async function branches(ctx: Ctx, input: Input): Promise<string> {
  const named = text(input, 'branch')
  const key = await projectKey(ctx, input)
  const branchData = await ctx.sonar('branches', { project: key })
  const all = arrayOf(branchData, 'branches')
    .filter(isObject)
    .map((b) => {
      const status = isObject(b.status) ? b.status : {}
      return { name: str(b.name), ...(b.isMain === true ? { isMain: true } : {}), qualityGate: str(status.qualityGateStatus), analysisDate: str(b.analysisDate) }
    })
    .filter((b) => named === undefined || b.name === named)
    .sort(newestFirst)
  // the main branch is listed whatever its date, so the answer always names it
  const main = all.find((b) => b.isMain)
  const listed = [...(main ? [main] : []), ...all.filter((b) => b !== main)].slice(0, LISTED_MAX)

  // pull requests need a commercial edition: their absence is said, not an error
  let pullRequests: unknown
  try {
    const prs = arrayOf(await ctx.sonar('pullRequests', { project: key }), 'pullRequests')
      .filter(isObject)
      .map((p) => {
        const status = isObject(p.status) ? p.status : {}
        const count = (name: string) => (typeof status[name] === 'number' ? status[name] : undefined)
        return {
          key: str(p.key),
          title: str(p.title),
          branch: str(p.branch),
          target: str(p.target) ?? str(p.base),
          qualityGate: str(status.qualityGateStatus),
          bugs: count('bugs'),
          vulnerabilities: count('vulnerabilities'),
          codeSmells: count('codeSmells'),
          analysisDate: str(p.analysisDate),
        }
      })
      .filter((p) => named === undefined || p.branch === named)
      .sort(newestFirst)
    pullRequests = { total: prs.length, listed: prs.slice(0, LISTED_MAX) }
  } catch (error) {
    if (!(error instanceof SonarError)) throw error
    pullRequests = { error: error.message }
  }

  return json({ projectKey: key, ...(named ? { branch: named } : {}), branches: { total: all.length, listed }, pullRequests })
}
