/// <reference path="./assets.d.ts" />
/**
 * The helper's arithmetic, key table, JSON and outline rules, run as C# and checked against the TypeScript the tool
 * is written in. The pure sources are compiled into a small test program: with the .NET Framework compiler on
 * Windows (the one that builds the helper for real, so these files are proven to compile with it), with the .NET
 * SDK where there is one, and skipped where there is neither.
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { fitImage, toScreen } from '../geometry'
import { KEY_NAMES, parseKeys } from '../keys'
import { findCompiler } from './build'
import parityText from './parity/Parity.cs'
import { HELPER_FILES } from './sources'

const run = promisify(execFile)
const PURE = ['Json.cs', 'Geometry.cs', 'Keys.cs', 'Outline.cs']

type Cases = Record<string, unknown[]>
type Answer = Record<string, any[]>
type Harness = (cases: Cases) => Promise<Answer>

let folder: string
let harness: Harness | undefined
let why = 'no C# compiler'

function sources(): { name: string; text: string }[] {
  return [...PURE.map((name) => ({ name, text: HELPER_FILES.find((file) => file.name === name)!.text })), { name: 'Parity.cs', text: parityText }]
}

function drive(command: string, args: string[]): Harness {
  return (cases) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`The parity program stopped with ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`))
        try {
          resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as Answer)
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.end(JSON.stringify(cases), 'utf8')
    })
}

async function buildWithFramework(): Promise<Harness> {
  const compiler = await findCompiler()
  const src = path.join(folder, 'src')
  await fs.mkdir(src, { recursive: true })
  const files = sources().map((file) => path.join(src, file.name))
  for (const file of sources()) await fs.writeFile(path.join(src, file.name), file.text, 'utf8')
  const exe = path.join(folder, 'parity.exe')
  const { stdout } = await run(compiler.csc, ['/nologo', '/noconfig', '/target:exe', `/out:${exe}`, '/r:System.dll', '/r:System.Core.dll', ...files], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  assert.doesNotMatch(stdout, /error/i)
  return drive(exe, [])
}

async function buildWithDotnet(): Promise<Harness | undefined> {
  try {
    await run('dotnet', ['--version'], { windowsHide: true, timeout: 20_000 })
  } catch {
    return undefined
  }
  const src = path.join(folder, 'src')
  await fs.mkdir(src, { recursive: true })
  for (const file of sources()) await fs.writeFile(path.join(src, file.name), file.text, 'utf8')
  await fs.writeFile(
    path.join(folder, 'parity.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>5</LangVersion>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <InvariantGlobalization>true</InvariantGlobalization>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="src/*.cs" />
  </ItemGroup>
</Project>
`,
    'utf8',
  )
  const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' }
  await run('dotnet', ['build', path.join(folder, 'parity.csproj'), '-c', 'Release', '-o', path.join(folder, 'out'), '--nologo', '-v', 'q'], { cwd: folder, env, timeout: 170_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  return drive('dotnet', [path.join(folder, 'out', 'parity.dll')])
}

before(
  async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-parity-'))
    try {
      if (process.platform === 'win32') {
        harness = await buildWithFramework()
      } else {
        harness = await buildWithDotnet()
      }
    } catch (error) {
      // A compiler that is there and fails on our sources is a failure of ours, not a missing tool.
      if (process.platform === 'win32' || (error as { code?: unknown }).code !== 'ENOENT') throw error
      why = String(error)
    }
  },
  { timeout: 180_000 },
)

after(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

const BS = String.fromCharCode(92)
const Q = '"'
const ask = async (cases: Cases): Promise<Answer> => harness!(cases)

describe('the helper agrees with the tool', () => {
  it('sizes images the way fitImage does', async (t) => {
    if (!harness) return t.skip(why)
    const sizes = [[1, 1], [100, 50], [800, 600], [1568, 1000], [1569, 1], [1920, 1080], [2560, 1440], [3840, 2160], [5120, 1440], [1, 5000], [1157, 1000], [1024, 768], [1366, 768], [3440, 1440], [7680, 4320], [0, 10], [10, 0], [-5, 5]]
    const limits = [[1568, 1_150_000], [1000, 500_000], [64, 4096], [4096, 8_000_000], [1568, 1_000_000]]
    const cases = sizes.flatMap(([w, h]) => limits.map(([edge, pixels]) => [w, h, edge, pixels]))
    const { fit } = await ask({ fit: cases })
    assert.equal(fit.length, cases.length)
    cases.forEach(([w, h, edge, pixels], index) => {
      const expected = fitImage(w, h, edge, pixels)
      const [width, height, scale] = fit[index]
      assert.deepEqual([width, height], [expected.width, expected.height], `size of ${w}x${h} within ${edge} and ${pixels}`)
      assert.ok(Math.abs(scale - expected.scale) < 1e-12, `scale of ${w}x${h} within ${edge} and ${pixels}: ${scale} against ${expected.scale}`)
    })
  })

  it('turns image pixels back into screen pixels the way toScreen does, halves included', async (t) => {
    if (!harness) return t.skip(why)
    const boxes = [[0, 0, 800, 600], [-1920, 0, 1920, 1080], [100, -40, 300, 200], [5, 7, 1, 1]]
    const scales = [1, 0.8166, 0.5, 0.4, 0.3333333, 0.7071067811865476, 0.9999, 0.25]
    const points = [0, 1, 2, 3, 7, 99, 400, 799, 1567]
    const cases: number[][] = []
    for (const box of boxes) for (const scale of scales) for (const px of points) for (const py of [0, 1, 5, 333]) cases.push([px, py, ...box, scale])
    for (const px of [-1, -3, -5]) cases.push([px, px, 0, 0, 800, 600, 0.4]) // -2.5 is -2 in JavaScript, not -3
    const { screen } = await ask({ screen: cases })
    cases.forEach(([px, py, bx, by, bw, bh, scale], index) => {
      const expected = toScreen([px, py], { box: [bx, by, bw, bh], scale })
      assert.deepEqual(screen[index], expected, `(${px}, ${py}) in a capture at ${scale} of [${bx}, ${by}, ${bw}, ${bh}]`)
    })
  })

  it('knows every key name keys.ts can produce, with the codes Windows uses', async (t) => {
    if (!harness) return t.skip(why)
    const names = [...KEY_NAMES, 'ENTER', 'F13', 'definitely-not-a-key', 'win', '']
    const { keys } = await ask({ keys: names })
    names.forEach((name, index) => {
      const known = KEY_NAMES.includes(name) || name === 'ENTER' || name === 'F13'
      assert.equal(keys[index][0], known, `"${name}" is ${known ? '' : 'not '}a key`)
    })
    const code = (name: string) => keys[names.indexOf(name)]
    assert.deepEqual(code('a').slice(1, 3), [0x41, false])
    assert.deepEqual(code('0').slice(1, 3), [0x30, false])
    assert.deepEqual(code('f1').slice(1, 3), [0x70, false])
    assert.deepEqual(code('f24').slice(1, 3), [0x87, false])
    assert.deepEqual(code('enter').slice(1, 3), [0x0d, false])
    assert.deepEqual(code('numpadenter').slice(1, 3), [0x0d, true])
    assert.deepEqual(code('delete').slice(1, 3), [0x2e, true])
    assert.deepEqual(code('up').slice(1, 3), [0x26, true])
    assert.deepEqual(code('space').slice(1, 3), [0x20, false])
    assert.deepEqual(code('numpad5').slice(1, 3), [0x65, false])
    assert.equal(code('ENTER')[1], 0x0d, 'the table ignores case')
  })

  it('knows which keys put a character in a field, which is where a password is guarded', async (t) => {
    if (!harness) return t.skip(why)
    const typing = ['a', 'z', '0', '9', 'space', 'minus', 'equals', 'comma', 'period', 'slash', 'semicolon', 'quote', 'lbracket', 'rbracket', 'backslash', 'backtick', 'numpad0', 'numpad9', 'numpadadd']
    const silent = ['enter', 'tab', 'escape', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'f1', 'f12', 'capslock', 'numpadenter', 'insert']
    const { keys } = await ask({ keys: [...typing, ...silent] })
    typing.forEach((name, index) => assert.equal(keys[index][3], true, `${name} types`))
    silent.forEach((name, index) => assert.equal(keys[typing.length + index][3], false, `${name} does not type`))
    for (const name of KEY_NAMES) if (/^[a-z0-9]$/.test(name)) assert.ok(typing.includes(name) || name.length === 1, name)
  })

  it('refuses the same combinations that leave the window as keys.ts does', async (t) => {
    if (!harness) return t.skip(why)
    const cases: [boolean, boolean, string][] = []
    for (const ctrl of [false, true]) for (const alt of [false, true]) for (const key of KEY_NAMES) cases.push([ctrl, alt, key])
    const { away } = await ask({ away: cases })
    cases.forEach(([ctrl, alt, key], index) => {
      const text = [ctrl ? 'ctrl' : '', alt ? 'alt' : '', key].filter(Boolean).join('+')
      const parsed = parseKeys(text)
      const phrase = away[index] as string | null
      if (phrase === null) assert.equal(parsed.ok, true, `${text} is allowed on both sides`)
      else {
        assert.equal(parsed.ok, false, `${text} is refused on both sides`)
        assert.ok(!parsed.ok && parsed.error.includes(phrase), `${text}: "${phrase}" in ${!parsed.ok ? parsed.error : ''}`)
      }
    })
    assert.equal(away[cases.findIndex(([ctrl, alt, key]) => ctrl && alt && key === 'delete')], 'opens the security screen')
  })

  it('reads and writes JSON like JSON does', async (t) => {
    if (!harness) return t.skip(why)
    const pair = `${BS}ud83d${BS}ude00`
    const valid = [
      '{"a":[1,2.5,1e3,-12,12345678901234567890,0.1,true,false,null],"b":{"c":"x","d":[]},"e":{}}',
      '  [ 1 , 2 ,\n 3 ]  ',
      `${Q}plain${Q}`,
      `${Q}quote ${BS}${Q} backslash ${BS}${BS} slash ${BS}/ tab ${BS}t newline ${BS}n return ${BS}r backspace ${BS}b formfeed ${BS}f${Q}`,
      `${Q}${BS}u00e9${BS}u65e5${BS}u672c ${pair}${Q}`,
      `${Q}${BS}u2028 and ${BS}u2029 and ${BS}u0001 and ${BS}u001f${Q}`,
      `${Q}${String.fromCodePoint(0x1f600, 0x20, 0xe9, 0x20, 0x65e5)}${Q}`,
      `{${Q}k${BS}u00e9${Q}:${Q}v${Q},${Q}${String.fromCodePoint(0x65e5)}${Q}:1}`,
      '[[[[[[[[[[1]]]]]]]]]]',
      '"" ',
      '0',
      '-7',
      '1.5e-7',
    ]
    const invalid = ['', '[1,]', '{"a":1,}', "{'a':1}", '[1 2]', '"unterminated', 'nul', '[1]x', '{"a"}', '[', `{${Q}a${Q}:`, '[' .repeat(80) + ']'.repeat(80)]
    const { json } = await ask({ json: [...valid, ...invalid] })
    valid.forEach((text, index) => {
      assert.equal(json[index].ok, true, `reads ${text}`)
      assert.deepEqual(JSON.parse(json[index].text), JSON.parse(text), `writes what it read: ${text}`)
    })
    invalid.forEach((text, index) => assert.equal(json[valid.length + index].ok, false, `refuses ${text.slice(0, 40)}`))
    // Nothing the helper writes may contain a raw line separator or control character: the client reads the stream line by line.
    for (const entry of json.slice(0, valid.length)) assert.doesNotMatch(entry.text, new RegExp(`[\\x00-\\x1f${String.fromCodePoint(0x2028, 0x2029)}]`))
  })
})

// ---------------------------------------------------------------- outlines

interface Node {
  role?: string | null
  name?: string
  can?: string[]
  box?: number[]
  offscreen?: boolean
  password?: boolean
  children?: Node[]
}

const WINDOW = [0, 0, 1000, 800]
const IN = [10, 10, 100, 24]

function node(role: string | null, name: string, extra: Partial<Node> = {}, children: Node[] = []): Node {
  return { role, name, box: IN, ...extra, children }
}

async function outline(root: Node, limits: Record<string, number> = {}) {
  const { outline: results } = await ask({ outline: [{ root: { role: 'window', name: 'Window', box: WINDOW, children: root.children }, window: WINDOW, limits }] })
  return results[0] as { entries: [string, string, number][]; total: number; cut: boolean; passwords: number[][] }
}

describe('the helper builds outlines by the rules the tool relies on', () => {
  it('leaves out containers that say nothing, and counts depth by the ones that are listed', async (t) => {
    if (!harness) return t.skip(why)
    const result = await outline(
      node(null, '', {}, [
        node('pane', '', {}, [
          node('toolbar', 'Main', {}, [node('button', 'Save', { can: ['invoke'] }), node('button', '', { can: ['invoke'] })]),
          node('group', '', {}, [node('edit', 'Search')]),
        ]),
        node('statusbar', 'Ready'),
      ]),
    )
    assert.deepEqual(result.entries, [['toolbar', 'Main', 0], ['button', 'Save', 1], ['button', '', 1], ['edit', 'Search', 0], ['statusbar', 'Ready', 0]])
    assert.equal(result.total, 5)
    assert.equal(result.cut, false)
  })

  it('skips what is out of view, what has no size and what the outline never lists, but looks inside what is only off to the side', async (t) => {
    if (!harness) return t.skip(why)
    const result = await outline(
      node(null, '', {}, [
        node('button', 'Visible'),
        node('button', 'Hidden', { offscreen: true }, [node('button', 'Inner')]),
        node('pane', 'Outside', { box: [2000, 2000, 50, 20] }, [node('button', 'Reached')]),
        node(null, 'Separator', {}, [node('button', 'Below a separator')]),
        node('button', 'Empty', { box: [10, 10, 0, 0] }),
      ]),
    )
    assert.deepEqual(result.entries, [['button', 'Visible', 0], ['button', 'Reached', 0]])
    assert.equal(result.total, 2)
  })

  it('finds every password field in view, listed or not, so a screenshot can paint over them', async (t) => {
    if (!harness) return t.skip(why)
    const result = await outline(
      node(null, '', {}, [
        node('edit', 'Password', { password: true, box: [20, 20, 200, 24] }),
        node('pane', '', { password: true, box: [5000, 5000, 100, 20] }),
        node('edit', 'Hidden password', { password: true, offscreen: true, box: [30, 30, 200, 24] }),
        node('edit', 'User name'),
      ]),
    )
    assert.deepEqual(result.passwords, [[20, 20, 200, 24], [5000, 5000, 100, 20]])
    assert.deepEqual(result.entries.map((entry) => entry[1]), ['Password', 'User name'])
  })

  it('keeps as many as it was asked to and counts the rest', async (t) => {
    if (!harness) return t.skip(why)
    const buttons = Array.from({ length: 6 }, (_, n) => node('button', `b${n}`))
    const result = await outline(node(null, '', {}, buttons), { maxEntries: 3 })
    assert.deepEqual(result.entries.map((entry) => entry[1]), ['b0', 'b1', 'b2'])
    assert.equal(result.total, 6, 'the model is told how many it is not seeing')
    assert.equal(result.cut, false)
  })

  it('stops after the visits it was allowed, and says the total is higher than it counted', async (t) => {
    if (!harness) return t.skip(why)
    const buttons = Array.from({ length: 10 }, (_, n) => node('button', `b${n}`))
    const visits = await outline(node(null, '', {}, buttons), { maxVisits: 4 })
    assert.equal(visits.entries.length, 4)
    assert.equal(visits.cut, true)
    assert.ok(visits.total > visits.entries.length)
    const children = await outline(node(null, '', {}, buttons), { maxChildren: 3 })
    assert.equal(children.entries.length, 3)
    assert.equal(children.cut, true)
    assert.ok(children.total > children.entries.length)
  })

  it('does not go deeper than it was allowed', async (t) => {
    if (!harness) return t.skip(why)
    const chain = node(null, '', {}, [node('group', 'g1', {}, [node('group', 'g2', {}, [node('group', 'g3', {}, [node('group', 'g4', {}, [node('button', 'deep')])])])])])
    const result = await outline(chain, { maxDepth: 2 })
    assert.deepEqual(result.entries.map((entry) => entry[1]), ['g1', 'g2', 'g3'])
    assert.equal(result.cut, true)
    assert.ok(result.total > 3)
  })
})
