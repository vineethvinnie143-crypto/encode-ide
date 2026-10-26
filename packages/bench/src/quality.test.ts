import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { changesBetween, snapshot } from './project'
import { judgeQuality, lineChanges, oversized, qualityFacts, type QualityFacts } from './quality'
import type { BenchTask } from './task'

const facts = (over: Partial<QualityFacts> = {}): QualityFacts => ({ changedLines: 4, added: [], tests: [], debug: 0, stubs: 0, unparsed: [], ...over })

describe('code quality (the plan Q3)', () => {
  const dirs: string[] = []
  after(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))))

  test('counts the lines one version has and the other does not, each line once, blank ones aside', () => {
    assert.deepEqual(lineChanges('a\nb\nb\n\nc', 'a\nb\nd\n\n\nc'), { added: ['d'], removed: 1 })
    assert.deepEqual(lineChanges('', 'x\r\ny'), { added: ['x', 'y'], removed: 0 })
    assert.deepEqual(lineChanges('x\ny', ''), { added: [], removed: 2 })
  })

  test('calls a change too large at three times the reference and twenty lines past it', () => {
    assert.equal(oversized(24, 4), false, 'twenty lines past four is not yet too many')
    assert.equal(oversized(25, 4), true)
    assert.equal(oversized(90, 30), false, 'three times thirty is not past it')
    assert.equal(oversized(91, 30), true)
  })

  test('says a file that does not parse is an issue, reference or not', () => {
    assert.deepEqual(judgeQuality(facts({ unparsed: ['a.js'] })), ['does not parse: a.js'])
    assert.deepEqual(judgeQuality(facts({ debug: 3, stubs: 1, added: ['scratch.js'] })), [], 'without a reference only what is wrong in any project counts')
  })

  test('judges size, stray files, tests, debug lines and stubs against the reference', () => {
    const reference = facts({ changedLines: 6, added: ['lib/new.js'], tests: ['test/a.test.js'], debug: 1 })
    assert.deepEqual(judgeQuality(facts({ changedLines: 6, added: ['lib/new.js'], tests: ['test/a.test.js'], debug: 1 }), reference), [], 'what the reference did is fine for the run')
    assert.deepEqual(judgeQuality(facts({ changedLines: 40, added: ['lib/new.js', 'scratch.js'], tests: ['test/a.test.js', 'test/b.test.js'], debug: 3, stubs: 1 }), reference), [
      'changed 40 lines where the reference changed 6',
      'added files the task did not need: scratch.js',
      'changed tests: test/b.test.js',
      'left 2 debug lines',
      'left a TODO or a stub',
    ])
    assert.deepEqual(judgeQuality(facts({ debug: 2 }), reference), ['left 1 debug line'])
  })

  test("reads the run's changes from its project and the task's own copy", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-quality-'))
    dirs.push(base)
    const write = async (file: string, text: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
    }
    const taskDir = path.join(base, 'task')
    const root = path.join(base, 'run')
    await write(path.join(taskDir, 'project', 'lib', 'sum.js'), 'export function sum(a, b) {\n  return 0\n}\n')
    await write(path.join(taskDir, 'project', 'gone.js'), 'one\ntwo\n')
    await write(path.join(taskDir, 'project', 'config.json'), '{"a": 1}\n')
    await write(path.join(taskDir, 'project', '_vendor', 'pad.js'), 'module.exports = 1\n')
    await write(path.join(root, 'lib', 'sum.js'), 'export function sum(a, b) {\n  console.log(a, b)\n  return a + b // TODO overflow\n}\n')
    await write(path.join(root, 'lib', 'broken.js'), 'function (\n')
    await write(path.join(root, 'test', 'sum.test.js'), "import { sum } from '../lib/sum.js'\n")
    await write(path.join(root, 'config.json'), '{"a": 1,}\n')
    await write(path.join(root, 'vendor', 'pad.js'), 'module.exports = 2\n')
    const task = { dir: taskDir, rename: { _vendor: 'vendor' } } as unknown as BenchTask
    const changes = { added: ['lib/broken.js', 'test/sum.test.js'], changed: ['config.json', 'lib/sum.js', 'vendor/pad.js'], removed: ['gone.js'] }
    const got = await qualityFacts(task, root, changes, { node: [process.execPath] })
    assert.deepEqual(got.added, ['lib/broken.js', 'test/sum.test.js'])
    assert.deepEqual(got.tests, ['test/sum.test.js'])
    assert.equal(got.debug, 1)
    assert.equal(got.stubs, 1)
    assert.deepEqual(got.unparsed, ['lib/broken.js', 'config.json'])
    // gone.js 2, broken.js 1, the test 1, config.json 1 + 1, sum.js 2 + 1, the renamed vendor file 1 + 1.
    assert.equal(got.changedLines, 11)
  })

  test('counts no file that running the code makes on its own as one the run added', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-snapshot-'))
    dirs.push(root)
    await fs.writeFile(path.join(root, 'shipping.py'), 'def cost(): return 1\n')
    const before = await snapshot(root)
    for (const folder of ['__pycache__', 'tests/__pycache__', '.pytest_cache/v/cache']) await fs.mkdir(path.join(root, ...folder.split('/')), { recursive: true })
    await fs.writeFile(path.join(root, '__pycache__', 'shipping.cpython-313.pyc'), 'x')
    await fs.writeFile(path.join(root, 'tests', '__pycache__', 'test_shipping.cpython-313.pyc'), 'x')
    await fs.writeFile(path.join(root, '.pytest_cache', 'v', 'cache', 'nodeids'), '[]')
    await fs.writeFile(path.join(root, 'scratch.py'), 'print(1)\n')
    assert.deepEqual(changesBetween(before, await snapshot(root)), { added: ['scratch.py'], changed: [], removed: [] })
  })

  test('leaves a parse unjudged where the program to tell is not here', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-quality-'))
    dirs.push(root)
    await fs.writeFile(path.join(root, 'a.py'), 'def (:\n')
    const task = { dir: path.join(root, 'none'), rename: {} } as unknown as BenchTask
    const got = await qualityFacts(task, root, { added: ['a.py'], changed: [], removed: [] }, { node: [process.execPath] })
    assert.deepEqual(got.unparsed, [])
    assert.equal(got.changedLines, 1)
  })
})
