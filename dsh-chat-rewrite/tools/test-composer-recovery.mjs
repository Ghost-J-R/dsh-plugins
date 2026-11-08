#!/usr/bin/env node
/**
 * test-composer-recovery.mjs — prove the client half repairs the "session
 * unavailable" state after a rewrite, without a browser.
 *
 * The client bundle loads through `window.__ModuleLoader__.load`, so a fake
 * window captures the factory; a fake Cordis context then lets the shell.overlay
 * registration hand out its `reload`, which is the exact function the panel calls
 * after a successful apply.
 *
 * No real session is touched: the "Session" here is a plain object with the two
 * fields the repair reads (`resync`, `removed`) and the notifier it pokes.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SESSION = 'session-composer-test'

// --- load the browser half through its own module protocol ------------------
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(specification) { loaded = specification },
  },
}
const stub = new Proxy(function stubComponent() { return null }, {
  get: (_target, key) => (key === 'then' ? undefined : stub),
  apply: () => null,
})
globalThis.require = (id) => (id === 'react' ? { ...stub, Fragment: stub, memo: (c) => c } : stub)
await import(`${new URL('../lib/client.cjs', import.meta.url).href}?cacheBust=${Date.now()}`)

const exports = loaded.factory(globalThis.require)

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}  ${detail ?? ''}`) }
}

/**
 * Build the client context the plugin needs, capturing every slot registration
 * so the shell.overlay inject face (which exposes `reload`) can be reached.
 */
function createContext(sessions) {
  const registrations = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: (name) => (name === 'sessions' ? sessions : name === 'styles' ? { insert: () => () => {} } : undefined),
    slots: {
      inject: (_name, callback) => callback(),
      register: (specification) => { registrations.push(specification); return { dispose() {} } },
    },
  }
  exports.apply(ctx)
  return { registrations, fullscreen: () => registrations.find((entry) => entry.name === 'shell.overlay') }
}

/** One fake resident Session, exactly the fields the repair touches. */
function createSession({ removed = true, resyncError = null, projections = null } = {}) {
  const calls = { resync: 0, markDirty: 0 }
  const session = {
    removed,
    ...projections === null ? {} : { projections },
    resync: async () => { calls.resync++; if (resyncError !== null) throw resyncError },
    notifier: { markDirty: () => { calls.markDirty++ } },
  }
  return { session, calls }
}

/**
 * A projection store stand-in recording what survives the guard: `lastCatalog`
 * is what a late frame would leave behind.
 * @returns {object} the store plus its observations.
 */
function createProjectionStore() {
  const store = {
    clears: 0,
    lastCatalog: undefined,
    clear() { this.clears++ },
    apply(key, value) { if (key === 'subagentCatalog') this.lastCatalog = value },
    applyCached() {},
    seed() {},
  }
  return store
}

/** A catalog snapshot that starts without the session and gains it on demand. */
function createList(sessionId) {
  let listed = false
  return {
    list: {
      getSnapshot: () => (listed
        ? { phase: 'ready', ids: [sessionId], byId: { [sessionId]: { sessionId } } }
        : { phase: 'ready', ids: [], byId: {} }),
    },
    relistSoon: (delayMs = 150) => { setTimeout(() => { listed = true }, delayMs) },
  }
}

// 1. The sticky flag is cleared once the catalog lists the session again.
{
  const { session, calls } = createSession()
  const catalog = createList(SESSION)
  const { fullscreen } = createContext({
    binding: (id) => (id === SESSION ? { session } : undefined),
    list: catalog.list,
  })
  const reload = fullscreen().inject().reload
  check('shell.overlay exposes reload', typeof reload === 'function')
  catalog.relistSoon()
  const started = Date.now()
  await reload(SESSION)
  check('removed cleared', session.removed === false, String(session.removed))
  check('resync ran once', calls.resync === 1, String(calls.resync))
  check('composer notified', calls.markDirty === 1, String(calls.markDirty))
  check('settled promptly', Date.now() - started < 1200, `${Date.now() - started}ms`)
}

