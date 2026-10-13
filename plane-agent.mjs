#!/usr/bin/env node
/**
 * plane-agent: a Plane CLI for coding agents. Names in, compact JSON out, verified writes.
 *
 *   plane-agent <verb> ...
 *     ready                              unblocked Todo, ranked: [{key,name,priority,labels}]
 *     show KEY-N                         {key,name,state,priority,labels,description}
 *     comments KEY-N                     [{id,at,text}]
 *     state KEY-N <state name>           {ok,key,state}
 *     comment KEY-N <markdown|->         md -> HTML, capped, read back; {ok,id}
 *     label KEY-N add|remove <label>     {ok,key,labels}
 *     create <name> [--state S] [--priority p] [--labels a,b] [--module M] [--desc md]
 *     selftest [KEY-N]                   live smoke; comments on KEY-N only if passed explicitly
 *
 * All verbs and configuration: README.md.
 * TRACKER_ADAPTER selects another module exporting createTracker(deps), without changing callers.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export const COMMENT_CAP = 400
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const rank = (p) => PRIORITY_RANK[p] ?? PRIORITY_RANK.none // an unknown priority must not NaN the sort
const csv = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c])

/** Tiny markdown -> HTML: paragraphs, lists, **bold**, *italic*, `code`, [text](http url). Everything else escaped. */
export function mdToHtml(md) {
  const inline = (raw) => {
    const code = []
    let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(`<code>${c}</code>`) - 1}\u0000`)
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)])
  }
  return md
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n')
      const tag = lines.every((l) => /^\s*[-*] /.test(l)) ? 'ul' : lines.every((l) => /^\s*\d+\. /.test(l)) ? 'ol' : ''
      if (tag) return `<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^\s*(?:[-*]|\d+\.) /, ''))}</li>`).join('')}</${tag}>`
      return `<p>${lines.map(inline).join('<br>')}</p>`
    })
    .join('')
}

