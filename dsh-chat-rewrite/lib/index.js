/**
 * dsh-chat-rewrite — Host half.
 *
 * Gives the browser half a small authenticated-when-mounted HTTP surface that
 * lists a session's human rounds and truly rewrites the stored session log
 * (delete the last rounds, or re-answer one round) by tail-truncating it at a
 * Zstandard frame boundary.
 *
 * Safety model:
 *  - a session the running Host still owns (opened in this app instance) is
 *    never touched: the in-memory log would diverge from the file and the next
 *    append would write non-monotonic sequences;
 *  - every apply copies the artifact aside first, then writes through a temp
 *    file and renames, then re-decodes the result to prove it is well formed;
 *  - only the current v4 generation is rewritten; older generations are left
 *    to the Host's own migration.
 *
 * The Host half intentionally imports nothing but Node builtins: an out-of-tree
 * plugin cannot rely on `@deepseek-ai/*` resolution from the packaged app.
 */

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildTruncated, decodeSessionLog, findRoundByMessage, planAnchors, summarize, verifyArtifact, SUPPORTED_VERSION,
} from './engine.js'

/** Cordis plugin name; must equal the npm package name for the Loader row. */
export const name = 'chat-rewrite'
/**
 * Services required before the plugin applies.
 *
 * `agents` is declared, not merely probed: Cordis runs this plugin only once
 * the registry exists, which is before the web application publishes its URL,
 * so the resume interception is in place before any client can restore a tab.
 * Probing instead (`ctx.get('agents')` during an earlier apply) raced the
 * session controller and left already-resumed sessions without a handle.
 */
export const inject = ['webServer', 'agents']

const API_PREFIX = '/chat-rewrite/api'
const SESSION_LOG = /^session\.v([1-9][0-9]*)\.jsonl\.zstd$/u
/** Backups are manual; nothing in the plugin prunes them. */
const MAX_BODY_BYTES = 64 * 1024
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/u

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const BACKUP_ROOT = join(DSH_HOME, 'chat-rewrite', 'backups')
const PENDING_ROOT = join(DSH_HOME, 'chat-rewrite', 'pending')

/**
 * Encode one raw string into a single safe path segment, exactly as the
 * Host's `encodeSegment` does, so the derived path matches what the Host
 * validates on read.
 * @param {string} raw - the string to encode.
 * @returns {string} the escaped segment.
 */
