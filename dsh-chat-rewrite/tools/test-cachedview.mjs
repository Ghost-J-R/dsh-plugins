#!/usr/bin/env node
/**
 * test-cachedview.mjs — the case that broke the live delete.
 *
 * `session-query` prepares a session for a cold read and caches it, so the
 * SessionStore can hold an id that has NO agent: no write handle, no append
 * cursor, nothing to release. Treating that as "owned" made every rewrite fall
 * back to the queue. The Host must rewrite the file directly and evict the cached
 * view so the reopened session renders the new history.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSessionLog } from './fixture.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-cachedview')
const REAL_LOG = findSessionLog()
const SESSION = 'session-cachedview-test'
const PROJECT = '--proj--'

rmSync(SANDBOX, { recursive: true, force: true })
const dir = join(SANDBOX, 'sessions', PROJECT, SESSION)
mkdirSync(dir, { recursive: true })
const logPath = join(dir, 'session.v4.jsonl.zstd')
copyFileSync(REAL_LOG, logPath)
const original = readFileSync(logPath)

process.env.DSH_HOME = SANDBOX
const { apply } = await import(pathToFileURL(join(PACKAGE, 'lib', 'index.js')).href)

/** The SessionStore shape the plugin pokes: a Map plus a `get` reader. */
const store = new Map([[SESSION, { id: SESSION, aCachedView: true }]])
const sessionsService = {
  store,
  get: (id) => store.get(id),
}
const agentsService = { get: () => undefined, resume: async () => { throw new Error('unexpected resume') } }

let route
const ctx = {
  effect: (factory) => { factory() },
  get: (name) => (name === 'sessions' ? sessionsService : name === 'agents' ? agentsService : undefined),
  webServer: { register: (registered) => { route = registered; return () => {} } },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx)

function mockRes() {
  const out = { status: 0, body: '' }
  return {
    writeHead(status) { out.status = status },
    end(body) { out.body = body === undefined ? '' : Buffer.from(body).toString('utf8') },
    out,
  }
}
async function call(path, method, body) {
  const res = mockRes()
  const req = method === 'GET'
    ? { url: `${route.path}${path}`, method: 'GET' }
    : { url: `${route.path}${path}`, method, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  await route.handler(req, res)
  let data
  try { data = JSON.parse(res.out.body) } catch { data = { raw: res.out.body } }
  return { status: res.out.status, data }
}

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}  ${detail ?? ''}`) }
}

// 1. inspect must separate "agent owns it" from "a cached view exists".
const before = await call(`/rewrite-inspect?sessionId=${SESSION}`, 'GET')
check('cached view is not reported live', before.data.live === false, JSON.stringify(before.data.live))
check('cached view reported separately', before.data.cachedView === true)
check('session is in the store', store.has(SESSION))

// 2. apply must rewrite instead of queueing.
const last = before.data.anchors.at(-1)
const applied = await call('/rewrite-apply', 'POST', {
  sessionId: SESSION,
  promptSeq: last.promptSeq,
  mode: 'after',
  confirm: true,
})
check('apply succeeded', applied.status === 200, JSON.stringify(applied.data).slice(0, 200))
check('nothing was released (no agent)', applied.data.released === false, JSON.stringify(applied.data.released))
check('cached view evicted', applied.data.evicted === true)
check('store no longer holds the stale view', !store.has(SESSION))
check('file rewritten', readFileSync(logPath).length !== original.length)
check('no automatic backup written', !existsSync(join(SANDBOX, 'chat-rewrite', 'backups', SESSION)))

// 3. the rewritten file is what the reader will see next.
const after = await call(`/rewrite-inspect?sessionId=${SESSION}`, 'GET')
check('round count reflects the rewrite', after.data.events === last.cutAfter, `events=${after.data.events} expected=${last.cutAfter}`)

// 4. an agent-owned session is still protected.
agentsService.get = (id) => (id === SESSION ? { id } : undefined)
const guarded = await call('/rewrite-apply', 'POST', {
  sessionId: SESSION,
  promptSeq: after.data.anchors.at(-1).promptSeq,
  mode: 'before',
  confirm: true,
})
check('agent-owned session still refused', guarded.status === 409 && guarded.data.error === 'SESSION_UNCAPTURED',
  JSON.stringify(guarded.data))

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL CACHED-VIEW CHECKS PASSED')