const UNESC = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' }
/** Visible text of an HTML body; block tags become spaces so words never fuse. */
export function htmlToText(html) {
  return (html ?? '')
    .replace(/<\/?(?:p|li|ul|ol|br|div|h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:lt|gt|quot|#39|amp);/g, (e) => UNESC[e])
    .replace(/\s+/g, ' ')
    .trim()
}

const idOf = (x) => (typeof x === 'string' ? x : x?.issue_id ?? x?.id)
const SUMMARY_FIELDS = 'id,sequence_id,name,state,priority,labels,archived_at,is_draft'
const checkPriority = (p) => { if (!Object.hasOwn(PRIORITY_RANK, p)) throw new Error('priority must be urgent|high|medium|low|none') }

export function createTracker({ fetchFn = fetch, env = process.env, cachePath, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const key = env.PLANE_API_KEY
  if (!key) throw new Error('PLANE_API_KEY is not set')
  for (const v of ['PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_ID', 'PLANE_PROJECT_PREFIX']) if (!env[v]) throw new Error(`${v} is not set`)
  const project = env.PLANE_PROJECT_ID
  const prefix = env.PLANE_PROJECT_PREFIX
  const root = (env.PLANE_API_BASE || 'https://api.plane.so/api/v1').replace(/\/+$/, '')
  const workspace = `${root}/workspaces/${encodeURIComponent(env.PLANE_WORKSPACE_SLUG)}`
  const base = `${workspace}/projects/${encodeURIComponent(project)}`
  const scope = `${base}|${prefix}`
  const issueKey = (r) => `${prefix}-${r.sequence_id}`
  const SKIP_LABELS = csv(env.PLANE_SKIP_LABELS)
  const CLOSED_STATES = env.PLANE_CLOSED_STATES === undefined ? ['Done', 'Cancelled'] : csv(env.PLANE_CLOSED_STATES)
  const cap = env.PLANE_COMMENT_CAP ? Number(env.PLANE_COMMENT_CAP) : COMMENT_CAP
  if (!Number.isInteger(cap) || cap < 0) throw new Error('PLANE_COMMENT_CAP must be a non-negative integer (0 = no cap)')
  const alias = env.PLANE_MODULE_ALIAS ? new RegExp(env.PLANE_MODULE_ALIAS, 'g') : null
  // one id cache per endpoint/workspace/project/prefix, outside any repo by default
  cachePath ??= env.PLANE_CACHE || join(homedir(), '.cache', 'plane-agent', `${createHash('sha256').update(scope).digest('hex').slice(0, 16)}.json`)

  let cache
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    cache = {}
  }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache) || cache.scope !== scope) cache = { scope, issues: {} }
  // PLANE_NO_CACHE_WRITE: read-only callers (dashboards) must not create the id cache.
  const save = () => {
    if (env.PLANE_NO_CACHE_WRITE) return
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(cache))
  }
  // name -> uuid maps are fetched once per PROCESS, never read from disk: a server-side rename must
  // not route or write through a stale name. A Map, so inherited keys (toString, __proto__) never resolve.
  const maps = {}

  async function api(method, path, body, at = base) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetchFn(`${at}${path}`, {
        method,
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      })
      if (r.status === 429 && attempt < 5) {
        const retry = r.headers?.get('retry-after')
        const seconds = retry ? Number(retry) : NaN
        const delay = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 60000
        await r.text()
        if (delay > 120000) throw new Error(`${method} ${path}: retry delay exceeds 120s; retry later`)
        await sleep(Math.max(1000, Number.isFinite(delay) ? delay : 60000))
        continue
      }
      const text = await r.text()
      // status only: a server error body can echo the key or a comment we sent
      if (!r.ok) throw Object.assign(new Error(`${method} ${path} ${r.status}`), { status: r.status })
      try {
        return text ? JSON.parse(text) : null
      } catch {
        throw new Error(`${method} ${path}: response is not JSON`)
      }
    }
  }

  /** Every row of a list endpoint, following cursor pagination. */
  async function list(path) {
    const out = []
    let cursor = null
    for (;;) {
      const q = `${path.includes('?') ? '&' : '?'}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = await api('GET', path + q)
      if (!Array.isArray(page) && !Array.isArray(page?.results)) throw new Error(`${path}: unsupported list response`)
      out.push(...(Array.isArray(page) ? page : page.results))
      if (Array.isArray(page) || !page?.next_page_results || !page.next_cursor) return out
      if (cursor === page.next_cursor) throw new Error(`${path}: repeated pagination cursor`)
      cursor = page.next_cursor
    }
  }

  async function names(kind) {
    // PLANE_MODULE_ALIAS: a module also answers to what the regex matches in its name, e.g. \bP\d+\b: "AI Program (P11)" -> P11
    const keys = (r) => (kind === 'modules' ? [r.name, ...(alias && r.name ? r.name.match(alias) ?? [] : [])] : [r.name ?? r.title])
    // cache the PROMISE: rows resolved in parallel must share one fetch, or a big list storms Plane into 502s
    return (maps[kind] ??= (async () => {
      const pairs = (await list(`/${kind}/`)).flatMap((r) => kind === 'members'
        ? [r.member?.display_name, r.member?.email, r.display_name, r.email].filter(Boolean).map((k) => [k, r.member?.id ?? r.member_id ?? r.id])
        : keys(r).map((k) => [k, r.id]))
      // two modules claiming one phase code would file into whichever came last: refuse instead
      if (kind === 'modules') for (const [k, id] of pairs) if (pairs.some(([k2, id2]) => k2 === k && id2 !== id)) throw new Error(`two modules answer to "${k}"; rename one`)
      return new Map(pairs)
    })().catch((e) => { delete maps[kind]; throw e }))
  }

  /** name -> uuid. Unknown names never map to anything. */
  async function resolve(kind, name) {
    const map = await names(kind)
    const id = map.get(name)
    // list the valid names so a guessing agent corrects itself in one call
    if (typeof id !== 'string' || !id) throw new Error(`unknown ${kind.slice(0, -1)} "${name}"; known: ${[...map.keys()].filter((n) => !n.includes('@')).slice(0, 40).join(', ')}`)
    return id
  }
  const nameOf = async (kind, id) => [...(await names(kind))].find(([, v]) => v === id)?.[0] ?? id

  async function issueId(k) {
    if (typeof k !== 'string' || !k.startsWith(prefix + '-') || !/^\d+$/.test(k.slice(prefix.length + 1))) throw new Error(`bad issue key "${k}"`)
    cache.issues ??= {}
    if (!cache.issues[k]) {
      let row
      try { row = await api('GET', `/work-items/${encodeURIComponent(k)}/`, undefined, workspace) }
      catch (e) { if (e.status === 404) throw new Error(`unknown issue "${k}"`); throw e }
      if (!row?.id || idOf(row.project) !== project) throw new Error(`issue "${k}" is outside the configured project`)
      cache.issues[k] = row.id
      save()
    }
    return cache.issues[k]
  }
  const labelNames = (row) => Promise.all((row.labels ?? []).map((l) => (l?.name ? l.name : nameOf('labels', idOf(l)))))
  const summary = async (r) => ({ key: issueKey(r), name: r.name, state: await nameOf('states', idOf(r.state)), priority: r.priority || 'none', labels: await labelNames(r) })
  const readIssue = async (k) => api('GET', `/work-items/${await issueId(k)}/`)
  const verifyPatch = async (k, body) => {
    const id = await issueId(k)
    await api('PATCH', `/work-items/${id}/`, body)
    const row = await readIssue(k)
    for (const [field, value] of Object.entries(body)) {
      const got = field === 'description_html' ? htmlToText(row.description_html) : Array.isArray(value) ? (row[field] ?? []).map(idOf).sort() : idOf(row[field]) ?? row[field]
      const want = field === 'description_html' ? htmlToText(value) : Array.isArray(value) ? [...value].sort() : value
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${k}: ${field} read-back differs`)
    }
    return row
  }

  const t = {
    async list({ state, label, query, archived = false } = {}) {
      const sid = state ? await resolve('states', state) : null
      const lid = label ? await resolve('labels', label) : null
      const rows = await list(`/${archived ? 'archived-work-items' : 'work-items'}/?fields=${SUMMARY_FIELDS}${query ? ',description_stripped' : ''}`)
      const selected = rows.filter((r) => (!!r.archived_at === archived) && (!sid || idOf(r.state) === sid) && (!lid || (r.labels ?? []).some((l) => idOf(l) === lid)) && (!query || `${issueKey(r)} ${r.name} ${r.description_stripped ?? ''}`.toLowerCase().includes(query.toLowerCase())))
      selected.sort((a, b) => rank(a.priority) - rank(b.priority) || Number(a.sequence_id) - Number(b.sequence_id))
      return Promise.all(selected.map(summary))
    },
    async ready({ label } = {}) {
      const todo = await resolve('states', 'Todo')
      const closed = await Promise.all(CLOSED_STATES.map((s) => resolve('states', s)))
      const rows = await list(`/work-items/?fields=${SUMMARY_FIELDS}`)
      const stateOf = new Map(rows.map((r) => [r.id, idOf(r.state)]))
      const out = []
      for (const r of rows.filter((x) => idOf(x.state) === todo && !x.archived_at && !x.is_draft)) {
        const labels = await labelNames(r)
        // a skipped label asked for by name opts back in: `ready --label art`
        if (labels.some((l) => SKIP_LABELS.includes(l) && l !== label) || (label && !labels.includes(label))) continue
        const rel = await api('GET', `/work-items/${r.id}/relations/`)
        // a blocker we cannot see (other project) counts as open: fail safe
        if (!Array.isArray(rel?.blocked_by)) throw new Error(`${issueKey(r)}: unsupported relations response`)
        if ((rel?.blocked_by ?? []).some((b) => !closed.includes(stateOf.get(idOf(b))))) continue
        out.push({ key: issueKey(r), name: r.name, priority: r.priority || 'none', labels, seq: Number(r.sequence_id) })
      }
      out.sort((a, b) => rank(a.priority) - rank(b.priority) || a.seq - b.seq)
      return out.map(({ seq: _s, ...row }) => row)
    },

    async show(k) {
      const r = await readIssue(k)
      return {
        key: k,
        name: r.name,
        state: await nameOf('states', idOf(r.state)),
        priority: r.priority || 'none',
        labels: await labelNames(r),
        description: r.description_stripped ?? htmlToText(r.description_html),
      }
    },

    async comments(k) {
      const rows = await list(`/work-items/${await issueId(k)}/comments/`)
      return rows.map((c) => ({ id: c.id, at: c.created_at, text: htmlToText(c.comment_html) }))
    },

    async state(k, name) {
      await verifyPatch(k, { state: await resolve('states', name) })
      return { ok: true, key: k, state: name }
    },

    async comment(k, md) {
      if (cap && md.length > cap) throw new Error(`comment is ${md.length} chars, cap is ${cap}`)
      const html = mdToHtml(md)
      const id = await issueId(k)
      const made = await api('POST', `/work-items/${id}/comments/`, { comment_html: html })
      const stored = (await list(`/work-items/${id}/comments/`)).find((c) => c.id === made?.id)
      if (!stored) throw new Error(`comment ${made?.id} not found on read-back`)
      if (htmlToText(stored.comment_html) !== htmlToText(html)) {
        throw new Error(`comment ${made.id} read-back differs from what was sent (markdown or tags stored as text?)`)
      }
      return { ok: true, id: made.id }
    },

    async label(k, action, name) {
      if (!['add', 'remove'].includes(action)) throw new Error(`label action must be add|remove, got "${action}"`)
      const id = await issueId(k)
      const row = await api('GET', `/work-items/${id}/`)
      const have = (row.labels ?? []).map(idOf)
      const lid = await resolve('labels', name)
      const next = action === 'add' ? [...new Set([...have, lid])] : have.filter((x) => x !== lid)
      await verifyPatch(k, { labels: next })
      return { ok: true, key: k, labels: await Promise.all(next.map((x) => nameOf('labels', x))) }
    },

    async create({ name, state = 'Backlog', priority = 'none', labels = [], module, desc = '' }) {
      if (!name) throw new Error('create needs a name')
      checkPriority(priority)
      // every name resolves BEFORE the POST: a typo must not leave a created item behind to be duplicated on retry
      const body = {
        name,
        state: await resolve('states', state),
        priority,
        labels: await Promise.all(labels.map((l) => resolve('labels', l))),
        ...(desc ? { description_html: mdToHtml(desc) } : {}),
      }
      const mod = module ? await resolve('modules', module) : null
      const made = await api('POST', '/work-items/', body)
      if (mod) {
        try {
          await api('POST', `/modules/${mod}/module-issues/`, { issues: [made.id] })
        } catch (e) {
          throw new Error(`created ${issueKey(made)} but the module attach failed: ${e.message}`)
        }
      }
      return { ok: true, key: issueKey(made), id: made.id }
    },

    async update(k, { name, state, priority, labels, desc, parent, assignees, start, due } = {}) {
      const body = {}
      if (name !== undefined) { if (!name.trim()) throw new Error('name must not be empty'); body.name = name }
      if (state !== undefined) body.state = await resolve('states', state)
      if (priority !== undefined) { checkPriority(priority); body.priority = priority }
      if (labels !== undefined) body.labels = await Promise.all(labels.map((l) => resolve('labels', l)))
      if (desc !== undefined) body.description_html = mdToHtml(desc)
      if (parent !== undefined) body.parent = parent ? await issueId(parent) : null
      if (assignees !== undefined) body.assignees = await Promise.all(assignees.map((a) => resolve('members', a)))
      for (const [field, value] of [['start_date', start], ['target_date', due]]) if (value !== undefined) {
        if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('dates must be YYYY-MM-DD or empty')
        body[field] = value || null
      }
      if (!Object.keys(body).length) throw new Error('update needs at least one field')
      await verifyPatch(k, body)
      return { ok: true, key: k }
    },

    async relations(k) {
      const rel = await api('GET', `/work-items/${await issueId(k)}/relations/`)
      if (!Array.isArray(rel?.blocked_by)) throw new Error(`${k}: unsupported relations response`)
      const keys = new Map(Object.entries(cache.issues ?? {}).map(([key, id]) => [id, key]))
      const out = {}
      for (const [kind, ids] of Object.entries(rel)) {
        if (!Array.isArray(ids)) throw new Error(`${k}: unsupported relations response`)
        out[kind] = []
        for (const r of ids) {
          const id = idOf(r)
          if (!id) throw new Error(`${k}: relation has no issue id`)
          if (!keys.has(id) && (!r?.project_id || r.project_id === project)) {
            try {
              const row = await api('GET', `/work-items/${encodeURIComponent(id)}/?fields=id,sequence_id`)
              keys.set(id, issueKey(row))
            } catch (e) { if (e.status !== 404) throw e }
          }
          out[kind].push(keys.get(id) ?? id)
        }
      }
      return out
    },
    async block(k, action, blocker) {
      if (!['add', 'remove'].includes(action)) throw new Error('block action must be add|remove')
      const id = await issueId(k), other = await issueId(blocker)
      if (id === other) throw new Error('an issue cannot block itself')
      if (action === 'remove') {
        const rel = await t.relations(k)
        if (!rel.blocked_by.includes(blocker)) return { ok: true, key: k, blocked_by: rel.blocked_by }
        // v1 removes the pair, not one typed edge. Never delete a sibling relation accidentally.
        if (Object.entries(rel).some(([kind, ids]) => kind !== 'blocked_by' && ids.includes(blocker))) throw new Error('removing this blocker would also remove another relation; use the tracker UI')
      }
      await api('POST', `/work-items/${id}/relations/${action === 'remove' ? 'remove/' : ''}`, action === 'remove' ? { related_issue: other } : { relation_type: 'blocked_by', issues: [other] })
      const rel = await t.relations(k)
      if (rel.blocked_by.includes(blocker) !== (action === 'add')) throw new Error(`${k}: blocker read-back differs`)
      return { ok: true, key: k, blocked_by: rel.blocked_by }
    },
    async module(k, name) {
      const id = await issueId(k)
      const target = name ? await resolve('modules', name) : null
      const modules = await list('/modules/')
      const current = []
      for (const m of modules) {
        const rows = await list(`/modules/${m.id}/module-issues/`)
        if (rows.some((r) => idOf(r) === id)) current.push(m)
      }
      if (name === undefined) return { key: k, modules: current.map((m) => m.name) }
      // one phase per issue: detach first, read back, restore on failure.
      try {
        for (const m of current.filter(m => m.id !== target)) await api('DELETE', `/modules/${m.id}/module-issues/${id}/`)
        if (target && !current.some(m => m.id === target)) await api('POST', `/modules/${target}/module-issues/`, { issues: [id] })
        for (const ms of new Set([...current.map((m) => m.id), ...(target ? [target] : [])])) {
          const rows = await list(`/modules/${ms}/module-issues/`)
          if (rows.some((r) => idOf(r) === id) !== (ms === target)) throw new Error(`${k}: module read-back differs`)
        }
      } catch (e) {
        let restoration = 'previous membership restored'
        try {
          // live Plane 404s a DELETE for a membership that never landed: already absent, keep restoring
          if (target && !current.some(m => m.id === target)) await api('DELETE', `/modules/${target}/module-issues/${id}/`).catch((e) => { if (e.status !== 404) throw e })
          for (const m of current) await api('POST', `/modules/${m.id}/module-issues/`, { issues: [id] })
          for (const ms of new Set([...current.map(m => m.id), ...(target ? [target] : [])])) {
            const rows = await list(`/modules/${ms}/module-issues/`)
            if (rows.some(r => idOf(r) === id) !== current.some(m => m.id === ms)) throw new Error('restore read-back differs')
          }
        } catch { restoration = 'restore failed, check tracker UI' }
        throw new Error(`${k}: module move failed: ${e.message}; ${restoration}`)
      }
      return { ok: true, key: k, modules: target ? [await nameOf('modules', target)] : [] }
    },
    async request(method, path, body, scope = 'project') {
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method) || !['project', 'workspace', 'api'].includes(scope)) throw new Error('api needs GET|POST|PATCH|DELETE and scope project|workspace|api')
      if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\x00-\x20\\#]/.test(path) || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(path.split('?')[0]))) throw new Error('api path must be relative to its scope, without traversal')
      const result = await api(method, path, body, scope === 'api' ? root : scope === 'workspace' ? workspace : base)
      return method === 'GET' ? result : { ok: true, ...(result?.id ? { id: result.id } : {}) }
    },

    /** Live smoke. Read-only unless `commentOn` is passed explicitly. */
    async selftest(commentOn) {
      for (const s of ['Backlog', 'Todo', 'In Progress', ...CLOSED_STATES]) await resolve('states', s)
      for (const l of SKIP_LABELS) await resolve('labels', l)
      await list('/modules/')
      const rows = await t.ready()
      const out = { ok: true, ready: rows.length }
      if (commentOn) out.comment = (await t.comment(commentOn, 'tracker **selftest** `ok`')).id
      return out
    },
  }
  return t
}

