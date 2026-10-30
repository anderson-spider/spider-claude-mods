// The SonarQube Web API client. Pure: fetch is injected. Every request is a GET to one of ENDPOINTS with its query
// built here, so no input chooses a path. The token rides only in the Authorization header, as SonarQube 9.x takes it:
// HTTP Basic with the token as the user and an empty password.

export const ENDPOINTS = {
  qualityGate: '/api/qualitygates/project_status',
  measures: '/api/measures/component',
  issues: '/api/issues/search',
  rule: '/api/rules/show',
  hotspots: '/api/hotspots/search',
  branches: '/api/project_branches/list',
  pullRequests: '/api/project_pull_requests/list',
} as const

export type Endpoint = keyof typeof ENDPOINTS
export type Params = Record<string, string | number | undefined>

type FetchResponse = { status: number; ok: boolean; text: string }

export type Fetch = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<FetchResponse>

/** A call the API answered with an error, or did not answer: its message is the tool's answer. */
export class SonarError extends Error {}

/** Reads one endpoint and returns its parsed JSON. */
export type Sonar = (endpoint: Endpoint, params?: Params) => Promise<unknown>

const BODY_PREVIEW = 500

/** The endpoint's URL under `base`, with the set params in the query. */
export function urlOf(base: string, endpoint: Endpoint, params: Params = {}): string {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, String(value))
  const text = query.toString()
  return `${base}${ENDPOINTS[endpoint]}${text ? `?${text}` : ''}`
}

export function sonar(fetch: Fetch, base: string, token: string): Sonar {
  const headers = { Authorization: `Basic ${btoa(`${token}:`)}`, Accept: 'application/json' }
  return async (endpoint, params) => {
    let response: FetchResponse
    try {
      response = await fetch(urlOf(base, endpoint, params), { method: 'GET', headers })
    } catch (error) {
      throw new SonarError(`The SonarQube server did not answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new SonarError(`SonarQube refused the token (HTTP ${response.status}): check that it is valid and can browse this project.`)
    }
    if (response.status === 404) throw new SonarError(`Not found in SonarQube (HTTP 404): ${apiErrors(response.text) ?? ENDPOINTS[endpoint]}`)
    if (response.status >= 400) {
      throw new SonarError(`SonarQube answered HTTP ${response.status}: ${apiErrors(response.text) ?? response.text.slice(0, BODY_PREVIEW)}`)
    }
    try {
      return JSON.parse(response.text) as unknown
    } catch {
      throw new SonarError(`SonarQube answered HTTP ${response.status} with no JSON: ${response.text.slice(0, BODY_PREVIEW)}`)
    }
  }
}

/** The messages of a SonarQube error body (`{"errors":[{"msg":...}]}`), joined, or undefined for any other body. */
function apiErrors(text: string): string | undefined {
  try {
    const errors = (JSON.parse(text) as { errors?: unknown }).errors
    if (!Array.isArray(errors)) return undefined
    const messages = errors.map((e) => (e as { msg?: unknown } | null)?.msg).filter((m): m is string => typeof m === 'string')
    return messages.length ? messages.join('; ') : undefined
  } catch {
    return undefined
  }
}