function encodeSegment(raw) {
  let out = ''
  for (const ch of raw) {
    if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch
    else out += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Locate the highest canonical generation of one stored session.
 * @param {string} sessionId - the session identity.
 * @returns {{path: string, version: number} | undefined} the selected log, or undefined when absent.
 */
function findLog(sessionId) {
  if (!SAFE_ID.test(sessionId)) return undefined
  let projects
  try {
    projects = readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return undefined
  }
  const segment = encodeSegment(sessionId)
  for (const project of projects) {
    const dir = join(SESSIONS_ROOT, project.name, segment)
    if (!existsSync(dir)) continue
    let best
    for (const entry of readdirSync(dir)) {
      const match = SESSION_LOG.exec(entry)
      if (match === null) continue
      const version = Number(match[1])
      if (best === undefined || version > best.version) best = { version, path: join(dir, entry) }
    }
    if (best !== undefined) return best
  }
  return undefined
}

/**
 * Liveness facts for one session.
 *
 * Only an **Agent** owns a persistence write handle: the agent loop opens it on
 * resume and keeps an append cursor, so rewriting the file under a live agent
 * would corrupt the next append. A published {@link Session} without an agent is
 * merely a cached in-memory view (session-query prepares one for cold reads); it
 * neither writes nor owns the file, so it must not block the rewrite — it only
 * has to be evicted afterwards so the next read re-reads the file.
 * @param {object} ctx - Host context.
 * @param {string} sessionId - the session identity.
 * @returns {{agent: boolean, session: boolean}} which store holds the id.
 */
function liveness(ctx, sessionId) {
  return {
    agent: ctx.get('agents')?.get?.(sessionId) !== undefined,
    session: ctx.get('sessions')?.get?.(sessionId) !== undefined,
  }
}

/**
 * Whether the running Host still owns this session's write handle.
 * @param {object} ctx - Host context.
 * @param {string} sessionId - the session identity.
 * @returns {boolean} true when an agent (write owner) is live.
 */
function isLive(ctx, sessionId) {
  return liveness(ctx, sessionId).agent
}

/**
 * Drop a cached in-memory Session so the next read comes from the rewritten file.
 * The store has no public delete, and the entry is a read-model cache owned by
 * this process; clearing it is the difference between "file changed" and "the UI
 * shows the change".
 * @param {object} ctx - Host context.
 * @param {string} sessionId - the session whose cached view to drop.
 * @returns {boolean} whether a cached view was dropped.
 */
function evictCachedSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const store = sessions?.store
  if (!(store instanceof Map) || !store.has(sessionId)) return false
  store.delete(sessionId)
  return true
}

/** Read and cap one JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Copy one artifact aside as a MANUAL backup.
 *
 * Backups are always an explicit user action: a rewrite never writes one on its
 * own, so the plugin adds no background writes at all. A manual backup means the
 * conversation matters, so it is never pruned automatically — not on a later
 * rewrite, and not when the conversation is deleted or archived. Only the user
 * deletes it, through `POST /rewrite-backup-delete` or `POST /rewrite-backup-purge`.
 *
 * @param {string} sessionId - owning session.
 * @param {Buffer} bytes - the artifact bytes to keep.
 * @param {object} meta - provenance recorded in `meta.json`.
 * @returns {{stamp: string, dir: string, file: string}} where it landed.
 */
function saveBackup(sessionId, bytes, meta) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const dir = join(BACKUP_ROOT, encodeSegment(sessionId), stamp)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, bytes)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, stamp, kind: 'manual' }, null, 2))
  return { stamp, dir, file }
}

/**
 * Snapshot one session's current log as a manual backup.
 * @param {string} sessionId - the session to copy.
 * @param {object} [meta] - extra provenance.
 * @returns {{status: number, value: object}} the HTTP result.
 */
function createBackup(sessionId, meta) {
  const loaded = loadSession(sessionId)
  if (loaded.error !== undefined) return { status: 409, value: loaded }
  const backup = saveBackup(sessionId, loaded.bytes, {
    sessionId,
    events: loaded.log.events.length,
    bytes: loaded.bytes.length,
    source: 'manual',
    ...meta,
  })
  return {
    status: 200,
    value: { ok: true, sessionId, stamp: backup.stamp, bytes: loaded.bytes.length, events: loaded.log.events.length },
  }
}

/** List the newest backups for one session. */
function listBackups(sessionId) {
  const root = join(BACKUP_ROOT, encodeSegment(sessionId))
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .map((stamp) => {
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(join(root, stamp, 'meta.json'), 'utf8'))
      } catch { /* an unreadable sidecar must not hide the artifact */ }
      let bytes
      try { bytes = statSync(join(root, stamp, 'session.v4.jsonl.zstd')).size } catch { bytes = undefined }
      return { stamp, bytes, ...meta }
    })
}

/**
 * Delete one backup of one session.
 * @param {string} sessionId - owning session.
 * @param {string} stamp - backup stamp from {@link listBackups}.
 * @returns {{status: number, value: object}} the HTTP result.
 */
function deleteBackup(sessionId, stamp) {
  if (typeof sessionId !== 'string' || typeof stamp !== 'string' || !/^[\w-]+$/u.test(stamp)) {
    return { status: 400, value: { error: 'BAD_REQUEST' } }
  }
  const dir = join(BACKUP_ROOT, encodeSegment(sessionId), stamp)
  if (!existsSync(dir)) return { status: 404, value: { error: 'BACKUP_NOT_FOUND' } }
  rmSync(dir, { recursive: true, force: true })
  const root = join(BACKUP_ROOT, encodeSegment(sessionId))
  let remaining = 0
  try { remaining = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length } catch { remaining = 0 }
  if (remaining === 0) rmSync(root, { recursive: true, force: true })
  return { status: 200, value: { ok: true, sessionId, stamp, remaining } }
}

