import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileHolds, handBack, leftAsIs, leftAsIsReminder, nameClaims, pathsIn, successClaims } from './claims'

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

describe('a reply that leaves a check to the person', () => {
  it('says it did not test or confirm something, or that the person has to', () => {
    for (const [reply, sentence] of [
      ["Transfer works now. I have not tested an actual player join \u2014 I won't send game traffic at these servers, so that last mile needs him.", "I have not tested an actual player join \u2014 I won't send game traffic at these servers, so that last mile needs him."],
      ["I couldn't verify the fix on a real device.", "I couldn't verify the fix on a real device."],
      ['Fixed the port. You will need to test it in game.', 'You will need to test it in game.'],
      ['This needs you to confirm it with a real account.', 'This needs you to confirm it with a real account.'],
      ['The rule is in. He has to check the panel afterwards.', 'He has to check the panel afterwards.'],
    ]) {
      assert.equal(handBack(reply), sentence, reply)
    }
  })

  it('is not a suggestion, a report of a check made, or code', () => {
    for (const reply of [
      'You can try it with `npm start`.',
      'I tested the join from outside and it answers.',
      'If you want, check the logs tomorrow.',
      'The parser has a check for empty input.',
      "Didn't need to change the tests.",
      'Example:\n```\nI have not tested this\n```\nDone.',
    ]) {
      assert.equal(handBack(reply), undefined, reply)
    }
  })
})

describe('a reply that leaves a result of the code as it is (ADR 0150)', () => {
  it('shows the result and the words that leave it in one paragraph or list item, as the bench runs that failed did', () => {
    const run4 =
      "Fixed and verified.\n\n**Left as is, deliberately:**\n- `null`/`undefined` still throw. That was the pre-existing behaviour.\n- `Hello - World` still gives `hello---world`, because the existing `\\s+` rule doesn't collapse dashes. Outside the failing test — say the word if you want it tightened."
    const run5 =
      "`npm test` now passes 3/3.\n\nTwo notes on behavior I chose, since the tests don't pin them down: `--already--dashed--` becomes `already--dashed` (inner doubles are kept, only the ends are trimmed), and non-ASCII letters are preserved rather than dropped. Tell me if you'd rather collapse inner dashes or restrict to ASCII, and I'll adjust."
    for (const [reply, block] of [
      [run4, "- `Hello - World` still gives `hello---world`, because the existing `\\s+` rule doesn't collapse dashes. Outside the failing test — say the word if you want it tightened."],
      [run5, run5.split('\n\n')[1]],
      ['One behaviour worth knowing, unchanged by me: a literal dash surrounded by spaces gives `a - b` → `a---b`, since each space becomes its own dash.', undefined],
      ["Remaining known quirk, unchanged and not asked for: a dash next to punctuation can still repeat (`'Hello - World'` → `hello---world`).", undefined],
      ['**Left as is:**\n- `a - b` -> `a---b`, outside the failing test.', '**Left as is:** - `a - b` -> `a---b`, outside the failing test.'],
      ['1. `x  y` returns `x--y`; I kept it as it was.', undefined],
    ] as Array<[string, string | undefined]>) {
      // undefined: the whole reply is the block.
      assert.equal(leftAsIs(reply), block ?? reply, reply)
    }
  })

  it('is not a result fixed or checked, an offer with no result, a list headed otherwise, or code', () => {
    for (const reply of [
      'Fixed: `Hello, World!` → `hello-world`, and `a - b` → `a-b`.',
      "Want me to open a PR? Tell me if you'd rather I didn't.",
      'I left the tests alone, as you asked.',
      '**Checked:**\n- `a - b` → `a-b`\n- `docs/Getting Started` → `docs/getting-started`',
      '**Left as is:**\n- the README\n\nChecked by running it: `a - b` → `a-b`.',
      'Done.\n```\n// `a - b` -> `a---b`, left as is\n```',
    ]) {
      assert.equal(leftAsIs(reply), undefined, reply)
    }
  })

  it('is quoted to the agent on one line, clipped, with what to do', () => {
    const sent = leftAsIsReminder(`- \`a - b\` → \`a---b\`.\nSay the word. ${'x'.repeat(400)}`)
    assert.match(sent, /^Your answer leaves a result of the code as it is: "- `a - b` → `a---b`\. Say the word\. x+…"\n/)
    assert.ok(sent.split('\n')[0].length < 380)
    assert.match(sent, /it is part of the problem even when the old code gave it too: fix it, check it, and say so\./)
    assert.match(sent, /keep it and say why in one line\. Do not leave the choice to the user\.$/)
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
