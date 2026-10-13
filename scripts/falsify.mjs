/**
 * Falsifies test/plane-agent.test.mjs against plane-agent.mjs.
 *
 *   npm run test:falsify        (~1 min)
 *
 * Breaks one rule of plane-agent.mjs at a time and requires the tests to go RED with real test
 * failures (not a syntax error or import crash), then restores the file and requires green. A find
 * string that no longer matches exactly once is STALE and counts as a failure. The original is held
 * in memory and rewritten on every catchable exit path; a hard kill leaves a .falsify.orig
 * sentinel and the next run refuses to start over it.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restoreFileOnExit } from './restore-on-exit.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = resolve(ROOT, 'plane-agent.mjs')
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs')
// A hard kill (TerminateProcess, SIGKILL) skips every exit hook, so the pre-mutation bytes also live in
// a gitignored sentinel. A leftover sentinel that differs from the file = a prior run died mid-mutation.
const SENTINEL = resolve(ROOT, '.falsify.orig')
const original = readFileSync(FILE, 'utf8')
if (existsSync(SENTINEL)) {
  if (readFileSync(SENTINEL, 'utf8') === original) unlinkSync(SENTINEL)
  else {
    console.error('STRANDED: a previous run died mid-mutation; plane-agent.mjs may be mutated.\nClean bytes: .falsify.orig. Restore: cp .falsify.orig plane-agent.mjs && rm .falsify.orig\n(or just delete the sentinel if you edited plane-agent.mjs on purpose since)')
    process.exit(2)
  }
}
writeFileSync(SENTINEL, original)
const restored = restoreFileOnExit(FILE)
process.on('exit', () => {
  if (readFileSync(FILE, 'utf8') === original && existsSync(SENTINEL)) unlinkSync(SENTINEL)
})

const REQUIRED = "['PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_ID', 'PLANE_PROJECT_PREFIX']"
const NAME_LOOKUP = "const id = map.get(name)\n    // list the valid names so a guessing agent corrects itself in one call\n    if (typeof id !== 'string' || !id) throw"

const MUTANTS = [
  // ranking and readiness
  ['rank: urgent no longer first', 'urgent: 0, high: 1', 'urgent: 9, high: 1'],
  ['rank: sequence tiebreak reversed', '|| a.seq - b.seq', '|| b.seq - a.seq'],
  ['skip: art issues no longer dropped', 'const SKIP_LABELS = csv(env.PLANE_SKIP_LABELS)', "const SKIP_LABELS = csv(env.PLANE_SKIP_LABELS).filter((l) => l !== 'art')"],
  ['skip: blocked:owner no longer dropped', 'const SKIP_LABELS = csv(env.PLANE_SKIP_LABELS)', "const SKIP_LABELS = csv(env.PLANE_SKIP_LABELS).filter((l) => l !== 'blocked:owner')"],
  ['blocked_by filter removed', '!closed.includes(stateOf.get(idOf(b)))', 'false'],
  ['unseen blocker treated as closed', '!closed.includes(stateOf.get(idOf(b)))', 'stateOf.has(idOf(b)) && !closed.includes(stateOf.get(idOf(b)))'],
  ['Done no longer counts as closed', 'csv(env.PLANE_CLOSED_STATES)', "csv(env.PLANE_CLOSED_STATES).filter((s) => s !== 'Done')"],
  ['Duplicate no longer counts as closed', 'csv(env.PLANE_CLOSED_STATES)', "csv(env.PLANE_CLOSED_STATES).filter((s) => s !== 'Duplicate')"],
  ['pagination stops after page one', '|| !page?.next_page_results ||', '|| true ||'],
  ['art ready ignores requested label', 'label && !labels.includes(label)', 'label'],
  ['unknown priority sorts as NaN', 'PRIORITY_RANK[p] ?? PRIORITY_RANK.none', 'PRIORITY_RANK[p]'],
  // comments
  ['comment cap off by one', 'md.length > cap)', 'md.length > cap + 1)'],
  ['comment cap removed', 'cap && md.length > cap)', 'false)'],
  ['comment read-back comparison removed', 'htmlToText(stored.comment_html) !== htmlToText(html)', 'false'],
  ['comment not-found check removed', 'if (!stored) throw', 'if (false) throw'],
  ['comment ack echoes the body', 'return { ok: true, id: made.id }', 'return { ok: true, id: made.id, body: html }'],
  // names, labels, modules
  ['unknown name maps to undefined silently', "if (typeof id !== 'string' || !id) throw new Error(`unknown", 'if (false) throw new Error(`unknown'],
  ['names resolved through inherited properties', NAME_LOOKUP, "const id = map.get(name) ?? Object.prototype[name]\n    if (!id) throw"],
  ['state ack echoes the row', 'return { ok: true, key: k, state: name }', "return { ok: true, key: k, state: name, row: await api('GET', `/work-items/${id}/`) }"],
  ['state sent as name, not uuid', "{ state: await resolve('states', name) }", '{ state: name }'],
  ['labels shown as uuids', "(row.labels ?? []).map((l) => (l?.name ? l.name : nameOf('labels', idOf(l))))", '(row.labels ?? []).map((l) => idOf(l))'],
  ['label add drops existing labels', '[...new Set([...have, lid])]', '[lid]'],
  ['create skips the module', 'if (mod) {', 'if (false) {'],
  ['module resolved after the POST', "const mod = module ? await resolve('modules', module) : null\n      const made = await api('POST', '/work-items/', body)", "const made = await api('POST', '/work-items/', body)\n      const mod = module ? await resolve('modules', module) : null"],
  ['create failure hides the created key', 'throw new Error(`created ${key} but ${e.message}`)', 'throw e'],
  ['create skips the issue read-back', "checkFields(key, await api('GET', `/work-items/${made.id}/`), body)", 'null'],
  ['create skips the module read-back', "if (!(await list(`/modules/${mod}/module-issues/`)).some((r) => idOf(r) === made.id)) throw", 'if (false) throw'],
  ['ready accepts an unknown --label', "if (label) await resolve('labels', label) //", '//'],
  ['blank comment cap disables the cap', 'env.PLANE_COMMENT_CAP?.trim()', 'env.PLANE_COMMENT_CAP'],
  ['module phase code is not a key', "[r.name, ...(alias && r.name ? r.name.match(alias) ?? [] : [])]", '[r.name, ...([] ?? r.name.match(alias))]'],
  ['two modules may claim one phase code', "if (kind === 'modules') for (const [k, id] of pairs)", 'if (false) for (const [k, id] of pairs)'],
  ['module detach sends the issue in a body, not the path', "api('DELETE', `/modules/${m.id}/module-issues/${id}/`)", "api('DELETE', `/modules/${m.id}/module-issues/`, { issues: [id] })"],
  ['module membership read from row.issue', 'rows.some((r) => idOf(r) === id)) current.push(m)', 'rows.some((r) => idOf(r.issue) === id)) current.push(m)'],
  ['restore aborts on the 404 of a destination that never attached', ".catch((e) => { if (e.status !== 404) throw e })", ''],
  ['name maps refetched on every lookup', 'return (maps[kind] ??= (async', 'return (maps[kind] = (async'],
  ['name maps seeded from the disk cache', 'const maps = {}', 'const maps = { states: new Map(Object.entries(cache.states ?? {})), labels: new Map(Object.entries(cache.labels ?? {})) }'],
  ['relation issue_id ignored', 'x?.issue_id ?? x?.id', 'x?.id'],
  // transport, auth, cache
  ['error message carries the response body', '`${method} ${path} ${r.status}`)', '`${method} ${path} ${r.status}: ${text}`)'],
  ['parse error carries the response text', '`${method} ${path}: response is not JSON`', '`${method} ${path}: ${text}`'],
  ['auth header wrong', "'X-API-Key': key", "'X-API-Key': 'x'"],
  ['cache file stores the key', 'JSON.stringify(cache))', 'JSON.stringify({ ...cache, key }))'],
  ['cache scope ignored', 'cache.scope !== scope', 'false'],
  ['missing key tolerated', "if (!key) throw new Error('PLANE_API_KEY is not set')", "if (false) throw new Error('PLANE_API_KEY is not set')"],
  ['writes skip read-back', 'if (JSON.stringify(got) !== JSON.stringify(want))', 'if (false)'],
  // markdown and argument parsing
  ['markdown converter stops escaping', 'replace(/[&<>"]/g', 'replace(/[&"]/g'],
  ['any link scheme accepted', '(https?:\\/\\/[^)\\s]+)\\)/g', '([^)\\s]+)\\)/g'],
  ['options parsed for every verb', 'options[verb] ? parseArgs(rest, options[verb])', 'true ? parseArgs(rest, options[verb] ?? [])'],
  ['unknown options silently accepted', 'if (!allowed.includes(name)) throw', 'if (false) throw'],

  // configuration through env
  ['PLANE_WORKSPACE_SLUG default restored', REQUIRED, "['PLANE_PROJECT_ID', 'PLANE_PROJECT_PREFIX']"],
  ['PLANE_PROJECT_ID default restored', REQUIRED, "['PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_PREFIX']"],
  ['PLANE_PROJECT_PREFIX default restored', REQUIRED, "['PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_ID']"],
  ['required-env check removed', "for (const v of " + REQUIRED + ") if (!env[v]) throw", "for (const v of []) if (!env[v]) throw"],
  ['default API base changed', "env.PLANE_API_BASE || 'https://api.plane.so/api/v1'", "env.PLANE_API_BASE || 'https://plane.example/api/v1'"],
  ['PLANE_API_BASE ignored', "(env.PLANE_API_BASE || 'https://api.plane.so/api/v1')", "('https://api.plane.so/api/v1')"],
  ['PLANE_SKIP_LABELS ignored', 'const SKIP_LABELS = csv(env.PLANE_SKIP_LABELS)', "const SKIP_LABELS = ['art', 'blocked:owner']"],
  ['skip labels default to art', 'csv(env.PLANE_SKIP_LABELS)', "csv(env.PLANE_SKIP_LABELS ?? 'art')"],
  ['csv does not trim', '.map((x) => x.trim())', '.map((x) => x)'],
  ['csv keeps empty entries', '.map((x) => x.trim()).filter(Boolean)', '.map((x) => x.trim())'],
  ['generic --label opt-in reverted to art only', 'SKIP_LABELS.includes(l) && l !== label', "SKIP_LABELS.includes(l) && !(label === 'art' && l === 'art')"],
  ['--label opts in every skipped label at once', 'SKIP_LABELS.includes(l) && l !== label', 'SKIP_LABELS.includes(l) && !label'],
  ['closed states default includes Duplicate', "['Done', 'Cancelled']", "['Done', 'Cancelled', 'Duplicate']"],
  ['closed states default loses Cancelled', "['Done', 'Cancelled']", "['Done']"],
  ['PLANE_CLOSED_STATES ignored', ': csv(env.PLANE_CLOSED_STATES)', ": ['Done', 'Cancelled']"],
  ['PLANE_CLOSED_STATES empty falls back to the default', 'env.PLANE_CLOSED_STATES === undefined', '!env.PLANE_CLOSED_STATES'],
  ['PLANE_COMMENT_CAP ignored', 'capRaw ? Number(capRaw) : COMMENT_CAP', 'COMMENT_CAP'],
  ['comment cap 0 still caps', 'cap && md.length > cap)', 'md.length > cap)'],
  ['negative comment cap accepted', '|| cap < 0)', ')'],
  ['non-integer comment cap accepted', '!Number.isInteger(cap) ||', ''],
  ['PLANE_MODULE_ALIAS ignored', "env.PLANE_MODULE_ALIAS ? new RegExp(env.PLANE_MODULE_ALIAS, 'g') : null", "new RegExp('\\\\bP\\\\d+[a-z]?\\\\b', 'g')"],
  ['module alias off', "env.PLANE_MODULE_ALIAS ? new RegExp(env.PLANE_MODULE_ALIAS, 'g') : null", 'null'],
  ['unknown-name error drops the known list', '"${name}"; known: ${[...map.keys()]', '"${name}"; known: ${[...[].keys()]'],
  ['known list includes emails', ".filter((n) => !n.includes('@'))", ''],
  ['known list uncapped', '.slice(0, 40)', ''],
  ['known list capped at 41', '.slice(0, 40)', '.slice(0, 41)'],
  ['PLANE_CACHE ignored', 'env.PLANE_CACHE || ', ''],
  ['default cache hash covers less than the scope', 'createHash(\'sha256\').update(scope)', "createHash('sha256').update(prefix)"],
  ['default cache directory not created', 'mkdirSync(dirname(cachePath), { recursive: true })', ''],
  ['PLANE_NO_CACHE_WRITE ignored', 'if (env.PLANE_NO_CACHE_WRITE) return', ''],
  ['old TRACKER_NO_CACHE_WRITE name still honoured', 'if (env.PLANE_NO_CACHE_WRITE) return', 'if (env.PLANE_NO_CACHE_WRITE || env.TRACKER_NO_CACHE_WRITE) return'],

  // help, verbs, runner
  ['no verb is an unknown verb, not help', "if (!verb || verb === 'help'", "if (verb === 'help'"],
  ['--help is an unknown verb', " || verb === '--help') return HELP", ') return HELP'],
  ['help returns an object', ' return HELP\n', " return { docs: 'README.md' }\n"],
  ['unknown verb message loses the hint', '; run: plane-agent help`', '`'],
  ['runner JSON-quotes strings', "typeof out === 'string' ? out : JSON.stringify(out)", 'JSON.stringify(out)'],
  ['runner never sets the exit code', 'process.exitCode = 1 //', '//'],
  ['runner calls process.exit', 'process.exitCode = 1 //', 'process.exit(1) //'],
]

const run = () => {
  const r = spawnSync(process.execPath, [VITEST, 'run', 'test/plane-agent.test.mjs'], { encoding: 'utf8', cwd: ROOT })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

let bad = 0
const check = (ok, name, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) bad++
}

const base = run()
check(base.code === 0, 'baseline green', 'tests fail before any mutation')
if (base.code !== 0) process.exit(1)

for (const [name, find, replace] of MUTANTS) {
  const n = original.split(find).length - 1
  if (n !== 1) {
    check(false, name, `STALE: find string matched ${n} times`)
    continue
  }
  writeFileSync(FILE, original.replace(find, () => replace))
  const r = run()
  check(r.code !== 0 && /Tests\s.*\d+ failed/.test(r.out), name, r.code === 0 ? 'SURVIVED: tests stayed green' : 'went red but not by a test failure (syntax/import crash?)')
}

restored()
const after = run()
check(after.code === 0, 'restored file is green', 'tests fail after restore')

console.log(bad ? `${bad} falsification problem(s)` : `All ${MUTANTS.length} mutants caught; restore green`)
process.exit(bad ? 1 : 0)
