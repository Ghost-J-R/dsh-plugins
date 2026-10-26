/**
 * dsh-web-fetch-family — Host half.
 *
 * Two jobs, in this order:
 *
 *   1. Own exactly one document, `$DSH_HOME/web-fetch-family/config.json`, and
 *      serve it to this bundle's browser half over one prefix route.
 *   2. Turn that document into live behaviour: a hostname listed under
 *      `ipv4Only` may only be reached over IPv4, and one under `ipv6Only` only
 *      over IPv6.
 *
 * Job 2 works by pinning the address family of the DNS lookup that Node performs
 * while opening a socket. `undici` — the client behind this harness's fetch —
 * reaches TLS through `tls.connect(...)` with `host: <hostname>` and no `lookup`
 * of its own, and plain HTTP through `net.connect(...)`. Both read
 * `options.lookup` at connect time, so supplying one is enough to decide which
 * stack the connection uses.
 *
 * The plugin deliberately exports no `Config`. A Cordis `Config` would make DSH
 * create a settings namespace for this row, and the settings service persists
 * volatile field edits into the profile's `cordis.patch.yml`; that would put
 * these rules in two places and contradict the point of a standalone document.
 * So the document is the single store, and the page is the only editor.
 *
 * It also avoids every `@deepseek-ai/*` import: this package is installed as a
 * `link:` dependency, so its real path sits outside the profile and bare host
 * imports would not resolve. Only Node builtins are used.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Loader row id from `cordis.patch.yml`; also the label used in Host logs. */
export const ROW_ID = 'web-fetch-family'
/** Route prefix owned by this bundle. The browser half repeats this literal. */
export const API_PREFIX = '/web-fetch-family/api'
/** DSH home: the desktop app sets DSH_HOME; the fallback matches the runtime. */
export const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** State directory and the one document it holds. */
export const STATE_DIR = join(HOME, ROW_ID)
export const CONFIG_FILE = join(STATE_DIR, 'config.json')
/** Document shape version, independent of the package version. */
export const SCHEMA_VERSION = 2
/** The two rule lists, in the order the page renders them. */
export const LISTS = ['ipv4Only', 'ipv6Only']
/** Interception scopes, narrowest first. */
export const MODES = ['targeted', 'global']
/**
 * `targeted` steps in only where the caller already resolved the hostname and
 * handed over its own `lookup` — which is exactly the pinned path of
 * `dsh-web-fetch-enhanced` (`new Agent({ connect: { lookup } })`, spread into
 * `tls.connect`'s options by undici). Nothing else that opens a socket does
 * that, so every other connection in the process keeps the call it made.
 *
 * `global` rewrites any connection whose host matches a rule, whether or not the
 * caller resolved the hostname itself.
 */
export const DEFAULT_MODE = 'targeted'
/** Cordis services this plugin waits for before `apply` runs. */
export const inject = ['webServer']
/** This package's own name: the key the profile records and the page registers under. */
export const PACKAGE_NAME = 'dsh-web-fetch-family'
/** The plugin whose fetch provider decides whether these rules sit on the path. */
export const ENHANCED_NAME = 'dsh-web-fetch-enhanced'
/**
 * The bundle that ships `dsh-web-fetch-enhanced` from 0.2.0 on.
 *
 * The standalone bundle was archived; the fetch plugin is now one of three
 * packages inside this profile bundle, so the profile's bundle list names this
 * one instead. Both layouts are recognised, because the profile may still be on
 * the old standalone bundle.
 */
export const ENHANCED_BUNDLE = 'dsh-tool-web-enhanced-profile'

