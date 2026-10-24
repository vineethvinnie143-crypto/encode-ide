import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { tempWorkspace, testContext, textOf } from '../testing'
import type { CodeMapSource } from '../types'
import { extract } from './extract'
import { CodeIndex } from './index'
import { renderMap, termsOf, type IndexedFile } from './rank'
import { codeMapTool } from './tool'

const indexed = (files: Record<string, string>): IndexedFile[] =>
  Object.entries(files).map(([file, text]) => {
    const found = extract(file, text)!
    return { path: file, language: found.language, definitions: found.definitions, names: found.names }
  })

/** A small project: a router used everywhere, a helper used once, a test, and a FiveM resource. */
const PROJECT = {
  'src/router.ts': 'export class RequestRouter {\n  route(path: string) {}\n}\nexport function createRequestRouter() { return new RequestRouter() }\n',
  'src/server.ts': "import { RequestRouter, createRequestRouter } from './router'\nconst router: RequestRouter = createRequestRouter()\nexport function startServer() { router.route('/') }\n",
  'src/handlers.ts': "import { RequestRouter } from './router'\nexport function registerHandlers(router: RequestRouter) {}\n",
  'src/cli.ts': "import { startServer } from './server'\nimport { formatBanner } from './banner'\nstartServer()\nformatBanner()\n",
  'src/banner.ts': 'export function formatBanner() { return "hi" }\n',
  'src/router.test.ts': "import { RequestRouter } from './router'\nfunction makeTestRouter() { return new RequestRouter() }\n",
  'garage/server.lua': "RegisterNetEvent('garage:server:park', function(plate) end)\nlocal function payDepot(source) end\n",
  'garage/client.lua': "RegisterCommand('park', function() TriggerServerEvent('garage:server:park', plate) end)\n",
}

