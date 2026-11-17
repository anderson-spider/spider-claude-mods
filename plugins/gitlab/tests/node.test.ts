import { nodeFetch, settingsAt } from '../server/node.ts'
import { expect, test } from './expect.ts'

const TOKEN = 'glpat-work-123'
const HEADERS = { 'PRIVATE-TOKEN': TOKEN, Accept: 'application/json' }

/** A fetch that answers `answers[url]` and records each request's url and token. */
function network(answers: Record<string, { status: number; location?: string; body?: string }>) {
  const seen: { url: string; token?: string }[] = []
  const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, token: init.headers['PRIVATE-TOKEN'] })
    const answer = answers[url] ?? { status: 404 }
    return new Response(answer.body ?? '', { status: answer.status, headers: answer.location ? { location: answer.location, 'X-Next-Page': '2' } : { 'X-Next-Page': '2' } })
  }) as unknown as typeof fetch
  return { seen, fetcher }
}

test('a redirect on the same host keeps the token, one to another host drops it, and headers come back lowercase', async () => {
  const { seen, fetcher } = network({
    'https://gitlab.example.com/api/v4/projects/1/jobs/2/trace': { status: 302, location: '/raw/2' },
    'https://gitlab.example.com/raw/2': { status: 302, location: 'https://storage.example.net/log?sig=x' },
    'https://storage.example.net/log?sig=x': { status: 200, body: 'log text' },
  })
  const response = await nodeFetch('https://gitlab.example.com/api/v4/projects/1/jobs/2/trace', { method: 'GET', headers: HEADERS }, fetcher)

  expect(response).toMatchObject({ status: 200, ok: true, text: 'log text', headers: { 'x-next-page': '2' } })
  expect(seen).toEqual([
    { url: 'https://gitlab.example.com/api/v4/projects/1/jobs/2/trace', token: TOKEN },
    { url: 'https://gitlab.example.com/raw/2', token: TOKEN },
    { url: 'https://storage.example.net/log?sig=x' },
  ])
})

test('redirects stop after three hops, answering the last one as it came', async () => {
  const hop = (n: number) => ({ status: 302, location: `https://gitlab.example.com/${n + 1}` })
  const { seen, fetcher } = network({ 'https://gitlab.example.com/0': hop(0), 'https://gitlab.example.com/1': hop(1), 'https://gitlab.example.com/2': hop(2), 'https://gitlab.example.com/3': hop(3) })
  const response = await nodeFetch('https://gitlab.example.com/0', { method: 'GET', headers: HEADERS }, fetcher)
  expect(response.status).toBe(302)
  expect(seen).toHaveLength(4)
})

test("the repository's settings: a missing file declares nothing, a broken one refuses, and only pluginConfigs and env are kept", async () => {
  const files: Record<string, string> = {
    '/repo/.claude/settings.json': JSON.stringify({ pluginConfigs: { gitlab: { options: { tokens: 'x' } } }, env: { A: '1' }, permissions: {} }),
    '/broken/.claude/settings.local.json': '{ not json',
  }
  const read = async (path: string) => {
    if (path in files) return files[path]!
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
  expect(await settingsAt('/repo', read)('project')).toEqual({ pluginConfigs: { gitlab: { options: { tokens: 'x' } } }, env: { A: '1' } })
  expect(await settingsAt('/repo', read)('local')).toBeUndefined()
  await expect(settingsAt('/broken', read)('local')).rejects.toThrow()
  const denied = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  await expect(settingsAt('/repo', denied)('project')).rejects.toThrow('denied')
})
