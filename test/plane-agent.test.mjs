// plane-agent.mjs against a fake Plane REST server. `npm run test:falsify` breaks each rule below
// one at a time and requires this file to go red.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMENT_CAP, HELP, createTracker, htmlToText, main, mdToHtml } from '../plane-agent.mjs'

const ENTRY = fileURLToPath(new URL('../plane-agent.mjs', import.meta.url))
const KEY = 'sk-test-secret-123'
const PROJECT = '00000000-0000-4000-8000-000000000001'
const API = 'https://plane.example/api/v1'
const SCOPE = `${API}/workspaces/ws/projects/${PROJECT}|TST`
const STATES = ['Backlog', 'Todo', 'In Progress', 'Done', 'Cancelled', 'Duplicate']
const LABELS = ['art', 'blocked:owner', 'rules', 'app']

// Env that makes the fixtures below mean what they always meant: art and blocked:owner issues are
// hidden from `ready`, Duplicate is a closed state, and a module answers to the phase code in its name.
const BASE_ENV = {
  PLANE_API_KEY: KEY,
  PLANE_WORKSPACE_SLUG: 'ws',
  PLANE_PROJECT_ID: PROJECT,
  PLANE_PROJECT_PREFIX: 'TST',
  PLANE_API_BASE: API,
  PLANE_SKIP_LABELS: 'art,blocked:owner',
  PLANE_CLOSED_STATES: 'Done,Cancelled,Duplicate',
  PLANE_MODULE_ALIAS: '\\bP\\d+[a-z]?\\b',
}
const envWith = (extra = {}) => ({ ...BASE_ENV, ...extra })
/** BASE_ENV with the named keys removed. */
const envWithout = (...names) => Object.fromEntries(Object.entries(BASE_ENV).filter(([k]) => !names.includes(k)))

function world() {
  const states = STATES.map((name) => ({ id: `s-${name}`, name }))
  const labels = LABELS.map((name) => ({ id: `l-${name}`, name }))
  const modules = [{ id: 'm-P10', name: 'P10' }]
  const members = [
    { member: { id: 'u-ann', display_name: 'ann', email: 'ann@example.com' } },
    { member: { id: 'u-bob', display_name: 'bob', email: 'bob@example.com' } },
  ]
  const mk = (n, state, priority, lbls = []) => ({
    id: `i-${n}`,
    sequence_id: n,
    name: `Issue ${n}`,
    state: `s-${state}`,
    priority,
    labels: lbls.map((l) => `l-${l}`),
    description_html: `<p>body ${n}</p>`,
    description_stripped: `body ${n}`,
  })
  const items = [
    mk(1, 'Todo', 'low'),
    mk(2, 'Todo', 'urgent'),
    mk(3, 'Todo', 'medium', ['art']),
    mk(4, 'Todo', 'high', ['blocked:owner']),
    mk(5, 'Todo', 'high', ['rules']),
    mk(6, 'Todo', 'none'),
    mk(7, 'Todo', 'urgent', ['app']), // blocked by open 8
    mk(8, 'In Progress', 'high'),
    mk(9, 'Todo', 'urgent'), // blocked by Done 10 -> ready
    mk(10, 'Done', 'low'),
    mk(11, 'Backlog', 'urgent'),
    mk(12, 'Todo', 'medium'),
  ]
  const blockedBy = { 'i-7': ['i-8'], 'i-9': ['i-10'] }
  const comments = {}
  return { states, labels, modules, members, items, blockedBy, comments, memberships: {}, calls: [], bodies: [], headers: [], commentMode: 'ok', nextId: 100, page: 2 }
}

