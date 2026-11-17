import { expect, test } from 'claude-code/testing'
import { NO_PANE, askedMessage, declinedMessage, enqueue, failedMessage, parseQueued, parseRequest, savedMessage } from '../hooks/request'

test('parseRequest keeps a checked request, trimmed and clipped', () => {
  const asked = parseRequest({
    name: 'CF_TOKEN',
    label: '  Cloudflare token  ',
    reason: 'Wrangler deploys the worker',
    steps: ['Open the dashboard', '', 'Copy the token', 'a', 'b', 'c', 'd'],
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    format: '40 characters',
  })

  expect(asked).toEqual({
    name: 'CF_TOKEN',
    label: 'Cloudflare token',
    reason: 'Wrangler deploys the worker',
    steps: ['Open the dashboard', 'Copy the token', 'a', 'b', 'c'],
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    format: '40 characters',
  })
})

test('parseRequest refuses a bad name or a missing label, and drops a url that is not http(s)', () => {
  expect(parseRequest({ label: 'x' })).toHaveProperty('error')
  expect(parseRequest({ name: '../x', label: 'x' })).toHaveProperty('error')
  expect(parseRequest({ name: 'OK' })).toHaveProperty('error')
  expect(parseRequest({ name: 'OK', label: 'x', url: 'javascript:alert(1)' })).toMatchObject({ url: undefined, steps: [], reason: '' })
  expect(parseRequest({ name: 'OK', label: 'x', steps: 'one' })).toMatchObject({ steps: [] })
})

test('enqueue puts the newest last and lets a new request replace an older one of the same name', () => {
  const a = { name: 'A', label: 'a', reason: '', steps: [] }
  const b = { name: 'B', label: 'b', reason: '', steps: [] }
  const a2 = { ...a, label: 'a again' }

  expect(enqueue([a], b)).toEqual([a, b])
  expect(enqueue([a, b], a2)).toEqual([b, a2])
})

test('the messages tell Claude what to do and never carry a value', () => {
  const file = '/h/.claude/secrets/T.0123456789abcdef'

  expect(savedMessage('T', file)).toContain(`"$(cat ${file})"`)
  expect(savedMessage('T', file)).toContain('24 hours')
  expect(declinedMessage('T', 'declined')).toContain('do not retry')
  expect(declinedMessage('T', 'closed the pane')).toContain('closed the pane')
  expect(failedMessage('T')).toContain('Nothing was stored')
  expect(askedMessage('T', true)).toContain('Do not ask for it in chat')
  expect(askedMessage('T', false)).toContain('above the prompt')
})

test('parseQueued checks a queued request file again and drops one that is not a request', () => {
  expect(parseQueued(JSON.stringify({ name: 'CF_TOKEN', label: 'Cloudflare token' }))).toEqual({ name: 'CF_TOKEN', label: 'Cloudflare token', reason: '', steps: [], url: undefined, format: undefined })
  expect(parseQueued(JSON.stringify({ name: '../x', label: 'x' }))).toBeUndefined()
  expect(parseQueued('[1]')).toBeUndefined()
  expect(parseQueued('not json')).toBeUndefined()
})

test('without a card to show, Claude is told not to ask in chat', () => {
  expect(NO_PANE).toContain('Do not ask for the secret in chat')
})
