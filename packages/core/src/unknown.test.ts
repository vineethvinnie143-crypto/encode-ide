/**
 * What a failed command named that was not there, and the note that says how to look it up (ADR 0140).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentShell } from '@encode/tools'
import { loopHarness, stubShell } from './testing'
import { lookUpNote, unknownIn } from './unknown'

describe('what a failed command says was not there', () => {
  it('reads programs, options, scripts, modules and members from the usual errors', () => {
    const cases: Array<[string, string, ReturnType<typeof unknownIn>]> = [
      ['rg foo', 'bash: rg: command not found', { kind: 'command', name: 'rg' }],
      ['jq .', 'sh: 1: jq: not found', { kind: 'command', name: 'jq' }],
      ['tree', "'tree' is not recognized as an internal or external command,\noperable program or batch file.", { kind: 'command', name: 'tree' }],
      ['pnpm run lint:fix', ' ERR_PNPM_NO_SCRIPT  Missing script: lint:fix', { kind: 'script', name: 'lint:fix' }],
      ['git log --oneline --graphs', 'fatal: unrecognized argument: --graphs', { kind: 'option', name: '--graphs', program: 'git log' }],
      ['ls --colour=auto -la', "ls: unrecognized option '--colour=auto'", { kind: 'option', name: '--colour', program: 'ls' }],
      ['cd app && python -m pytest --fast tests/', 'pytest: error: unrecognized arguments: --fast', { kind: 'option', name: '--fast', program: 'python -m pytest' }],
      ['NODE_ENV=test npx vitest run --threads', "CACError: Unknown option `--threads`", { kind: 'option', name: '--threads', program: 'vitest run' }],
      ['kubectl get pods --wide', 'Error: unknown flag: --wide', { kind: 'option', name: '--wide', program: 'kubectl get pods' }],
      ['python app.py', "Traceback (most recent call last):\nModuleNotFoundError: No module named 'yaml'", { kind: 'module', name: 'yaml' }],
      ['python app.py', "ImportError: cannot import name 'soft_unicode' from 'markupsafe'", { kind: 'member', name: 'soft_unicode', owner: 'markupsafe' }],
      ['python app.py', "AttributeError: module 'numpy' has no attribute 'float'", { kind: 'member', name: 'float', owner: 'numpy' }],
      ['node app.js', "Error: Cannot find module 'express'\nRequire stack:", { kind: 'module', name: 'express' }],
      ['node app.js', "Error: Cannot find module './routes'", undefined],
      ['node app.js', 'TypeError: fs.readFileAsync is not a function', { kind: 'member', name: 'readFileAsync', owner: 'fs' }],
      ['npx tsc', "src/a.ts(3,10): error TS2305: Module '\"zod\"' has no exported member 'zodSchema'.", { kind: 'member', name: 'zodSchema', owner: 'zod' }],
      ['npx tsc', "src/a.ts(3,10): error TS2339: Property 'flatMap' does not exist on type 'Foo'.", { kind: 'member', name: 'flatMap', owner: 'Foo' }],
      ['cargo build', 'error[E0599]: no method named `len2` found for struct `Vec<u8>` in the current scope', { kind: 'member', name: 'len2', owner: 'Vec<u8>' }],
      ['go build ./...', './main.go:12:7: undefined: strings.Reverse', { kind: 'member', name: 'Reverse', owner: 'strings' }],
      ['npm test', '1 failing\n  AssertionError: expected 3 to equal 4', undefined],
    ]
    for (const [command, output, expected] of cases) assert.deepEqual(unknownIn(command, output), expected, `${command}: ${output}`)
  })

  it('says how to look each one up, for the platform and the tools there are', () => {
    assert.match(lookUpNote({ kind: 'command', name: 'rg' }, { platform: 'linux', codeMap: true }), /^eNCode: `rg` is not installed here, or not on the PATH \(`command -v rg` says which\)\./)
    assert.match(lookUpNote({ kind: 'command', name: 'rg' }, { platform: 'win32', codeMap: true }), /`where\.exe rg`/)
    assert.match(lookUpNote({ kind: 'option', name: '--wide', program: 'kubectl get pods' }, { platform: 'linux', codeMap: true }), /`kubectl get pods` here does not take `--wide`\. Before you try again, read what this version takes \(`kubectl get pods --help`\)\. Don't guess another spelling/)
    assert.match(lookUpNote({ kind: 'member', name: 'float', owner: 'numpy' }, { platform: 'linux', codeMap: true }), /`numpy` has no `float` at the version this ran with\. Look up what it has before you try again: CodeMap with package/)
    assert.doesNotMatch(lookUpNote({ kind: 'member', name: 'float', owner: 'numpy' }, { platform: 'linux', codeMap: false }), /CodeMap/)
  })
})

describe('the note on a failed command, through the loop', () => {
  it('goes with the result once a request for each name, and not with a command that worked', async () => {
    const failing = (root: string): AgentShell => ({
      ...stubShell(root),
      run: async (command) => (command.startsWith('rg') ? { output: 'bash: rg: command not found', exitCode: 127, timedOut: false, interrupted: false, cwd: root } : { output: 'ok', exitCode: 0, timedOut: false, interrupted: false, cwd: root }),
    })
    const bash = (command: string) => ({ calls: [{ name: 'Bash', input: { command, description: 'Search' } }] })
    const h = await loopHarness({ script: [bash('rg foo'), bash('rg bar'), bash('grep -rn foo .'), { text: 'Found it.' }], shell: failing })
    await h.run('find foo')
    const results = h.client.requests.slice(1).map((request) => JSON.stringify(request.payload.messages.at(-1)))
    assert.match(results[0]!, /eNCode: `rg` is not installed here/)
    assert.doesNotMatch(results[1]!, /eNCode: `rg` is not installed here/, 'once a request')
    assert.doesNotMatch(results[2]!, /eNCode:/)
  })
})
