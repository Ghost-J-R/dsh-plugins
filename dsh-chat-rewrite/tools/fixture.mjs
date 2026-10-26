/**
 * fixture.mjs — pick a real session log for the suites to copy into their sandbox.
 *
 * The suites never touch the live store: they copy one log into a throwaway
 * `$DSH_HOME` under `.exp/`. That fixture comes from the user's own sessions
 * directory, discovered at run time so nothing machine-specific is committed and
 * the suites work on any installation.
 *
 * Selection order:
 *   1. `DSH_HOME_REAL` / `DSH_HOME` when set — that home's sessions are scanned;
 *   2. the default `~/.dsh` sessions;
 *   3. the first log that decodes with this plugin's engine.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeSessionLog } from '../lib/engine.js'

/**
 * Every stored session log under one home's `sessions/` tree.
 * @param {string} home - DSH home to inspect.
 * @returns {string[]} absolute log paths, newest directory first.
 */
function sessionLogs(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const logs = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const log = join(root, project.name, session.name, 'session.v4.jsonl.zstd')
      if (existsSync(log)) logs.push(log)
    }
  }
  return logs
}

/**
 * Find one real, decodable session log to use as a fixture.
 * @param {object} [options] - selection options.
 * @param {boolean} [options.seeded] - require a forked (seeded) session.
 * @returns {string} absolute path to a usable log.
 * @throws when the installation stores no session this engine can decode.
 */
export function findSessionLog({ seeded = false } = {}) {
  const homes = [process.env.DSH_HOME_REAL, process.env.DSH_HOME, join(homedir(), '.dsh')]
    .filter((home) => typeof home === 'string' && home.trim() !== '')
  for (const home of homes) {
    for (const log of sessionLogs(home)) {
      let decoded
      try {
        decoded = decodeSessionLog(readFileSync(log))
      } catch { continue }
      if (seeded && decoded.header.isSeeded !== true) continue
      // A fixture needs at least one human round to rewrite.
      if (decoded.events.length < 20) continue
      return log
    }
  }
  throw new Error('no usable session log found; set DSH_HOME to a dsh installation with sessions')
}
