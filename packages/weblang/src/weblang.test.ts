import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { JsonRpcConnection } from '@encode/lsp'
import { CssService } from './css/service'
import { HtmlService } from './html/service'
import { parseJson, valueOf } from './json/parser'
import { validate, type Schema } from './json/schema'
import { formatJson, JsonService } from './json/service'
import { fileUri, schemaLoader, startServer } from './server'
import { Document } from './text'

/** A document with the cursor where `|` is, and that position. */
function at(text: string, languageId: string, name = 'file'): { doc: Document; position: { line: number; character: number } } {
  const offset = text.indexOf('|')
  const doc = new Document(`file:///work/${name}`, languageId, 1, text.replace('|', ''))
  return { doc, position: doc.positionAt(offset) }
}
const doc = (text: string, languageId: string, name = 'file') => new Document(`file:///work/${name}`, languageId, 1, text)
const messages = (list: { message: string }[]) => list.map((item) => item.message)
const labels = (list: { label: string }[]) => list.map((item) => item.label)

describe('JSON', () => {
  it('reads values and says where each problem is, reading on after it', () => {
    const good = parseJson('{"a": [1, 2.5e3, true, null, "x\\u0041"], "b": {}}', { comments: false })
    assert.deepEqual(good.problems, [])
    assert.deepEqual(valueOf(good.root!), { a: [1, 2500, true, null, 'xA'], b: {} })
    const bad = parseJson('{"a": 1 "b": 2, c: 3, "d": , "e": "open\n}', { comments: false })
    assert.deepEqual(messages(bad.problems), ['This string is not closed.', 'Expected a comma.', 'A property name must be in double quotes.', 'Expected a value.'])
    // What came after each problem was still read.
    assert.deepEqual(Object.keys(valueOf(bad.root!) as object), ['a', 'b', 'c', 'd', 'e'])
  })

  it('takes comments and trailing commas only in JSON with comments', () => {
    const text = '{\n  // note\n  "a": [1, 2,],\n}'
    assert.deepEqual(messages(parseJson(text, { comments: true }).problems), [])
    assert.deepEqual(messages(parseJson(text, { comments: false }).problems), ['Comments are not allowed in JSON. Name the file .jsonc to keep them.', 'A trailing comma is not allowed in JSON.', 'A trailing comma is not allowed in JSON.'])
    // tsconfig.json is JSON with comments whatever its extension.
    assert.deepEqual(new JsonService().diagnostics(doc(text, 'json', 'tsconfig.json')).filter((item) => item.severity === 1), [])
  })

  it('stops at a depth it cannot read, and at a second top value', () => {
    assert.ok(messages(parseJson('['.repeat(600), { comments: false }).problems).includes('This is nested too deeply to read.'))
    assert.deepEqual(messages(parseJson('{} {}', { comments: false }).problems), ['Only one value may be at the top of a JSON document.'])
  })

  it('marks a repeated key and checks a document against its schema', () => {
    const service = new JsonService()
    const found = service.diagnostics(doc('{"name": "Bad Name", "type": "esm", "private": "yes", "name": "x"}', 'json', 'package.json'))
    assert.deepEqual(messages(found).sort(), [
      'Does not match the pattern "^(?:@[a-z0-9-*~][a-z0-9-*._~]*/)?[a-z0-9-~][a-z0-9-._~]*$".',
      'Expected a boolean.',
      'Expected one of "module", "commonjs".',
      'The property "name" is already in this object; the last one wins.',
    ])
  })

  it('validates the parts of JSON Schema editors use', () => {
    const schema: Schema = {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { enum: ['a', 'b'] },
        size: { type: 'integer', minimum: 1, maximum: 9 },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 3 },
        shape: { oneOf: [{ $ref: '#/$defs/circle' }, { $ref: '#/$defs/square' }] },
        old: { deprecationMessage: 'Use size.' },
      },
      additionalProperties: false,
      if: { properties: { kind: { const: 'b' } } },
      then: { required: ['size'] },
      $defs: {
        circle: { type: 'object', properties: { r: { type: 'number' } }, required: ['r'], additionalProperties: false },
        square: { type: 'object', properties: { side: { type: 'number' } }, required: ['side'], additionalProperties: false },
      },
    }
    const check = (text: string) => messages(validate(parseJson(text, { comments: false }).root!, schema, schema))
    assert.deepEqual(check('{"kind": "a", "size": 3, "tags": ["x"], "shape": {"r": 1}}'), [])
    assert.deepEqual(check('{"kind": "b"}'), ['Missing the property "size".'])
    assert.deepEqual(check('{"kind": "c", "size": 10.5, "tags": ["x", "x"], "extra": 1}').sort(), ['Expected an integer.', 'Expected one of "a", "b".', 'The property "extra" is not allowed.', 'This item is already in the list.'].sort())
    assert.deepEqual(check('{"kind": "a", "shape": {"side": "2"}}'), ['Expected a number.'])
    assert.deepEqual(check('{"kind": "a", "old": 1}'), ['Use size.'])
    // With no kind, `if` holds (its property is not there to fail), so `then` asks for size too.
    assert.deepEqual(check('{}'), ['Missing the property "size".', 'Missing the property "kind".'])
  })

  it('completes keys and values from the schema', () => {
    const service = new JsonService()
    const keys = at('{\n  "name": "x",\n  "ty|\n}', 'json', 'package.json')
    const items = service.completion(keys.doc, keys.position)
    const type = items.find((item) => item.label === 'type')!
    assert.equal(type.insertText, '"type": $1')
    assert.ok(!labels(items).includes('name'), 'a key already there is not offered again')
    const values = at('{"type": |}', 'json', 'package.json')
    assert.deepEqual(labels(service.completion(values.doc, values.position)), ['"module"', '"commonjs"'])
    const inside = at('{"compilerOptions": {"strict": |}}', 'json', 'tsconfig.json')
    assert.deepEqual(labels(service.completion(inside.doc, inside.position)), ['true', 'false'])
  })

  it('hovers with what the schema says', () => {
    const { doc: d, position } = at('{"ty|pe": "module"}', 'json', 'package.json')
    const hover = new JsonService().hover(d, position)
    assert.match(hover!.contents.value, /How `\.js` files are read/)
  })

  it('lists symbols and folds objects, arrays and regions', () => {
    const service = new JsonService()
    const d = doc('{\n  "a": {\n    "b": 1\n  },\n  // #region list\n  "c": [\n    {"d": true}\n  ]\n  // #endregion\n}', 'jsonc')
    const symbols = service.symbols(d)
    assert.deepEqual(symbols.map((item) => [item.name, item.children?.map((child) => child.name)]), [['a', ['b']], ['c', ['[0]']]])
    assert.deepEqual(service.folding(d).map((range) => [range.startLine, range.endLine, range.kind ?? '']), [[0, 8, ''], [1, 2, ''], [4, 8, 'region'], [5, 6, '']])
  })

  it('lays a document out again, comments kept, and leaves one it cannot read', () => {
    const text = '{"a":1,"b":[1,2,{"c":null}],\n\n"d":{}, // last\n"e":[] /* end */}\n'
    assert.equal(formatJson(text, { tabSize: 2, insertSpaces: true }, true), '{\n  "a": 1,\n  "b": [\n    1,\n    2,\n    {\n      "c": null\n    }\n  ],\n\n  "d": {}, // last\n  "e": [] /* end */\n}\n')
    assert.equal(formatJson('{"a":1}', { tabSize: 4, insertSpaces: false }, false), '{\n\t"a": 1\n}')
    assert.equal(formatJson('{"a":1\r\n}', { tabSize: 2, insertSpaces: true }, false), '{\r\n  "a": 1\r\n}')
    assert.deepEqual(new JsonService().format(doc('{"a": 1 "b": 2}', 'json'), { tabSize: 2, insertSpaces: true }), [])
  })
})

