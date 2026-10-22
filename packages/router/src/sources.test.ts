import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The router runs in the desktop app's agent host, in the CLI and in a
 * Cloudflare Workers gateway, so its sources may use only what all three
 * offer (fetch, timers, AbortController, Web Crypto) and import only the
 * provider contract. Tests and the testing helpers run on Node and are exempt.
 */

function sourceRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'packages', 'router', 'src')
    if (existsSync(join(candidate, 'router.ts'))) return candidate
    if (dirname(dir) === dir) throw new Error('Run the tests from inside the repository: packages/router/src was not found.')
  }
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** The code without comments, so prose may name what code may not use. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

const NODE_ONLY: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bfrom\s+['"]node:|\bimport\(\s*['"]node:|\brequire\(/, what: 'a Node module' },
  { pattern: /\bprocess\s*\./, what: 'process' },
  { pattern: /\bBuffer\b/, what: 'Buffer' },
  { pattern: /\bsetImmediate\b/, what: 'setImmediate' },
  { pattern: /\b__dirname\b|\b__filename\b/, what: 'CommonJS paths' },
]

describe('router sources', () => {
  const root = sourceRoot()
  const files = sources(root)

  it('are found', () => {
    assert.ok(files.length >= 10, `only ${files.length} source files under ${root}`)
  })

  it('use nothing Workers lacks', () => {
    const found = files.flatMap((file) => NODE_ONLY.filter(({ pattern }) => pattern.test(code(file))).map(({ what }) => `${relative(root, file)} uses ${what}`))
    assert.deepEqual(found, [])
  })

  it('import only each other and the provider contract', () => {
    const found = files.flatMap((file) =>
      [...code(file).matchAll(/(?<![.\w$])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../') && specifier !== '@encode/providers')
        .map((specifier) => `${relative(root, file)} imports ${specifier}`),
    )
    assert.deepEqual(found, [])
  })
})