describe('the code map', () => {
  it('puts first what the project uses most, and a test helper last', () => {
    const map = renderMap(indexed(PROJECT), { maxChars: 10_000 })
    const lines = map.text.split('\n')
    assert.equal(lines[0], 'src/router.ts')
    assert.match(lines[1], /^ {2}1 export class RequestRouter$/)
    assert.match(lines[2], /^ {4}2 route\(path: string\)$/)
    assert.ok(lines.indexOf('src/router.test.ts') > lines.indexOf('src/banner.ts'))
    // src/cli.ts only calls.
    assert.equal(map.files, 7)
    assert.equal(map.shownFiles, 7)
  })

  it('keeps to its budget, showing the files that matter most', () => {
    const map = renderMap(indexed(PROJECT), { maxChars: 120 })
    assert.ok(map.text.length <= 120)
    assert.ok(map.text.startsWith('src/router.ts\n'))
    assert.ok(map.shownFiles < map.files)
  })

  it('is pulled towards the words of the work, and the kind of definition they name', () => {
    const files = indexed(PROJECT)
    const map = renderMap(files, { terms: termsOf('Players get charged twice when they park at the garage depot'), maxChars: 400 })
    assert.match(map.text, /^garage\/server\.lua\n/)
    assert.match(map.text, /payDepot/)
    const events = renderMap(files, { terms: termsOf('which events does the resource register?'), maxChars: 80 })
    assert.match(events.text, /RegisterNetEvent\('garage:server:park'/)
  })

  it('maps one folder', () => {
    const map = renderMap(indexed(PROJECT), { within: 'garage', focus: ['garage'], maxChars: 10_000 })
    assert.deepEqual(map.text.split('\n').filter((line) => !line.startsWith(' ')).sort(), ['garage/client.lua', 'garage/server.lua'])
  })

  it('takes the words of a request that may name code', () => {
    assert.deepEqual(termsOf('Please fix the bug in createRouter so src/router.ts returns 404s; it should also retry'), ['createRouter', 'src/router.ts', 'retry'])
  })
})

describe('the index of a folder', () => {
  it('reads the source files once, again when they change, and leaves out the rest', async () => {
    const root = await tempWorkspace({
      'src/a.ts': 'export function alpha() {}\n',
      'src/b.py': 'def beta():\n    pass\n',
      'node_modules/x/index.js': 'export function outside() {}\n',
      'dist/a.js': 'export function built() {}\n',
      'ignored/c.ts': 'export function gamma() {}\n',
      '.gitignore': 'ignored/\n',
      '.env': 'KEY=secret\n',
      'notes.md': '# Notes\n',
      'min.js': `${'var a=1;'.repeat(5_000)}\n`,
    })
    let now = 0
    const index = new CodeIndex({ root, now: () => now })
    const names = async () => (await index.files()).flatMap((file) => file.definitions.map((definition) => `${file.path}:${definition.name}`))
    assert.deepEqual(await names(), ['src/a.ts:alpha', 'src/b.py:beta'])

    await fs.writeFile(path.join(root, 'src/a.ts'), 'export function alpha2() {}\n')
    // Within the time it trusts the index, a file is read again only when a tool says it changed.
    assert.deepEqual(await names(), ['src/a.ts:alpha', 'src/b.py:beta'])
    index.changed(path.join(root, 'src/a.ts'))
    assert.deepEqual(await names(), ['src/a.ts:alpha2', 'src/b.py:beta'])

    await fs.rm(path.join(root, 'src/b.py'))
    await fs.writeFile(path.join(root, 'src/d.ts'), 'export class Delta {}\n')
    now += 60_000
    assert.deepEqual(await names(), ['src/a.ts:alpha2', 'src/d.ts:Delta'])
    assert.equal(index.truncated, false)
  })

  it('says when the folder has more files than it reads', async () => {
    const root = await tempWorkspace({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n', 'c.ts': 'export function c() {}\n' })
    const index = new CodeIndex({ root, maxFiles: 2 })
    assert.equal((await index.files()).length, 2)
    assert.equal(index.truncated, true)
  })
})

describe('CodeMap', () => {
  const source = (root: string): CodeMapSource => {
    const index = new CodeIndex({ root })
    return { files: async () => ({ files: await index.files(), truncated: index.truncated }), changed: (file) => index.changed(file) }
  }
  const run = async (root: string, input: Record<string, unknown>, map: CodeMapSource | null = source(root)) => {
    const ctx = testContext(root, map ? { codeMap: map } : {})
    const outcome = await codeMapTool.run(input, ctx)
    return { ok: outcome.ok, text: textOf(outcome.content) }
  }

  it('maps the project, a folder, or one file', async () => {
    const root = await tempWorkspace(PROJECT)
    const all = await run(root, {})
    assert.ok(all.ok)
    assert.match(all.text, /^src\/router\.ts\n {2}1 export class RequestRouter/)
    const folder = await run(root, { path: 'garage' })
    assert.doesNotMatch(folder.text, /src\//)
    const one = await run(root, { path: 'src/router.ts' })
    assert.equal(one.text, 'src/router.ts, 3 definitions (line, then the line as written):\n1 export class RequestRouter\n  2 route(path: string)\n4 export function createRequestRouter()')
  })

  it('finds where a name is defined, and which files use it', async () => {
    const root = await tempWorkspace(PROJECT)
    const found = await run(root, { symbol: 'RequestRouter' })
    assert.match(found.text, /^RequestRouter is defined at:\nsrc\/router\.ts:1 export class RequestRouter\nUsed by name in 4 files: /)
    assert.match(found.text, /src\/server\.ts \(2\)/)
    const event = await run(root, { symbol: 'garage:server:park' })
    assert.match(event.text, /garage\/server\.lua:1 RegisterNetEvent\('garage:server:park', function\(plate\)/)
    assert.match(event.text, /Used by name in 1 file: garage\/client\.lua \(1\)/)
    assert.match((await run(root, { symbol: 'requestrouter' })).text, /^No definition is named exactly requestrouter; in another case:/)
    assert.match((await run(root, { symbol: 'Nowhere' })).text, /^No definition of Nowhere in the code map/)
  })

  it('says what it cannot map', async () => {
    const root = await tempWorkspace({ ...PROJECT, 'README.md': '# Hi\n' })
    assert.match((await run(root, { path: 'README.md' })).text, /README\.md is not a source file the code map reads/)
    assert.equal((await run(root, { path: 'missing' })).ok, false)
    assert.equal((await run(root, { path: '..' })).ok, false)
    assert.equal((await run(root, {}, null)).ok, false)
  })
})