/** Largest accepted request body. Two textareas cannot legitimately exceed it. */
const MAX_BODY_BYTES = 256 * 1024
/** One DNS label: 1-63 characters, no leading or trailing hyphen. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** Characters that only appear when a scheme, path, port, or credentials leaked in. */
const NON_HOSTNAME = /[/:@?#\s]/
/** Address family numbers as Node spells them in `dns.lookup` options. */
const IPV4 = 4
const IPV6 = 6

// ------------------------------------------------------------- builtins ----

/**
 * The CJS builtin module objects, not ESM namespace snapshots.
 *
 * An ESM namespace is a frozen view taken when the module graph is linked, so a
 * later assignment to a property is invisible through it. The CJS exports object
 * is the object the rest of the process actually reads properties from, and
 * `createRequire` on a builtin specifier always hands back that same singleton.
 */
const require = createRequire(import.meta.url)
const netModule = require('node:net')
const tlsModule = require('node:tls')
const dnsModule = require('node:dns')
const httpsModule = require('node:https')

/**
 * Captured before anything can patch over them, so restore is exact.
 *
 * `net.connect` and `net.createConnection` are the same function in Node; the
 * patch keeps them aliased to one wrapper so that identity survives.
 */
const ORIGINAL = {
  netConnect: netModule.connect,
  netCreateConnection: netModule.createConnection,
  tlsConnect: tlsModule.connect
}

/** The document with both lists present and empty. */
function emptyDocument() {
  return { version: SCHEMA_VERSION, mode: DEFAULT_MODE, ipv4Only: [], ipv6Only: [] }
}

/** True when every element is a string, so a scalar is never mistaken for a list. */
function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Read the document and never throw.
 *
 * A missing file is a normal first run. A file that exists but cannot be used is
 * reported instead of being silently replaced, so hand-edited content is never
 * destroyed by a read.
 *
 * @returns `{ document, exists, error }`; `error` is user-facing text or null.
 */
export async function readDocument() {
  let text
  try {
    text = await readFile(CONFIG_FILE, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { document: emptyDocument(), exists: false, error: null }
    return { document: emptyDocument(), exists: false, error: `无法读取 ${CONFIG_FILE}：${error.message}` }
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { document: emptyDocument(), exists: true, error: `${CONFIG_FILE} 不是合法 JSON：${error.message}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { document: emptyDocument(), exists: true, error: `${CONFIG_FILE} 的顶层必须是一个对象。` }
  }

  const document = emptyDocument()
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode)) {
      return {
        document: emptyDocument(),
        exists: true,
        error: `${CONFIG_FILE} 的 mode 只能是 ${MODES.join(' 或 ')}。`
      }
    }
    document.mode = raw.mode
  }
  for (const list of LISTS) {
    const value = raw[list]
    if (value === undefined) continue
    if (!stringArray(value)) {
      return { document: emptyDocument(), exists: true, error: `${CONFIG_FILE} 的 ${list} 必须是字符串数组。` }
    }
    document[list] = [...value]
  }
  return { document, exists: true, error: null }
}

/**
 * Replace the document atomically: a temporary sibling is written and then
 * renamed over the target, so an interrupted write cannot leave a half file.
 */
export async function writeDocument(document) {
  await mkdir(STATE_DIR, { recursive: true })
  const temporary = `${CONFIG_FILE}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, CONFIG_FILE)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  return document
}

/**
 * Reduce one pasted line to a rule, or explain why it cannot become one.
 *
 * A pasted URL is accepted and reduced to its hostname so the user does not have
 * to edit it by hand; anything else non-hostname shaped is refused by name.
 *
 * @returns `{ ok: true, value }` or `{ ok: false, reason }`.
 */
export function normalizeRule(input) {
  const raw = String(input).trim()
  if (raw === '') return { ok: false, reason: '空行' }

  let host = raw
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname
    } catch {
      return { ok: false, reason: `无法解析为地址：${raw}` }
    }
  }
  host = host.toLowerCase().replace(/\.$/, '')

  let wildcard = false
  if (host.startsWith('*.')) {
    wildcard = true
    host = host.slice(2)
  }
  if (host === '') return { ok: false, reason: '缺少域名' }

  const literal = isIP(host) !== 0
  if (literal) {
    if (wildcard) return { ok: false, reason: 'IP 字面量不能使用 * 通配' }
    return { ok: true, value: host }
  }
  if (NON_HOSTNAME.test(host)) {
    return { ok: false, reason: '只写域名，不要包含协议、路径、端口或凭据' }
  }
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) {
    return { ok: false, reason: '不是可用的域名（需要至少两段，且每段只含字母、数字、连字符）' }
  }
  return { ok: true, value: wildcard ? `*.${host}` : host }
}

/**
 * Turn the two textareas into a document, or into the reasons that stop a save.
 *
 * `input[list]` is the textarea split on newlines including blank lines, so a
 * reported line number is the line number the user sees.
 *
 * @returns `{ document, problems }`; each problem is `{ list, line, text, reason }`.
 */
export function parseLists(input) {
  const document = emptyDocument()
  const problems = []

  if (input?.mode !== undefined) {
    if (MODES.includes(input.mode)) document.mode = input.mode
    else {
      problems.push({
        list: 'mode',
        line: 0,
        text: String(input.mode),
        reason: `拦截范围只能是 ${MODES.join(' 或 ')}`
      })
    }
  }

  for (const list of LISTS) {
    const lines = input?.[list]
    if (!stringArray(lines)) {
      problems.push({ list, line: 0, text: '', reason: '缺少这个字段，或它不是字符串数组' })
      continue
    }
    const seen = new Set()
    lines.forEach((line, index) => {
      if (line.trim() === '') return
      const result = normalizeRule(line)
      if (!result.ok) {
        problems.push({ list, line: index + 1, text: line.trim(), reason: result.reason })
        return
      }
      if (seen.has(result.value)) {
        problems.push({ list, line: index + 1, text: result.value, reason: '这一行与前面重复' })
        return
      }
      seen.add(result.value)
      document[list].push(result.value)
    })
  }

  // A rule in both lists contradicts itself: it cannot be IPv4-only and IPv6-only.
  for (const rule of document.ipv4Only) {
    if (document.ipv6Only.includes(rule)) {
      problems.push({ list: 'both', line: 0, text: rule, reason: '同一个域名不能同时出现在两张表里' })
    }
  }
  return { document, problems }
}

