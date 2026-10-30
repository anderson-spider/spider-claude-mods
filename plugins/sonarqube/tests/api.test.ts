import { expect, test } from 'claude-code/testing'
import { SonarError, sonar, urlOf, type Fetch } from '../hooks/api'

type Sent = { url: string; headers: Record<string, string> }

function fake(status: number, text: string) {
  const sent: Sent[] = []
  const fetch: Fetch = async (url, init) => (sent.push({ url, headers: init.headers }), { status, ok: status < 400, text })
  return { sent, fetch }
}

test('the query holds the set params only, under the fixed endpoint', () => {
  expect(urlOf('https://s.example.com/sonar', 'issues', { componentKeys: 'a b', p: 2, types: undefined })).toBe('https://s.example.com/sonar/api/issues/search?componentKeys=a+b&p=2')
  expect(urlOf('https://s.example.com', 'rule')).toBe('https://s.example.com/api/rules/show')
})

test('the token goes only in the Authorization header, as Basic token-colon', async () => {
  const { sent, fetch } = fake(200, '{"ok":1}')

  expect(await sonar(fetch, 'https://s.example.com', 'squ_x')('rule', { key: 'k' })).toEqual({ ok: 1 })
  expect(sent).toEqual([{ url: 'https://s.example.com/api/rules/show?key=k', headers: { Authorization: `Basic ${btoa('squ_x:')}`, Accept: 'application/json' } }])
})

test('errors become SonarError: refused token, not found with the API message, other statuses, no JSON, no answer', async () => {
  const call = (status: number, text: string) => sonar(fake(status, text).fetch, 'https://s.example.com', 't')('issues').catch((e: unknown) => e)

  const refused = await call(401, '')
  expect(refused).toBeInstanceOf(SonarError)
  expect((refused as Error).message).toContain('refused the token (HTTP 401)')
  expect(((await call(403, '')) as Error).message).toContain('HTTP 403')
  expect(((await call(404, '{"errors":[{"msg":"Component key \'x\' not found"}]}')) as Error).message).toBe("Not found in SonarQube (HTTP 404): Component key 'x' not found")
  expect(((await call(400, '{"errors":[{"msg":"a"},{"msg":"b"}]}')) as Error).message).toBe('SonarQube answered HTTP 400: a; b')
  expect(((await call(500, 'x'.repeat(900))) as Error).message).toBe(`SonarQube answered HTTP 500: ${'x'.repeat(500)}`)
  expect(((await call(200, '<html>')) as Error).message).toBe('SonarQube answered HTTP 200 with no JSON: <html>')

  const down = await sonar(async () => Promise.reject(new Error('ECONNREFUSED')), 'https://s.example.com', 't')('issues').catch((e: unknown) => e)
  expect(down).toBeInstanceOf(SonarError)
  expect((down as Error).message).toBe('The SonarQube server did not answer: ECONNREFUSED')
})