function fakeFetch(w) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const u = new URL(url)
    const path = u.pathname.replace(/^.*\/projects\/[^/]+/, '')
    w.calls.push(`${method} ${path}`)
    w.headers.push(init.headers ?? {})
    const body = init.body ? JSON.parse(init.body) : undefined
    if (body !== undefined) w.bodies.push(body)
    const reply = (status, data) => ({ status, ok: status < 400, text: async () => (data === undefined ? '' : JSON.stringify(data)) })
    const identifier = /\/workspaces\/[^/]+\/work-items\/([A-Z]+)-(\d+)\/$/.exec(u.pathname)
    if (identifier) {
      const item = w.items.find((x) => x.sequence_id === Number(identifier[2]))
      return item ? reply(200, { ...item, project: PROJECT }) : reply(404, {})
    }
    const paged = (rows) => {
      const at = Number(u.searchParams.get('cursor') ?? 0)
      const slice = rows.slice(at, at + w.page)
      const more = at + w.page < rows.length
      return reply(200, { results: slice, next_page_results: more, next_cursor: more ? String(at + w.page) : null })
    }
    let m
    if (method === 'GET' && path === '/states/') return paged(w.states)
    if (method === 'GET' && path === '/labels/') return paged(w.labels)
    if (method === 'GET' && path === '/modules/') return paged(w.modules)
    if (method === 'GET' && path === '/members/') return paged(w.members)
    if (method === 'GET' && path === '/work-items/') return paged(w.items)
    if (method === 'GET' && path === '/archived-work-items/') return paged(w.items.filter((r) => !!r.archived_at))
    if (method === 'POST' && path === '/work-items/') {
      const n = w.items.length + 1
      const it = { id: `i-${n}`, sequence_id: n, name: body.name, state: body.state, priority: body.priority, labels: body.labels, description_html: body.description_html ?? '', description_stripped: '' }
      w.items.push(it)
      return reply(201, it)
    }
    if ((m = /^\/work-items\/([^/]+)\/$/.exec(path))) {
      const it = w.items.find((x) => x.id === m[1])
      if (!it) return reply(404, { error: 'nf' })
      if (method === 'GET') return reply(200, it)
      if (method === 'PATCH') {
        if (body.state && !w.states.some((s) => s.id === body.state)) return reply(404, { error: 'state nf' })
        Object.assign(it, body)
        return reply(200, it) // the real server echoes the whole row; the CLI must not
      }
    }
    if ((m = /^\/work-items\/([^/]+)\/relations\/(remove\/)?$/.exec(path))) {
      if (method === 'POST') w.blockedBy[m[1]] = m[2] ? (w.blockedBy[m[1]] ?? []).filter((x) => x !== body.related_issue) : [...new Set([...(w.blockedBy[m[1]] ?? []), ...body.issues])]
      return reply(200, { blocked_by: (w.blockedBy[m[1]] ?? []).map((issue_id) => ({ issue_id, project_id: PROJECT })), blocking: [], relates_to: [] })
    }
    if ((m = /^\/work-items\/([^/]+)\/comments\/$/.exec(path))) {
      const all = (w.comments[m[1]] ??= [])
      if (method === 'GET') return paged(all)
      const id = `c-${w.nextId++}`
      const html = w.commentMode === 'ok' ? body.comment_html : `<p>${String(body.comment_html).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
      all.push({ id, comment_html: html, created_at: '2026-09-30T00:00:00Z' })
      return reply(201, { id, comment_html: html })
    }
    // live Plane: module rows are the issues themselves; DELETE names the issue in the path
    if ((m = /^\/modules\/([^/]+)\/module-issues\/(?:([^/]+)\/)?$/.exec(path))) {
      if (method === 'POST' && !m[2]) w.memberships[m[1]] = [...new Set([...(w.memberships[m[1]] ?? []), ...body.issues])]
      else if (method === 'DELETE' && m[2]) {
        if (!(w.memberships[m[1]] ?? []).includes(m[2])) return reply(404, { error: 'not in module' })
        w.memberships[m[1]] = w.memberships[m[1]].filter((x) => x !== m[2])
      }
      else if (method !== 'GET' || m[2]) return reply(404, { error: 'bad module route' })
      return method === 'GET' ? paged((w.memberships[m[1]] ?? []).map((id) => ({ id }))) : reply(200, null)
    }
    return reply(404, { error: `no route ${method} ${path}` })
  }
}

const tmpDir = (prefix = 'plane-agent-test-') => mkdtempSync(join(tmpdir(), prefix))
const fresh = () => join(tmpDir(), 'c.json')

function setup(w = world(), seedCache) {
  const cachePath = join(tmpDir(), 'cache.json')
  if (seedCache) writeFileSync(cachePath, JSON.stringify(seedCache))
  const t = createTracker({ fetchFn: fakeFetch(w), env: envWith(), cachePath })
  return { w, t, cachePath }
}
const count = (w, call) => w.calls.filter((c) => c === call).length

describe('plane-agent: auth', () => {
  it('fails loud with one line when PLANE_API_KEY is unset', () => {
    expect(() => createTracker({ fetchFn: fakeFetch(world()), env: {}, cachePath: fresh() })).toThrow('PLANE_API_KEY is not set')
  })
  it('sends the key as X-API-Key and never writes it to the cache', async () => {
    const { w, t, cachePath } = setup()
    await t.ready()
    await t.show('TST-5') // writes the issue-key cache
    expect(w.headers.every((h) => h['X-API-Key'] === KEY)).toBe(true)
    expect(readFileSync(cachePath, 'utf8')).not.toContain(KEY)
  })
  it('PLANE_NO_CACHE_WRITE leaves the cache file untouched (read-only callers)', async () => {
    const cachePath = join(tmpDir(), 'cache.json')
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_NO_CACHE_WRITE: '1' }), cachePath })
    await t.ready()
    await t.show('TST-5')
    expect(existsSync(cachePath)).toBe(false)
  })
  it('the old TRACKER_NO_CACHE_WRITE name no longer suppresses the write', async () => {
    const cachePath = join(tmpDir(), 'cache.json')
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ TRACKER_NO_CACHE_WRITE: '1' }), cachePath })
    await t.show('TST-5')
    expect(existsSync(cachePath)).toBe(true)
  })
})

describe('plane-agent: name maps', () => {
  // a 300-row Done list fired one /labels/ fetch per label ref in parallel: Plane answered 502
  it('fetches each name map once, however many rows resolve it at the same time', async () => {
    const { w, t } = setup()
    await t.list({})
    expect(count(w, 'GET /labels/')).toBe(Math.ceil(w.labels.length / w.page))
    expect(count(w, 'GET /states/')).toBe(Math.ceil(w.states.length / w.page))
  })
})

describe('plane-agent: ready', () => {
  it('ranks urgent>high>medium>low>none then sequence, in compact rows', async () => {
    const { t } = setup()
    const rows = await t.ready()
    expect(rows.map((r) => r.key)).toEqual(['TST-2', 'TST-9', 'TST-5', 'TST-12', 'TST-1', 'TST-6'])
    expect(Object.keys(rows[0])).toEqual(['key', 'name', 'priority', 'labels'])
  })
  it('drops art and blocked:owner issues', async () => {
    const { t } = setup()
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).not.toContain('TST-3')
    expect(keys).not.toContain('TST-4')
  })
  it('drops an issue with an open blocker, keeps one whose blocker is Done', async () => {
    const { t } = setup()
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).not.toContain('TST-7')
    expect(keys).toContain('TST-9')
  })
  it('treats a blocker it cannot see as open', async () => {
    const w = world()
    w.blockedBy['i-2'] = ['elsewhere']
    const { t } = setup(w)
    expect((await t.ready()).map((r) => r.key)).not.toContain('TST-2')
  })
  it('follows pagination across every page', async () => {
    const w = world()
    w.page = 1
    const { t } = setup(w)
    expect(await t.ready()).toHaveLength(6)
    expect(count(w, 'GET /work-items/')).toBe(12)
  })
  it('reports label names, not uuids', async () => {
    const { t } = setup()
    expect((await t.ready()).find((r) => r.key === 'TST-5').labels).toEqual(['rules'])
  })
})

describe('plane-agent: show / comments', () => {
  it('returns state and label NAMES and the stripped description', async () => {
    const { t } = setup()
    const s = await t.show('TST-5')
    expect(s).toEqual({ key: 'TST-5', name: 'Issue 5', state: 'Todo', priority: 'high', labels: ['rules'], description: 'body 5' })
  })
  it('rejects a malformed or unknown key', async () => {
    const { t } = setup()
    await expect(t.show('nope')).rejects.toThrow('bad issue key')
    await expect(t.show('TST-999')).rejects.toThrow('unknown issue "TST-999"')
  })
  it('lists comments as compact rows across pages', async () => {
    const { t, w } = setup()
    for (const n of [1, 2, 3]) await t.comment('TST-5', `note ${n}`)
    const rows = await t.comments('TST-5')
    expect(rows.map((r) => r.text)).toEqual(['note 1', 'note 2', 'note 3'])
    expect(Object.keys(rows[0])).toEqual(['id', 'at', 'text'])
    expect(w.page).toBe(2)
  })
})

describe('plane-agent: state / label / create', () => {
  it('sets state by NAME and acks without echoing the row', async () => {
    const { t, w } = setup()
    const out = await t.state('TST-5', 'In Progress')
    expect(out).toEqual({ ok: true, key: 'TST-5', state: 'In Progress' })
    expect(w.items.find((i) => i.id === 'i-5').state).toBe('s-In Progress')
    expect(JSON.stringify(out)).not.toContain('body 5')
  })
  it('an unknown state name fails loud naming it and writes nothing', async () => {
    const { t, w } = setup()
    await expect(t.state('TST-5', 'Doing')).rejects.toThrow('unknown state "Doing"')
    expect(w.calls.some((c) => c.startsWith('PATCH'))).toBe(false)
  })
  it('an unknown label never maps to anything', async () => {
    const { t, w } = setup()
    await expect(t.label('TST-5', 'add', 'nonesuch')).rejects.toThrow('unknown label "nonesuch"')
    expect(w.calls.some((c) => c.startsWith('PATCH'))).toBe(false)
  })
  it('adds and removes labels by name, keeping the others', async () => {
    const { t } = setup()
    expect(await t.label('TST-5', 'add', 'app')).toEqual({ ok: true, key: 'TST-5', labels: ['rules', 'app'] })
    expect(await t.label('TST-5', 'remove', 'rules')).toEqual({ ok: true, key: 'TST-5', labels: ['app'] })
  })
  it('creates an issue with names, then files the module', async () => {
    const { t, w } = setup()
    const out = await t.create({ name: 'New', state: 'Todo', priority: 'high', labels: ['rules'], module: 'P10', desc: 'hello **there**' })
    expect(out).toEqual({ ok: true, key: 'TST-13', id: 'i-13' })
    expect(w.items[12]).toMatchObject({ state: 's-Todo', labels: ['l-rules'], description_html: '<p>hello <strong>there</strong></p>' })
    expect(w.calls).toContain('POST /modules/m-P10/module-issues/')
  })
  it('resolves a module by its full name or the phase code inside it', async () => {
    const { t, w } = setup()
    w.modules.splice(0, 1, { id: 'm-P10', name: 'AI Program (P10)' })
    await t.create({ name: 'New', module: 'P10' })
    await t.create({ name: 'New', module: 'AI Program (P10)' })
    expect(w.calls.filter((c) => c === 'POST /modules/m-P10/module-issues/')).toHaveLength(2)
  })
  it('refuses a phase code two modules claim, before posting', async () => {
    const { t, w } = setup()
    w.modules.push({ id: 'm-X', name: 'Map editor (P10)' })
    await expect(t.create({ name: 'N', module: 'P10' })).rejects.toThrow('two modules answer to "P10"')
    expect(w.calls).not.toContain('POST /work-items/')
  })
  it('create with an unknown module fails loud', async () => {
    const { t } = setup()
    await expect(t.create({ name: 'N', module: 'P99' })).rejects.toThrow('unknown module "P99"')
  })
})

describe('plane-agent: comment', () => {
  it('converts markdown to HTML, reads back, and returns only {ok,id}', async () => {
    const { t, w } = setup()
    const out = await t.comment('TST-5', 'did **it** with `code`')
    expect(Object.keys(out)).toEqual(['ok', 'id'])
    expect(w.bodies).toContainEqual({ comment_html: '<p>did <strong>it</strong> with <code>code</code></p>' })
  })
  it(`enforces the ${COMMENT_CAP}-char cap before any POST`, async () => {
    const { t, w } = setup()
    await expect(t.comment('TST-5', 'x'.repeat(COMMENT_CAP + 1))).rejects.toThrow('cap is 400')
    expect(w.calls.some((c) => c.startsWith('POST /work-items/i-5/comments'))).toBe(false)
    await expect(t.comment('TST-5', 'x'.repeat(COMMENT_CAP))).resolves.toMatchObject({ ok: true })
  })
  it('errors when the stored body is markdown or tags shown as text', async () => {
    const w = world()
    w.commentMode = 'literal'
    const { t } = setup(w)
    await expect(t.comment('TST-5', 'did **it**')).rejects.toThrow('read-back differs')
  })
  it('errors when the comment cannot be found on read-back', async () => {
    const { t, w } = setup()
    const f = fakeFetch(w)
    const t2 = createTracker({ fetchFn: async (u, i) => (i?.method === 'POST' && u.includes('/comments/') ? { status: 201, ok: true, text: async () => '{"id":"ghost"}' } : f(u, i)), env: envWith(), cachePath: fresh() })
    await expect(t2.comment('TST-5', 'hi')).rejects.toThrow('not found on read-back')
    expect(t).toBeTruthy()
  })
  it('does not echo the body in the ack', async () => {
    const { t } = setup()
    expect(JSON.stringify(await t.comment('TST-5', 'secret-ish body text'))).not.toContain('secret-ish')
  })
})

describe('plane-agent: name maps and issue cache', () => {
  it('issue key -> uuid is cached on disk: a second run does not list work items to find it', async () => {
    const { t, w, cachePath } = setup()
    await t.state('TST-5', 'Done')
    const w2 = world()
    const t2 = createTracker({ fetchFn: fakeFetch(w2), env: envWith(), cachePath })
    await t2.state('TST-5', 'Done')
    expect(count(w2, 'GET /work-items/')).toBe(0)
    expect(w.calls.length).toBeGreaterThan(0)
  })
  it('names are fetched once per process, however many lookups', async () => {
    const { t, w } = setup()
    await t.state('TST-5', 'Done')
    await t.state('TST-6', 'Todo')
    await expect(t.state('TST-5', 'Nonesuch')).rejects.toThrow('unknown state "Nonesuch"')
    expect(count(w, 'GET /states/')).toBe(Math.ceil(w.states.length / w.page)) // every page of /states/ once
  })
  it('a name added server-side is found by a fresh process', async () => {
    const { t, w } = setup()
    await t.state('TST-5', 'Done')
    w.states.push({ id: 's-In Review', name: 'In Review' })
    const t2 = createTracker({ fetchFn: fakeFetch(w), env: envWith(), cachePath: fresh() })
    expect(await t2.state('TST-5', 'In Review')).toMatchObject({ ok: true })
  })
})

describe('plane-agent: markdown converter', () => {
  it('handles paragraphs, emphasis, code, lists and links', () => {
    expect(mdToHtml('a *b* **c**\nnext\n\n- x\n- y\n\n1. p\n2. q\n\n[l](https://e.com/x)')).toBe(
      '<p>a <em>b</em> <strong>c</strong><br>next</p><ul><li>x</li><li>y</li></ul><ol><li>p</li><li>q</li></ol><p><a href="https://e.com/x">l</a></p>',
    )
  })
  it('escapes raw HTML and refuses non-http links', () => {
    expect(mdToHtml('<script>x</script> [a](javascript:alert(1))')).toBe('<p>&lt;script&gt;x&lt;/script&gt; [a](javascript:alert(1))</p>')
  })
  it('keeps code spans literal', () => {
    expect(mdToHtml('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })
  it('htmlToText round-trips visible text', () => {
    expect(htmlToText('<p>a &lt;b&gt;</p><ul><li>x</li></ul>')).toBe('a <b> x')
  })
})

/** fakeFetch with one route overridden: `over` returns a reply to short-circuit, or undefined to fall through. */
function tracker(w, over, cachePath = fresh()) {
  const f = fakeFetch(w)
  return createTracker({ fetchFn: async (u, i) => over(i?.method ?? 'GET', u) ?? f(u, i), env: envWith(), cachePath })
}
const reply = (status, text) => ({ status, ok: status < 400, text: async () => text })

// Each case below reproduces one reviewer finding against the pre-fix code.
describe('plane-agent: review round', () => {
  it('inherited property names never resolve as uuids', async () => {
    const { t, w } = setup()
    await expect(t.state('TST-5', 'toString')).rejects.toThrow('unknown state "toString"')
    await expect(t.label('TST-5', 'add', '__proto__')).rejects.toThrow('unknown label "__proto__"')
    expect(w.calls.some((c) => c.startsWith('PATCH'))).toBe(false)
  })
  it('a server-side rename is honoured even with a stale name cache on disk', async () => {
    const w = world()
    w.labels.find((l) => l.id === 'l-rules').name = 'art' // rules -> art
    w.labels.find((l) => l.id === 'l-art').name = 'design'
    w.states.find((s) => s.id === 's-In Progress').name = 'Doing'
    const seed = { scope: SCOPE, labels: { art: 'l-art', rules: 'l-rules' }, states: { 'In Progress': 's-In Progress' }, issues: {} }
    const cachePath = fresh()
    writeFileSync(cachePath, JSON.stringify(seed))
    const t = tracker(w, () => undefined, cachePath)
    expect((await t.ready()).map((r) => r.key)).not.toContain('TST-5') // now labelled art
    await expect(t.state('TST-1', 'In Progress')).rejects.toThrow('unknown state "In Progress"')
    await expect(t.state('TST-1', 'Doing')).resolves.toMatchObject({ ok: true })
  })
  it('an API error surfaces method, path and status only', async () => {
    const t = tracker(world(), (m, u) => (m === 'POST' && u.includes('/comments/') ? reply(500, `boom ${KEY} the-comment-text`) : undefined))
    const e = await t.comment('TST-5', 'the-comment-text').catch((x) => x)
    expect(e.message).toBe('POST /work-items/i-5/comments/ 500')
  })
  it('a non-JSON success body is not echoed into the error', async () => {
    const t = tracker(world(), (m, u) => (m === 'GET' && u.includes('/states/') ? reply(200, `<html>${KEY}`) : undefined))
    const e = await t.state('TST-5', 'Done').catch((x) => x)
    expect(e.message).toMatch(/not JSON/)
    expect(e.message).not.toContain(KEY)
  })
  it('comment text starting with -- is posted verbatim, not parsed as an option', async () => {
    const w = world()
    await main(['comment', 'TST-5', '--note', 'done'], { fetchFn: fakeFetch(w), env: envWith(), cachePath: fresh() })
    expect(w.bodies).toContainEqual({ comment_html: '<p>--note done</p>' })
  })
  it('create resolves an unknown module BEFORE posting the item', async () => {
    const { t, w } = setup()
    await expect(t.create({ name: 'N', module: 'P99' })).rejects.toThrow('unknown module "P99"')
    expect(w.calls).not.toContain('POST /work-items/')
  })
  it('a failed module attach names the item that WAS created', async () => {
    const t = tracker(world(), (m, u) => (m === 'POST' && u.includes('/modules/') ? reply(500, 'x') : undefined))
    await expect(t.create({ name: 'N', module: 'P10' })).rejects.toThrow('created TST-13')
  })
  it('an unknown priority ranks as none instead of scrambling the sort', async () => {
    const w = world()
    w.items.push({ ...w.items[0], id: 'i-0', sequence_id: 0, priority: 'bogus' })
    const { t } = setup(w)
    expect((await t.ready()).map((r) => r.key).slice(-3)).toEqual(['TST-1', 'TST-0', 'TST-6'])
  })
})

describe('plane-agent: command contract', () => {
  it('lists art and In Progress without the ready exclusions; searches bodies', async () => {
    const { t } = setup()
    expect((await t.list({ state: 'Todo', label: 'art' })).map((r) => r.key)).toEqual(['TST-3'])
    expect((await t.list({ state: 'In Progress' })).map((r) => r.key)).toEqual(['TST-8'])
    expect((await t.list({ query: 'body 11' })).map((r) => r.key)).toEqual(['TST-11'])
    expect((await t.ready({ label: 'art' })).map((r) => r.key)).toEqual(['TST-3'])
  })
  it('ready excludes drafts and archives while retaining closed blocker states', async () => {
    const { t, w } = setup()
    Object.assign(w.items[1], { archived_at: '2026-10-01' })
    Object.assign(w.items[4], { is_draft: true })
    expect((await t.ready()).map((r) => r.key)).toEqual(['TST-9', 'TST-12', 'TST-1', 'TST-6'])
    expect((await t.list({ archived: true })).map((r) => r.key)).toEqual(['TST-2'])
  })
  it('lists request sparse fields and cold lookup never scans the project', async () => {
    const { t, w } = setup()
    await t.show('TST-5')
    expect(w.calls.some((c) => c.endsWith('/workspaces/ws/work-items/TST-5/'))).toBe(true)
    expect(count(w, 'GET /work-items/')).toBe(0)
    const f = fakeFetch(w)
    const urls = []
    const t2 = createTracker({ fetchFn: async (u, i) => { urls.push(u); return f(u, i) }, env: envWith(), cachePath: fresh() })
    await t2.ready()
    expect(urls.filter((u) => new URL(u).pathname.endsWith('/work-items/')).every((u) => new URL(u).searchParams.get('fields')?.includes('sequence_id'))).toBe(true)
  })
  it('updates fields, clears description/labels/parent and rejects invalid input before writing', async () => {
    const { t, w } = setup()
    await t.update('TST-5', { name: 'Renamed', priority: 'low', desc: '**new**', parent: 'TST-1', due: '2026-10-02' })
    expect(w.items[4]).toMatchObject({ name: 'Renamed', priority: 'low', description_html: '<p><strong>new</strong></p>', parent: 'i-1', target_date: '2026-10-02' })
    await t.update('TST-5', { labels: [], desc: '', parent: '', due: '' })
    expect(w.items[4]).toMatchObject({ labels: [], parent: null, target_date: null })
    const before = w.bodies.length
    await expect(t.update('TST-5', { priority: 'wrong' })).rejects.toThrow('priority')
    await expect(t.update('TST-5', { due: '2026-02-30' })).rejects.toThrow('dates')
    await expect(t.update('TST-5', { due: '2026-13-01' })).rejects.toThrow('dates')
    await expect(t.update('TST-5', {})).rejects.toThrow('at least one')
    expect(w.bodies.length).toBe(before)
  })
  it('detects successful-but-ignored state writes', async () => {
    const t = tracker(world(), (m) => m === 'PATCH' ? reply(200, '{}') : undefined)
    await expect(t.state('TST-5', 'Done')).rejects.toThrow('read-back differs')
  })
  it('adds, lists and removes blocker edges by key', async () => {
    const { t } = setup()
    await t.block('TST-5', 'add', 'TST-8')
    expect((await t.relations('TST-5')).blocked_by).toEqual(['TST-8'])
    expect((await t.ready()).map((r) => r.key)).not.toContain('TST-5')
    await t.block('TST-5', 'remove', 'TST-8')
    expect((await t.ready()).map((r) => r.key)).toContain('TST-5')
    await expect(t.block('TST-5', 'add', 'TST-5')).rejects.toThrow('itself')
  })
  it('moves and clears modules after detaching the original', async () => {
    const { t, w } = setup()
    w.modules.push({ id: 'm-P9', name: 'P9' })
    w.memberships['m-P9'] = ['i-5']
    await t.module('TST-5', 'P10')
    expect(await t.module('TST-5')).toEqual({ key: 'TST-5', modules: ['P10'] })
    expect(w.calls.indexOf('DELETE /modules/m-P9/module-issues/i-5/')).toBeLessThan(w.calls.indexOf('POST /modules/m-P10/module-issues/'))
    await t.module('TST-5', '')
    expect(await t.module('TST-5')).toEqual({ key: 'TST-5', modules: [] })
  })
  it('raw REST rejects host escapes and traversal; writes only return an ack', async () => {
    const { t } = setup()
    for (const path of ['https://evil.test', '//evil.test', '/../outside', '/%2e%2e/outside', '/a\\b']) await expect(t.request('GET', path)).rejects.toThrow('path')
    expect(await t.request('POST', '/work-items/', { name: 'Secret body', labels: [] })).toMatchObject({ ok: true })
    expect(JSON.stringify(await t.request('PATCH', '/work-items/i-5/', { name: 'Secret' }))).not.toContain('Secret')
  })
  it('supports another Plane project and prefix without reusing a stale cache', async () => {
    const cachePath = fresh()
    writeFileSync(cachePath, JSON.stringify({ scope: 'old', issues: { 'LOCAL-5': 'wrong' } }))
    const urls = []
    const t = createTracker({ env: { PLANE_API_KEY: KEY, PLANE_API_BASE: 'http://localhost:8000/api/v1/', PLANE_PROJECT_ID: 'local-project', PLANE_PROJECT_PREFIX: 'LOCAL', PLANE_WORKSPACE_SLUG: 'local' }, cachePath,
      fetchFn: async (u) => { urls.push(u); return reply(200, JSON.stringify({ id: 'local-5', project: 'local-project', name: 'Local', state: 'Done', labels: [] })) } })
    await t.request('GET', '/states/')
    await t.relations('LOCAL-5').catch(() => {})
    expect(urls).toContain('http://localhost:8000/api/v1/workspaces/local/work-items/LOCAL-5/')
    expect(urls.every((u) => u.startsWith('http://localhost:8000/'))).toBe(true)
    expect(readFileSync(cachePath, 'utf8')).not.toContain('wrong')
  })
  it('the command contract accepts opaque backend keys without Plane authentication', async () => {
    const calls = []
    const backend = { show: async (k) => { calls.push(k); return { key: k, name: 'Beads candidate' } } }
    expect(await main(['show', 'bd-a1b'], { env: {}, tracker: backend })).toMatchObject({ key: 'bd-a1b' })
    expect(calls).toEqual(['bd-a1b'])
  })
  it('loads the selected backend module without requiring Plane credentials', async () => {
    const adapter = join(tmpDir('plane-agent-adapter-'), 'backend.mjs')
    writeFileSync(adapter, 'export function createTracker() { return { show: async key => ({key, name:"Other tracker"}) } }')
    expect(await main(['show', 'bd-a1'], { env: { TRACKER_ADAPTER: adapter } })).toEqual({ key: 'bd-a1', name: 'Other tracker' })
  })
  it('honors Retry-After and fails closed on unknown list and relation schemas', async () => {
    const { w } = setup()
    const f = fakeFetch(w)
    const waits = []
    let first = true
    const t = createTracker({ env: envWith(), cachePath: fresh(), sleep: async (n) => { waits.push(n) }, fetchFn: async (u, i) => {
      if (first) { first = false; return { ...reply(429, '{}'), headers: { get: () => '7' } } }
      return f(u, i)
    } })
    await t.ready()
    expect(waits).toEqual([7000])
    await expect(tracker(world(), (_m, u) => u.includes('/states/') ? reply(200, '{"data":[]}') : undefined).ready()).rejects.toThrow('unsupported list response')
    await expect(tracker(world(), (_m, u) => u.includes('/relations/') ? reply(200, '{}') : undefined).ready()).rejects.toThrow('unsupported relations response')
  })
  it('rejects misspelled or missing options before auth and help needs no key', async () => {
    await expect(main(['update', 'TST-5', '--priorty', 'high'], { env: {} })).rejects.toThrow('unknown option')
    await expect(main(['create', 'Name', '--state'], { env: {} })).rejects.toThrow('needs a value')
    await expect(main(['search'], { env: {} })).rejects.toThrow('search needs text')
    expect(await main(['help'], { env: {} })).toBe(HELP)
  })
  it('refuses excessive server retry waits and URL control characters', async () => {
    const waits = []
    const t = createTracker({ env: envWith(), cachePath: fresh(), sleep: async (n) => { waits.push(n) }, fetchFn: async () => ({ ...reply(429, '{}'), headers: { get: () => '86400' } }) })
    await expect(t.request('GET', '/states/')).rejects.toThrow('retry delay')
    expect(waits).toEqual([])
    await expect(t.request('GET', '/.\t./states/')).rejects.toThrow('traversal')
  })
  it('accepts option-like text using equals values and the end-of-options marker', async () => {
    const backend = { create: async (v) => v, update: async (_k, v) => v }
    expect(await main(['create', '--', '--- title'], { tracker: backend })).toEqual({ name: '--- title' })
    expect(await main(['update', 'bd-a1', '--desc=-- note'], { tracker: backend })).toEqual({ desc: '-- note' })
  })
  it('retains foreign relation ids when the project lookup returns 404', async () => {
    const t = tracker(world(), (_m, u) => u.includes('/relations/') ? reply(200, '{"blocked_by":["foreign"]}') : u.includes('/work-items/foreign/') ? reply(404, '{}') : undefined)
    expect((await t.relations('TST-5')).blocked_by).toEqual(['foreign'])
  })
  it('moves when the server silently ignores attaches with existing memberships', async () => {
    const w = world()
    w.modules.push({ id: 'm-P8', name: 'P8' })
    w.memberships['m-P10'] = ['i-5']
    const t = tracker(w, (method, url) => {
      if (method === 'POST' && url.includes('/modules/m-P8/') && w.memberships['m-P10']?.length) return reply(200, '{}')
      return undefined
    })
    expect(await t.module('TST-5', 'P8')).toMatchObject({ modules: ['P8'] })
  })
  it('restores the old membership if attaching the destination fails', async () => {
    const w = world()
    w.modules.push({ id: 'm-P8', name: 'P8' })
    w.memberships['m-P10'] = ['i-5']
    const t = tracker(w, (method, url) => method === 'POST' && url.includes('/modules/m-P8/') ? reply(500, '{}') : undefined)
    await expect(t.module('TST-5', 'P8')).rejects.toThrow('previous membership restored')
    expect(w.memberships['m-P10']).toEqual(['i-5'])
  })
  it('restores the original when verification fails after a successful move', async () => {
    const w = world()
    w.modules.push({ id: 'm-P8', name: 'P8' })
    w.memberships['m-P10'] = ['i-5']
    let failed = false
    const t = tracker(w, (method, url) => {
      if (method === 'GET' && url.includes('/modules/m-P8/') && w.memberships['m-P8']?.length && !failed) { failed = true; return reply(500, '{}') }
      if (method === 'POST' && url.includes('/modules/m-P10/') && w.memberships['m-P8']?.length) return reply(200, '{}')
      return undefined
    })
    await expect(t.module('TST-5', 'P8')).rejects.toThrow('move failed')
    expect(w.memberships['m-P10']).toEqual(['i-5'])
    expect(w.memberships['m-P8']).toEqual([])
  })
})

// ---- configuration: no project defaults, everything through env ----

/** Build a tracker with HOME pointed at a temp dir, so a default cache path can never touch the real one. */
function inTempHome(make) {
  const home = tmpDir('plane-home-')
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    if (homedir() !== home) throw new Error('cannot redirect os.homedir(); refusing to touch the real home')
    return { home, t: make() }
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

describe('plane-agent: required env', () => {
  for (const v of ['PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_ID', 'PLANE_PROJECT_PREFIX']) {
    it(`${v} has no default: createTracker throws "${v} is not set"`, () => {
      expect(() => createTracker({ fetchFn: fakeFetch(world()), env: envWithout(v), cachePath: fresh() })).toThrow(`${v} is not set`)
    })
  }
  it('PLANE_API_BASE defaults to the Plane cloud API', async () => {
    const urls = []
    const t = createTracker({ env: envWithout('PLANE_API_BASE'), cachePath: fresh(), fetchFn: async (u) => { urls.push(u); return reply(200, '{}') } })
    await t.request('GET', '/states/')
    expect(urls).toEqual([`https://api.plane.so/api/v1/workspaces/ws/projects/${PROJECT}/states/`])
  })
})

