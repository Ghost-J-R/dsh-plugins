#!/usr/bin/env node
/**
 * test-cascade.mjs — a cut also removes the subagent sessions it unlinks.
 *
 * Subagent conversations are ordinary session logs that the Host discovers as
 * children of their parent. Truncating the parent's log therefore leaves them
 * alive and openable, which is the bug this suite pins: every child whose
 * creation record sits inside the dropped region is released and its log
 * deleted, descendants included — while a forked copy of the conversation is
 * kept, and a child that is still running blocks the whole operation.
 *
 * The fixture is synthetic so the suite runs on any machine: a parent log with
 * three catalog links (child A created before the cut, child B after it, and a
 * seeded session wrongly listed as a child), plus a grandchild under B.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-cascade')
const PROJECT = '--proj--'
const PARENT = 'session-cascade-parent'
const CHILD_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const CHILD_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const GRANDCHILD = 'cccccccc-0000-4000-8000-000000000003'
const FORK = 'session-forked-copy'
/** Second scenario: cold parent, live child, and no captured handle for it. */
const PARENT2 = 'session-cascade-parent-cold'
const CHILD_C = 'dddddddd-0000-4000-8000-000000000004'

/** Compress one frame exactly like the Host writer (checksum on). */
const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'), {
  params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
})

/**
 * Write a minimal valid session log.
 * @param {string} dir - session directory.
 * @param {object} header - session header.
 * @param {object[]} events - events, numbered densely from 0.
 */
