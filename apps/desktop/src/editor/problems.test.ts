import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodeDiagnostic } from '@shared/types'
import { filterProblems, inTextOrder, problemFrom } from './problems'

const mark = (line: number, character: number, severity: CodeDiagnostic['severity'] = 'error', message = `at ${line}:${character}`, source?: string): CodeDiagnostic => ({
  line,
  character,
  endLine: line,
  endCharacter: character + 1,
  severity,
  message,
  ...(source ? { source } : {}),
})

const files: [string, CodeDiagnostic[]][] = [
  ['lib/b.ts', [mark(4, 0)]],
  ['src/a.ts', [mark(9, 2, 'warning'), mark(2, 5), mark(2, 5, 'hint')]],
  ['src/c.ts', [mark(1, 1, 'info')]],
]

describe('F8 and Shift+F8', () => {
  it('go to the next problem in the file, then on to the next file, round to the first', () => {
    const at = (path: string, line: number, character: number) => ({ path, line, character })
    const go = (from: ReturnType<typeof at> | null, direction: 1 | -1) => {
      const found = problemFrom(files, from, direction)
      return found && `${found.path}:${found.item.line}:${found.item.character}`
    }
    assert.equal(go(at('src/a.ts', 0, 0), 1), 'src/a.ts:2:5')
    assert.equal(go(at('src/a.ts', 2, 5), 1), 'src/a.ts:9:2', 'the one the cursor is on is not the next')
    assert.equal(go(at('src/a.ts', 9, 2), 1), 'src/c.ts:1:1')
    assert.equal(go(at('src/c.ts', 5, 0), 1), 'lib/b.ts:4:0', 'past the last file, round to the first')
    assert.equal(go(at('src/a.ts', 2, 5), -1), 'lib/b.ts:4:0')
    assert.equal(go(at('lib/b.ts', 0, 0), -1), 'src/c.ts:1:1', 'before the first file, round to the last')
    assert.equal(go(null, 1), 'lib/b.ts:4:0')
    assert.equal(go(null, -1), 'src/c.ts:1:1')
  })

  it('start from where a file without problems would be, and pass over hints', () => {
    const go = (path: string, direction: 1 | -1) => {
      const found = problemFrom(files, { path, line: 0, character: 0 }, direction)
      return found && `${found.path}:${found.item.line}`
    }
    assert.equal(go('m.ts', 1), 'src/a.ts:2')
    assert.equal(go('m.ts', -1), 'lib/b.ts:4')
    assert.equal(go('z.ts', 1), 'lib/b.ts:4')
    assert.equal(problemFrom([['a.ts', [mark(0, 0, 'hint')]]], null, 1), null)
    assert.equal(problemFrom([], null, 1), null)
  })

  it('come in the order of the text, the worst first at one place', () => {
    assert.deepEqual(inTextOrder([mark(3, 0), mark(1, 4, 'warning'), mark(1, 4, 'error'), mark(1, 2, 'info')]).map((item) => `${item.line}:${item.character}:${item.severity}`), ['1:2:info', '1:4:error', '1:4:warning', '3:0:error'])
  })
})

describe('the Problems list', () => {
  const all = { errors: true, warnings: true, others: true }

  it('keeps the severities shown and the words typed, in any order, against the message, its source and the path', () => {
    const list: [string, CodeDiagnostic[]][] = [
      ['src/a.ts', [mark(0, 0, 'error', "Cannot find name 'foo'.", 'ts'), mark(1, 0, 'warning', 'Unused variable', 'eslint')]],
      ['src/b.py', [mark(0, 0, 'info', 'Import could be sorted', 'ruff')]],
    ]
    const shape = (groups: ReturnType<typeof filterProblems>) => groups.map((group) => [group.path, group.items.map((item) => item.message)])
    assert.deepEqual(shape(filterProblems(list, all, '')), [
      ['src/a.ts', ["Cannot find name 'foo'.", 'Unused variable']],
      ['src/b.py', ['Import could be sorted']],
    ])
    assert.deepEqual(shape(filterProblems(list, { ...all, warnings: false, others: false }, '')), [['src/a.ts', ["Cannot find name 'foo'."]]])
    assert.deepEqual(shape(filterProblems(list, all, 'ESLINT unused')), [['src/a.ts', ['Unused variable']]])
    assert.deepEqual(shape(filterProblems(list, all, 'b.py')), [['src/b.py', ['Import could be sorted']]])
    assert.deepEqual(filterProblems(list, all, 'nothing like this'), [])
  })
})