// ------------------------------------------------------------- matching ----

/**
 * Reduce a connect target to the key rules are written against, or null when no
 * rule could ever apply to it.
 *
 * IP literals are skipped: they already carry their own family, and `dns.lookup`
 * is never consulted for them.
 */
export function canonicalHost(value) {
  if (typeof value !== 'string') return null
  let host = value.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.replace(/\.$/, '')
  if (host === '' || isIP(host) !== 0) return null
  return host
}

/**
 * Turn a document into a lookup structure, without trusting it.
 *
 * `parseLists` already refuses one hostname in both lists, but a hand-edited
 * `config.json` can still contain that contradiction. Such a hostname is left
 * out of both maps, so it falls back to no rule at all rather than to whichever
 * list happened to be read last — an ambiguous rule must not silently pick a
 * family.
 *
 * @returns `{ exact, wildcard, conflicts, lists }`; `lists` is what is actually
 * in effect, which is what `GET /status` reports.
 */
export function buildRuleSet(document) {
  const exact = new Map()
  const wildcard = new Map()
  const seenConflicts = new Set()
  const conflicts = []
  const lists = { ipv4Only: [], ipv6Only: [] }

  for (const [list, family] of [['ipv4Only', IPV4], ['ipv6Only', IPV6]]) {
    const mirror = list === 'ipv4Only' ? 'ipv6Only' : 'ipv4Only'
    for (const rule of document?.[list] ?? []) {
      if (typeof rule !== 'string' || rule === '') continue
      const isWildcard = rule.startsWith('*.')
      const key = isWildcard ? rule.slice(2) : rule
      if (key === '') continue

      if ((document?.[mirror] ?? []).includes(rule)) {
        if (!seenConflicts.has(rule)) {
          seenConflicts.add(rule)
          conflicts.push(rule)
        }
        continue
      }

      const target = isWildcard ? wildcard : exact
      if (target.has(key)) {
        if (target.get(key) !== family && !seenConflicts.has(rule)) {
          seenConflicts.add(rule)
          conflicts.push(rule)
        }
        continue
      }
      target.set(key, family)
      lists[list].push(rule)
    }
  }
  return { exact, wildcard, conflicts, lists }
}

/**
 * Which family a hostname is pinned to: 4, 6, or 0 for "no rule".
 *
 * An exact rule always beats a wildcard, and the longest matching wildcard beats
 * a shorter one, so a specific exception can be carved out of a broad suffix.
 * `*.example.net` matches subdomains only, not `example.net` itself.
 */
export function familyFor(hostname, ruleSet = rules) {
  const host = canonicalHost(hostname)
  if (host === null) return 0

  const exact = ruleSet.exact.get(host)
  if (exact !== undefined) return exact

  let family = 0
  let longest = -1
  for (const [suffix, candidate] of ruleSet.wildcard) {
    if (suffix.length <= longest) continue
    if (host.length > suffix.length + 1 && host.endsWith(`.${suffix}`)) {
      longest = suffix.length
      family = candidate
    }
  }
  return family
}

// ---------------------------------------------------------- interceptor ----

/** Live rule set. Replaced whole, never mutated, so a reader sees one document. */
let rules = buildRuleSet(emptyDocument())
/** Live interception scope, from the same document as the rules. */
let mode = DEFAULT_MODE
/** The installed patch, or null while no hostname is pinned. */
let installed = null
/** Why the last rule load failed, surfaced by `GET /status`. */
let lastLoadError = null
/** Why the last pinned lookup failed, surfaced by `GET /status`. */
let lastRefusal = null
/** Observable evidence that the interceptor did something. */
const counters = { attempts: 0, pinned4: 0, pinned6: 0, unqualified: 0, passedThrough: 0 }

/** Which scope is in force. Reported by `GET /status`. */
export function currentMode() {
  return mode
}

/** True while the process's connect exports are patched by this plugin. */
export function isArmed() {
  return installed !== null
}

/**
 * A `dns.lookup`-shaped function that keeps the caller's own resolver but forces
 * the pinned family.
 *
 * Forcing `family` rather than filtering the result is what makes this work with
 * Node's Happy Eyeballs: `net` asks for every address (`all: true`) and then
 * races them, so a filtered list would still let the unwanted family through on
 * the retry. With `family` pinned, only the chosen stack is ever returned.
 */
