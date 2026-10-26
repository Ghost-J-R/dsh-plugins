#!/usr/bin/env node
/**
 * test-theme.mjs — the panel must follow the app theme, not paint its own.
 *
 * Every colour in the browser half has to come from the 14 official theme
 * tokens (`cordis_inspect_query` provider `Theme`, method `listTokens`).
 * A hardcoded `#fff` or a token that does not exist silently falls back to a
 * light card, which is exactly the "white panel" bug this suite prevents.
 *
 * The only literals allowed are the scrim and the dialog shadow: both must
 * darken regardless of theme.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * Tokens this plugin may use. `Theme.listTokens` reports the 14 alias colours a
 * theme must override; the shipped overlay dialog additionally uses the extended
 * set below (masks, layer-3, radii, elevation, button fill), so those are proven
 * present in this app and are allowed here too.
 */
const TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-elevation-prominent',
  '--dsw-radius-panel',
  '--dsw-radius-md',
  '--dsw-radius-sm',
  '--dsw-specific-sidebar-fill',
])

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail === undefined ? '' : `  ${detail}`}`) }
}

const source = readFileSync(join(PACKAGE, 'lib', 'client.cjs'), 'utf8')
/** Source with comments stripped: hex values are allowed in prose, not in code. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/(^|[^:])\/\/.*$/gmu, '$1')

// 1. No hardcoded hex colours in code.
const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])
check('no hardcoded hex colour', hex.length === 0, hex.join(' '))

// 2. Every `var(--dsw-…)` names a token the Theme provider actually defines.
const used = new Set([...code.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
const unknown = [...used].filter((token) => !TOKENS.has(token))
check('every theme token exists', unknown.length === 0, unknown.join(' '))

// Surfaces, calibrated against the running app: the dialog takes the
// application background (bg-base = #151517), nested cards use the same surface
// DSH gives its input box and message cards (layer-2 = #2c2c2e), and buttons sit
// one step above that (layer-3 = #353638) so a control never merges into the
// panel.
const overlayStyle = /overlay:\s*\{[^}]*\}/u.exec(source)?.[0] ?? ''
const panelStyle = /panel:\s*\{[^}]*\}/u.exec(source)?.[0] ?? ''
const confirmStyle = /confirm:\s*\{[^}]*\}/u.exec(source)?.[0] ?? ''
const badgeStyle = /badge:\s*\{[^}]*\}/u.exec(source)?.[0] ?? ''
const smallButtonStyle = /smallButton:\s*\{[^}]*\}/u.exec(source)?.[0] ?? ''
check('mask uses bg-mask-1', /background:\s*'var\(--dsw-alias-bg-mask-1\)'/u.test(overlayStyle), overlayStyle)
check('panel surface is the application background (bg-base)',
  /background:\s*'var\(--dsw-alias-bg-base\)'/u.test(panelStyle), panelStyle)
check('nested card matches a DSH card surface (bg-layer-2)',
  /background:\s*'var\(--dsw-alias-bg-layer-2\)'/u.test(confirmStyle), confirmStyle)
check('buttons sit above the cards (bg-layer-3)',
  /background:\s*'var\(--dsw-alias-bg-layer-3\)'/u.test(smallButtonStyle), smallButtonStyle)
check('chips do not outshine the buttons (bg-layer-2)',
  /background:\s*'var\(--dsw-alias-bg-layer-2\)'/u.test(badgeStyle), badgeStyle)
check('dialog uses the elevated shadow token', /boxShadow:\s*'var\(--dsw-elevation-prominent\)'/u.test(panelStyle))
check('bg-overlay is not used as a surface', !/background:\s*'var\(--dsw-alias-bg-overlay\)'/u.test(source))
check('text uses label tokens', used.has('--dsw-alias-label-primary') && used.has('--dsw-alias-label-secondary'))
check('accent uses the brand token', used.has('--dsw-alias-brand-primary'))

// 3. No colour literals at all: the mask, the shadow and every fill are tokens.
const rgb = [...source.matchAll(/rgba?\(([^)]*)\)/g)].map((match) => match[0])
check('no rgb()/rgba() literals', rgb.length === 0, rgb.join(' '))

// 4. Translucency must be expressed with color-mix so both themes work.
check('color-mix is used for state fills', /color-mix\(in srgb,var\(--dsw-alias/u.test(source))

console.log('')
if (failures > 0) { console.log(`FAILED: ${failures}`); process.exit(1) }
console.log('ALL THEME CHECKS PASSED')
