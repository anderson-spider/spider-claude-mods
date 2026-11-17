// What the plugin does, on either side: the MCP server answers the tools (server/main.mjs), the hooks module the
// commands and the watch on background jobs (register.tsx). Pure: each side hands in its host.
import { ROOT_CHECK, detachedRuns } from './detached'
import { diagnose, report } from './doctor'
import { askRequestOf, commandRequestOf, imageRequestOf, placementError, reviewRequestOf } from './input'
import { fileStore } from './jobs'
import { locateAgy } from './locate'
import type { Entry, JobStore, Outcome, ProcessRunner, Request } from './model'
import { answerOf, askCommandAnswer, errorText, failure, imageCommandAnswer, notPrivate, startedJob } from './presentation'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION, REVIEW_DESCRIPTION } from './prompts'
import { resolveReview, reviewCommandInput } from './review'
import { createRunner, type RunnerDeps } from './runner'
import {
  ASK_INPUT_SCHEMA,
  ASK_USAGE,
  IMAGE_INPUT_SCHEMA,
  IMAGE_USAGE,
  JOBS_DESCRIPTION,
  JOBS_INPUT_SCHEMA,
  REVIEW_INPUT_SCHEMA,
  REVIEW_USAGE,
} from './tool-schemas'
import { workspaces } from './workspace'

/** What a side gives the plugin: processes, files and the session, and, in the hooks module only, the UI and new turns. */
export type Host = {
  run: ProcessRunner
  /** The one environment variables the plugin reads. */
  env(name: 'TMPDIR' | 'HOME' | 'PATH'): Promise<string | undefined>
  exists(path: string): Promise<boolean>
  /** A text file's content, or undefined when there is none. */
  read(path: string): Promise<string | undefined>
  readBytes(path: string): Promise<{ base64: string }>
  write(path: string, text: string): Promise<void>
  /** A folder's entries; rejects when it is missing. */
  list(path: string): Promise<Entry[]>
  sessionId(): Promise<string>
  /** The session's folder: an ask runs there, and jobs are listed and taken over within one project. */
  project(): string
  /** The Claude Code process this side runs for, or undefined when it is not known. */
  pid(): number | undefined
  /** Waits; the hooks module waits through a host process, which does not use up a hook's clock budget as a timer would. */
  sleep(ms: number): Promise<unknown>
  status?(text: string | undefined): void
  toast?(text: string): void
  /** A new turn for a job's end notice: the hooks module's alone (runner.ts hands the server's jobs off to it). */
  submit?(text: string): Promise<unknown>
}

export type Settings = { foregroundMs: number; backgroundMs: number; agyPath?: string; defaultModel?: string }

/** A tool's answer: its text (an image's previews after it), an error when isError. */
export type ToolAnswer = ReturnType<typeof answerOf> | { result: string; isError?: true }

/** The tools the MCP server lists, by their short names. */
export const TOOLS = [
  { name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_INPUT_SCHEMA },
  { name: 'image', description: IMAGE_DESCRIPTION, inputSchema: IMAGE_INPUT_SCHEMA },
  { name: 'review', description: REVIEW_DESCRIPTION, inputSchema: REVIEW_INPUT_SCHEMA },
  { name: 'jobs', description: JOBS_DESCRIPTION, inputSchema: JOBS_INPUT_SCHEMA },
] as const

export type ToolName = (typeof TOOLS)[number]['name']

const STATUS = 'agy is working'