function writeLog(dir, header, events) {
  mkdirSync(dir, { recursive: true })
  const numbered = events.map((event, index) => ({ seq: index, time: 1_792_000_000_000 + index, ...event }))
  const frames = [frame(`${JSON.stringify(header)}\n`)]
  if (numbered.length > 0) frames.push(frame(`${numbered.map((event) => JSON.stringify(event)).join('\n')}\n`))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

/** One human round, so the cut lands on a real anchor. */
const round = (turn, text) => [
  { type: 'turn/start', data: { turn } },
  { type: 'user/message', data: { id: `prompt-${turn}`, turn, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  { type: 'assistant/message', data: { turn, message: { id: `answer-${turn}`, role: 'assistant', content: [{ type: 'text', text: `答复 ${turn}` }] } } },
  { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
]

rmSync(SANDBOX, { recursive: true, force: true })
const logs = join(SANDBOX, 'sessions', PROJECT)
const header = (id, extra) => ({ type: 'session', version: 4, id, createdAt: 1_792_000_000_000, cwd: 'E:\\proj', isSeeded: false, delegationDepth: 0, agentPreset: 'standard', ...extra })

// Round 1 and 2 happen before any delegation; child A is created after round 2,
// child B and the (mis-listed) fork after round 3.
writeLog(join(logs, PARENT), header(PARENT), [
  ...round(1, '第一轮'),
  ...round(2, '第二轮'),
  { type: 'subagent/catalog', data: { version: 0, childId: CHILD_A, mode: 'one-shot', label: '早于切点的子会话' } },
  { type: 'team/member', data: { version: 2, teamId: PARENT, member: { id: CHILD_A, name: 'early', phase: 'active' } } },
  ...round(3, '第三轮'),
  { type: 'subagent/catalog', data: { version: 0, childId: CHILD_B, mode: 'continuable', label: '切点之后的子会话' } },
  { type: 'subagent/catalog', data: { version: 0, childId: FORK, mode: 'continuable', label: '误列为一个子会话的 fork' } },
])
writeLog(join(logs, CHILD_A), header(CHILD_A, { origin: 'subagent', parentSession: PARENT, delegationDepth: 1 }), round(1, '子会话 A'))
writeLog(join(logs, CHILD_B), header(CHILD_B, { origin: 'subagent', parentSession: PARENT, delegationDepth: 1 }), [
  ...round(1, '子会话 B'),
  { type: 'subagent/catalog', data: { version: 0, childId: GRANDCHILD, mode: 'one-shot', label: '孙会话' } },
])
writeLog(join(logs, GRANDCHILD), header(GRANDCHILD, { origin: 'subagent', parentSession: CHILD_B, delegationDepth: 2 }), round(1, '孙会话'))
// A fork is an independent copy: seeded, no origin, depth 0.
writeLog(join(logs, FORK), header(FORK, { isSeeded: true, parentSession: PARENT, delegationDepth: 0 }), round(1, 'fork 副本'))
// Second parent: cold in the Host, but its child is live and has no captured handle.
// The delegation happens *inside* round 2, so cutting before round 2 drops it.
writeLog(join(logs, PARENT2), header(PARENT2), [
  ...round(1, '冷父第一轮'),
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'user/message', data: { id: 'prompt-cold-2', turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '冷父第二轮' }] } },
  { type: 'subagent/catalog', data: { version: 0, childId: CHILD_C, mode: 'one-shot', label: '冷父的子会话' } },
  { type: 'assistant/message', data: { turn: 2, message: { id: 'answer-cold-2', role: 'assistant', content: [{ type: 'text', text: '答复 2' }] } } },
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
])
writeLog(join(logs, CHILD_C), header(CHILD_C, { origin: 'subagent', parentSession: PARENT2, delegationDepth: 1 }), round(1, '子会话 C'))

process.env.DSH_HOME = SANDBOX
const { apply } = await import(pathToFileURL(join(PACKAGE, 'lib', 'index.js')).href)

/**
 * Fake Agent registry. `resume` lives on the prototype exactly like the real
 * AgentRegistry so the plugin's interception captures the returned handle, which
 * is the capability a live parent needs before it can be rewritten.
 */
class FakeAgents {
  live = new Map()

  async resume(options) {
    const id = options.resumeSessionId
    const live = this.live
    live.set(id, 'idle')
    return {
      agent: { id, get status() { return live.get(id) } },
      dispose: async () => { live.delete(id) },
    }
  }

  get(id) {
    return this.live.has(id) ? { id, status: this.live.get(id) } : undefined
  }
}

/** Fake Host services: which sessions look live, and what drainChildren receives. */
const agents = new FakeAgents()
const drained = []
let route
const ctx = {
  effect: (factory) => { factory() },
  get: (name) => {
    if (name === 'agents') return agents
    if (name === 'subagents') {
      return {
        drainChildren: async (_parent, ids) => {
          drained.push(...ids)
          for (const id of ids) if (agents.live.get(id) !== 'running') agents.live.delete(id)
        },
      }
    }
    return undefined
  },
  webServer: { register: (registered) => { route = registered; return () => {} } },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx)
// The parent is open in the app, so its handle is captured by the interception.
await agents.resume({ resumeSessionId: PARENT })

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
const dirOf = (id) => join(logs, id)

// 1. inspect exposes the creation coordinates the panel needs.
const inspected = await call(`/rewrite-inspect?sessionId=${PARENT}`, 'GET')
check('inspect 200', inspected.status === 200, JSON.stringify(inspected.data).slice(0, 120))
check('inspect lists the three catalog links', inspected.data.subagents?.length === 3,
  JSON.stringify(inspected.data.subagents))
check('child A is announced before the cut',
  (inspected.data.subagents ?? []).find((link) => link.childId === CHILD_A)?.seq < 15)
const anchor3 = (inspected.data.anchors ?? []).find((anchor) => anchor.turn === 3)
check('turn 3 anchor exists', anchor3 !== undefined)

// 2. A running child blocks the cut before anything is written.
agents.live.set(PARENT, 'idle')
agents.live.set(CHILD_B, 'running')
const blocked = await call('/rewrite-apply', 'POST', {
  sessionId: PARENT, promptSeq: anchor3.promptSeq, mode: 'before', confirm: true,
})
check('running child refuses the cut', blocked.status === 409 && blocked.data.error === 'SESSION_BUSY_CHILD',
  JSON.stringify(blocked.data))
check('nothing deleted while blocked', existsSync(dirOf(CHILD_B)) && existsSync(dirOf(PARENT)))
agents.live.set(CHILD_B, 'idle')

// 3. Cut before round 3: drops child B (and its grandchild) but keeps child A and the fork.
const applied = await call('/rewrite-apply', 'POST', {
  sessionId: PARENT, promptSeq: anchor3.promptSeq, mode: 'before', confirm: true,
})
check('apply 200', applied.status === 200, JSON.stringify(applied.data).slice(0, 200))
check('child B removed', applied.data.cascade?.deleted?.includes(CHILD_B), JSON.stringify(applied.data.cascade))
check('grandchild removed recursively', applied.data.cascade?.deleted?.includes(GRANDCHILD),
  JSON.stringify(applied.data.cascade))
check('child A kept (created before the cut)', existsSync(dirOf(CHILD_A)))
check('child B log is gone', !existsSync(dirOf(CHILD_B)))
check('grandchild log is gone', !existsSync(dirOf(GRANDCHILD)))
check('fork copy kept', existsSync(dirOf(FORK)))
check('fork reported as skipped', applied.data.cascade?.skipped?.includes(FORK), JSON.stringify(applied.data.cascade))
check('drainChildren saw the live child', drained.includes(CHILD_B), JSON.stringify(drained))
check('parent log still readable', (await call(`/rewrite-inspect?sessionId=${PARENT}`, 'GET')).status === 200)
check('kept catalog no longer lists child B',
  !((await call(`/rewrite-inspect?sessionId=${PARENT}`, 'GET')).data.subagents ?? []).some((link) => link.childId === CHILD_B))

// 4. Cold parent, live child, no captured handle: the child cannot be released,
//    so its log must be kept and the failure reported instead of silently lost.
agents.live.set(CHILD_C, 'idle')
const inspected2 = await call(`/rewrite-inspect?sessionId=${PARENT2}`, 'GET')
const anchor2 = (inspected2.data.anchors ?? []).find((anchor) => anchor.turn === 2)
const applied2 = await call('/rewrite-apply', 'POST', {
  sessionId: PARENT2, promptSeq: anchor2.promptSeq, mode: 'before', confirm: true,
})
check('cold-parent apply still succeeds', applied2.status === 200, JSON.stringify(applied2.data).slice(0, 200))
check('unreleasable child is reported as failed',
  (applied2.data.cascade?.failed ?? []).some((entry) => entry.id === CHILD_C),
  JSON.stringify(applied2.data.cascade))
check('unreleasable child log is kept', existsSync(dirOf(CHILD_C)))

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL CASCADE CHECKS PASSED')
