// What every tool shares: the context it runs in and the checks of its inputs. An InputError is refused before any
// request; its message is the tool's answer.
import type { Sonar } from './api'
import { PROPERTIES_FILE } from './project'

export class InputError extends Error {}

export type Ctx = {
  sonar: Sonar
  /** The nearest sonar-project.properties' `sonar.projectKey`, for a call that names no project. */
  detect: () => Promise<{ key: string; file: string } | undefined>
}

export type Input = Record<string, unknown>

/** A trimmed, non-empty string input, or undefined when absent. */
export function text(input: Input, name: string): string | undefined {
  const value = input[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new InputError(`${name} must be a non-empty string.`)
  return value.trim()
}

export function required(input: Input, name: string): string {
  const value = text(input, name)
  if (value === undefined) throw new InputError(`${name} is required.`)
  return value
}

/** A list input whose members are each one of `allowed` (case-insensitive) when given, or any non-empty string. */
export function list(input: Input, name: string, allowed?: readonly string[]): string[] | undefined {
  const value = input[name]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.length) throw new InputError(`${name} must be a non-empty list.`)
  return value.map((item) => {
    const member = typeof item === 'string' ? item.trim() : ''
    if (!member) throw new InputError(`${name} must hold non-empty strings.`)
    if (!allowed) return member
    const upper = member.toUpperCase()
    if (!allowed.includes(upper)) throw new InputError(`${name} takes ${allowed.join(', ')}; got ${member}.`)
    return upper
  })
}

/** One of `allowed` (case-insensitive), or undefined when absent. */
export function oneOf<T extends string>(input: Input, name: string, allowed: readonly T[]): T | undefined {
  const value = text(input, name)
  if (value === undefined) return undefined
  const upper = value.toUpperCase() as T
  if (!allowed.includes(upper)) throw new InputError(`${name} takes ${allowed.join(', ')}; got ${value}.`)
  return upper
}

/** A whole number from `min` to `max`, `fallback` when absent. */
export function integer(input: Input, name: string, min: number, max: number, fallback: number): number {
  const value = input[name]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${name} must be a whole number from ${min} to ${max}.`)
  }
  return value
}

export const PAGE_SIZE_MAX = 100

/** `page` and `pageSize` (20 by default, 100 at most) as the API's `p` and `ps`. */
export function paging(input: Input): { p: number; ps: number } {
  return { p: integer(input, 'page', 1, 10_000, 1), ps: integer(input, 'pageSize', 1, PAGE_SIZE_MAX, 20) }
}

/** The analysis a call reads: the main branch, a `branch` or a `pullRequest`, never both. */
export function scope(input: Input): { branch?: string; pullRequest?: string } {
  const branch = text(input, 'branch')
  const pullRequest = text(input, 'pullRequest')
  if (branch !== undefined && pullRequest !== undefined) throw new InputError('branch and pullRequest are mutually exclusive: pass one.')
  return branch !== undefined ? { branch } : pullRequest !== undefined ? { pullRequest } : {}
}

/** The `projectKey` input, else the one sonar-project.properties gives. */
export async function projectKey(ctx: Ctx, input: Input): Promise<string> {
  const given = text(input, 'projectKey')
  if (given !== undefined) return given
  const found = await ctx.detect()
  if (found) return found.key
  throw new InputError(`Pass projectKey: no ${PROPERTIES_FILE} with sonar.projectKey was found from the session's folder up to its git root.`)
}

/** The answer of a tool: compact JSON. */
export const json = (value: unknown): string => JSON.stringify(value)

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An object's field when it is an array, else empty. */
export const arrayOf = (value: unknown, name: string): unknown[] => {
  const field = isObject(value) ? value[name] : undefined
  return Array.isArray(field) ? field : []
}