function pinningLookup(hostname, family, inherited) {
  const base = typeof inherited === 'function' ? inherited : dnsModule.lookup
  return function lookup(requested, options, callback) {
    let merged
    if (typeof options === 'function') {
      callback = options
      merged = { family }
    } else {
      merged = { ...(options ?? {}), family }
    }

    counters.attempts += 1
    base(requested, merged, (error, ...rest) => {
      if (error) {
        counters.unqualified += 1
        lastRefusal = `${requested} → ${error.code ?? error.message}`
        // Keep `code` — undici maps it — but say why the lookup was narrowed.
        if (error instanceof Error) {
          const name = family === IPV4 ? 'IPv4' : 'IPv6'
          error.message = `${error.message}（域名族规则：${requested} 已限定只使用 ${name}，但没有解析到 ${name} 地址）`
        }
        return callback(error, ...rest)
      }
      if (family === IPV4) counters.pinned4 += 1
      else counters.pinned6 += 1
      return callback(null, ...rest)
    })
  }
}

/**
 * Locate the options object in a `net.connect` / `tls.connect` call.
 *
 * Only the two shapes that carry a hostname are recognised:
 * `connect(options[, listener])` and `connect(port, host[, listener])`. A unix
 * socket path has no hostname, and any other argument shape is left alone rather
 * than guessed at — a wrong guess would rewrite an unrelated connection.
 *
 * @returns `{ index, options }` or null.
 */
function connectOptionsOf(args) {
  const first = args[0]
  if (first !== null && typeof first === 'object') return { index: 0, options: first }
  if (
    typeof first === 'number' &&
    typeof args[1] === 'string' &&
    (args.length < 3 || typeof args[2] === 'function')
  ) {
    return { index: -1, options: { port: first, host: args[1] } }
  }
  return null
}

/** Wrap one connect export so pinned hostnames get a family-limited lookup. */
function patchConnect(original) {
  return function connect(...args) {
    const found = connectOptionsOf(args)
    if (found === null) return original.apply(this, args)

    const family = familyFor(found.options.host)
    // No rule for this target: forward untouched — same arguments, same object
    // identity — so unpinned traffic behaves exactly as if this plugin were absent.
    if (family === 0) return original.apply(this, args)

    // Targeted scope: a caller that resolved the hostname itself had to pass its
    // own lookup, and only such a caller is stepped in on. Everything else keeps
    // the exact call it made, and the bypass is counted so the page can show it.
    if (mode === 'targeted' && typeof found.options.lookup !== 'function') {
      counters.passedThrough += 1
      return original.apply(this, args)
    }

    const options = {
      ...found.options,
      lookup: pinningLookup(canonicalHost(found.options.host), family, found.options.lookup)
    }
    const forwarded =
      found.index === 0 ? [options, ...args.slice(1)] : [options, ...args.slice(2)]
    return original.apply(this, forwarded)
  }
}

/**
 * Arm the interceptor.
 *
 * @returns true when this call installed the patch.
 */
export function installInterceptor() {
  if (installed !== null) return false
  const netConnect = patchConnect(ORIGINAL.netConnect)
  const tlsConnect = patchConnect(ORIGINAL.tlsConnect)
  netModule.connect = netConnect
  // Keep Node's own alias identity: `net.connect === net.createConnection`.
  netModule.createConnection = netConnect
  tlsModule.connect = tlsConnect
  installed = { netConnect, tlsConnect }
  return true
}

/**
 * Disarm the interceptor and restore the originals.
 *
 * Each export is restored only while it still holds our own wrapper, so a patch
 * somebody else installed after us is never silently undone.
 *
 * @returns true when this call removed the patch.
 */
export function removeInterceptor() {
  if (installed === null) return false
  if (netModule.connect === installed.netConnect) {
    netModule.connect = ORIGINAL.netConnect
    netModule.createConnection = ORIGINAL.netCreateConnection
  }
  if (tlsModule.connect === installed.tlsConnect) tlsModule.connect = ORIGINAL.tlsConnect
  installed = null
  return true
}

/**
 * Match the patch to the rule set.
 *
 * With an empty document the process keeps exactly the exports Node shipped: no
 * patched builtin, no injected lookup, nothing to reason about. That is the
 * state a freshly installed plugin runs in until the first rule is saved.
 */
export function syncInterceptor() {
  if (rules.exact.size + rules.wildcard.size > 0) installInterceptor()
  else removeInterceptor()
  return isArmed()
}

/** Replace the live rule set and match the interceptor to it. */
export function setRules(document) {
  rules = buildRuleSet(document)
  mode = MODES.includes(document?.mode) ? document.mode : DEFAULT_MODE
  syncInterceptor()
  return rules
}

/** Reload the document from disk and apply it. Never throws. */
export async function refreshRules() {
  const { document, error } = await readDocument()
  lastLoadError = error
  return setRules(document)
}

// ----------------------------------------------------------- environment ----

/** Public resolvers used to tell a poisoned answer from a real one. */
const DOH_ENDPOINTS = [
  { host: '1.1.1.1', servername: 'cloudflare-dns.com', label: '1.1.1.1' },
  { host: '8.8.8.8', servername: 'dns.google', label: '8.8.8.8' }
]
/** Ceiling for one probe. Everything runs concurrently, so this is also the page's ceiling. */
const PROBE_TIMEOUT_MS = 8000