describe('plane-agent: PLANE_SKIP_LABELS', () => {
  it('defaults to none: ready lists art and blocked:owner issues', async () => {
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWithout('PLANE_SKIP_LABELS'), cachePath: fresh() })
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).toContain('TST-3')
    expect(keys).toContain('TST-4')
  })
  it('hides exactly the labels named, trimming spaces', async () => {
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_SKIP_LABELS: 'rules, app' }), cachePath: fresh() })
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).not.toContain('TST-5') // rules
    expect(keys).toContain('TST-3') // art is no longer hidden
    expect(keys).toContain('TST-4')
  })
  it('an empty value is the empty list, not a label named ""', async () => {
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_SKIP_LABELS: '' }), cachePath: fresh() })
    expect((await t.ready()).map((r) => r.key)).toContain('TST-3')
  })
  it('--label opts a skipped label back in, whichever label it is', async () => {
    const { t } = setup()
    expect((await t.ready({ label: 'art' })).map((r) => r.key)).toEqual(['TST-3'])
    expect((await t.ready({ label: 'blocked:owner' })).map((r) => r.key)).toEqual(['TST-4'])
    const t2 = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_SKIP_LABELS: 'rules' }), cachePath: fresh() })
    expect((await t2.ready({ label: 'rules' })).map((r) => r.key)).toEqual(['TST-5'])
  })
  it('--label opts in only the label named, not a second skipped label on the same issue', async () => {
    const w = world()
    w.items[2].labels.push('l-blocked:owner') // TST-3 now carries art and blocked:owner
    const { t } = setup(w)
    expect(await t.ready({ label: 'art' })).toEqual([])
    expect((await t.ready({ label: 'blocked:owner' })).map((r) => r.key)).toEqual(['TST-4'])
  })
})

