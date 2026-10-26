#!/usr/bin/env node
/**
 * test-release.mjs — prove the "delete on the spot" path.
 *
 * The Session controller drops every `AgentHandle` it receives, so no supported
 * API can release a session the running Host owns. The Host half records those
 * handles by wrapping `AgentRegistry.resume`; this test reproduces that shape
 * with a fake registry and checks the whole sequence:
 *
 *   resume() -> handle captured -> /apply -> dispose -> rewrite -> released:true
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSessionLog } from './fixture.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-release')
const REAL_LOG = findSessionLog()
const SESSION = 'session-release-test'
const PROJECT = '--E-Vibe~0020Coding-DeepSeek-Harness--'

rmSync(SANDBOX, { recursive: true, force: true })
const sessionDir = join(SANDBOX, 'sessions', PROJECT, SESSION)
mkdirSync(sessionDir, { recursive: true })
const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
copyFileSync(REAL_LOG, logPath)
const original = readFileSync(logPath)

process.env.DSH_HOME = SANDBOX
const { apply } = await import(pathToFileURL(join(PACKAGE, 'lib', 'index.js')).href)

/** A registry whose `resume` lives on the prototype, exactly like AgentRegistry. */
class FakeAgents {
  live = new Set()
  disposed = []

  async resume(options) {
    const id = options.resumeSessionId
    this.live.add(id)
    return {
      agent: { id, status: 'idle' },
      dispose: async () => {
        this.disposed.push(id)
        this.live.delete(id)
      },
    }
  }

  get(id) {
    return this.live.has(id) ? { id } : undefined
  }
}

const agents = new FakeAgents()
let route
const ctx = {
  effect: (factory) => { factory() },
  get: (name) => (name === 'agents' ? agents : undefined),
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

// The Host opens the session (this is what the controller does on follow).
await agents.resume({ resumeSessionId: SESSION })
const before = await call(`/rewrite-inspect?sessionId=${SESSION}`, 'GET')
check('session reported live before the rewrite', before.data.live === true)

const targets = before.data.anchors
const last = targets.at(-1)
const applied = await call('/rewrite-apply', 'POST', {
  sessionId: SESSION,
  promptSeq: last.promptSeq,
  mode: 'after',
  confirm: true,
})
check('apply succeeded on a live session', applied.status === 200, JSON.stringify(applied.data).slice(0, 200))
check('apply reports released', applied.data.released === true, JSON.stringify(applied.data.released))
check('agent disposed exactly once', agents.disposed.length === 1, JSON.stringify(agents.disposed))
check('handle released ownership', agents.live.size === 0)
check('file rewritten', readFileSync(logPath).length !== original.length)
check('no automatic backup written', !existsSync(join(SANDBOX, 'chat-rewrite', 'backups', SESSION)))

const after = await call(`/rewrite-inspect?sessionId=${SESSION}`, 'GET')
check('session no longer live', after.data.live === false)
check('prompt kept, answer dropped', after.data.events === last.cutAfter, `events=${after.data.events} expected=${last.cutAfter}`)
check('last round now unanswered', after.data.anchors.at(-1)?.answered === false)

// A second press must not resurrect or double-dispose anything.
const again = await call('/rewrite-apply', 'POST', {
  sessionId: SESSION,
  promptSeq: after.data.anchors.at(-1).promptSeq,
  mode: 'before',
  confirm: true,
})
check('second rewrite still works (cold path)', again.status === 200 && again.data.released === false, JSON.stringify(again.data).slice(0, 160))
check('no extra disposal', agents.disposed.length === 1)

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL RELEASE CHECKS PASSED')