// 2. A session that never returns is left alone: no clearing without a catalog row.
{
  const { session, calls } = createSession()
  const catalog = createList(SESSION)
  const { fullscreen } = createContext({
    binding: () => ({ session }),
    list: catalog.list,
  })
  const reload = fullscreen().inject().reload
  const started = Date.now()
  await reload(SESSION)
  const waited = Date.now() - started
  check('unlisted session keeps its flag', session.removed === true, String(session.removed))
  check('no composer notification for an absent session', calls.markDirty === 0, String(calls.markDirty))
  check('waited out the bounded window', waited >= 1500 && waited < 4000, `${waited}ms`)
}

// 3. A session that was never removed is not touched.
{
  const { session, calls } = createSession({ removed: false })
  const catalog = createList(SESSION)
  catalog.relistSoon(0)
  const { fullscreen } = createContext({ binding: () => ({ session }), list: catalog.list })
  const reload = fullscreen().inject().reload
  await reload(SESSION)
  check('healthy session untouched', session.removed === false && calls.markDirty === 0,
    JSON.stringify({ removed: session.removed, ...calls }))
}

// 4. A released generation (no binding) is a no-op, not a crash.
{
  const { fullscreen } = createContext({ binding: () => undefined, list: createList(SESSION).list })
  const reload = fullscreen().inject().reload
  let threw = false
  try { await reload(SESSION) } catch { threw = true }
  check('missing binding is a quiet no-op', threw === false)
}

// 5. A failing resync leaves the flag alone instead of half-repairing.
{
  const { session } = createSession({ resyncError: new Error('stream gone') })
  const catalog = createList(SESSION)
  catalog.relistSoon(0)
  const { fullscreen } = createContext({ binding: () => ({ session }), list: catalog.list })
  const reload = fullscreen().inject().reload
  let threw = false
  try { await reload(SESSION) } catch { threw = true }
  check('resync failure is contained', threw === false && session.removed === true,
    JSON.stringify({ threw, removed: session.removed }))
}

// 6. Deleted subagent sessions are forgotten: their summary rows are removed and
//    their ids are filtered out of every catalog a late frame can re-add them to.
{
  const ghost = 'deleted-subagent'
  const keptAgent = 'still-live-agent'
  const managerStore = createProjectionStore()
  const sessionStore = createProjectionStore()
  const mutations = []
  const { session } = createSession({ removed: false, projections: sessionStore })
  const catalog = createList(SESSION)
  catalog.relistSoon(0)
  const { fullscreen } = createContext({
    binding: () => ({ session }),
    list: catalog.list,
    manager: {
      projectionStore: () => managerStore,
      recordMutation: (mutation) => mutations.push(mutation),
    },
  })
  const reload = fullscreen().inject().reload
  await reload(SESSION, [ghost])
  check('deleted row is removed from the list summaries',
    mutations.length === 1 && mutations[0].kind === 'remove' && mutations[0].sessionId === ghost,
    JSON.stringify(mutations))
  check('manager store is cleared', managerStore.clears === 1, String(managerStore.clears))
  check('session store is cleared', sessionStore.clears === 1, String(sessionStore.clears))
  // The race that defeated a plain clear: a frame from the pre-truncation
  // generation arrives afterwards with a higher seq and carries the deleted id.
  managerStore.apply('subagentCatalog', [{ id: ghost }, { id: keptAgent }], 64)
  check('late frame cannot resurrect the deleted agent',
    Array.isArray(managerStore.lastCatalog)
    && managerStore.lastCatalog.length === 1
    && managerStore.lastCatalog[0].id === keptAgent,
    JSON.stringify(managerStore.lastCatalog))
}

// 7. Nothing was deleted: no summary mutation and no store touching.
{
  const managerStore = createProjectionStore()
  const sessionStore = createProjectionStore()
  const mutations = []
  const { session } = createSession({ removed: false, projections: sessionStore })
  const catalog = createList(SESSION)
  catalog.relistSoon(0)
  const { fullscreen } = createContext({
    binding: () => ({ session }),
    list: catalog.list,
    manager: { projectionStore: () => managerStore, recordMutation: (mutation) => mutations.push(mutation) },
  })
  const reload = fullscreen().inject().reload
  await reload(SESSION, [])
  check('no deletions leave the caches alone',
    mutations.length === 0 && managerStore.clears === 0 && sessionStore.clears === 0,
    JSON.stringify({ mutations, manager: managerStore.clears, session: sessionStore.clears }))
}

if (failures > 0) { console.log(`\nFAILED: ${failures}`); process.exit(1) }
console.log('\nALL COMPOSER-RECOVERY CHECKS PASSED')
