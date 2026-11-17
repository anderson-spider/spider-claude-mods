// What a call needs from outside, on Node: git and ssh as processes in the session's folder, fetch, the environment,
// the repository's settings files and a clock whose waits keep the call alive.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fetch, FetchResponse } from './api.ts'
import type { Deps } from './run.ts'

/** A process's exit code and output; one that cannot start or times out exits non-zero with what it printed. */
function processRun(command: string, timeoutMs: number, cwd?: string) {
  return (args: string[]) => new Promise<{ exitCode: number; stdout: string }>(resolve => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ exitCode: code, stdout: stdout ?? '' })
    })
  })
}

const REDIRECTS = 3

/**
 * fetch, its headers as a lowercase map (where `x-next-page` is read). A redirect (a job log in object storage) is
 * followed by hand, a few hops at most: the token goes on only to the host it was sent to.
 */
export const nodeFetch = async (url: string, init: Parameters<Fetch>[1], fetcher: typeof fetch = fetch): Promise<FetchResponse> => {
  const origin = new URL(url).origin
  let at = url
  let response = await fetcher(at, { method: init.method, headers: init.headers, body: init.body, redirect: 'manual' })
  for (let hop = 0; hop < REDIRECTS && response.status >= 300 && response.status < 400 && response.headers.get('location'); hop++) {
    at = new URL(response.headers.get('location')!, at).toString()
    const headers = new URL(at).origin === origin ? init.headers : Object.fromEntries(Object.entries(init.headers).filter(([name]) => name.toLowerCase() !== 'private-token'))
    response = await fetcher(at, { method: 'GET', headers, redirect: 'manual' })
  }
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return { status: response.status, ok: response.ok, text: await response.text(), headers }
}

/**
 * One settings source of the repository at `cwd`: `.claude/settings.json` (project) or `.claude/settings.local.json`
 * (local). A missing file declares nothing; one that cannot be read or parsed rejects, so the tokens are refused.
 */
export function settingsAt(cwd: string, read: (path: string) => Promise<string> = path => readFile(path, 'utf8')): Deps['settings'] {
  return async source => {
    const path = join(cwd, '.claude', source === 'project' ? 'settings.json' : 'settings.local.json')
    let text: string
    try {
      text = await read(path)
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return undefined
      throw err
    }
    const settings = JSON.parse(text) as { pluginConfigs?: unknown; env?: unknown } | null
    return { pluginConfigs: settings?.pluginConfigs, env: settings?.env }
  }
}

/** The deps of one call in `cwd`; `beat` runs before each wait, which keeps a long call alive. */
export function nodeDeps(cwd: string, beat: () => void): Deps {
  return {
    git: processRun('git', 10_000, cwd),
    ssh: processRun('ssh', 5_000, cwd),
    fetch: nodeFetch,
    env: async name => process.env[name],
    settings: settingsAt(cwd),
    clock: {
      now: () => Date.now(),
      sleep: ms => {
        beat()
        return new Promise(resolve => setTimeout(resolve, ms))
      },
    },
  }
}
