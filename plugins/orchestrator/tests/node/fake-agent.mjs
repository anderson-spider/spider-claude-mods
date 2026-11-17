#!/usr/bin/env node
// @ts-nocheck -- a scripted stand-in whose messages are whatever the test sends; typing it would only restate them.
// A scripted ACP agent standing in for `agy acp`: FAKE_AGENT_SCRIPT (JSON) says what each prompt does, and every
// message it gets, its argv, cwd and pid go to FAKE_AGENT_LOG (one JSON line each). session/resume takes any session id
// (as agy keeps its sessions on disk), but fails when the script sets resumeError.
import { appendFileSync } from 'node:fs'

const script = JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? '{}')
const logFile = process.env.FAKE_AGENT_LOG
const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
log({ start: { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid } })
if (script.crashAtStart) process.exit(3)

let next = 1000
const pending = new Map()
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const ask = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); send({ id, method, params }) })
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })
let cancel = () => {}
let prompts = 0
if (script.noise) process.stdout.write('Signing in...\n')

async function prompt(params) {
  // retrySteps: one list of steps per later prompt, the last one repeated.
  const turn = prompts++
  const later = script.retrySteps ?? []
  const steps = (turn === 0 ? script.steps : later[Math.min(turn - 1, later.length - 1)]) ?? [{ say: 'done' }]
  const cancelled = new Promise((resolve) => (cancel = () => resolve({ stopReason: 'cancelled' })))
  for (const step of steps) {
    if (step.say) update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.say } })
    if (step.tool) update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: step.tool, kind: 'read', status: 'pending' })
    if (step.permission) {
      const answer = await ask('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'p1', ...step.permission }, options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }] })
      log({ permission: step.permission, answer })
    }
    if (step.fs) log({ fs: await ask('fs/read_text_file', { sessionId: params.sessionId, path: '/etc/hosts' }).catch((e) => e) })
    if (step.sleep) { const r = await Promise.race([new Promise((resolve) => setTimeout(resolve, step.sleep)), cancelled]); if (r) return r }
    if (step.exit) process.exit(step.exit)
    if (step.error) throw Object.assign(new Error(step.error), { code: -32000 })
  }
  return { stopReason: script.stopReason ?? 'end_turn' }
}

const methods = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
  'session/new': () => ({ sessionId: script.sessionId ?? '11111111-2222-3333-4444-555555555555', modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }] }, models: { currentModelId: 'gemini-4-argon-medium', availableModels: [{ modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon' }, { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash' }] }, configOptions: [{ id: 'thought_level', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }] }),
  'session/resume': (params) => {
    if (script.resumeError) throw Object.assign(new Error(script.resumeError), { code: -32002 })
    log({ resumed: params.sessionId })
    return { models: { currentModelId: 'gemini-4-argon-medium', availableModels: [] } }
  },
  'session/set_mode': () => ({}),
  'session/set_model': (params) => { if (!params.modelId.startsWith('gemini')) throw Object.assign(new Error(`Unknown model ID: ${params.modelId}`), { code: -32602 }); return {} },
  'session/set_config_option': () => ({ configOptions: [] }),
  'session/prompt': prompt,
}

let buffer = ''
process.stdin.setEncoding('utf8').on('data', async (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    log({ got: message })
    if (message.method === 'session/cancel') { cancel(); continue }
    if (message.method && message.id !== undefined) {
      try { send({ id: message.id, result: await methods[message.method](message.params ?? {}) }) } catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }) }
    } else if (message.id !== undefined) {
      const resolve = pending.get(message.id); pending.delete(message.id)
      resolve?.(message.error ? Promise.reject(message.error) : message.result)
    }
  }
})
process.on('SIGTERM', () => { log({ signal: 'SIGTERM' }); process.exit(0) })
