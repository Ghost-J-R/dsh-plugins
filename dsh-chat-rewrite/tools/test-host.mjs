#!/usr/bin/env node
/**
 * test-host.mjs — drive the Host half against a sandbox DSH home (no real data).
 *
 * Builds a throwaway $DSH_HOME inside .exp/, copies one real session into it,
 * then exercises /inspect, /apply, /restore and the live-session guard through
 * the plugin's own web route handler.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSessionLog } from './fixture.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-home')
const REAL_LOG = findSessionLog()
const SESSION = 'session-sandbox-test'
const PROJECT = '--E-Vibe~0020Coding-DeepSeek-Harness--'

// Fresh sandbox home with one staged session.
rmSync(SANDBOX, { recursive: true, force: true })
const sessionDir = join(SANDBOX, 'sessions', PROJECT, SESSION)
mkdirSync(sessionDir, { recursive: true })
copyFileSync(REAL_LOG, join(sessionDir, 'session.v4.jsonl.zstd'))
const originalBytes = readFileSync(join(sessionDir, 'session.v4.jsonl.zstd'))
const originalHash = (await import('node:crypto')).createHash('sha256').update(originalBytes).digest('hex')

// The plugin reads DSH_HOME at import time.
process.env.DSH_HOME = SANDBOX
const { apply } = await import(pathToFileURL(join(PACKAGE, 'lib', 'index.js')).href)

let route
let live = false
const ctx = {
  effect: (factory) => { factory() },
  get: (name) => (live && (name === 'sessions' || name === 'agents')
    ? { get: () => ({ live: true }) }
    : undefined),
  webServer: {
    register: (registered) => { route = registered; return () => {} },
  },
}
apply(ctx)
if (route === undefined) throw new Error('route was not registered')
console.log(`route   : ${route.kind} ${route.path}`)

function mockRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers) },
    end(body) { out.body = body === undefined ? '' : Buffer.from(body).toString('utf8') },
    out,
  }
}

async function get(path) {
  const res = mockRes()
  await route.handler({ url: `${route.path}${path}`, method: 'GET' }, res)
  return { status: res.out.status, data: JSON.parse(res.out.body) }
}

async function post(path, body) {
  const payload = Buffer.from(JSON.stringify(body))
  const req = {
    url: `${route.path}${path}`,
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield payload },
  }
  const res = mockRes()
  await route.handler(req, res)
  return { status: res.out.status, data: JSON.parse(res.out.body) }
}

let failures = 0
function check(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`) }
  else { failures++; console.log(`  FAIL  ${label}  ${detail ?? ''}`) }
}

// 1. inspect
const inspected = await get(`/rewrite-inspect?sessionId=${SESSION}`)
check('inspect 200', inspected.status === 200, JSON.stringify(inspected.data).slice(0, 120))
const baseAnchors = inspected.data.anchors?.length ?? 0
const baseTurns = inspected.data.turns ?? 0
// The fixture is whatever real session this machine stores, so assertions are
// relative to it rather than pinned to one machine's conversation.
check('inspect lists rounds', baseAnchors >= 2, `got ${baseAnchors}`)
check('inspect not live', inspected.data.live === false)
console.log(`  info  title「${inspected.data.title}」 ${inspected.data.events} events / ${baseTurns} turns`)

// 2. live guard: an agent owns the write handle, and this fake Host offers no
//    captured handle, so the rewrite must be refused rather than queued.
live = true
const blocked = await post('/rewrite-apply', { sessionId: SESSION, promptSeq: inspected.data.anchors.at(-1).promptSeq, mode: 'after', confirm: true })
check('live guard 409 SESSION_UNCAPTURED', blocked.status === 409 && blocked.data.error === 'SESSION_UNCAPTURED', JSON.stringify(blocked.data))
live = false

// 3. confirmation guard
const noConfirm = await post('/rewrite-apply', { sessionId: SESSION, promptSeq: inspected.data.anchors.at(-1).promptSeq, mode: 'after' })
check('confirmation required', noConfirm.status === 400 && noConfirm.data.error === 'CONFIRMATION_REQUIRED', JSON.stringify(noConfirm.data))

// 3b. back up the untouched original by hand — rewrites never do it themselves
const firstBackup = await post('/rewrite-backup-create', { sessionId: SESSION })
check('manual backup of the original', firstBackup.status === 200, JSON.stringify(firstBackup.data))

// 4. re-answer the last round (keep prompt, drop answer)
const last = inspected.data.anchors.at(-1)
const reapplied = await post('/rewrite-apply', { sessionId: SESSION, promptSeq: last.promptSeq, mode: 'after', confirm: true })
check('apply after 200', reapplied.status === 200, JSON.stringify(reapplied.data).slice(0, 160))
check('apply dropped events', reapplied.data.eventsAfter === last.cutAfter, `cut=${reapplied.data.eventsAfter} expected=${last.cutAfter}`)
const afterBytes = readFileSync(join(sessionDir, 'session.v4.jsonl.zstd'))
check('file changed on disk', afterBytes.length !== originalBytes.length, `${originalBytes.length} -> ${afterBytes.length}`)
const backups = readdirSync(join(SANDBOX, 'chat-rewrite', 'backups', SESSION))
check('rewrite wrote no backup of its own', backups.length === 1, JSON.stringify(backups))

// 5. re-inspect: "re-answer" keeps the prompt, so the round still exists but has no answer
const reinspected = await get(`/rewrite-inspect?sessionId=${SESSION}`)
check('re-answer keeps the round', reinspected.data.anchors?.length === baseAnchors,
  `got ${reinspected.data.anchors?.length} expected ${baseAnchors}`)
check('re-answer leaves it unanswered', reinspected.data.anchors.at(-1)?.answered === false)
check('re-inspect shrunk', reinspected.data.events === last.cutAfter, `got ${reinspected.data.events}`)

// 6. rewind past the last round (drop the whole round)
const rewound = await post('/rewrite-apply', {
  sessionId: SESSION,
  promptSeq: reinspected.data.anchors.at(-1).promptSeq,
  mode: 'before',
  confirm: true,
})
check('apply before 200', rewound.status === 200, JSON.stringify(rewound.data).slice(0, 160))
const afterRewind = await get(`/rewrite-inspect?sessionId=${SESSION}`)
check('rewind drops the round', afterRewind.data.anchors?.length === baseAnchors - 1,
  `got ${afterRewind.data.anchors?.length} expected ${baseAnchors - 1}`)
check('rewind leaves one round fewer', afterRewind.data.turns === baseTurns - 1,
  `got ${afterRewind.data.turns} expected ${baseTurns - 1}`)

// 7. restore the OLDEST backup (the untouched original), taken by hand in step 3b
const backupDir = join(SANDBOX, 'chat-rewrite', 'backups', SESSION)
const stamps = readdirSync(backupDir).sort()
check('the manual backup is still the only one', stamps.length === 1, JSON.stringify(stamps))
const restored = await post('/rewrite-restore', { sessionId: SESSION, stamp: stamps[0], confirm: true })
check('restore 200', restored.status === 200, JSON.stringify(restored.data))
const finalHash = (await import('node:crypto')).createHash('sha256')
  .update(readFileSync(join(sessionDir, 'session.v4.jsonl.zstd'))).digest('hex')
check('restored bytes identical', finalHash === originalHash, `${finalHash.slice(0, 12)} vs ${originalHash.slice(0, 12)}`)

// 8. unknown session
const missing = await get('/rewrite-inspect?sessionId=session-does-not-exist')
check('missing session 404', missing.status === 404 && missing.data.error === 'SESSION_NOT_FOUND', JSON.stringify(missing.data))

console.log('')
if (failures > 0) {
  console.log(`FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