// The whole contract for a cold agent: read once per session, then no other docs needed.
export const HELP = `plane-agent: Plane work items for coding agents. Output is JSON on stdout; errors go to stderr with exit 1.
Issues are keys like ABC-12. States, labels, modules and members are the names shown in Plane's UI;
an unknown name changes nothing and the error lists the valid ones.

Typical loop: ready -> state KEY "In Progress" -> (work) -> comment KEY "what changed" -> state KEY Done

What should I work on next?
  ready [--label L]             [{key,name,priority,labels}]: Todo items whose blockers are all closed, sorted by
                                priority (urgent first), then by issue number (oldest first). The first row is the pick.
                                Hides labels listed in PLANE_SKIP_LABELS (e.g. needs-a-human items).
                                --label L: only items carrying L, for an agent that works one kind of task;
                                naming a hidden label shows it again.
Find and read
  list [--state S] [--label L] [--query text] [--archived true]   any state, filtered
  search TEXT                   match key, title or description
  show KEY                      {key,name,state,priority,labels,description}
  comments KEY                  [{id,at,text}], plain text
  relations KEY                 {blocked_by:[KEY],blocking:[KEY],...}, open and closed alike; ready already skips blocked items
Change (each write is read back from Plane; a mismatch exits 1, so exit 0 means it stuck)
  state KEY "State"             move the issue
  comment KEY "markdown"        progress note; "-" reads stdin; capped at PLANE_COMMENT_CAP chars (default 400)
  label KEY add|remove L        keeps the other labels
  update KEY --name --desc --state --priority --labels a,b --parent KEY --assignees a,b --start --due YYYY-MM-DD
                                only the flags given change; --labels replaces the set; an empty value clears
  create "title" [--state S] [--priority urgent|high|medium|low|none] [--labels a,b] [--module M] [--desc md]
                                -> {ok,key}; unknown names fail before anything is created
  block KEY add|remove OTHER    KEY is blocked by OTHER
  module KEY [M|-]              no M: read; M: move to M; -: remove
Other
  selftest                      read-only connection check
  api GET|POST|PATCH|DELETE /path/ [json|-]   raw Plane REST, unverified; last resort`

