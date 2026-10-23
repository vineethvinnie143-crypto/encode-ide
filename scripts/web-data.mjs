/**
 * Writes packages/weblang/src/data/css-data.ts and html-data.ts: the CSS properties, their syntax and keywords, the
 * at-rules, pseudo-classes, pseudo-elements and functions, and the HTML elements with their attributes, that eNCode's
 * own JSON, CSS and HTML language server knows (ADR 0085). They are read from data packages on npm, pinned here by
 * version and sha512 and checked before they are read: mdn-data (CC0) for CSS, and html-tag-names, html-void-elements
 * and html-element-attributes (MIT) for HTML. Nothing in them is run; only their JSON and lists are read.
 *
 *   node scripts/web-data.mjs
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'packages', 'weblang', 'src', 'data')

const PACKAGES = {
  'mdn-data': { version: '2.37.2', integrity: 'sha512-rz9YOBGItdSbe7HcSArUbhiAv4SB/4DKRYg96CSFS2CcIYMbUvBtZlzA1NCbk2AdgbmYwMqwNblLpR441lLeiQ==' },
  'html-tag-names': { version: '2.1.0', integrity: 'sha512-+NhBUNvS5Ig8g8LO1DBpyapuGsu+FLcpLwmMADCntvU9IUa30++WV3GmuBHZm8Y9cHdIson/uvbQ/6jVL63XZw==' },
  'html-void-elements': { version: '3.0.0', integrity: 'sha512-bEqo66MRXsUGxWHV5IP0PUiAWwoEjba4VCzg0LjFJBpchPaTfyfCKTG6bc5F8ucKec3q5y6qOdGyYTSBEvhCrg==' },
  'html-element-attributes': { version: '3.5.0', integrity: 'sha512-rU2BFhp0kQla9sqPBI46C+zbP6PFOtD7z6XNAJ6as+cGecCDXLx0W3aIs6XdPLmBBG/Fy1meRi/n65Exofz4Qw==' },
}

/** The files of a gzipped npm tarball, by path inside `package/`. */
function untar(gz) {
  const data = gunzipSync(gz)
  const files = new Map()
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const name = `${field(345, 155) ? `${field(345, 155)}/` : ''}${field(0, 100)}`
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    if (type === '0' || type === '') files.set(name.replace(/^package\//, ''), data.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function fetchPackage(name) {
  const { version, integrity } = PACKAGES[name]
  const base = name.split('/').pop()
  const response = await fetch(`https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`)
  if (!response.ok) throw new Error(`${name} ${version}: ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (`sha512-${createHash('sha512').update(body).digest('base64')}` !== integrity) throw new Error(`${name} ${version} does not match its pinned hash`)
  return untar(body)
}

const json = (files, file) => JSON.parse(files.get(file).toString('utf8'))

/** The words an ES module's `export const x = [...]` or `{...}` holds, read as JSON after taking the export off. */
function exported(files, file) {
  const text = files.get(file).toString('utf8')
  const start = text.search(/export const \w+ = /)
  if (start < 0) throw new Error(`${file} exports no constant`)
  const body = text.slice(text.indexOf('=', start) + 1).trim().replace(/;\s*$/, '')
  // The lists are plain literals: single quotes become double quotes and keys get theirs.
  const asJson = body.replace(/'([^'\\]*)'/g, '"$1"').replace(/([{,]\s*)([A-Za-z_$*][\w$-]*)\s*:/g, '$1"$2":').replace(/,(\s*[\]}])/g, '$1')
  return JSON.parse(asJson)
}

const IDENT = /^-?[a-z][a-z0-9-]*$/

/** Keywords a value syntax allows, following `<name>` to other syntaxes made only of keywords, a few levels deep. */
function keywords(syntax, syntaxes, depth = 0, seen = new Set()) {
  const found = new Set()
  const cleaned = syntax.replace(/'[^']*'/g, ' ').replace(/\{[^}]*\}/g, ' ')
  for (const token of cleaned.split(/[\s|&[\]?*+#!,/()]+/)) {
    if (!token) continue
    const reference = /^<([a-z0-9-]+)>$/.exec(token)
    if (reference) {
      const name = reference[1]
      if (depth < 3 && syntaxes[name] && !seen.has(name)) {
        seen.add(name)
        for (const word of keywords(syntaxes[name].syntax, syntaxes, depth + 1, seen)) found.add(word)
      }
      continue
    }
    if (IDENT.test(token)) found.add(token)
  }
  return [...found]
}

/** Common enumerated attribute values, written by eNCode from the HTML standard. */
const ATTRIBUTE_VALUES = {
  'input/type': ['button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week'],
  'button/type': ['button', 'reset', 'submit'],
  'form/method': ['dialog', 'get', 'post'],
  'form/enctype': ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'],
  'script/type': ['module', 'importmap', 'text/javascript'],
  'link/rel': ['alternate', 'canonical', 'icon', 'manifest', 'modulepreload', 'preconnect', 'prefetch', 'preload', 'stylesheet'],
  'a/rel': ['external', 'help', 'license', 'next', 'nofollow', 'noopener', 'noreferrer', 'prev', 'search', 'tag'],
  '*/target': ['_blank', '_parent', '_self', '_top'],
  '*/dir': ['auto', 'ltr', 'rtl'],
  '*/loading': ['eager', 'lazy'],
  '*/decoding': ['async', 'auto', 'sync'],
  '*/crossorigin': ['anonymous', 'use-credentials'],
  '*/referrerpolicy': ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'],
  '*/autocomplete': ['off', 'on', 'name', 'email', 'username', 'new-password', 'current-password', 'one-time-code', 'tel', 'street-address', 'postal-code', 'country'],
  '*/inputmode': ['decimal', 'email', 'none', 'numeric', 'search', 'tel', 'text', 'url'],
  '*/enterkeyhint': ['done', 'enter', 'go', 'next', 'previous', 'search', 'send'],
  '*/contenteditable': ['false', 'plaintext-only', 'true'],
  '*/draggable': ['false', 'true'],
  '*/spellcheck': ['false', 'true'],
  '*/translate': ['no', 'yes'],
  '*/hidden': ['hidden', 'until-found'],
  '*/popover': ['auto', 'hint', 'manual'],
  'track/kind': ['captions', 'chapters', 'descriptions', 'metadata', 'subtitles'],
  'video/preload': ['auto', 'metadata', 'none'],
  'audio/preload': ['auto', 'metadata', 'none'],
  'iframe/sandbox': ['allow-downloads', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-same-origin', 'allow-scripts', 'allow-top-navigation'],
  'th/scope': ['col', 'colgroup', 'row', 'rowgroup'],
  'ol/type': ['1', 'A', 'I', 'a', 'i'],
  'textarea/wrap': ['hard', 'off', 'soft'],
  'meta/name': ['application-name', 'author', 'color-scheme', 'description', 'generator', 'keywords', 'referrer', 'robots', 'theme-color', 'viewport'],
  'meta/http-equiv': ['content-security-policy', 'content-type', 'default-style', 'refresh', 'x-ua-compatible'],
}

/** Elements the HTML standard no longer has; offered last and marked as such. */
const OBSOLETE = new Set(['acronym', 'applet', 'basefont', 'bgsound', 'big', 'blink', 'center', 'command', 'content', 'dir', 'element', 'font', 'frame', 'frameset', 'image', 'isindex', 'keygen', 'listing', 'marquee', 'menuitem', 'multicol', 'nextid', 'nobr', 'noembed', 'noframes', 'plaintext', 'rb', 'rtc', 'shadow', 'spacer', 'strike', 'tt', 'xmp'])

const header = (sources) => `// Written by scripts/web-data.mjs from ${sources}, pinned and checked there. Run it again to change this file.\n`

async function main() {
  const mdn = await fetchPackage('mdn-data')
  const properties = json(mdn, 'css/properties.json')
  const syntaxes = json(mdn, 'css/syntaxes.json')
  const atRules = json(mdn, 'css/at-rules.json')
  const selectors = json(mdn, 'css/selectors.json')
  const functions = json(mdn, 'css/functions.json')
  const units = json(mdn, 'css/units.json')

  const props = Object.keys(properties)
    .filter((name) => IDENT.test(name))
    .sort()
    .map((name) => {
      const item = properties[name]
      const status = item.status && item.status !== 'standard' ? item.status : undefined
      return [name, item.syntax, keywords(item.syntax, syntaxes).sort(), ...(status ? [status] : [])]
    })
  const ats = Object.keys(atRules)
    .filter((name) => /^@[a-z-]+$/.test(name))
    .sort()
    .map((name) => [name, (atRules[name].descriptors ? Object.keys(atRules[name].descriptors).sort() : [])])
  const pseudoClasses = Object.keys(selectors).filter((name) => /^:[a-z-]+(\(\))?$/.test(name)).sort()
  const pseudoElements = Object.keys(selectors).filter((name) => /^::[a-z-]+(\(\))?$/.test(name)).sort()
  const fns = Object.keys(functions).filter((name) => /^[a-z-]+\(\)$/.test(name)).sort()
  const unitNames = Object.keys(units).filter((name) => /^[a-z%]+$/i.test(name)).sort()

  const css = [
    header(`mdn-data ${PACKAGES['mdn-data'].version} (CC0)`),
    '/** Each CSS property: its name, its value syntax, the keywords that syntax allows, and its status when not standard. */',
    `export const CSS_PROPERTIES: readonly (readonly [string, string, readonly string[], string?])[] = ${JSON.stringify(props)}`,
    '',
    '/** Each at-rule, with the descriptors its block takes (for `@font-face`, `@page`...). */',
    `export const CSS_AT_RULES: readonly (readonly [string, readonly string[]])[] = ${JSON.stringify(ats)}`,
    '',
    `export const CSS_PSEUDO_CLASSES: readonly string[] = ${JSON.stringify(pseudoClasses)}`,
    '',
    `export const CSS_PSEUDO_ELEMENTS: readonly string[] = ${JSON.stringify(pseudoElements)}`,
    '',
    `export const CSS_FUNCTIONS: readonly string[] = ${JSON.stringify(fns)}`,
    '',
    `export const CSS_UNITS: readonly string[] = ${JSON.stringify(unitNames)}`,
    '',
  ].join('\n')

  const tags = exported(await fetchPackage('html-tag-names'), 'index.js')
  const voids = exported(await fetchPackage('html-void-elements'), 'index.js')
  const attributes = exported(await fetchPackage('html-element-attributes'), 'index.js')
  const elements = tags
    .filter((name) => /^[a-z][a-z0-9]*$/.test(name))
    .sort()
    .map((name) => [name, (attributes[name] ?? []).filter((attribute) => /^[a-z][a-z0-9-]*$/.test(attribute)).sort(), (voids.includes(name) ? 1 : 0) | (OBSOLETE.has(name) ? 2 : 0)])
  const html = [
    header(`html-tag-names ${PACKAGES['html-tag-names'].version}, html-void-elements ${PACKAGES['html-void-elements'].version} and html-element-attributes ${PACKAGES['html-element-attributes'].version} (MIT)`),
    '/** Each element: its name, its own attributes, and flags: 1 void (no closing tag), 2 obsolete. */',
    `export const HTML_ELEMENTS: readonly (readonly [string, readonly string[], number])[] = ${JSON.stringify(elements)}`,
    '',
    '/** Attributes every element takes, besides `data-*` and the `on*` event handlers. */',
    `export const HTML_GLOBAL_ATTRIBUTES: readonly string[] = ${JSON.stringify((attributes['*'] ?? []).filter((attribute) => /^[a-z][a-z0-9-]*$/.test(attribute)).sort())}`,
    '',
    '/** Values an attribute takes, by `element/attribute`, or `*` for any element. Written by eNCode from the HTML standard. */',
    `export const HTML_ATTRIBUTE_VALUES: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(ATTRIBUTE_VALUES)}`,
    '',
  ].join('\n')

  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'css-data.ts'), css)
  fs.writeFileSync(path.join(out, 'html-data.ts'), html)
  console.log(`wrote ${props.length} properties, ${ats.length} at-rules and ${elements.length} elements (${Math.round((css.length + html.length) / 1024)} KB)`)
}

await main()
