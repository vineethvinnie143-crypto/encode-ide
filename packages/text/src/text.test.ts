import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { ChangeSet, Text } from './index'

/** Documents from empty to a few thousand lines, so edits cross leaf boundaries. */
const docs: Gen<string> = (random, size) => {
  const count = Math.floor(random() * (size * 120 + 1))
  const lines: string[] = []
  for (let index = 0; index < count; index++) {
    const kind = random()
    lines.push(kind < 0.2 ? '' : kind < 0.95 ? 'x'.repeat(Math.floor(random() * 40)) + index : 'y'.repeat(20_000))
  }
  return lines.join('\n')
}

const pieces = gen.string('ab\n\n€😀', 0, 12)

function lineAtModel(source: string, pos: number) {
  const from = pos === 0 ? 0 : source.lastIndexOf('\n', pos - 1) + 1
  const end = source.indexOf('\n', pos)
  const to = end === -1 ? source.length : end
  const number = source.slice(0, from).split('\n').length
  return { number, from, to, text: source.slice(from, to) }
}

describe('Text', () => {
  it('round-trips strings and counts lines', () => {
    for (const source of ['', 'a', '\n', 'a\nb', 'a\n\nb\n', '\r\n']) {
      const text = Text.of(source)
      assert.equal(text.toString(), source)
      assert.equal(text.length, source.length)
      assert.equal(text.lineCount, source.split('\n').length)
    }
  })

  it('finds lines by offset and number', () => {
    const text = Text.of('one\ntwo\n\nfour')
    assert.deepEqual(text.lineAt(0), { number: 1, from: 0, to: 3, text: 'one' })
    assert.deepEqual(text.lineAt(3), { number: 1, from: 0, to: 3, text: 'one' })
    assert.deepEqual(text.lineAt(4), { number: 2, from: 4, to: 7, text: 'two' })
    assert.deepEqual(text.lineAt(8), { number: 3, from: 8, to: 8, text: '' })
    assert.deepEqual(text.line(4), { number: 4, from: 9, to: 13, text: 'four' })
    assert.throws(() => text.line(0), RangeError)
    assert.throws(() => text.line(5), RangeError)
    assert.throws(() => text.lineAt(14), RangeError)
    assert.throws(() => text.lineAt(1.5), RangeError)
  })

  it('compares with a string in place, as the string would read as a document', async () => {
    const piece = gen.oneOf('', 'a', 'b', '\n', 'ab\n', '\r', '😀')
    const source = gen.map(gen.array(piece, 0, 40), (parts) => parts.join(''))
    await check(gen.tuple(source, source), ([a, b]) => {
      assert.equal(Text.of(a).eqString(b), a === b)
      assert.equal(Text.of(a).eqString(a), true)
    })
    const big = Text.of(Array.from({ length: 3000 }, (_, index) => `line ${index}`))
    const text = big.toString()
    assert.ok(big.eqString(text))
    assert.ok(!big.eqString(`${text.slice(0, -1)}X`))
    assert.ok(!big.eqString(text.replace('line 2000\n', 'line 2000 ')))
  })

  it('rejects ranges outside the document', () => {
    const text = Text.of('abc')
    assert.throws(() => text.replace(2, 1, 'x'), RangeError)
    assert.throws(() => text.replace(-1, 1, 'x'), RangeError)
    assert.throws(() => text.sliceString(0, 4), RangeError)
  })

  it('shares untouched leaves between versions', () => {
    const big = Text.of(Array.from({ length: 5000 }, (_, index) => `line ${index}`))
    const edited = big.replace(big.line(2500).from, big.line(2500).from, 'X')
    assert.equal(edited.line(2500).text, 'Xline 2499')
    assert.equal(big.line(2500).text, 'line 2499')
    assert.equal(edited.line(1).text, 'line 0')
    assert.equal(edited.line(5000).text, 'line 4999')
  })

  it('matches a string model under random edits', async () => {
    const cases = gen.tuple(docs, gen.array(gen.tuple(gen.int(0, 1_000_000), gen.int(0, 50), pieces), 1, 12))
    await check(
      cases,
      ([source, edits]) => {
        let model = source
        let text = Text.of(source)
        for (const [at, span, insert] of edits) {
          const from = at % (model.length + 1)
          const to = Math.min(model.length, from + span)
          model = model.slice(0, from) + insert + model.slice(to)
          text = text.replace(from, to, insert)
          assert.equal(text.length, model.length)
          assert.equal(text.lineCount, model.split('\n').length)
        }
        assert.equal(text.toString(), model)
        for (let probe = 0; probe < 8; probe++) {
          const pos = Math.floor(((probe + 0.5) / 8) * model.length)
          assert.deepEqual(text.lineAt(pos), lineAtModel(model, pos))
          const end = Math.min(model.length, pos + 777)
          assert.equal(text.sliceString(pos, end), model.slice(pos, end))
        }
        const lines = model.split('\n')
        const n = Math.ceil(lines.length / 2)
        assert.equal(text.line(n).text, lines[n - 1])
        assert.deepEqual(text.lineTexts(), lines)
        assert.ok(text.eq(Text.of(model)))
      },
      { runs: 120, maxSize: 30 },
    )
  })
})