function parseArgs(argv, allowed) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { pos.push(...argv.slice(i + 1)); break }
    if (argv[i].startsWith('--')) {
      const eq = argv[i].indexOf('=')
      const name = argv[i].slice(2, eq < 0 ? undefined : eq)
      if (!allowed.includes(name)) throw new Error(`unknown option --${name}`)
      if (eq >= 0) { opt[name] = argv[i].slice(eq + 1); continue }
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${name} needs a value`)
      opt[name] = argv[++i]
    }
    else pos.push(argv[i])
  }
  return { pos, opt }
}

export async function main(argv, deps = {}) {
  const [verb, ...rest] = argv
  const options = {
    create: ['state', 'priority', 'labels', 'module', 'desc'],
    update: ['name', 'state', 'priority', 'labels', 'desc', 'parent', 'assignees', 'start', 'due'],
    list: ['state', 'label', 'query', 'archived'], ready: ['label'], api: ['scope'],
  }
  const verbs = 'ready|list|search|show|comments|state|comment|label|create|update|relations|block|module|api|selftest'
  if (!verb || verb === 'help' || verb === '--help') return HELP
  if (!verbs.split('|').includes(verb)) throw new Error(`unknown verb "${verb}"; run: plane-agent help`)
  // Comment text (including --foo) remains literal; options are parsed only on verbs that accept them.
  const { pos, opt } = options[verb] ? parseArgs(rest, options[verb]) : { pos: rest, opt: {} }
  if (verb === 'search' && !pos.join(' ').trim()) throw new Error('search needs text')
  const env = deps.env ?? process.env
  const factory = env.TRACKER_ADAPTER && !deps.tracker ? (await import(pathToFileURL(resolvePath(env.TRACKER_ADAPTER)).href)).createTracker : createTracker
  if (typeof factory !== 'function') throw new Error('TRACKER_ADAPTER must export createTracker(deps)')
  const t = deps.tracker ?? await factory(deps)
  const text = (s) => (s === '-' ? readFileSync(0, 'utf8') : s)
  const values = (s) => s ? s.split(',') : []
  switch (verb) {
    case 'ready': return t.ready(opt)
    case 'list':
      if (opt.archived !== undefined && !['true', 'false'].includes(opt.archived)) throw new Error('--archived must be true|false')
      return t.list({ ...opt, archived: opt.archived === 'true' })
    case 'search': return t.list({ query: pos.join(' ') })
    case 'show': return t.show(pos[0])
    case 'comments': return t.comments(pos[0])
    case 'state': return t.state(pos[0], pos[1])
    case 'comment': return t.comment(pos[0], text(pos.slice(1).join(' ')))
    case 'label': return t.label(pos[0], pos[1], pos[2])
    case 'update': return t.update(pos[0], { ...opt, ...(opt.desc !== undefined && { desc: text(opt.desc) }), ...(opt.labels !== undefined && { labels: values(opt.labels) }), ...(opt.assignees !== undefined && { assignees: values(opt.assignees) }) })
    case 'relations': return t.relations(pos[0])
    case 'block': return t.block(pos[0], pos[1], pos[2])
    case 'module': return t.module(pos[0], pos[1] === '-' ? '' : pos[1])
    case 'api': return t.request(pos[0], pos[1], pos[2] === undefined ? undefined : JSON.parse(text(pos[2])), opt.scope)
    case 'create':
      return t.create({
        name: pos[0],
        ...(opt.state && { state: opt.state }),
        ...(opt.priority && { priority: opt.priority }),
        ...(opt.labels && { labels: opt.labels.split(',') }),
        ...(opt.module && { module: opt.module }),
        ...(opt.desc && { desc: text(opt.desc) }),
      })
    case 'selftest': return t.selftest(pos[0])
  }
}

// realpath both sides: npm links bins through symlinks, so argv[1] is rarely this file's own path
const self = (p) => { try { return realpathSync(p) } catch { return p } }
if (process.argv[1] && self(fileURLToPath(import.meta.url)) === self(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (out) => console.log(typeof out === 'string' ? out : JSON.stringify(out)),
    (e) => {
      console.error(`plane-agent: ${e.message}`)
      process.exitCode = 1 // not exit(1): on Windows that aborts with UV_HANDLE_CLOSING and exit 127 while fetch sockets close
    },
  )
}