describe('CSS, SCSS and Less', () => {
  const css = new CssService()
  const problems = (text: string, languageId = 'css') => messages(css.diagnostics(doc(text, languageId, `x.${languageId}`)))

  it('names unknown properties, at-rules, pseudo-classes and keyword values, with the likely one', () => {
    assert.deepEqual(problems('a { colr: red; -webkit-box-flex: 1; --x: 1; position: absolutee; display: flex; } a:hovr::befor {} @medai screen {}'), [
      'Unknown property colr. Did you mean color?',
      'absolutee is not a value position takes. Did you mean absolute?',
      'Unknown pseudo-class :hovr. Did you mean :hover?',
      'Unknown pseudo-element ::befor. Did you mean ::before?',
      'Unknown at-rule @medai. Did you mean @media?',
    ])
  })

  it('knows what is not a mistake: legacy pseudo-elements, frameworks, Tailwind, keyframes, descriptors', () => {
    assert.deepEqual(problems('@tailwind base; @layer components { .btn { @apply px-4; } } a:before, :global(.x), ::v-deep b {} @keyframes spin { from { opacity: 0 } 50% { opacity: 1 } } @font-face { font-family: X; src: url(a.woff2); } .a { position: inherit; }'), [])
    assert.deepEqual(problems('@font-face { font-famly: X; }'), ['@font-face has no descriptor font-famly. Did you mean font-family?'])
  })

  it('reads on after a missing semicolon, colon or }', () => {
    assert.deepEqual(problems('a {\n  color: red\n  margin: 0;\n  padding\n}\nb { color: blue;'), ['Expected a semicolon at the end of this line.', 'Expected a colon after padding.', 'This { is not closed.'])
    assert.deepEqual(problems('color: red;'), ['Expected a selector and a { block } here.'])
  })

  it('reads SCSS and Less as theirs', () => {
    assert.deepEqual(problems('// note\n$gap: 4px;\n@use "sass:math";\n@mixin pad($x) { padding: $x; }\n.a { @include pad($gap); &:hover { color: red; } &-b { margin: math.div($gap, 2); } font: { family: x; } #{$p}-top: 1px; }', 'scss'), [])
    assert.deepEqual(problems('@w: 10px;\n.m() { width: @w; }\n.a { .m(); color: darken(@c, 5%); @media (min-width: 1px) { width: @w; } }', 'less'), [])
  })

  it('completes properties, values, custom properties, at-rules and pseudo-classes', () => {
    const complete = (text: string, languageId = 'css') => {
      const { doc: d, position } = at(text, languageId, `x.${languageId}`)
      return labels(css.completion(d, position))
    }
    const properties = complete('a { dis| }')
    assert.ok(properties.includes('display') && properties.includes('color'))
    const values = complete('a { display: |}')
    assert.ok(values.includes('flex') && values.includes('grid') && values.includes('inherit') && values.includes('var()'))
    assert.deepEqual(complete(':root { --brand: red; } a { color: var(--|) }'), ['--brand'])
    assert.ok(complete('@me|').includes('@media'))
    assert.ok(complete('a:ho|').includes(':hover'))
    assert.ok(complete('a::be|').includes('::before'))
    assert.ok(complete('|').includes('div'))
    assert.ok(complete('$gap: 1px; a { margin: | }', 'scss').includes('$gap'))
  })

  it('hovers with a property\'s syntax, and lists symbols and folds', () => {
    const { doc: d, position } = at('a { dis|play: flex }', 'css')
    assert.match(css.hover(d, position)!.contents.value, /\*\*display\*\*[\s\S]*display-outside/)
    const sheet = doc('@media screen {\n  .a {\n    color: red;\n  }\n}\n:root { --x: 1; }\n/* one\n two */', 'css')
    assert.deepEqual(css.symbols(sheet).map((item) => [item.name, item.children?.map((child) => child.name)]), [['@media screen', ['.a']], [':root', ['--x']]])
    assert.deepEqual(css.folding(sheet).map((range) => [range.startLine, range.endLine, range.kind ?? '']), [[0, 3, ''], [1, 2, ''], [6, 7, 'comment']])
  })
})