export function createService(settings: () => Settings) {
  const runner = createRunner(() => settings())

  // The user's id, kept once read: without TMPDIR the plugin's folder is named by it, away from other users' in /tmp.
  // A failed read is tried again next time; meanwhile the folder is the bare name, which ROOT_CHECK still guards.
  let uid: string | undefined
  // Runs this side waits on in the foreground, and whether the status line says so now.
  let active = 0
  let shown = false

  async function uidOf(host: Host): Promise<string | undefined> {
    if (uid) return uid
    const done = await host.run(['id', '-u'], { timeoutMs: 5_000 }).catch(() => undefined)
    const id = done?.exitCode === 0 ? done.stdout.trim() : ''
    if (/^\d+$/.test(id)) uid = id
    return uid
  }

  async function folders(host: Host) {
    const tmp = (await host.env('TMPDIR'))?.replace(/\/$/, '')
    const id = tmp ? undefined : await uidOf(host)
    const outDir = tmp ? `${tmp}/agy` : `/tmp/agy${id ? `-${id}` : ''}`
    const home = await host.env('HOME')
    // Where agy keeps each conversation's artifacts folder, the images its image-generator subagent makes among them;
    // without HOME there is none to find, and an image run says it found no image.
    return { outDir, home, artifactsRoot: home ? `${home}/.gemini/antigravity-cli/brain` : '' }
  }

  async function agyOf(host: Host, home: string | undefined) {
    return locateAgy(settings().agyPath, { exists: path => host.exists(path), path: await host.env('PATH'), home })
  }

  /** The jobs, kept as files both sides share. */
  async function storeOf(host: Host): Promise<JobStore> {
    const { outDir } = await folders(host)
    return fileStore({ run: host.run, read: host.read, list: async path => (await host.list(path)).map(entry => entry.name) }, outDir, `${outDir}/jobs`)
  }

  async function depsOf(host: Host): Promise<RunnerDeps> {
    const run = host.run
    const { outDir, home, artifactsRoot } = await folders(host)
    const pid = host.pid()
    return {
      files: detachedRuns({ run, read: host.read, exists: host.exists }),
      store: await storeOf(host),
      workspaces: workspaces({ run, list: async path => (await host.list(path)).map(entry => entry.name), dir: `${outDir}/worktrees`, workDir: `${outDir}/.work` }),
      sessionId: host.sessionId,
      project: async () => host.project(),
      runsDir: `${outDir}/runs`,
      sleep: host.sleep,
      output: { write: host.write, outDir, artifactsRoot, list: host.list, run, readBytes: host.readBytes },
      agy: () => agyOf(host, home),
      ...(pid !== undefined ? { pid } : {}),
      toast: text => host.toast?.(text),
      ...(host.submit ? { submit: host.submit } : {}),
    }
  }

  /** The model ids `agy models` lists (its first column), or why they could not be read. */
  async function modelsOf(host: Host, agy: string): Promise<string[] | { error: string }> {
    try {
      const done = await host.run([agy, 'models'], { timeoutMs: 30_000 })
      if (done.exitCode !== 0) return { error: (done.stderr.trim() || done.stdout.trim()).split('\n')[0] || `exit code ${done.exitCode}` }
      return done.stdout.split('\n').flatMap(text => (text.includes('\t') ? [text.split('\t')[0]!.trim()] : []))
    } catch (error) {
      return { error: errorText(error) }
    }
  }

  /** A request whose model `agy models` lists, or the error that names the valid ids; a request without one passes. */
  async function checkedModel(host: Host, request: Request): Promise<Request | string> {
    if (!request.model) return request
    const agy = await agyOf(host, (await folders(host)).home)
    if (typeof agy !== 'string') return agy.error
    const models = await modelsOf(host, agy)
    if (!Array.isArray(models)) return `agy could not list its models (${models.error}), so the run did not start.`
    return models.includes(request.model) ? request : `${request.model} is not an agy model id. agy models lists: ${models.join(', ')}.`
  }

  async function placed(host: Host, request: Request): Promise<Request | string> {
    const { outDir, home } = await folders(host)
    const misplaced = placementError(request, { project: host.project(), outDir, home })
    if (misplaced) return misplaced
    const root = await host.run(['sh', '-c', ROOT_CHECK, 'sh', outDir], { timeoutMs: 10_000 })
    if (root.exitCode !== 0) return notPrivate(outDir)
    return checkedModel(host, request)
  }

  /**
   * A request ready to run, or the error to answer: its files and answer where they may be (placementError), the
   * plugin's folder private to the user (ROOT_CHECK, before anything is written there), and its model one agy lists.
   */
  async function readyOf(host: Host, request: Request | string): Promise<Request | string> {
    if (typeof request === 'string') return request
    try {
      return await placed(host, request)
    } catch (error) {
      return `The agy run did not start: ${errorText(error)}`
    }
  }

  // The status line says a run is going while one is waited on here, or (`pickUp`) by this process's MCP server.
  function showStatus(host: Host, elsewhere: boolean) {
    const now = active > 0 || elsewhere
    if (now === shown) return
    shown = now
    host.status?.(now ? STATUS : undefined)
  }

  async function runNow(host: Host, request: Request): Promise<Outcome> {
    active++
    showStatus(host, false)
    try {
      return await runner.runNow(await depsOf(host), request)
    } catch (error) {
      return failure(`The agy run failed: ${errorText(error)}`)
    } finally {
      active--
      showStatus(host, false)
    }
  }

  /** A review's request, made runnable in the session's repository, or the error to answer. */
  async function reviewOf(host: Host, input: Record<string, unknown>): Promise<Request | string> {
    const request = reviewRequestOf(input, settings().defaultModel)
    if (typeof request === 'string') return request
    return resolveReview(request, async args => {
      const done = await host.run(['git', '-C', host.project(), ...args], { timeoutMs: 10_000 })
      return { exitCode: done.exitCode, stdout: done.stdout }
    })
  }

  async function serve(host: Host, request: Request | string, wait: unknown): Promise<ToolAnswer> {
    const checked = await readyOf(host, request)
    if (typeof checked === 'string') return { result: checked, isError: true }
    if (wait === false) {
      const job = await runner.startJob(await depsOf(host), checked)
      if ('ok' in job) return answerOf(job)
      return { result: startedJob(job) }
    }
    return answerOf(await runNow(host, checked))
  }

  return {
    /** Answers a tool call. */
    async tool(host: Host, name: ToolName, input: Record<string, unknown>): Promise<ToolAnswer> {
      const model = settings().defaultModel
      if (name === 'ask') return serve(host, askRequestOf(input, model), input.wait)
      if (name === 'image') return serve(host, imageRequestOf(input, model), input.wait)
      if (name === 'review') return serve(host, await reviewOf(host, input), input.wait)
      return { result: await runner.report(await depsOf(host)) }
    },

    async ask(host: Host, args: string) {
      const checked = await readyOf(host, commandRequestOf(args, ASK_USAGE, settings().defaultModel))
      if (typeof checked === 'string') return { text: checked }
      return askCommandAnswer(await runNow(host, checked))
    },

    async image(host: Host, args: string) {
      const checked = await readyOf(host, commandRequestOf(args, IMAGE_USAGE, settings().defaultModel, 'image'))
      if (typeof checked === 'string') return { text: checked }
      return imageCommandAnswer(await runNow(host, checked))
    },

    async review(host: Host, args: string) {
      const input = reviewCommandInput(args)
      if (!input) return { text: REVIEW_USAGE }
      const checked = await readyOf(host, await reviewOf(host, input))
      if (typeof checked === 'string') return { text: checked }
      const job = await runner.startJob(await depsOf(host), checked)
      return { text: 'ok' in job ? job.text : startedJob(job) }
    },

    async doctor(host: Host) {
      const { home, artifactsRoot } = await folders(host)
      const artifacts = artifactsRoot ? { path: artifactsRoot, exists: await host.exists(artifactsRoot) } : { path: 'HOME is not set, so agy’s artifacts folder', exists: false }
      const checks = await diagnose({ agy: await agyOf(host, home), run: host.run, models: agy => modelsOf(host, agy), artifacts })
      return { text: report(checks) }
    },

    /** At session start: jobs of an earlier version (in `old`, `$.store`) move to the files, then the runner resumes. */
    async resume(host: Host, old?: JobStore) {
      if (old) {
        const store = await storeOf(host)
        for (const key of (await old.keys()).filter(key => key.startsWith('job:'))) {
          const job = await old.get(key)
          if (job !== undefined && (await store.get(key)) === undefined) await store.set(key, job)
          await old.delete(key)
        }
      }
      await runner.resume(await depsOf(host))
    },

    /** Every few seconds in the hooks module: takes the server's handed-off jobs, and keeps the status line true. */
    async pickUp(host: Host) {
      const { foreground } = await runner.pickUp(await depsOf(host))
      showStatus(host, foreground)
    },
  }
}

export type Service = ReturnType<typeof createService>
