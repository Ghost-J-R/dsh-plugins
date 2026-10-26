#!/usr/bin/env node
/**
 * test-queue.mjs — prove the deferred-rewrite path end to end in a sandbox home.
 *
 * Simulates the real constraint: the first Host instance "owns" the session, so
 * `/rewrite-apply` refuses and the client queues. A second plugin load stands in for the
 * next application start, where the queue drains before any session opens.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSessionLog } from './fixture.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-queue')
const REAL_LOG = findSessionLog()
const SESSION = 'session-queue-test'
const PROJECT = '--E-Vibe~0020Coding-DeepSeek-Harness--'

rmSync(SANDBOX, { recursive: true, force: true })
const sessionDir = join(SANDBOX, 'sessions', PROJECT, SESSION)
mkdirSync(sessionDir, { recursive: true })
const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
copyFileSync(REAL_LOG, logPath)
const original = readFileSync(logPath)
const originalHash = createHash('sha256').update(original).digest('hex')

process.env.DSH_HOME = SANDBOX
const { apply } = await import(pathToFileURL(join(PACKAGE, 'lib', 'index.js')).href)

function mockRes() {
  const out = { status: 0, body: '' }
  return {
    writeHead(status) { out.status = status },
    end(body) { out.body = body === undefined ? '' : Buffer.from(body).toString('utf8') },
    out,
  }
}

/** Boot one plugin instance; `live` decides whether the Host owns the session. */
function boot(live) {
  let route
  const ctx = {
    effect: (factory) => { factory() },
    get: (name) => (live && (name === 'sessions' || name === 'agents')
      ? { get: () => ({ live: true }) }
      : undefined),
    webServer: { register: (registered) => { route = registered; return () => {} } },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx)
  return async (path, body) => {
    const res = mockRes()
    const req = body === undefined
      ? { url: `${route.path}${path}`, method: 'GET' }
      : { url: `${route.path}${path}`, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    await route.handler(req, res)
    let data
    try { data = JSON.parse(res.out.body) } catch { data = { raw: res.out.body } }
    return { status: res.out.status, data }
  }
}

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}  ${detail ?? ''}`) }
}

// ---- instance 1: the session is owned by the running Host ------------------
const first = await boot(true)
const inspected = await first(`/rewrite-inspect?sessionId=${SESSION}`)
check('inspect reports live', inspected.status === 200 && inspected.data.live === true)

const lastTurn = inspected.data.turns
const direct = await first('/rewrite-apply', {
  sessionId: SESSION,
  promptSeq: inspected.data.anchors.at(-1).promptSeq,
  mode: 'after',
  confirm: true,
})
check('apply refused while owned', direct.status === 409 && direct.data.error === 'SESSION_UNCAPTURED', JSON.stringify(direct.data))

const queued = await first('/rewrite-queue', { sessionId: SESSION, turn: lastTurn, mode: 'before' })
check('queue accepted', queued.status === 200 && queued.data.queued === true, JSON.stringify(queued.data))
check('queue file written', existsSync(join(SANDBOX, 'chat-rewrite', 'pending', `${SESSION}.json`)))
check('file untouched while queued',
  createHash('sha256').update(readFileSync(logPath)).digest('hex') === originalHash)

// ---- instance 2: next application start, nothing owns the session ---------
await boot(false)
const after = await boot(false) // idempotent second load must not double-apply
check('queue drained on boot', !existsSync(join(SANDBOX, 'chat-rewrite', 'pending', `${SESSION}.json`)))
const bytes = readFileSync(logPath)
check('file rewritten on boot', bytes.length !== original.length, `${original.length} -> ${bytes.length}`)
const backupRoot = join(SANDBOX, 'chat-rewrite', 'backups', SESSION)
check('no automatic backup recorded', !existsSync(backupRoot))

const verify = await after(`/rewrite-inspect?sessionId=${SESSION}`)
check('rewound to the previous round', verify.data.turns === lastTurn - 1, `turns=${verify.data.turns}`)
check('session still readable', verify.status === 200 && verify.data.events > 0)

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL QUEUE CHECKS PASSED')
