import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

/**
 * Nothing the interface shows is an error's own text: every failure goes through errorText(), which keeps one plain
 * line and turns a fault in eNCode's code into a fixed sentence. This fails the build when a file reads an error's
 * message or stack itself, so a raw "TypeError: ..." or a provider's JSON cannot reach a toast, a dialog or the chat.
 */

/** The renderer's sources; the test runs from a bundle elsewhere, so it is found from the working folder. */
function sourceRoot(): string {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'apps', 'desktop', 'src')
    if (existsSync(path.join(candidate, 'ipc-error.ts'))) return candidate
    if (path.dirname(dir) === dir) throw new Error('Run the tests from inside the repository: apps/desktop/src was not found.')
  }
}

const ROOT = sourceRoot()

/** errorText() is the one place allowed to read them. */
const ALLOWED = new Set(['ipc-error.ts'])

const RAW: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\(\s*\w+\s+as\s+(?:Error|\w*Error)\s*\)\.(?:message|stack)\b/, what: 'reads a caught error as Error' },
  { pattern: /\b(?:error|err|e|reason|cause|caught|thrown|failure)\.(?:message|stack)\b/, what: "reads an error's message or stack" },
  { pattern: /\bString\(\s*(?:error|err|e|reason|caught)\s*\)/, what: 'turns a caught error into text' },
]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('errors in the interface', () => {
  it('reach the person only through errorText()', () => {
    const found: string[] = []
    const files = sources(ROOT)
    assert.ok(files.length > 100, `only ${files.length} files were found under ${ROOT}`)
    for (const file of files) {
      if (ALLOWED.has(path.relative(ROOT, file))) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/^\s*(?:\/\/|\*)/.test(line)) return
          for (const { pattern, what } of RAW) if (pattern.test(line)) found.push(`${path.relative(ROOT, file)}:${index + 1} ${what}: ${line.trim()}`)
        })
    }
    assert.deepEqual(found, [], `Show these through errorText() from src/ipc-error.ts:\n${found.join('\n')}`)
  })

  it('would catch the forms it looks for', () => {
    const lines = ['notify("error", (err as Error).message)', 'setError(error.message)', 'toast(String(error))', 'console.log(e.stack)']
    for (const line of lines) assert.ok(RAW.some(({ pattern }) => pattern.test(line)), line)
    for (const line of ['notify("error", outcome.message)', 'setError(errorText(error))', 'event.message']) assert.ok(!RAW.some(({ pattern }) => pattern.test(line)), line)
  })
})
