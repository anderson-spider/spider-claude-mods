// The wiring every tool shares: which GitLab a call goes to, with which token and project, then the tool itself. Pure:
// git, ssh, the network, the environment, the repository's settings and the clock are injected (`Deps`), so the tests
// run it against fakes and main.ts against Node.
import { GitlabError, NoProjectError, gitlab, type Fetch } from './api.ts'
import { InputError, makeCtx, type Clock, type Ctx } from './context.ts'
import { errorText } from './errors.ts'
import { currentBranch, hostName, locate, projectPath, sshHostname, type Git, type Ssh } from './remote.ts'
import { DEFAULT_HOST_ENV, ENV_NAME, offText, resolveDefaultHost, resolveToken, type TokenIo } from './tokens.ts'

/** What a call needs from outside: processes, the network, the environment, the repository's settings and the clock. */
export type Deps = {
  git: Git
  ssh: Ssh
  fetch: Fetch
  /** A variable of the server's environment. */
  env: (name: string) => Promise<string | undefined>
  /** One settings source of the repository; rejects when it cannot be read. */
  settings: TokenIo['settings']
  clock: Clock
}

/** The plugin's options, as the host hands them over (`${user_config.*}`): an option that is not set is empty or absent. */
export type Options = { tokens?: unknown; defaultHost?: unknown }

export type Reply = { text: string; isError?: true }

/** A tool: what it answers for its input, through the context of its call. */
export type Tool = (ctx: Ctx, input: Record<string, unknown>) => Promise<string>

/** Shapes an answer: `isError` is set only when true. */
function reply(text: string, isError = false): Reply {
  return isError ? { text, isError: true } : { text }
}

/**
 * Where a call goes: the host, its token and, when the host is the remote's, the remote's project. `fallback` marks a
 * remote that names no GitLab with a token (none, unreadable, or a host missing from tokens), the only case defaultHost serves.
 */
type Target = { host: string; token: string; current?: string } | { error: string; fallback?: true }

/** The remote's host (an SSH alias resolved through `ssh -G`) and its token. */
async function fromRemote(git: Git, ssh: Ssh, io: TokenIo, tokens: unknown): Promise<Target> {
  const where = await locate(git)
  if ('error' in where) return { error: where.error, fallback: true }
  let host = where.host
  let access = await resolveToken(io, tokens, host)
  if (access.off === 'no-host' && where.ssh) {
    // an SSH remote may name a ~/.ssh/config alias (`git@work:group/app.git`): its token is the real host's
    const real = await sshHostname(ssh, host)
    if (real && real !== host) {
      access = await resolveToken(io, tokens, real)
      if (access.off === 'no-host') return { error: `The remote's host ${host} is an SSH alias for ${real}. ${offText('no-host', real)}`, fallback: true }
      host = real
    } else if (!host.includes('.')) {
      return { error: `${offText('no-host', host)} If ${host} is an SSH alias from ~/.ssh/config, ssh -G could not resolve it: give the remote the real host name.`, fallback: true }
    }
  }
  if (access.off === 'no-host') return { error: offText(access.off, host), fallback: true }
  if (access.off !== undefined) return { error: offText(access.off, host) }
  return { host, token: access.token, current: where.project }
}

/** A host named by the `host` input or the defaultHost option, and its token; the remote's project only when the remote is on it. */
async function onHost(git: Git, ssh: Ssh, io: TokenIo, tokens: unknown, host: string): Promise<Target> {
  const access = await resolveToken(io, tokens, host)
  if (access.off !== undefined) return { error: offText(access.off, host) }
  const where = await locate(git)
  if ('error' in where) return { host, token: access.token }
  const same = where.host === host || (!!where.ssh && (await sshHostname(ssh, where.host)) === host)
  return { host, token: access.token, current: same ? where.project : undefined }
}

/**
 * Picks the host (the `host` input, else the remote's, else the defaultHost option when the remote gives none with a
 * token) and its token, switches to `project` when given and runs the tool; the token is masked in every answer.
 */
export async function run(deps: Deps, tool: Tool, input: Record<string, unknown>, options: Options): Promise<Reply> {
  const { git, ssh } = deps
  const io: TokenIo = { settings: deps.settings, env: () => deps.env(ENV_NAME) }
  let target: Target
  if (input.host !== undefined) {
    const named = hostName(input.host)
    if (!named) return reply('host must be a GitLab host name (gitlab.example.com), not a URL.', true)
    target = await onHost(git, ssh, io, options.tokens, named)
  } else {
    target = await fromRemote(git, ssh, io, options.tokens)
    if ('error' in target && target.fallback) {
      const fallback = await resolveDefaultHost(io, options.defaultHost, () => deps.env(DEFAULT_HOST_ENV))
      if (fallback.off !== undefined) return reply(offText(fallback.off), true)
      if (fallback.value !== undefined) {
        const named = hostName(fallback.value)
        if (!named) return reply(`The gitlab defaultHost option (or ${DEFAULT_HOST_ENV}) is not a host name (gitlab.example.com).`, true)
        target = await onHost(git, ssh, io, options.tokens, named)
      }
    }
  }
  if ('error' in target) return reply(target.error, true)
  const { host, token, current } = target
  let project = current
  if (input.project !== undefined) {
    const named = projectPath(input.project)
    if (!named) return reply(`project must be a project path (group/project) or numeric id on ${host}, not a URL: name another GitLab with host.`, true)
    project = named
  }
  const api = gitlab(deps.fetch, host, project, token)
  // an answer can echo what the request carried (a proxy's error page, a fetch error), so the token is masked in every output
  const masked = (text: string, isError = false) => reply(text.split(token).join('[token]'), isError)
  const foreign = project === undefined || current === undefined || project.toLowerCase() !== current.toLowerCase()
  try {
    return masked(await tool(makeCtx(api, () => currentBranch(git), deps.clock, foreign), input))
  } catch (err) {
    if (err instanceof NoProjectError) return masked(`Name the project (group/project or its numeric id): the repository's remote is not on ${host}.`, true)
    if (err instanceof InputError) return masked(err.message, true)
    if (err instanceof GitlabError) return masked(errorText(err, project ?? host, host), true)
    return masked(`Call to ${host} failed: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}