describe('ChangeSet', () => {
  const specs = (length: number) => gen.array(gen.tuple(gen.int(0, length), gen.int(0, 6), pieces), 0, 60)

  it('applies, inverts and maps like a string model', async () => {
    const cases: Gen<[string, [number, number, string][]]> = (random, size) => {
      const source = docs(random, size)
      return [source, specs(source.length)(random, size)]
    }
    await check(
      cases,
      ([source, raw]) => {
        const doc = Text.of(source)
        const changes = ChangeSet.of(
          raw.map(([from, span, insert]) => ({ from, to: Math.min(source.length, from + span), insert })),
          source.length,
        )
        // Sorted and non-overlapping.
        for (let index = 1; index < changes.changes.length; index++) {
          assert.ok(changes.changes[index].from >= changes.changes[index - 1].to)
        }
        let model = source
        for (let index = changes.changes.length - 1; index >= 0; index--) {
          const change = changes.changes[index]
          model = model.slice(0, change.from) + change.insert + model.slice(change.to)
        }
        const after = changes.apply(doc)
        assert.equal(after.toString(), model)
        assert.equal(changes.newLength, model.length)
        assert.equal(changes.invert(doc).apply(after).toString(), source)

        // Mapping is monotonic and keeps text outside the changes in place.
        let previous = -1
        for (let pos = 0; pos <= source.length; pos += Math.max(1, Math.floor(source.length / 40))) {
          const mapped = changes.mapPos(pos)
          assert.ok(mapped >= previous)
          assert.ok(mapped <= after.length)
          previous = mapped
          const inside = changes.changes.some((change) => pos >= change.from && pos <= change.to)
          if (!inside && pos < source.length) assert.equal(after.sliceString(mapped, mapped + 1), source[pos])
        }
      },
      { runs: 150, maxSize: 20 },
    )
  })

  it('composes like applying one set after the other', async () => {
    const cases: Gen<[string, [number, number, string][], [number, number, string][]]> = (random, size) => {
      const source = docs(random, Math.min(size, 4))
      return [source, specs(source.length)(random, size), specs(source.length + 40)(random, size)]
    }
    await check(
      cases,
      ([source, rawA, rawB]) => {
        const doc = Text.of(source)
        const first = ChangeSet.of(
          rawA.map(([from, span, insert]) => ({ from, to: Math.min(source.length, from + span), insert })),
          source.length,
        )
        const middle = first.apply(doc)
        const second = ChangeSet.of(
          rawB
            .filter(([from]) => from <= middle.length)
            .map(([from, span, insert]) => ({ from, to: Math.min(middle.length, from + span), insert })),
          middle.length,
        )
        const composed = first.compose(second)
        assert.equal(composed.length, source.length)
        assert.equal(composed.apply(doc).toString(), second.apply(middle).toString())
        assert.equal(composed.invert(doc).apply(composed.apply(doc)).toString(), source)
      },
      { runs: 300, maxSize: 20 },
    )
  })

  it('merges overlapping and touching changes', () => {
    const changes = ChangeSet.of(
      [
        { from: 2, to: 4, insert: 'X' },
        { from: 3, to: 6, insert: 'Y' },
        { from: 8, insert: 'A' },
        { from: 8, insert: 'B' },
        { from: 8, to: 9, insert: 'C' },
      ],
      10,
    )
    assert.deepEqual(changes.changes, [
      { from: 2, to: 6, insert: 'XY' },
      { from: 8, to: 9, insert: 'ABC' },
    ])
  })

  it('maps around insertion points by association', () => {
    const changes = ChangeSet.of({ from: 3, insert: 'xyz' }, 5)
    assert.equal(changes.mapPos(3, -1), 3)
    assert.equal(changes.mapPos(3, 1), 6)
    assert.equal(changes.mapPos(4), 7)
    const deletion = ChangeSet.of({ from: 1, to: 4 }, 5)
    assert.equal(deletion.mapPos(2), 1)
    assert.equal(deletion.mapPos(4), 1)
    assert.equal(deletion.mapPos(5), 2)
  })

  it('reports the span it covers', () => {
    const changes = ChangeSet.of([{ from: 1, to: 2, insert: 'abc' }, { from: 5, to: 7 }], 10)
    assert.deepEqual(changes.span(), { fromA: 1, toA: 7, fromB: 1, toB: 7 })
    assert.equal(ChangeSet.empty(3).span(), null)
  })

  it('rejects changes outside the document', () => {
    assert.throws(() => ChangeSet.of({ from: 2, to: 1 }, 5), RangeError)
    assert.throws(() => ChangeSet.of({ from: 0, to: 6 }, 5), RangeError)
    assert.throws(() => ChangeSet.of({ from: 0 }, 5).apply(Text.of('abc')), RangeError)
  })
})

describe('width', () => {
  it('counts cells the way terminals do', async () => {
    const { codePointWidth, stringWidth } = await import('./index')
    assert.equal(codePointWidth('a'.codePointAt(0)!), 1)
    assert.equal(codePointWidth(0x07), 0)
    assert.equal(codePointWidth('中'.codePointAt(0)!), 2)
    assert.equal(codePointWidth('ｱ'.codePointAt(0)!), 1)
    assert.equal(codePointWidth('Ａ'.codePointAt(0)!), 2)
    assert.equal(codePointWidth('😀'.codePointAt(0)!), 2)
    assert.equal(codePointWidth(0x0301), 0)
    assert.equal(codePointWidth(0x200d), 0)
    assert.equal(codePointWidth('é'.codePointAt(0)!), 1)
    assert.equal(stringWidth('a\tb', 4), 5)
    assert.equal(stringWidth('\t', 4, 2), 2)
    assert.equal(stringWidth('日本語'), 6)
    assert.equal(stringWidth('é'), 1)
    assert.equal(stringWidth('😀x'), 3)
  })
})
