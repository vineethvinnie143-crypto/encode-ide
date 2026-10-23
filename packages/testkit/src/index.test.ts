import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check, gen, prng } from './index'

// The kit's own tests make properties fail on purpose: they are not fuzz targets, whatever scripts/fuzz.mjs asks.
delete process.env.ENCODE_FUZZ_MS
delete process.env.ENCODE_FUZZ_REPORT

/** The error `check` fails with. */
async function failure(run: () => Promise<void>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error as Error
  }
  assert.fail('the property should have failed')
}

/** The input a failure was made smaller to. */
const smallest = (error: Error) => JSON.parse(/made smaller in \d+ steps: (.*)\n/.exec(error.message)![1])

describe('prng', () => {
  it('gives the same numbers for the same seed, all in [0, 1)', () => {
    const a = prng(42)
    const b = prng(42)
    for (let index = 0; index < 1000; index++) {
      const value = a()
      assert.equal(value, b())
      assert.ok(value >= 0 && value < 1)
    }
  })
})

describe('check', () => {
  it('runs every case of a property that holds', async () => {
    let cases = 0
    await check(gen.int(0, 10), () => {
      cases++
    }, { runs: 50, seed: 1 })
    assert.equal(cases, 50)
  })

  it('makes a failing list smaller: one item, the smallest that fails', async () => {
    const error = await failure(() => check(gen.array(gen.int(0, 1000)), (list) => list.every((item) => item <= 500), { seed: 7 }))
    assert.deepEqual(smallest(error), [501])
    assert.match(error.message, /seed 7; replay with ENCODE_PROPERTY_SEED=7/)
    assert.match(error.message, /As first found: \[/)
  })

  it('makes a failing string smaller, down to the characters that matter', async () => {
    const error = await failure(() => check(gen.string('ab'), (text) => !text.includes('bb'), { seed: 3 }))
    assert.equal(smallest(error), 'bb')
  })

  it('makes a pair smaller in both parts', async () => {
    const error = await failure(() =>
      check(gen.tuple(gen.int(0, 100), gen.array(gen.int(0, 100))), ([limit, list]) => list.length <= limit, { seed: 11 }),
    )
    assert.deepEqual(smallest(error), [0, [0]])
  })

  it('reports what the smaller case failed with', async () => {
    const error = await failure(() =>
      check(gen.int(0, 100), (value) => assert.ok(value < 10, `${value} is too big`), { seed: 5 }),
    )
    assert.equal(smallest(error), 10)
    assert.match(error.message, /10 is too big$/)
    assert.equal((error.cause as Error).message, '10 is too big')
  })

  it('can leave a failure as it was found', async () => {
    const error = await failure(() => check(gen.int(0, 100), (value) => value < 10, { seed: 5, shrink: false }))
    assert.doesNotMatch(error.message, /made smaller/)
    assert.match(error.message, /Input: \d+/)
  })

  it('runs the examples that failed before, first', async () => {
    const seen: number[] = []
    await check(gen.int(0, 10), (value) => {
      seen.push(value)
    }, { runs: 3, seed: 1, examples: [99, 98] })
    assert.deepEqual(seen.slice(0, 2), [99, 98])
    const error = await failure(() => check(gen.int(0, 10), (value) => value < 50, { examples: [99] }))
    assert.match(error.message, /example 1, which failed before/)
  })

  it('replays the same cases from the same seed', async () => {
    const runOnce = async () => {
      const values: number[][] = []
      await check(gen.array(gen.int(0, 9)), (list) => {
        values.push(list)
      }, { runs: 20, seed: 1234 })
      return values
    }
    assert.deepEqual(await runOnce(), await runOnce())
  })

  it('fuzzes for a time when asked, and writes one report line per property', async () => {
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'encode-fuzz-')), 'report.jsonl')
    const saved = { ms: process.env.ENCODE_FUZZ_MS, report: process.env.ENCODE_FUZZ_REPORT }
    process.env.ENCODE_FUZZ_MS = '150'
    process.env.ENCODE_FUZZ_REPORT = report
    try {
      let cases = 0
      await check(gen.int(0, 10), () => {
        cases++
      }, { runs: 10 })
      assert.ok(cases > 10, `${cases} cases in 150 ms`)
      const lines = fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(lines.length, 1)
      assert.equal(lines[0].cases, cases)
      assert.equal(lines[0].failed, false)
      assert.match(lines[0].site, /packages\/testkit\/src\/index\.test\.ts:\d+/)
    } finally {
      for (const [key, value] of [['ENCODE_FUZZ_MS', saved.ms], ['ENCODE_FUZZ_REPORT', saved.report]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(path.dirname(report), { recursive: true, force: true })
    }
  })
})