/**
 * Delete every backup of one session.
 * @param {string} sessionId - owning session.
 * @returns {{status: number, value: object}} the HTTP result.
 */
function deleteAllBackups(sessionId) {
  if (typeof sessionId !== 'string') return { status: 400, value: { error: 'BAD_REQUEST' } }
  const root = join(BACKUP_ROOT, encodeSegment(sessionId))
  if (!existsSync(root)) return { status: 200, value: { ok: true, sessionId, removed: 0 } }
  const removed = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  rmSync(root, { recursive: true, force: true })
  return { status: 200, value: { ok: true, sessionId, removed } }
}

/** Replace one file atomically through a sibling temp file. */
function publishAtomically(path, bytes) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, bytes)
  try {
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Load, decode and plan one session; shared by inspect and apply. */
function loadSession(sessionId) {
  const found = findLog(sessionId)
  if (found === undefined) return { error: 'SESSION_NOT_FOUND' }
  if (found.version !== SUPPORTED_VERSION) {
    return { error: 'UNSUPPORTED_GENERATION', version: found.version }
  }
  const bytes = readFileSync(found.path)
  let log
  try {
    log = decodeSessionLog(bytes)
  } catch (error) {
    return { error: 'DECODE_FAILED', detail: String(error?.message ?? error) }
  }
  return { found, bytes, log }
}

/**
 * Agent handles captured from `ctx.agents.resume()`, keyed by session.
 *
 * `AgentHandle.dispose()` is a capability held by the caller, and the Session
 * controller drops it after taking `.agent`, so no supported API can release a
 * session that the running Host owns. `AgentRegistry.resume` is the single
 * funnel every resume passes through, and it is an ordinary prototype method,
 * so wrapping it once records each handle before its owner discards it.
 *
 * Two properties keep this working across plugin reloads:
 *  - the map lives on a `Symbol.for` key, so a re-imported module instance
 *    writes and reads the same table instead of splitting into two;
 *  - installation is idempotent and retried, because Cordis services become
 *    available asynchronously and `ctx.get('agents')` may be undefined during
 *    the first apply.
 *
 * This is deliberately narrow: read-only recording, no behaviour change, and
 * every failure degrades to the deferred (`/rewrite-queue`) path.
 */
const HANDLES_KEY = Symbol.for('dsh-chat-rewrite.agent-handles')
const agentHandles = globalThis[HANDLES_KEY] ?? (globalThis[HANDLES_KEY] = new Map())

/** Outcome of the most recent release attempt, exposed by `/rewrite-health` for diagnosis. */
let lastRelease
/** Recent resume observations, so `/rewrite-health` can separate "not intercepted" from "capture failed". */
const RESUME_LOG_KEY = Symbol.for('dsh-chat-rewrite.resume-log')
const resumeLog = globalThis[RESUME_LOG_KEY] ?? (globalThis[RESUME_LOG_KEY] = [])

/**
 * Install the handle wrapper once, or report that it is already installed.
 *
 * Two creation paths mint a handle that this plugin must be able to use later:
 * `resume` (open an existing session) and `create` (a new session, including a
 * forked child, which is created with a seed). A fork therefore never appears in
 * `resume`, and wrapping only that method left forked sessions unreleasable.
 *
 * @param {object} ctx - Host context that can reach the agent registry.
 * @returns {boolean} whether interception is in place after the call.
 */
function interceptResume(ctx) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return false
  }
  if (agents === undefined || agents === null) return false
  try {
    const proto = Object.getPrototypeOf(agents)
    if (proto === null || proto === undefined) return false
    let installed = false
    for (const [method, idOf] of [
      ['resume', (options) => options?.resumeSessionId],
      ['create', (options) => options?.sessionId],
    ]) {
      const original = proto[method]
      if (typeof original !== 'function') continue
      // A previous plugin instance may already have wrapped this prototype; the
      // shared map makes that wrapper authoritative for this instance too.
      if (original[HANDLES_KEY] === true) { installed = true; continue }
      const wrapped = async function capture(options) {
        const at = new Date().toISOString()
        let handle
        try {
          handle = await original.call(this, options)
        } catch (error) {
          recordResume(at, idOf(options), false, `threw: ${String(error?.message ?? error)}`)
          throw error
        }
        let captured = false
        try {
          const id = idOf(options) ?? handle?.agent?.id
          if (id !== undefined) {
            agentHandles.set(String(id), handle)
            captured = true
          }
        } catch (error) { recordResume(at, idOf(options), false, `capture: ${String(error?.message ?? error)}`) }
        recordResume(at, idOf(options) ?? handle?.agent?.id, true, captured ? 'captured' : 'no id')
        return handle
      }
      wrapped[HANDLES_KEY] = true
      proto[method] = wrapped
      installed = true
    }
    if (installed) ctx.logger?.info?.('chat-rewrite: agent-handle interception installed')
    return installed
  } catch (error) {
    ctx.logger?.warn?.(`chat-rewrite: agent-handle interception unavailable: ${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * Record one handle-creation observation for `/rewrite-health`.
 * @param {string} at - ISO timestamp.
 * @param {unknown} id - session id, when known.
 * @param {boolean} ok - whether the creation call itself succeeded.
 * @param {string} detail - capture outcome.
 */
function recordResume(at, id, ok, detail) {
  resumeLog.unshift({ at, id: String(id ?? '?'), ok, detail })
  resumeLog.length = Math.min(resumeLog.length, 12)
}

/**
 * Release one session so its log can be rewritten in place.
 * @param {object} ctx - Host context.
 * @param {string} sessionId - the session to release.
 * @returns {Promise<'cold'|'released'|'running'|'no-handle'|'failed'>} the outcome.
 */
async function releaseSession(ctx, sessionId) {
  if (!isLive(ctx, sessionId)) return 'cold'
  interceptResume(ctx)
  const handle = agentHandles.get(sessionId)
  if (handle === undefined) return 'no-handle'
  // Never cut a turn that is producing output.
  if (handle.agent?.status === 'running') return 'running'
  try {
    await handle.dispose()
  } catch (error) {
    ctx.logger?.warn?.(`chat-rewrite: releasing "${sessionId}" failed: ${String(error?.message ?? error)}`)
    return 'failed'
  }
  agentHandles.delete(sessionId)
  // The agent registry is the authority for "the write handle is gone": its
  // removal is what unwinds the agent scope that owned the persistence handle.
  // The published Session may linger briefly, so it must not decide this.
  const agents = ctx.get('agents')
  const stillOwned = agents?.get?.(sessionId) !== undefined
  if (stillOwned) lastRelease = { sessionId, outcome: 'still-owned', at: new Date().toISOString() }
  return stillOwned ? 'failed' : 'released'
}

/** GET /rewrite-inspect — everything the panel needs for one session. */
function inspect(ctx, sessionId) {
  const owned = liveness(ctx, sessionId)
  const loaded = loadSession(sessionId)
  if (loaded.error !== undefined) return loaded
  const { found, bytes, log } = loaded
  const summary = summarize(log)
  const anchors = planAnchors(log)
  return {
    sessionId,
    path: found.path,
    bytes: bytes.length,
    ...summary,
    live: owned.agent,
    cachedView: owned.session && !owned.agent,
    anchors,
  }
}

/** POST /rewrite-apply — rewrite the stored log so the chosen cut survives. */
async function applyCut(ctx, body) {
  const { sessionId, promptSeq, mode, confirm } = body
  if (typeof sessionId !== 'string' || typeof promptSeq !== 'number' || (mode !== 'before' && mode !== 'after')) {
    return { status: 400, value: { error: 'BAD_REQUEST' } }
  }
  if (confirm !== true) return { status: 400, value: { error: 'CONFIRMATION_REQUIRED' } }

  const loaded = loadSession(sessionId)
  if (loaded.error !== undefined) return { status: 409, value: loaded }

  // Release the Host's ownership first when the session is open in this
  // process: that closes its write handle, so the rewrite below cannot race a
  // live append. A session resumed before the interception was installed has no
  // handle; a session mid-turn is refused rather than interrupted.
  let released = false
  const outcome = await releaseSession(ctx, sessionId)
  if (outcome === 'running') return { status: 409, value: { error: 'SESSION_BUSY' } }
  if (outcome === 'no-handle') return { status: 409, value: { error: 'SESSION_UNCAPTURED' } }
  if (outcome === 'failed') return { status: 409, value: { error: 'SESSION_IS_LIVE' } }
  released = outcome === 'released'

  const anchor = planAnchors(loaded.log).find((candidate) => candidate.promptSeq === promptSeq)
  if (anchor === undefined) return { status: 409, value: { error: 'ANCHOR_NOT_FOUND' } }
  if ((mode === 'before' && !anchor.rewindable) || (mode === 'after' && anchor.deletable === false)) {
    return { status: 409, value: { error: 'NOT_REWINDABLE', reason: anchor.reason ?? 'inherited' } }
  }
  const cut = mode === 'before' ? anchor.cutBefore : anchor.cutAfter
  if (cut >= loaded.log.events.length) return { status: 409, value: { error: 'NOTHING_TO_DROP' } }

  let built
  try {
    built = buildTruncated(loaded.log, loaded.bytes, cut)
    verifyArtifact(built.bytes, cut + (built.reseeded ? 1 : 0), loaded.log)
  } catch (error) {
    return { status: 500, value: { error: 'BUILD_FAILED', detail: String(error?.message ?? error) } }
  }

  // No backup is written here: backups are an explicit user action, so a rewrite
  // adds exactly one disk write (the replaced artifact) and nothing else.
  publishAtomically(loaded.found.path, built.bytes)

  // A re-seeded cut appends a fresh inherited marker, so the artifact holds one
  // more event than the cut itself.
  const expectedEvents = cut + (built.reseeded ? 1 : 0)
  // Prove the file on disk is what the Host reader will accept.
  const reread = readFileSync(loaded.found.path)
  const verified = verifyArtifact(reread, expectedEvents, loaded.log)
  // Drop the cached in-memory view so the reopened session reads the new file.
  const evicted = evictCachedSession(ctx, sessionId)
  return {
    status: 200,
    value: {
      ok: true,
      cut,
      reseeded: built.reseeded,
      eventsBefore: loaded.log.events.length,
      eventsAfter: expectedEvents,
      dropped: built.dropped,
      framesCopied: built.copied,
      framesRecompressed: built.recompressed,
      bytesBefore: loaded.bytes.length,
      bytesAfter: reread.length,
      frames: verified.frames,
      released,
      // A cached in-memory view of the old log must go, otherwise the reopened
      // session keeps rendering the pre-rewrite history.
      evicted,
    },
  }
}

/** POST /rewrite-restore — put a backup back. */
function restore(ctx, body) {
  const { sessionId, stamp, confirm } = body
  if (typeof sessionId !== 'string' || typeof stamp !== 'string') {
    return { status: 400, value: { error: 'BAD_REQUEST' } }
  }
  if (confirm !== true) return { status: 400, value: { error: 'CONFIRMATION_REQUIRED' } }
  if (isLive(ctx, sessionId)) return { status: 409, value: { error: 'SESSION_IS_LIVE' } }
  const found = findLog(sessionId)
  if (found === undefined) return { status: 404, value: { error: 'SESSION_NOT_FOUND' } }
  const dir = join(BACKUP_ROOT, encodeSegment(sessionId), stamp)
  const file = join(dir, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) return { status: 404, value: { error: 'BACKUP_NOT_FOUND' } }
  let bytes
  try {
    bytes = readFileSync(file)
    decodeSessionLog(bytes)
  } catch (error) {
    return { status: 500, value: { error: 'BACKUP_UNREADABLE', detail: String(error?.message ?? error) } }
  }
  publishAtomically(found.path, bytes)
  return { status: 200, value: { ok: true, bytes: bytes.length, stamp } }
}

/** One rewrite waiting for the next application start, persisted by session. */
function pendingPath(sessionId) {
  return join(PENDING_ROOT, `${encodeSegment(sessionId)}.json`)
}

/**
 * Record a rewrite for the next application start. A session the running Host
 * owns cannot be rewritten in place, and no supported API releases it, so the
 * edit is deferred rather than refused.
 * @param {object} body - `{sessionId, turn, mode}`.
 * @returns {{status: number, value: object}} the HTTP result.
 */
function queueRewrite(body) {
  const { sessionId, turn, mode } = body
  if (typeof sessionId !== 'string' || !Number.isSafeInteger(turn)
    || (mode !== 'before' && mode !== 'after')) {
    return { status: 400, value: { error: 'BAD_REQUEST' } }
  }
  const loaded = loadSession(sessionId)
  if (loaded.error !== undefined) return { status: 409, value: loaded }
  const anchor = planAnchors(loaded.log).find((candidate) => candidate.turn === turn)
  if (anchor === undefined) return { status: 409, value: { error: 'ANCHOR_NOT_FOUND' } }
  if ((mode === 'before' && !anchor.rewindable) || (mode === 'after' && anchor.deletable === false)) {
    return { status: 409, value: { error: 'NOT_REWINDABLE', reason: anchor.reason ?? 'inherited' } }
  }
  mkdirSync(PENDING_ROOT, { recursive: true })
  writeFileSync(pendingPath(sessionId), `${JSON.stringify({
    sessionId,
    turn,
    mode,
    promptSeq: anchor.promptSeq,
    requestedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  return { status: 200, value: { queued: true, sessionId, turn, mode } }
}

/**
 * Apply every queued rewrite. Runs once while the Host boots, before any
 * client can open a session, so every target is cold and the file rewrite is
 * safe. Entries are re-resolved against the current log because the session
 * may have grown since the request.
 * @param {object} ctx - Host context.
 */
function applyPendingRewrites(ctx) {
  if (!existsSync(PENDING_ROOT)) return
  for (const entry of readdirSync(PENDING_ROOT)) {
    if (!entry.endsWith('.json')) continue
    const file = join(PENDING_ROOT, entry)
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      rmSync(file, { force: true })
      continue
    }
    try {
      if (isLive(ctx, record.sessionId)) continue
      const loaded = loadSession(record.sessionId)
      if (loaded.error !== undefined) {
        rmSync(file, { force: true })
        continue
      }
      const anchor = planAnchors(loaded.log).find((candidate) => candidate.turn === record.turn)
      if (anchor === undefined || (record.mode === 'before' && !anchor.rewindable)
        || (record.mode === 'after' && anchor.deletable === false)) {
        rmSync(file, { force: true })
        continue
      }
      const cut = record.mode === 'before' ? anchor.cutBefore : anchor.cutAfter
      if (cut >= loaded.log.events.length) {
        rmSync(file, { force: true })
        continue
      }
      const built = buildTruncated(loaded.log, loaded.bytes, cut)
      verifyArtifact(built.bytes, cut + (built.reseeded ? 1 : 0), loaded.log)
      publishAtomically(loaded.found.path, built.bytes)
      evictCachedSession(ctx, record.sessionId)
      rmSync(file, { force: true })
      ctx.logger?.info?.(`chat-rewrite: applied queued rewrite for "${record.sessionId}" (turn ${record.turn}, ${record.mode})`)
    } catch (error) {
      ctx.logger?.warn?.(`chat-rewrite: queued rewrite for "${record.sessionId}" failed: ${String(error?.message ?? error)}`)
      rmSync(file, { force: true })
    }
  }
}

/** Mounted prefix route: small JSON RPC over the Host web server. */
async function handler(ctx, req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    if (route === '/rewrite-inspect' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const value = inspect(ctx, sessionId)
      sendJson(res, value.error === undefined ? 200 : value.error === 'SESSION_NOT_FOUND' ? 404 : 409, value)
      return
    }
    if (route === '/rewrite-backups' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      sendJson(res, 200, { sessionId, backups: listBackups(sessionId) })
      return
    }
    if (route === '/rewrite-resolve' && req.method === 'GET') {
      // Map one assistant message to the human round it belongs to, so the
      // delete button rendered on that message targets a real cut.
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const messageId = url.searchParams.get('messageId') ?? ''
      const loaded = loadSession(sessionId)
      if (loaded.error !== undefined) {
        sendJson(res, loaded.error === 'SESSION_NOT_FOUND' ? 404 : 409, loaded)
        return
      }
      const anchor = findRoundByMessage(loaded.log, messageId)
      if (anchor === undefined) {
        sendJson(res, 404, { error: 'ROUND_NOT_FOUND', sessionId, messageId })
        return
      }
      sendJson(res, 200, {
        sessionId,
        live: isLive(ctx, sessionId),
        anchor,
        events: loaded.log.events.length,
      })
      return
    }
    if (route === '/rewrite-backup-create' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const result = createBackup(body.sessionId, body.note === undefined ? {} : { note: String(body.note) })
      sendJson(res, result.status, result.value)
      return
    }
    if (route === '/rewrite-backup-delete' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'CONFIRMATION_REQUIRED' })
        return
      }
      const result = deleteBackup(body.sessionId, body.stamp)
      sendJson(res, result.status, result.value)
      return
    }
    if (route === '/rewrite-backup-purge' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'CONFIRMATION_REQUIRED' })
        return
      }
      const result = deleteAllBackups(body.sessionId)
      sendJson(res, result.status, result.value)
      return
    }
    if (route === '/rewrite-queue' && req.method === 'POST') {
      const result = queueRewrite(await readJsonBody(req))
      sendJson(res, result.status, result.value)
      return
    }
    if (route === '/rewrite-pending' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const file = pendingPath(sessionId)
      sendJson(res, 200, {
        sessionId,
        pending: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
      })
      return
    }
    if (route === '/rewrite-health' && req.method === 'GET') {
      const agents = ctx.get('agents')
      const proto = agents === undefined ? undefined : Object.getPrototypeOf(agents)
      sendJson(res, 200, {
        interception: interceptResume(ctx),
        prototypePatched: proto?.resume?.[HANDLES_KEY] === true,
        interceptedPrototype: proto === undefined ? null : (proto.constructor?.name ?? 'anon'),
        captured: [...agentHandles.keys()],
        resumeLog: [...resumeLog],
        lastRelease,
      })
      return
    }
    if (route === '/rewrite-apply' && req.method === 'POST') {
      const result = await applyCut(ctx, await readJsonBody(req))
      sendJson(res, result.status, result.value)
      return
    }
    if (route === '/rewrite-restore' && req.method === 'POST') {
      const result = restore(ctx, await readJsonBody(req))
      sendJson(res, result.status, result.value)
      return
    }
    sendJson(res, 404, { error: 'NOT_FOUND', path: url.pathname })
  } catch (error) {
    sendJson(res, 500, { error: 'INTERNAL', detail: String(error?.message ?? error) })
  }
}

/**
 * Register the rewrite route.
 * @param {object} ctx - Host context carrying the web server.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => handler(ctx, req, res),
  }), 'chat-rewrite: routes')
  // Record the handles the Session controller discards, so a rewrite can
  // release a session the Host still owns instead of deferring it. The agent
  // service may not exist yet during composition, so install once now and
  // again as soon as Cordis reports it available.
  interceptResume(ctx)
  ctx.inject?.(['agents'], (scope) => { interceptResume(scope) })
  // Boot-time drain of rewrites deferred while a previous Host owned the session.
  // Runs during composition, before any client can open a session.
  try {
    applyPendingRewrites(ctx)
  } catch (error) {
    ctx.logger?.warn?.(`chat-rewrite: boot-time queue drain failed: ${String(error?.message ?? error)}`)
  }
}
