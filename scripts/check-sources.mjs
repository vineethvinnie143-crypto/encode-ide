/**
 * Fails when a tracked text file holds characters that make code read
 * differently from how it runs: Unicode bidirectional controls ("Trojan
 * Source", CVE-2021-42574) and invisible zero-width characters. Run in CI on
 * every change, so one cannot arrive unnoticed in a pull request.
 *
 *   node scripts/check-sources.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const NAMES = new Map([
  [0x200b, 'zero width space'],
  [0x200c, 'zero width non-joiner'],
  [0x200d, 'zero width joiner'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x202a, 'left-to-right embedding'],
  [0x202b, 'right-to-left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left-to-right override'],
  [0x202e, 'right-to-left override'],
  [0x2060, 'word joiner'],
  [0x2061, 'function application'],
  [0x2062, 'invisible times'],
  [0x2063, 'invisible separator'],
  [0x2064, 'invisible plus'],
  [0x2066, 'left-to-right isolate'],
  [0x2067, 'right-to-left isolate'],
  [0x2068, 'first strong isolate'],
  [0x2069, 'pop directional isolate'],
  [0xfeff, 'zero width no-break space (byte order mark)'],
])
const SUSPICIOUS = new RegExp(`[${[...NAMES.keys()].map((code) => `\\u${code.toString(16).padStart(4, '0')}`).join('')}]`, 'gu')
const TEXT = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html|svg|txt)$|(?:^|\/)(?:\.[a-z-]+rc|\.gitignore|\.node-version|LICENSE)$/i

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((file) => TEXT.test(file))
const problems = []
for (const file of files) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(SUSPICIOUS)) {
      const code = match[0].codePointAt(0)
      const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
      problems.push({ file, line: index + 1, column: match.index + 1, what: `${hex} ${NAMES.get(code)}` })
    }
  })
}

for (const { file, line, column, what } of problems) {
  // GitHub Actions turns this form into an annotation on the line.
  if (process.env.GITHUB_ACTIONS) console.log(`::error file=${file},line=${line},col=${column}::${what}`)
  else console.log(`${file}:${line}:${column}: ${what}`)
}
if (problems.length) {
  console.error(`check-sources: ${problems.length} hidden or direction-changing character(s) in ${new Set(problems.map((p) => p.file)).size} file(s).`)
  process.exit(1)
}
console.log(`check-sources: ${files.length} files clean.`)
