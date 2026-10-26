#!/usr/bin/env node
/**
 * install.mjs — mount this bundle into one DSH profile (default: desktop).
 *
 *   node install.mjs            # install into the active profile
 *   node install.mjs --uninstall
 *   node install.mjs --profile-dir "C:\\Users\\you\\.dsh\\profiles\\desktop"
 *
 * What it changes, and nothing else:
 *   1. <profile>/package.json  -> dependencies["dsh-chat-rewrite"] and dsh.profile.bundles
 *   2. <profile>/node_modules/dsh-chat-rewrite -> directory junction to this package
 *
 * It never runs pnpm. The junction is exactly what a `link:` dependency produces,
 * so the profile keeps working and a later `pnpm install` simply recreates it.
 * The package.json is backed up beside itself before every change.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const NAME = 'dsh-chat-rewrite'
const SELF = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const profileIndex = args.indexOf('--profile-dir')
const profileDir = profileIndex >= 0
  ? resolve(args[profileIndex + 1])
  : resolve(process.env.DSH_PROFILE_DIR?.trim()
    || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles', 'desktop'))

const packagePath = join(profileDir, 'package.json')
if (!existsSync(packagePath)) {
  console.error(`[FAIL] profile package.json not found: ${packagePath}`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const backupPath = `${packagePath}.bak-chat-rewrite-${stamp}`
copyFileSync(packagePath, backupPath)

const read = () => JSON.parse(readFileSync(packagePath, 'utf8'))
const write = (value) => writeFileSync(packagePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const pkg = read()
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []

const linkPath = join(profileDir, 'node_modules', NAME)

if (uninstall) {
  delete pkg.dependencies[NAME]
  pkg.dsh.profile.bundles = bundles.filter((entry) => entry !== NAME)
  write(pkg)
  if (existsSync(linkPath)) rmSync(linkPath, { recursive: false, force: true })
  console.log(`[OK] removed ${NAME} from ${profileDir}`)
  console.log(`     package.json backup: ${backupPath}`)
  process.exit(0)
}

const spec = `link:${SELF.replaceAll('\\', '/')}`
pkg.dependencies[NAME] = spec
pkg.dsh.profile.bundles = bundles.includes(NAME) ? bundles : [...bundles, NAME]
write(pkg)

mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
if (existsSync(linkPath)) rmSync(linkPath, { recursive: false, force: true })
symlinkSync(SELF, linkPath, 'junction')

console.log(`[OK] ${NAME} mounted into ${profileDir}`)
console.log(`     dependency : ${spec}`)
console.log(`     bundle row : appended to dsh.profile.bundles`)
console.log(`     junction   : ${linkPath}`)
console.log(`     backup     : ${backupPath}`)
console.log('')
console.log('Next: restart the DSH desktop app so the Loader composes the new bundle row.')