describe('HTML', () => {
  const html = new HtmlService(new CssService())
  const problems = (text: string) => messages(html.diagnostics(doc(text, 'html', 'x.html')))

  it('closes what the standard lets be left open, and says what is left open or closes nothing', () => {
    assert.deepEqual(problems('<!doctype html><html><body><ul><li>a<li>b</ul><p>one<p>two<div>x</div><table><tr><td>1<td>2</table><br><img alt=""></body></html>'), [])
    assert.deepEqual(problems('<div><span>a</div></p></br>'), ['<span> is not closed.', '</p> closes no open element.', '<br> takes no end tag.'])
    assert.deepEqual(problems('<section><div>'), ['<div> is not closed.', '<section> is not closed.'])
  })

  it('names unknown and obsolete elements, repeated attributes and ids, and images with no alt text', () => {
    assert.deepEqual(problems('<dvi id="a" class="x" class="y"></dvi><center id="a"></center><my-card></my-card><svg><foreignObject/><path d=""/></svg><img src="a.png">'), [
      'Unknown element <dvi>. Did you mean <div>?',
      'class is already on this element; the first one is used.',
      '<center> is obsolete.',
      'The id "a" is already used on this page.',
      'This image has no alt text for screen readers; use alt="" for one that is only decoration.',
    ])
    assert.deepEqual(problems('<div/>'), ['<div/> does not close it in HTML; write <div></div>.', '<div> is not closed.'])
  })

  it('completes elements, the open end tag, attributes, their values and character references', () => {
    const complete = (text: string) => {
      const { doc: d, position } = at(text, 'html', 'x.html')
      return html.completion(d, position)
    }
    assert.ok(labels(complete('<di|')).includes('div'))
    assert.deepEqual(complete('<section><p>a</|').map((item) => item.insertText), ['p>'])
    const attributes = labels(complete('<input class="a" |>'))
    assert.ok(attributes.includes('type') && attributes.includes('id') && attributes.includes('aria-label') && attributes.includes('onclick') && !attributes.includes('class'))
    assert.ok(labels(complete('<input type="ch|">')).includes('checkbox'))
    assert.ok(labels(complete('a &co|')).includes('&copy;'))
  })

  it('checks and completes the CSS in <style> at its place in the page', () => {
    const page = '<html>\n<style>\n  a { colr: red; }\n</style>\n<p>colr: no</p>\n</html>'
    const found = html.diagnostics(doc(page, 'html', 'x.html'))
    assert.deepEqual(found.map((item) => [item.message, item.range.start.line, item.range.start.character]), [['Unknown property colr. Did you mean color?', 2, 6]])
    const { doc: d, position } = at('<style>\n  a { disp| }\n</style>', 'html', 'x.html')
    assert.ok(labels(html.completion(d, position)).includes('display'))
  })

  it('lists elements by id and class, folds them, and hovers on names', () => {
    const page = doc('<main id="app">\n  <div class="card big">\n    x\n  </div>\n</main>', 'html', 'x.html')
    assert.deepEqual(html.symbols(page).map((item) => [item.name, item.children?.map((child) => child.name)]), [['main#app', ['div.card.big']]])
    assert.deepEqual(html.folding(page).map((range) => [range.startLine, range.endLine]), [[0, 3], [1, 2]])
    const { doc: d, position } = at('<im|g alt="">', 'html', 'x.html')
    assert.match(html.hover(d, position)!.contents.value, /<img>[\s\S]*Void/)
  })
})

