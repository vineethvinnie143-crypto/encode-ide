import '../testing/bridge'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as surface from './surface'

const APP = path.join(process.cwd(), 'apps', 'desktop')

/** What the rest of the app may use of the editor (ADR 0088). A change here is a change of the interface: say it there. */
const SURFACE = [
  'askServers',
  'canReportIssue',
  'clearMarks',
  'closeFile',
  'closeFilesUnder',
  'fileText',
  'findSymbols',
  'focusEditor',
  'formatBeforeSave',
  'ghostFooter',
  'goToPlace',
  'hasShownEditor',
  'isOpen',
  'isShowing',
  'isUnsaved',
  'keepView',
  'languageOf',
  'lineColoursFor',
  'markSaved',
  'matchesSaved',
  'openFile',
  'putBackView',
  'renameFile',
  'runEditorCommand',
  'setMarks',
  'showRange',
  'snapshotForSave',
  'startLanguageSync',
  'takeExternal',
  'tokenClass',
  'tooLargeForServers',
  'useGhost',
  'useOutline',
  'useProblems',
]

/** The editor's own modules, relative to apps/desktop; the two doors into them are the surface's. */
const ENGINE = ['src/editor/', 'src/components/CodeEditor.tsx', 'src/components/code/']
const DOORS = new Set(['src/editor/surface', 'src/editor/surface-view'])
const PACKAGES = /^@encode\/(?:editor|editor-view|text)(?:\/|$)/

const posix = (file: string) => file.split(path.sep).join('/')
const inEngine = (relative: string) => ENGINE.some((part) => (part.endsWith('/') ? relative.startsWith(part) : relative === part))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sources(relative))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(relative)
  }
  return out
}

/** Every module a source names: static imports and exports, side-effect imports, and import(). */
function importsOf(text: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = []
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[\w\s{},*$]*?\bfrom\s+['"]([^'"]+)['"]/gm)) out.push({ spec: match[2], typeOnly: Boolean(match[1]) })
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ spec: match[1], typeOnly: false })
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: match[1], typeOnly: false })
  return out
}

/** Where a module named from `file` lives, relative to apps/desktop and without its extension; null for a package. */
function target(file: string, spec: string): string | null {
  if (spec.startsWith('@/')) return posix(path.join('src', spec.slice(2)))
  if (spec.startsWith('@shared/')) return posix(path.join('shared', spec.slice(8)))
  if (!spec.startsWith('.')) return null
  return posix(path.normalize(path.join(path.dirname(file), spec)))
}

describe('the editor as the rest of the app sees it', () => {
  it('is the list of things the surface exports, no more and no fewer', () => {
    assert.deepEqual(Object.keys(surface).sort(), [...SURFACE].sort())
  })

  it('is the only way into the editor from outside its own modules', () => {
    const files = [...sources('src'), ...sources('shared'), ...sources('electron')].filter((file) => !inEngine(file))
    assert.ok(files.length > 200, `read ${files.length} sources`)
    const around: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(APP, file), 'utf8')
      for (const { spec, typeOnly } of importsOf(text)) {
        if (PACKAGES.test(spec)) {
          // The main process reads the editor's report of an issue as data, by its type (EditorTrace).
          if (typeOnly && !file.startsWith('src/')) continue
          around.push(`${file}: ${spec}`)
          continue
        }
        const to = target(file, spec)
        if (to === null) continue
        const bare = to.replace(/\.(?:tsx?|css)$/, '')
        if (!DOORS.has(bare) && (inEngine(to) || inEngine(`${bare}.tsx`) || inEngine(`${bare}/`))) around.push(`${file}: ${spec}`)
      }
    }
    assert.deepEqual(around, [], 'go through src/editor/surface.ts or surface-view.ts')
  })

  it('selects, keeps and puts back nothing while no editor is on screen', () => {
    assert.equal(surface.hasShownEditor(), false)
    assert.equal(surface.isShowing('/work/a.ts'), false)
    assert.equal(surface.keepView('/work/a.ts'), null)
    assert.equal(surface.showRange('/work/a.ts', { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }), false)
    assert.equal(surface.runEditorCommand('undo'), false)
  })

  it('opens, renames and lets go of a file, its text read line by line', () => {
    assert.deepEqual(surface.openFile('/work/shop/client.lua', 'local a = 1\r\nprint(a)\r\n'), { language: 'lua' })
    assert.equal(surface.isOpen('/work/shop/client.lua'), true)
    assert.equal(surface.canReportIssue('/work/shop/client.lua'), true)
    const text = surface.fileText('/work/shop/client.lua')!
    assert.equal(text.lines, 3)
    assert.equal(text.line(2), 'print(a)')
    assert.equal(surface.isUnsaved('/work/shop/client.lua'), false)
    assert.equal(surface.takeExternal('/work/shop/client.lua', 'local a = 2\r\n'), true)
    assert.equal(surface.matchesSaved('/work/shop/client.lua', 'local a = 2\r\n'), true)
    surface.renameFile('/work/shop/client.lua', '/work/shop/client.ts')
    assert.equal(surface.languageOf('/work/shop/client.ts'), 'typescript')
    assert.equal(surface.languageOf('/work/shop/client.lua'), null)
    surface.closeFilesUnder('/work/shop')
    assert.equal(surface.isOpen('/work/shop/client.ts'), false)
    assert.equal(surface.canReportIssue(null), false)
  })

  it('colours lines it does not show as the editor does, a failing tokenizer leaving them plain', () => {
    const colours = surface.lineColoursFor('a.ts')
    const { tokens } = colours.line('const a = 1', colours.start)
    assert.equal(surface.tokenClass(tokens[1]), 'tok-keyword')
    assert.equal(surface.tokenClass(0), '')
    assert.ok(colours.line('x'.repeat(200_000), colours.start).tokens.length >= 2)
  })
})