describe('plane-agent: PLANE_CLOSED_STATES', () => {
  // TST-12 is blocked by a Duplicate issue and TST-1 by a Cancelled one
  const blockedWorld = () => {
    const w = world()
    w.items.push({ ...w.items[9], id: 'i-13', sequence_id: 13, state: 's-Duplicate' }, { ...w.items[9], id: 'i-14', sequence_id: 14, state: 's-Cancelled' })
    w.blockedBy['i-12'] = ['i-13']
    w.blockedBy['i-1'] = ['i-14']
    return w
  }
  it('defaults to Done and Cancelled: a Duplicate blocker still blocks', async () => {
    const t = createTracker({ fetchFn: fakeFetch(blockedWorld()), env: envWithout('PLANE_CLOSED_STATES'), cachePath: fresh() })
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).toContain('TST-1') // Cancelled blocker is closed
    expect(keys).toContain('TST-9') // Done blocker is closed
    expect(keys).not.toContain('TST-12')
  })
  it('is configurable: Duplicate closed counts, Cancelled left out blocks', async () => {
    const t = createTracker({ fetchFn: fakeFetch(blockedWorld()), env: envWith({ PLANE_CLOSED_STATES: 'Done, Duplicate' }), cachePath: fresh() })
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).toContain('TST-12')
    expect(keys).not.toContain('TST-1')
  })
  it('the RL-style list closes all three', async () => {
    const t = createTracker({ fetchFn: fakeFetch(blockedWorld()), env: envWith(), cachePath: fresh() })
    const keys = (await t.ready()).map((r) => r.key)
    expect(keys).toContain('TST-12')
    expect(keys).toContain('TST-1')
  })
  it('an empty value closes nothing, and does not look up a state named ""', async () => {
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_CLOSED_STATES: '' }), cachePath: fresh() })
    expect((await t.ready()).map((r) => r.key)).not.toContain('TST-9') // its Done blocker is no longer closed
  })
})