/**
 * Which profile this plugin was loaded from.
 *
 * Enumerated rather than assumed: it is the profile whose bundle list names this
 * package, which is the same fact the plugin manager reads. No profile name is
 * ever hard-coded, so renaming or adding profiles cannot silently point the
 * status panel at the wrong one.
 */
export async function locateProfile() {
  const root = join(HOME, 'profiles')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return { profile: null, error: `无法列出 ${root}：${error.message}`, ambiguous: false }
  }

  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
      matches.push({ name: entry.name, dir, manifest })
    }
  }

  if (matches.length === 0) return { profile: null, error: null, ambiguous: false }
  return { profile: matches[0], error: null, ambiguous: matches.length > 1 }
}

/**
 * Whether `dsh-web-fetch-enhanced` is installed and switched on in that profile.
 *
 * Reported, never enforced. These rules act on the socket layer, so they still
 * apply while some other provider is selected; whether that is useful is the
 * operator's call, and the page shows the fact rather than acting on it.
 *
 * "Enabled" means the profile's bundle list names either the standalone bundle
 * that shipped this plugin before 0.2.0, or the profile bundle that ships it
 * from 0.2.0 on. Only checking one of the two reports a false negative after the
 * migration.
 */
export async function enhancedState() {
  const { profile, error, ambiguous } = await locateProfile()
  if (profile === null) {
    return {
      known: false,
      profile: null,
      installed: false,
      enabled: false,
      version: null,
      bundle: null,
      dependency: null,
      ambiguous,
      reason: error ?? '没有找到把本插件列入 bundles 的 profile'
    }
  }

  const bundles = profile.manifest?.dsh?.profile?.bundles ?? []
  const dependency = profile.manifest?.dependencies?.[ENHANCED_NAME] ?? null
  let version = null
  try {
    const manifest = JSON.parse(
      await readFile(join(profile.dir, 'node_modules', ENHANCED_NAME, 'package.json'), 'utf8')
    )
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    version = null
  }

  const bundle = bundles.includes(ENHANCED_BUNDLE)
    ? ENHANCED_BUNDLE
    : bundles.includes(ENHANCED_NAME)
      ? ENHANCED_NAME
      : null

  return {
    known: true,
    profile: profile.name,
    installed: dependency !== null || version !== null,
    enabled: bundle !== null,
    version,
    bundle,
    dependency,
    ambiguous,
    reason: null
  }
}

/**
 * What can be established about a proxy or Clash without reading its config.
 *
 * Only facts this process can observe: proxy environment variables, the DNS
 * servers the OS hands out, and whether answers land in the ranges Clash uses for
 * fake-ip. The router's Clash configuration is not reachable from here, so it is
 * never guessed at — the page says what was measured and nothing more.
 */
export function clashState() {
  const proxyEnv = {}
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') proxyEnv[key] = value
  }
  let dnsServers = []
  try {
    dnsServers = dnsModule.getServers()
  } catch {
    dnsServers = []
  }
  return { proxyEnv, hasProxyEnv: Object.keys(proxyEnv).length > 0, dnsServers }
}

/**
 * Whether an address sits in a range Clash reserves for fake-ip.
 *
 * `198.18.0.0/15` is Clash's default fake-ip range, and the CIDR this harness's
 * web-fetch allowlist already carries. A hit means DNS is answered locally and
 * the real destination is chosen later from the domain. Teredo and ULA prefixes
 * are folded in because they appear the same way: an address that is not the
 * site's own.
 */
export function fakeRange(address) {
  if (typeof address !== 'string') return false
  const version = isIP(address)
  if (version === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)
  }
  if (version !== 6) return false
  const head = address.toLowerCase()
  return head.startsWith('fc') || head.startsWith('fd') || head.startsWith('2001:0:') || head.startsWith('2001::')
}

/** Ranges a local proxy hands out instead of the site's real address. */
const FAKE_RANGES = ['198.18.0.0/15', '2001::/96', 'fc00::/7']

/** Expand a compressed IPv6 literal into eight 4-digit groups, or null. */
function expandV6(address) {
  const bare = String(address).split('%')[0].toLowerCase()
  if (bare.includes('.')) return null
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => group.padStart(4, '0'))
}

/**
 * The narrowest range worth allowlisting for one observed address.
 *
 * A range a proxy is known to hand out is reported whole, because that is the
 * unit an operator recognises and configures — and because one observed address
 * inside such a range says nothing about how the proxy will number the next one.
 * Anything else is reduced to its own /16 or /64, so a suggestion is never
 * broader than the observation that produced it.
 *
 * @returns a CIDR string, or null when the address cannot be read.
 */
