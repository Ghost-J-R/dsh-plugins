#!/usr/bin/env node
/**
 * test-seeded.mjs — deleting rounds inside a forked (seeded) session.
 *
 * A fork's inherited prefix ends with `session/end-seed {inherited:true}`, which
 * IS the inherited cut. Cutting at or before it re-seeds the fork: the kept
 * prefix is followed by a fresh marker, so the artifact still declares "I am a
 * seeded session" and the parent's history it inherits simply gets shorter.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSessionLog } from './fixture.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(here, '..')
const SANDBOX = join(PACKAGE, '.exp', 'sandbox-seeded')

const engine = await import(new URL('../lib/engine.js', import.meta.url).href)

let FORK
try {
  FORK = findSessionLog({ seeded: true })
} catch {
  console.log('SKIP: no seeded (fork) session available on this machine')
  process.exit(0)
}
console.log(`fixture: ${FORK}`)

rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(join(SANDBOX, 'sessions', '--proj--', 'session-seeded-test'), { recursive: true })
const staged = join(SANDBOX, 'sessions', '--proj--', 'session-seeded-test', 'session.v4.jsonl.zstd')
copyFileSync(FORK, staged)

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}  ${detail ?? ''}`) }
}

const buffer = readFileSync(staged)
const log = engine.decodeSessionLog(buffer)
check('source is a seeded session', log.header.isSeeded === true)
check('source has an inherited marker', log.seededCut !== undefined, `seededCut=${log.seededCut}`)

const anchors = engine.planAnchors(log)
const inherited = anchors.filter((anchor) => anchor.inherited === true)
check('inherited rounds exist', inherited.length > 0, `${inherited.length}/${anchors.length}`)
check('inherited rounds are deletable', inherited.every((anchor) => anchor.deletable === true))
check('later rounds are rewindable', anchors.filter((anchor) => anchor.rewindable).length > 0)

for (const [label, anchor] of [['rewind', inherited.at(-1)], ['re-answer', anchors.at(-1)]]) {
  const cut = label === 'rewind' ? anchor.cutBefore : anchor.cutAfter
  const built = engine.buildTruncated(log, buffer, cut)
  console.log(`\n[${label}] cut=${cut} reseeded=${built.reseeded} bytes ${buffer.length} -> ${built.bytes.length}`)
  const verified = engine.verifyArtifact(built.bytes, cut + (built.reseeded ? 1 : 0), log)
  const out = engine.decodeSessionLog(built.bytes)
  check(`${label}: artifact is still seeded`, out.header.isSeeded === true)
  if (built.reseeded) {
    // Cutting inside the inherited prefix writes a fresh marker at the new cut.
    check(`${label}: new marker is the last event`,
      out.events.at(-1).type === 'session/end-seed' && out.events.at(-1).data.inherited === true,
      JSON.stringify(out.events.at(-1)?.type))
    check(`${label}: marker seq equals the new cut`, out.seededCut === out.events.length - 1,
      `seededCut=${out.seededCut} last=${out.events.length - 1}`)
  } else {
    // A plain tail cut keeps the original inherited prefix and its marker.
    check(`${label}: original marker survives`, out.seededCut === log.seededCut,
      `seededCut=${out.seededCut} expected=${log.seededCut}`)
  }
  check(`${label}: dense seq`, out.events.every((event, index) => event.seq === index))
  check(`${label}: verified shape`, verified.events === out.events.length)
  // The reseeded fork's own rounds must be gone. "re-answer" keeps the chosen
  // round itself (unanswered), so it is checked by its answer state instead.
  const after = engine.planAnchors(out)
  if (label === 'rewind') {
    check(`${label}: fewer rounds afterwards`, after.length < anchors.length, `${after.length} vs ${anchors.length}`)
  } else {
    check(`${label}: chosen round survives unanswered`, after.at(-1)?.answered === false,
      JSON.stringify({ turn: after.at(-1)?.turn, answered: after.at(-1)?.answered }))
  }
}

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL SEEDED CHECKS PASSED')
