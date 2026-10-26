import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.env.BENCH_ROOT
const { buildMenu, renderMenu } = await import(pathToFileURL(path.join(root, 'src', 'menu.js')).href)
const titles = (pages) => renderMenu(buildMenu(pages))

test('build.js writes the menu of site.json', () => {
  fs.rmSync(path.join(root, 'menu.txt'), { force: true })
  execFileSync(process.execPath, ['build.js'], { cwd: root, encoding: 'utf8' })
  const menu = fs.readFileSync(path.join(root, 'menu.txt'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(
    menu,
    [
      'Kettle docs',
      '- Home',
      '- Getting started',
      '  - Install',
      '  - Your first brew',
      '- Care',
      '  - Descaling',
      '  - Changing filters',
      '- Support',
      '  - Warranty',
      '  - Contact',
      '',
    ].join('\n'),
  )
})

test('a chain listed from its deepest page up', () => {
  const pages = [
    { id: 'c', title: 'C', parent: 'b' },
    { id: 'b', title: 'B', parent: 'a' },
    { id: 'a', title: 'A', parent: null },
  ]
  assert.deepEqual(titles(pages), ['- A', '  - B', '    - C'])
})

test('pages keep the order they are listed in, under their parent', () => {
  const pages = [
    { id: 'x2', title: 'X2', parent: 'x' },
    { id: 'y', title: 'Y', parent: null },
    { id: 'x1', title: 'X1', parent: 'x' },
    { id: 'x', title: 'X', parent: null },
    { id: 'x3', title: 'X3', parent: 'x' },
    { id: 'y1', title: 'Y1', parent: 'y' },
  ]
  assert.deepEqual(titles(pages), ['- Y', '  - Y1', '- X', '  - X2', '  - X1', '  - X3'])
})

test('a menu already in order is as before', () => {
  const pages = [
    { id: 'a', title: 'A', parent: null },
    { id: 'a1', title: 'A1', parent: 'a' },
    { id: 'b', title: 'B', parent: null },
  ]
  assert.deepEqual(titles(pages), ['- A', '  - A1', '- B'])
})
