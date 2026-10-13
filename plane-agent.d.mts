/** Types for plane-agent.mjs, which stays plain JS so `node` can run it without a build step. */
export const COMMENT_CAP: number
export function mdToHtml(md: string): string
export function htmlToText(html: string | undefined): string
export interface TrackerDeps {
  fetchFn?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>
  env?: Record<string, string | undefined>
  cachePath?: string
  sleep?: (ms: number) => Promise<void>
  tracker?: Tracker
}
export interface Tracker {
  ready(options?: { label?: string }): Promise<{ key: string; name: string; priority: string; labels: string[] }[]>
  list(options?: { state?: string; label?: string; query?: string; archived?: boolean }): Promise<Record<string, unknown>[]>
  update(k: string, fields: { name?: string; state?: string; priority?: string; labels?: string[]; desc?: string; parent?: string; assignees?: string[]; start?: string; due?: string }): Promise<Record<string, unknown>>
  relations(k: string): Promise<Record<string, string[]>>
  block(k: string, action: string, blocker: string): Promise<Record<string, unknown>>
  module(k: string, name?: string): Promise<Record<string, unknown>>
  request(method: string, path: string, body?: unknown, scope?: string): Promise<unknown>
  show(k: string): Promise<Record<string, unknown>>
  comments(k: string): Promise<{ id: string; at: string; text: string }[]>
  state(k: string, name: string): Promise<Record<string, unknown>>
  comment(k: string, md: string): Promise<{ ok: boolean; id: string }>
  label(k: string, action: string, name: string): Promise<Record<string, unknown>>
  create(a: { name: string; state?: string; priority?: string; labels?: string[]; module?: string; desc?: string }): Promise<Record<string, unknown>>
  selftest(commentOn?: string): Promise<Record<string, unknown>>
}
export function createTracker(deps?: TrackerDeps): Tracker
export const HELP: string
export function main(argv: string[], deps?: TrackerDeps): Promise<unknown>
