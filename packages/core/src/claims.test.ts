import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileHolds, nameClaims, pathsIn, successClaims } from './claims'

describe('a reply that says the checks pass', () => {
  it('is a report, in its many forms', () => {
    for (const reply of [
      'All tests pass.',
      'Fixed the parser. The tests pass now (42/42).',
      'The typecheck is clean and the build succeeds.',
      'Everything compiles cleanly.',
      'There are no type errors left.',
      'It passes all the tests.',
      'Tests are green.',
    ]) {
      assert.equal(successClaims(reply).length, 1, reply)
    }
  })

  it('is not a hope, a plan, an instruction or a doubt', () => {
    for (const reply of [
      'The tests should pass now.',
      'Run `pnpm test` to confirm the tests pass.',
      "I couldn't run the tests, so I don't know whether they pass.",
      'If the tests pass, merge it.',
      'Once the build succeeds, deploy.',
      'The tests will pass after you install the dependencies.',
      'I added a test for the empty input.',
    ]) {
      assert.deepEqual(successClaims(reply), [], reply)
    }
    // Code blocks are the agent's example, not its claim.
    assert.deepEqual(successClaims('Output:\n```\nall tests passed\n```\nDone.'), [])
  })
})

describe('the files a reply names', () => {
  it('are the paths in code spans, links and text, without line numbers', () => {
    assert.deepEqual(pathsIn('I changed `src/auth.ts:42` and packages/core/src/loop.ts. See [the docs](docs/adr/0095-checks.md).'), [
      'src/auth.ts',
      'packages/core/src/loop.ts',
      'docs/adr/0095-checks.md',
    ])
    assert.deepEqual(pathsIn('Windows: `C:\\Users\\v\\app\\main.lua`.'), ['C:\\Users\\v\\app\\main.lua'])
  })

  it('leave out what may not exist: suggestions, removals, bare names, placeholders and addresses', () => {
    assert.deepEqual(pathsIn('You could create `src/new.ts` for this.'), [])
    assert.deepEqual(pathsIn('I removed `src/old.ts`.'), [])
    assert.deepEqual(pathsIn('It is in `utils.ts`.'), [], 'a bare name could be in any folder')
    assert.deepEqual(pathsIn('Put it in `path/to/file.ts` or `src/*.ts` or `<dir>/a.ts`.'), [])
    assert.deepEqual(pathsIn('See https://example.com/docs/page.html and www.site.com/a.js.'), [])
    assert.deepEqual(pathsIn('The ratio is 3/4 and the date is 10/24.'), [])
  })
})

describe('a name a reply puts in a file', () => {
  it('is read where the sentence names the code and the file', () => {
    assert.deepEqual(nameClaims('I added `validateToken()` to `src/auth.ts` and called it from `Router.handle`.'), [
      { sentence: 'I added `validateToken()` to `src/auth.ts` and called it from `Router.handle`.', files: ['src/auth.ts'], names: ['validateToken', 'handle'] },
    ])
    assert.deepEqual(nameClaims('The bug was in `parse()`.'), [], 'no file')
    assert.deepEqual(nameClaims('I removed `oldHelper()` from `src/a.ts`.'), [], 'gone from the file')
    assert.deepEqual(nameClaims('You could add `cache()` to `src/a.ts`.'), [], 'a suggestion')
    assert.deepEqual(nameClaims('There is no `formatPrice` in the project, so I used `formatCurrency` from src/money.js.'), [], 'says it is not there')
    assert.deepEqual(nameClaims('`src/a.ts` now returns `null` when `id` is empty.'), [], 'common words and short names say nothing')
  })

  it('is held when the file has it as a whole word', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-claims-'))
    try {
      const file = path.join(dir, 'a.ts')
      await fs.writeFile(file, 'export function validateToken(t: string) { return $check(t) }\n')
      assert.equal(await fileHolds(file, 'validateToken'), true)
      assert.equal(await fileHolds(file, 'validate'), false, 'part of a word is not the name')
      assert.equal(await fileHolds(file, '$check'), true)
      assert.equal(await fileHolds(path.join(dir, 'missing.ts'), 'x'), true, 'an unreadable file is not held against the reply')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