export function containingCidr(address) {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 198 && (b === 18 || b === 19)) return '198.18.0.0/15'
    return `${a}.${b}.0.0/16`
  }
  if (version !== 6) return null
  const groups = expandV6(address)
  if (groups === null) return null
  if (groups[0] === '2001' && groups.slice(1, 6).every((group) => group === '0000')) return '2001::/96'
  if ((Number.parseInt(groups[0], 16) & 0xfe00) === 0xfc00) return 'fc00::/7'
  // Compress trailing zero groups so the result is the form a person would write.
  const head = groups.slice(0, 4)
  while (head.length > 1 && head[head.length - 1] === '0000') head.pop()
  return `${head.map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * The allowlist `dsh-web-fetch-enhanced` is currently configured with.
 *
 * Read out of the profile's own `cordis.patch.yml` with a line scan rather than a
 * YAML parser: this plugin takes no dependencies, and that file is a flat list of
 * `- id: …` rows whose list values are one item per line. Anything unexpected
 * yields null, which the page reports as "unknown" rather than as "empty" — an
 * unreadable file must never look like an empty allowlist.
 *
 * @returns `{ allowCidrs, allowHostnames }` or null.
 */
export async function enhancedAllowlist() {
  const { profile } = await locateProfile()
  if (profile === null) return null

  let text
  try {
    text = await readFile(join(profile.dir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return null
  }

  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*-\s*id:\s*['"]?web-fetch-enhanced['"]?\s*$/.test(line))
  if (start === -1) return null

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*-\s*id:/.test(lines[index])) {
      end = index
      break
    }
  }
  const block = lines.slice(start + 1, end)

  const readList = (key) => {
    const at = block.findIndex((line) => new RegExp(`^\\s*${key}:`).test(line))
    if (at === -1) return null
    const inline = block[at].slice(block[at].indexOf(':') + 1).trim()
    if (inline.startsWith('[')) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    }
    const items = []
    for (let index = at + 1; index < block.length; index += 1) {
      if (block[index].trim() === '') continue
      const match = /^\s*-\s*(.+?)\s*$/.exec(block[index])
      if (match === null) break
      items.push(match[1].replace(/^['"]|['"]$/g, ''))
    }
    return items
  }

  const allowCidrs = readList('allowCidrs')
  const allowHostnames = readList('allowHostnames')
  if (allowCidrs === null && allowHostnames === null) return null
  return { allowCidrs: allowCidrs ?? [], allowHostnames: allowHostnames ?? [] }
}

// ------------------------------------------------------------- diagnosis ----

/** Resolve through the OS resolver; an empty list means "no answer of that family". */
async function systemLookup(host, family) {
  try {
    const answers = await dnsModule.promises.lookup(host, { family, all: true })
    return answers.map((entry) => entry.address)
  } catch {
    return []
  }
}

/**
 * Ask one public resolver over HTTPS, bypassing whatever the OS resolver does.
 *
 * The address is a literal and the SNI name is pinned explicitly, so this call is
 * never touched by the family interceptor, and a poisoned local answer cannot
 * influence the comparison in either direction.
 */
function dohQueryOnce(endpoint, name, type) {
  return new Promise((resolve) => {
    const request = httpsModule.request(
      {
        host: endpoint.host,
        servername: endpoint.servername,
        port: 443,
        path: `/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        timeout: PROBE_TIMEOUT_MS
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            const wanted = type === 'A' ? 1 : 28
            resolve(
              (parsed?.Answer ?? [])
                .filter((record) => record?.type === wanted && typeof record.data === 'string')
                .map((record) => record.data)
            )
          } catch {
            resolve(null)
          }
        })
      }
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', () => resolve(null))
    request.end()
  })
}

/** First public resolver that answers, or null when none does. */
async function dohQuery(name, type) {
  for (const endpoint of DOH_ENDPOINTS) {
    const answers = await dohQueryOnce(endpoint, name, type)
    if (answers !== null) return { answers, resolver: endpoint.label }
  }
  return null
}

/**
 * Can a TCP+TLS handshake complete to this literal address?
 *
 * The address is a literal, so `familyFor` returns 0 for it and the interceptor
 * passes the call straight through: the diagnosis measures the real network,
 * never this plugin's own rule. That matters — without it, testing a hostname
 * already pinned to IPv4 would report IPv6 as broken merely because the probe was
 * rewritten to IPv4.
 *
 * Certificate verification is off on purpose. When DNS is poisoned the address
 * belongs to somebody else and no certificate can match, but that says nothing
 * about whether this family is reachable.
 */
function tlsProbe(address, servername) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = tlsModule.connect({
      host: address,
      servername,
      port: 443,
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT_MS
    })
    const settle = (ok, error) => {
      socket.destroy()
      resolve({ ok, ms: Date.now() - started, error, address })
    }
    socket.once('secureConnect', () => settle(true, null))
    socket.once('timeout', () => settle(false, 'timeout'))
    socket.once('error', (error) => settle(false, error.code ?? error.message))
  })
}

/**
 * The one line of advice worth giving about Clash, and only when it applies.
 *
 * A local proxy answers with addresses that belong to nobody, and web_fetch
 * refuses non-public addresses unless they are allowlisted — so a proxy's own
 * range has to be allowed through before any rule here can matter.
 */