describe('plane-agent: PLANE_COMMENT_CAP', () => {
  const longComment = 'x'.repeat(COMMENT_CAP + 100)
  it('0 means no cap', async () => {
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_COMMENT_CAP: '0' }), cachePath: fresh() })
    await expect(t.comment('TST-5', longComment)).resolves.toMatchObject({ ok: true })
  })
  it('a number replaces the default and the message names it', async () => {
    const { w } = setup()
    const t = createTracker({ fetchFn: fakeFetch(w), env: envWith({ PLANE_COMMENT_CAP: '10' }), cachePath: fresh() })
    await expect(t.comment('TST-5', 'x'.repeat(11))).rejects.toThrow('comment is 11 chars, cap is 10')
    await expect(t.comment('TST-5', 'x'.repeat(10))).resolves.toMatchObject({ ok: true })
    expect(await t.comments('TST-5')).toHaveLength(1)
  })
  it('a larger cap lets a long comment through', async () => {
    const t = createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_COMMENT_CAP: '1000' }), cachePath: fresh() })
    await expect(t.comment('TST-5', longComment)).resolves.toMatchObject({ ok: true })
  })
  for (const bad of ['-1', '1.5', 'abc']) {
    it(`${bad} throws at construction`, () => {
      expect(() => createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_COMMENT_CAP: bad }), cachePath: fresh() })).toThrow('PLANE_COMMENT_CAP must be a non-negative integer')
    })
  }
})

