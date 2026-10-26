#!/usr/bin/env node
/**
 * test-backups.mjs — backups are manual, and nothing automatic ever deletes them.
 *
 * The contract this suite pins:
 *  - a rewrite writes NO backup (the only disk write it makes is the replaced log);
 *  - `POST /backups/create` is the only way a backup appears;
 *  - a manual backup survives later rewrites;
 *  - `POST /backups/delete` / `/rewrite-backup-purge` need `confirm: true`;
 *  - no sweep route exists: nothing prunes a backup behind the user's back.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSessionLog } from './fixture.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-backups')
const REAL_LOG = findSessionLog()
const SESSION = 'session-backup-test'
const PROJECT = '--proj--'

rmSync(SANDBOX, { recursive: true, force: true })
const dir = join(SANDBOX, 'sessions', PROJECT, SESSION)
mkdirSync(dir, { recursive: true })
copyFileSync(REAL_LOG, join(dir, 'session.v4.jsonl.zstd'))

process.env.DSH_HOME = SANDBOX
const { apply } = await import(pathToFileURL(join(PACKAGE, 'lib', 'index.js')).href)

let route
const ctx = {
  effect: (factory) => { factory() },
  get: () => undefined,
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
const backupRoot = join(SANDBOX, 'chat-rewrite', 'backups')
const stampsOf = (id) => {
  const root = join(backupRoot, id)
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []
}

// 1. A rewrite must not leave a backup behind.
const inspected = await call(`/rewrite-inspect?sessionId=${SESSION}`, 'GET')
const anchor = inspected.data.anchors.at(-1)
const applied = await call('/rewrite-apply', 'POST', {
  sessionId: SESSION, promptSeq: anchor.promptSeq, mode: 'after', confirm: true,
})
check('apply succeeded', applied.status === 200, JSON.stringify(applied.data).slice(0, 120))
check('apply wrote no backup', stampsOf(SESSION).length === 0, JSON.stringify(stampsOf(SESSION)))
check('apply reports no backup', applied.data.backup === undefined)

// 2. Manual backup.
const created = await call('/rewrite-backup-create', 'POST', { sessionId: SESSION })
check('manual backup created', created.status === 200 && typeof created.data.stamp === 'string', JSON.stringify(created.data))
check('one backup on disk', stampsOf(SESSION).length === 1)

// 3. A later rewrite keeps the manual backup.
await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
const again = await call('/rewrite-apply', 'POST', {
  sessionId: SESSION, promptSeq: anchor.promptSeq, mode: 'before', confirm: true,
})
check('second rewrite still works', again.status === 200, JSON.stringify(again.data).slice(0, 120))
check('manual backup survived the rewrite', stampsOf(SESSION).length === 1)

// 4. Listing reports size and kind.
const list = await call(`/rewrite-backups?sessionId=${SESSION}`, 'GET')
const row = list.data.backups?.[0] ?? {}
check('list reports bytes', typeof row.bytes === 'number', JSON.stringify(row))
check('list marks it manual', row.kind === 'manual', JSON.stringify(row.kind))

// 5. Deletion needs confirmation, then works.
const noConfirm = await call('/rewrite-backup-purge', 'POST', { sessionId: SESSION })
check('purge refuses without confirmation', noConfirm.status === 400 && noConfirm.data.error === 'CONFIRMATION_REQUIRED')
const noConfirmOne = await call('/rewrite-backup-delete', 'POST', { sessionId: SESSION, stamp: row.stamp })
check('single delete refuses without confirmation', noConfirmOne.status === 400)
const deleted = await call('/rewrite-backup-delete', 'POST', { sessionId: SESSION, stamp: row.stamp, confirm: true })
check('single delete ok', deleted.status === 200 && deleted.data.remaining === 0, JSON.stringify(deleted.data))
check('backup removed from disk', stampsOf(SESSION).length === 0)

// 6. No sweep route: nothing prunes backups automatically.
const sweep = await call('/backups/sweep', 'POST', {})
check('sweep route is gone', sweep.data?.error === 'NOT_FOUND', JSON.stringify(sweep.data))

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL BACKUP CHECKS PASSED')