const FAKE_IP_HINT =
  '开着 Clash 的话，把它 fake-ip 的网段一起放行——它代答的假 IP 会被 web_fetch 当成非公网地址直接拒掉。'

/** Verdict prose, keyed by the measured kind. */
const VERDICTS = {
  'ipv6-broken': {
    title: 'e621 型：IPv4 能通，IPv6 这条路被中断',
    summary:
      '这个域名有 IPv6 地址，连过去会被立刻重置，而 IPv4 正常。系统默认优先 IPv6，所以不干预就会踩到这条坏路。',
    plugin: 'ipv4Only',
    clashHint: ''
  },
  'ipv4-broken': {
    title: '反向型：IPv6 能通，IPv4 这条路被中断',
    summary: 'IPv4 连不上而 IPv6 正常。系统默认优先 IPv6，所以这个域名通常不需要干预。',
    plugin: 'ipv6Only',
    clashHint: ''
  },
  'dns-hijack': {
    title: 'danbooru 型：本地解析出来的不是这个站',
    summary:
      '系统解析出的地址与公共解析器给出的完全对不上。族规则在这里没用——要做的是把下面那个网段放行，让 web_fetch 敢去连它。',
    plugin: null,
    clashHint: ''
  },
  'family-ok': {
    title: '两族都能连上，族规则帮不上忙',
    summary: 'IPv4 与 IPv6 都能完成 TLS 握手。这个域名的失败原因不在这两层。',
    plugin: null,
    clashHint: ''
  },
  unresolved: {
    title: '本机解析不出这个域名',
    summary: 'A 与 AAAA 都没有答案。族规则在这种情况下不会生效，先解决解析。',
    plugin: null,
    clashHint: ''
  },
  unreachable: {
    title: '两族都连不上',
    summary: 'DNS 有答案，但两个族都完成不了握手。这与地址族无关。',
    plugin: null,
    clashHint: '开着 Clash 的话，确认它当前出口可用，或该域名没被某条规则 REJECT 掉。'
  }
}

/**
 * Work out which layer is actually broken for one hostname.
 *
 * The judgement is made from this run's own measurements — what the OS resolver
 * says, what a public resolver says, and whether each family completes a
 * handshake. Nothing is decided from the hostname itself: the same symptom has
 * different causes on different networks, and on this machine a domain's answer
 * was observed to change between two runs minutes apart.
 */
export async function diagnose(input) {
  const raw = String(input ?? '').trim()
  // Reuse the rule parser rather than `canonicalHost`: a pasted URL must be
  // reduced exactly the way it would be on save, so the two entry points can
  // never disagree about what counts as valid.
  const parsed = normalizeRule(raw)
  if (!parsed.ok) return { ok: false, error: parsed.reason }
  if (parsed.value.startsWith('*.')) {
    return { ok: false, error: '诊断要一个具体域名，不支持 *. 通配——通配只用于规则。' }
  }
  const host = parsed.value
  if (isIP(host) !== 0) {
    return { ok: false, error: '这是一个 IP 字面量。族规则只对域名有意义——IP 本身已经确定了族。' }
  }

  const [systemA, systemAAAA, publicA, publicAAAA] = await Promise.all([
    systemLookup(host, IPV4),
    systemLookup(host, IPV6),
    dohQuery(host, 'A'),
    dohQuery(host, 'AAAA')
  ])

  const [v4, v6] = await Promise.all([
    systemA.length > 0 ? tlsProbe(systemA[0], host) : Promise.resolve(null),
    systemAAAA.length > 0 ? tlsProbe(systemAAAA[0], host) : Promise.resolve(null)
  ])

  // null — not false — when no public resolver answered. "Cannot tell" must never
  // be reported as "poisoned".
  const dnsConsistent =
    publicA === null
      ? null
      : (systemA.length === 0 && publicA.answers.length === 0) ||
        systemA.some((address) => publicA.answers.includes(address))

  let kind
  if (systemA.length === 0 && systemAAAA.length === 0) kind = 'unresolved'
  else if (dnsConsistent === false) kind = 'dns-hijack'
  else if (v4?.ok === true && v6 !== null && v6.ok === false) kind = 'ipv6-broken'
  else if (v6?.ok === true && v4 !== null && v4.ok === false) kind = 'ipv4-broken'
  else if (v4?.ok === true || v6?.ok === true) kind = 'family-ok'
  else kind = 'unreachable'

  const verdict = VERDICTS[kind]
  const notes = []
  if (dnsConsistent === null) {
    notes.push('公共解析器这次没有回应，无法判断 DNS 是否被污染；下面的结论只基于各族是否真的能握手。')
  }
  if (systemA.length > 0 && systemAAAA.length === 0) {
    notes.push('这个域名本来就没有 IPv6 地址，所以它不会是 e621 型的问题。')
  }
  if (systemAAAA.length > 0 && systemA.length === 0) {
    notes.push('这个域名只有 IPv6 地址。')
  }
  const faked = [...systemA, ...systemAAAA].filter(fakeRange)
  if (faked.length > 0) {
    notes.push(
      `解析结果里有地址落在 fake-ip 常用网段：${faked.join('、')}。这是本地代答的地址，不是站点的真实地址。`
    )
  }

  // Whatever the verdict, an address web_fetch would refuse as non-public has to be
  // allowlisted before anything else can work. A hijacked answer means every answer
  // is untrustworthy, so all of them are candidates; otherwise only the ones that
  // landed in a range a proxy is known to hand out.
  const suspicious = kind === 'dns-hijack' ? [...systemA, ...systemAAAA] : faked
  const suggestCidrs = [...new Set(suspicious.map(containingCidr).filter(Boolean))]
  let allowlist = null
  if (suggestCidrs.length > 0) {
    const currentCidrs = (await enhancedAllowlist())?.allowCidrs ?? null
    allowlist = {
      suggest: suggestCidrs,
      current: currentCidrs,
      // null current means "could not read", which must not look like "nothing there".
      missing: currentCidrs === null ? suggestCidrs : suggestCidrs.filter((cidr) => !currentCidrs.includes(cidr))
    }
  }

  return {
    ok: true,
    host,
    kind,
    verdict: {
      title: verdict.title,
      summary: verdict.summary,
      plugin: verdict.plugin === null ? null : { list: verdict.plugin, rule: host },
      allowlist,
      clashHint: faked.length > 0 || kind === 'dns-hijack' ? FAKE_IP_HINT : verdict.clashHint,
      enhancedHint:
        kind === 'family-ok'
          ? '如果 web_fetch 抓这个站仍然失败，多半是站点按 User-Agent 或反爬策略拒绝。去 dsh-web-fetch-enhanced 里换一个正常的浏览器 User-Agent。'
          : '',
      notes
    },
    evidence: {
      systemA,
      systemAAAA,
      publicA: publicA?.answers ?? null,
      publicAAAA: publicAAAA?.answers ?? null,
      publicResolver: publicA?.resolver ?? null,
      dnsConsistent,
      v4,
      v6
    },
    clash: clashState()
  }
}