describe('plane-agent: PLANE_MODULE_ALIAS', () => {
  const named = (name) => {
    const w = world()
    w.modules.splice(0, 1, { id: 'm-X', name })
    return w
  }
  it('unset: only the full module name resolves', async () => {
    const w = named('AI Program (P10)')
    const t = createTracker({ fetchFn: fakeFetch(w), env: envWithout('PLANE_MODULE_ALIAS'), cachePath: fresh() })
    await expect(t.create({ name: 'N', module: 'P10' })).rejects.toThrow('unknown module "P10"')
    await expect(t.create({ name: 'N', module: 'AI Program (P10)' })).resolves.toMatchObject({ ok: true })
  })
  it('a custom regex makes the match an alias', async () => {
    const w = named('Sprint seven [SPR-7]')
    const t = createTracker({ fetchFn: fakeFetch(w), env: envWith({ PLANE_MODULE_ALIAS: 'SPR-\\d+' }), cachePath: fresh() })
    await t.create({ name: 'N', module: 'SPR-7' })
    expect(w.calls).toContain('POST /modules/m-X/module-issues/')
  })
  it('the default RL-style alias does not apply once the regex is replaced', async () => {
    const w = named('AI Program (P10)')
    const t = createTracker({ fetchFn: fakeFetch(w), env: envWith({ PLANE_MODULE_ALIAS: 'SPR-\\d+' }), cachePath: fresh() })
    await expect(t.create({ name: 'N', module: 'P10' })).rejects.toThrow('unknown module "P10"')
  })
})

