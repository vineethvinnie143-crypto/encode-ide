import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, type Gen } from '@encode/testkit'
import { ChangeSet, Text, type ChangeSpec } from '@encode/text'
import { LineItems } from './line-items'

interface Item {
  from: number
  to: number
  id: string
}

const items = () => new LineItems<Item>((item, from, to) => ({ ...item, from, to }))

/** Every item as [line, from, to, id]. */
function dump(store: LineItems<Item>, doc: Text): [number, number, number, string][] {
  const out: [number, number, number, string][] = []
  for (let line = 1; line <= doc.lineCount; line++) for (const item of store.line(line) ?? []) out.push([line, item.from, item.to, item.id])
  return out
}

function make(doc: Text, list: [number, number, number, string][]): LineItems<Item> {
  const byLine = new Map<number, Item[]>()
  for (const [line, from, to, id] of list) {
    let row = byLine.get(line)
    if (!row) byLine.set(line, (row = []))
    row.push({ from, to, id })
  }
  void doc
  const store = items()
  store.set(byLine)
  return store
}

describe('items placed on lines', () => {
  it('keep what is before an edit, move what is after it, and drop what it reaches into', () => {
    const doc = Text.of('let count = 1\nfoo(bar)\n')
    // A range for `count`, a point after it (a hint), a range for `foo` and `bar`.
    const store = make(doc, [
      [1, 4, 9, 'count'],
      [1, 9, 9, 'hint'],
      [2, 0, 3, 'foo'],
      [2, 4, 7, 'bar'],
    ])
    const second = store.line(2)
    // Typing at the end of `count`: it keeps its place, the hint there moves with the typed text, line 2 is untouched.
    const typed = ChangeSet.of({ from: 9, insert: 's' }, doc.length)
    store.map(typed, doc)
    const after = typed.apply(doc)
    assert.deepEqual(dump(store, after), [
      [1, 4, 9, 'count'],
      [1, 10, 10, 'hint'],
      [2, 0, 3, 'foo'],
      [2, 4, 7, 'bar'],
    ])
    assert.equal(store.line(2), second, 'a line the edit did not reach keeps its array')
    // Typing inside `foo` drops it; `bar` moves.
    const inside = ChangeSet.of({ from: after.line(2).from + 1, insert: 'x' }, after.length)
    store.map(inside, after)
    const third = inside.apply(after)
    assert.deepEqual(dump(store, third), [
      [1, 4, 9, 'count'],
      [1, 10, 10, 'hint'],
      [2, 5, 8, 'bar'],
    ])
  })

  it('shift the lines below an edit that adds or removes lines, and split a line broken in two', () => {
    const doc = Text.of('a b\nc d\ne f\n')
    const store = make(doc, [
      [1, 0, 1, 'a'],
      [1, 2, 3, 'b'],
      [2, 0, 1, 'c'],
      [3, 2, 3, 'f'],
    ])
    // Break line 1 after `a `: `b` goes to a new line 2, the rest move down one.
    const broken = ChangeSet.of({ from: 2, insert: '\n' }, doc.length)
    store.map(broken, doc)
    const after = broken.apply(doc)
    assert.deepEqual(dump(store, after), [
      [1, 0, 1, 'a'],
      [2, 0, 1, 'b'],
      [3, 0, 1, 'c'],
      [4, 2, 3, 'f'],
    ])
    // Join lines 2 to 4 by deleting from `b`'s end to before `f`: `f` comes up onto line 2.
    const joined = ChangeSet.of({ from: after.line(2).from + 1, to: after.line(4).from + 2 }, after.length)
    store.map(joined, after)
    assert.deepEqual(dump(store, joined.apply(after)), [
      [1, 0, 1, 'a'],
      [2, 0, 1, 'b'],
      [2, 1, 2, 'f'],
    ])
  })

  it('follow a paste of many lines', () => {
    const doc = Text.of('x\ny\n')
    const store = make(doc, [[2, 0, 1, 'y']])
    const paste = ChangeSet.of({ from: 0, insert: 'line\n'.repeat(5_000) }, doc.length)
    store.map(paste, doc)
    assert.deepEqual(dump(store, paste.apply(doc)), [[5_002, 0, 1, 'y']])
  })

  const scenario: Gen<{ lines: string[]; placed: [number, number, number, string][]; specs: ChangeSpec[] }> = (random, size) => {
    const lineCount = 1 + Math.floor(random() * (size + 3))
    const lines = Array.from({ length: lineCount }, () => 'abcdefghij'.slice(0, Math.floor(random() * 11)))
    const placed: [number, number, number, string][] = []
    lines.forEach((text, index) => {
      let at = 0
      while (at <= text.length && random() < 0.7) {
        const from = at + Math.floor(random() * 3)
        if (from > text.length) break
        const to = random() < 0.3 ? from : Math.min(text.length, from + 1 + Math.floor(random() * 3))
        placed.push([index + 1, from, to, `i${placed.length}`])
        at = to + (to === from ? 1 : 0)
      }
    })
    const length = lines.join('\n').length
    const specs: ChangeSpec[] = []
    let at = 0
    for (let count = Math.floor(random() * 3) + 1; count > 0 && at <= length; count--) {
      const from = at + Math.floor(random() * Math.max(1, (length - at) / 2))
      if (from > length) break
      const to = Math.min(length, from + (random() < 0.4 ? 0 : Math.floor(random() * 8)))
      const insert = random() < 0.3 ? '' : ['x', 'yz', '\n', 'p\nq', '\n\n'][Math.floor(random() * 5)]
      specs.push({ from, to, insert })
      at = to + 1
    }
    return { lines, placed, specs }
  }

  it('end up where mapping each one\'s place through the edit puts it, or dropped where the edit reached into it', async () => {
    await check(scenario, ({ lines, placed, specs }) => {
      const doc = Text.of(lines.join('\n'))
      const changes = ChangeSet.of(specs, doc.length)
      const store = make(doc, placed)
      store.map(changes, doc)
      const after = changes.apply(doc)
      // The same by hand: an item survives an edit wholly before it or wholly after it, and moves as its places do.
      // A point where text goes in is after it; one where a replaced stretch starts, before it.
      const list: [number, number, number][] = []
      changes.forEach((fromA, toA, _fromB, _toB, insert) => list.push([fromA, toA, insert.length]))
      const expected: [number, number, number, string][] = []
      for (const [line, from, to, id] of placed) {
        const a = doc.line(line).from + from
        const b = doc.line(line).from + to
        const before = (fromA: number, toA: number) => b <= fromA && a < toA
        if (!list.every(([fromA, toA]) => before(fromA, toA) || a >= toA)) continue
        let delta = 0
        for (const [fromA, toA, inserted] of list) if (!before(fromA, toA)) delta += inserted - (toA - fromA)
        const at = after.lineAt(a + delta)
        expected.push([at.number, a + delta - at.from, b + delta - at.from, id])
      }
      expected.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
      assert.deepEqual(dump(store, after), expected)
    })
  })
})