// ---------------------------------------------------------------- routes ----

/** What `GET /status` reports: whether the rules are live, what they did, and the surroundings. */
async function statusPayload() {
  const counts = { ipv4Only: 0, ipv6Only: 0 }
  for (const family of [...rules.exact.values(), ...rules.wildcard.values()]) {
    if (family === IPV4) counts.ipv4Only += 1
    else counts.ipv6Only += 1
  }
  return {
    armed: isArmed(),
    mode,
    rules: rules.lists,
    counts,
    conflicts: rules.conflicts,
    counters: { ...counters },
    lastRefusal,
    configPath: CONFIG_FILE,
    loadError: lastLoadError,
    enhanced: await enhancedState(),
    clash: clashState()
  }
}

/** Write one JSON response, owning the whole lifecycle as the route contract requires. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

/** Read a JSON request body, refusing anything larger than the page can send. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** One panel request; the handler owns the whole response lifecycle. */
const handler = async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && route === '/config') {
      const { document, exists, error } = await readDocument()
      return sendJson(res, 200, { ...document, configPath: CONFIG_FILE, exists, loadError: error })
    }

    if (method === 'GET' && route === '/status') {
      return sendJson(res, 200, await statusPayload())
    }

    if (method === 'POST' && route === '/diagnose') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendJson(res, 400, { error: `请求体无法解析：${error.message}` })
      }
      const result = await diagnose(body?.host)
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    if (method === 'POST' && route === '/config') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendJson(res, 400, { error: `请求体无法解析：${error.message}` })
      }
      const { document, problems } = parseLists(body)
      if (problems.length > 0) {
        return sendJson(res, 400, { error: `有 ${problems.length} 处无法保存`, problems })
      }
      await writeDocument(document)
      // The new rules take effect on this very request: host code has no hot
      // reload, so waiting for a restart is not an option.
      lastLoadError = null
      setRules(document)
      return sendJson(res, 200, { ...document, configPath: CONFIG_FILE, exists: true, loadError: null })
    }

    return sendJson(res, 404, { error: `unknown route ${method} ${route}` })
  } catch (error) {
    return sendJson(res, 500, { error: error?.message ?? String(error) })
  }
}

/** Mount the route and the interceptor for exactly as long as this plugin is loaded. */
export function apply(ctx) {
  // Rules land one file read after mount. A failure here leaves the interceptor
  // disarmed rather than half-configured, and `GET /status` reports why.
  void refreshRules().catch(() => {})
  ctx.effect(() => () => removeInterceptor(), `${ROW_ID}: family interceptor`)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    `${ROW_ID}: config api`
  )
}