describe('plane-agent: known names in unknown-name errors', () => {
  it('state: lists the valid names', async () => {
    const { t } = setup()
    await expect(t.state('TST-5', 'Doing')).rejects.toThrow('unknown state "Doing"; known: Backlog, Todo, In Progress, Done, Cancelled, Duplicate')
  })
  it('label and module: list the valid names', async () => {
    const { t } = setup()
    await expect(t.label('TST-5', 'add', 'nonesuch')).rejects.toThrow('unknown label "nonesuch"; known: art, blocked:owner, rules, app')
    await expect(t.create({ name: 'N', module: 'P99' })).rejects.toThrow('unknown module "P99"; known: P10')
  })
  it('member: lists display names but not emails', async () => {
    const { t } = setup()
    const e = await t.update('TST-5', { assignees: ['zed'] }).catch((x) => x)
    expect(e.message).toBe('unknown member "zed"; known: ann, bob')
  })
  it('caps the list at 40 names', async () => {
    const w = world()
    for (let i = 0; i < 45; i++) w.labels.push({ id: `l-lab-${i}`, name: `lab-${i}` })
    const { t } = setup(w)
    const e = await t.label('TST-5', 'add', 'nonesuch').catch((x) => x)
    const known = e.message.split('; known: ')[1].split(', ')
    expect(known).toHaveLength(40)
    expect(known.at(-1)).toBe('lab-35')
  })
  it('a name that resolves is unaffected', async () => {
    const { t } = setup()
    await expect(t.label('TST-5', 'add', 'app')).resolves.toMatchObject({ ok: true })
  })
})