describe('the server', () => {
  it('answers over LSP: problems after an open and a change, completion, formatting, then shuts down', async () => {
    const toServer = new PassThrough()
    const fromServer = new PassThrough()
    let exited: number | null = null
    startServer(toServer, fromServer, (code) => (exited = code))
    const published: { uri: string; diagnostics: { message: string }[] }[] = []
    const client = new JsonRpcConnection(fromServer, toServer, { onNotification: (method, params) => method === 'textDocument/publishDiagnostics' && published.push(params as never) })
    const init = await client.request<{ capabilities: { completionProvider: unknown } }>('initialize', { rootUri: 'file:///work', capabilities: {} })
    assert.ok(init.capabilities.completionProvider)
    client.notify('initialized', {})
    const uri = 'file:///work/package.json'
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'json', version: 1, text: '{"type": "esm"}' } })
    const wait = async (test: () => boolean) => {
      for (let tries = 0; tries < 100 && !test(); tries++) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(test())
    }
    await wait(() => published.length === 1)
    assert.deepEqual(messages(published[0]!.diagnostics), ['Expected one of "module", "commonjs".'])
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } }, text: 'module' }] })
    await wait(() => published.length === 2)
    assert.deepEqual(published[1]!.diagnostics, [])
    const completion = await client.request<{ items: { label: string }[] }>('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 1 } })
    assert.ok(labels(completion.items).includes('name'))
    const edits = await client.request<{ newText: string }[]>('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } })
    assert.equal(edits[0]!.newText, '{\n  "type": "module"\n}')
    await assert.rejects(client.request('textDocument/rename', { textDocument: { uri } }), /not something this server does/)
    await client.request('shutdown', null)
    client.notify('exit')
    await wait(() => exited === 0)
  })

  it('reads a document\'s own schema only from a file inside the folder, and fetches nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-weblang-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-weblang-out-'))
    try {
      fs.writeFileSync(path.join(root, 'schema.json'), '{"type": "object", "properties": {"port": {"type": "number"}}}')
      fs.writeFileSync(path.join(outside, 'schema.json'), '{"type": "object"}')
      const load = schemaLoader(() => [root])
      const documentUri = fileUri(path.join(root, 'config.json'))
      assert.equal(load(documentUri, './schema.json')?.type, 'object')
      assert.equal(load(documentUri, path.relative(root, path.join(outside, 'schema.json'))), null)
      assert.equal(load(documentUri, 'https://example.test/schema.json'), null)
      const service = new JsonService(load)
      const found = service.diagnostics(new Document(documentUri, 'json', 1, '{"$schema": "./schema.json", "port": "80"}'))
      assert.deepEqual(messages(found), ['Expected a number.'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