describe('plane-agent: cache location', () => {
  it('defaults to ~/.cache/plane-agent/<sha256(scope)[:16]>.json and creates the directory', async () => {
    const { home, t } = inTempHome(() => createTracker({ fetchFn: fakeFetch(world()), env: envWith() }))
    await t.show('TST-5')
    const file = join(home, '.cache', 'plane-agent', `${createHash('sha256').update(SCOPE).digest('hex').slice(0, 16)}.json`)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ scope: SCOPE, issues: { 'TST-5': 'i-5' } })
  })
  it('PLANE_CACHE overrides it, nested directories included', async () => {
    const target = join(tmpDir(), 'a', 'b', 'ids.json')
    const { home, t } = inTempHome(() => createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_CACHE: target }) }))
    await t.show('TST-5')
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(home, '.cache'))).toBe(false)
  })
  it('different projects get different default files', async () => {
    const a = inTempHome(() => createTracker({ fetchFn: fakeFetch(world()), env: envWith() }))
    const b = inTempHome(() => createTracker({ fetchFn: fakeFetch(world()), env: envWith({ PLANE_PROJECT_PREFIX: 'ZZZ' }) }))
    await a.t.show('TST-5')
    await expect(b.t.show('ZZZ-5')).resolves.toMatchObject({ key: 'ZZZ-5' })
    const name = (h) => readdirSync(join(h, '.cache', 'plane-agent'))[0]
    expect(name(a.home)).not.toBe(name(b.home))
  })
})

describe('plane-agent: help, verbs and the runner', () => {
  it('help, no verb and --help all return the HELP text, no key needed', async () => {
    for (const argv of [['help'], [], ['--help']]) expect(await main(argv, { env: {} })).toBe(HELP)
    expect(HELP).toContain('ready')
    expect(HELP).toContain('PLANE_SKIP_LABELS')
  })
  it('an unknown verb names itself and points at help', async () => {
    await expect(main(['frobnicate'], { env: {} })).rejects.toThrow('unknown verb "frobnicate"; run: plane-agent help')
  })

  const run = (args, env = {}) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  it('the runner prints a string raw', () => {
    const r = run(['help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`${HELP}\n`)
  })
  it('the runner prints an object as JSON', () => {
    const adapter = join(tmpDir('plane-agent-adapter-'), 'backend.mjs')
    writeFileSync(adapter, 'export function createTracker() { return { show: async key => ({key, name:"Other tracker"}) } }')
    const r = run(['show', 'bd-a1'], { TRACKER_ADAPTER: adapter })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ key: 'bd-a1', name: 'Other tracker' })
  })
  it('an error goes to stderr with exit 1', () => {
    const r = run(['bogus'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim()).toBe('plane-agent: unknown verb "bogus"; run: plane-agent help')
  })
  it('the runner sets exitCode instead of calling process.exit', () => {
    expect(readFileSync(ENTRY, 'utf8')).not.toMatch(/process\.exit\(/)
  })
})
