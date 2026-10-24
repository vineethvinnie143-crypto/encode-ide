import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { NativeDoc } from '@encode/lsp'
import { tempWorkspace, testContext, textOf } from '../testing'
import { packageOverview, packageQuery, packageSymbol, searchNatives } from './package-docs'
import { compareVersions, findPackage, projectPackages, renderPackages, type PackageEnv } from './packages'
import { codeMapTool } from './tool'

/** A web project: one package without types of its own, one with `exports` types, one missing, one of the workspace. */
const NPM = {
  'package.json': JSON.stringify({ dependencies: { alpha: '^1.4.0', beta: '^2.0.0', '@scope/gamma': '^1.0.0', local: 'workspace:*' }, devDependencies: { '@types/alpha': '^1.4.0' } }),
  'node_modules/alpha/package.json': JSON.stringify({ name: 'alpha', version: '1.4.0', main: 'index.js' }),
  'node_modules/alpha/index.js': 'exports.alphaRun = (x) => String(x)\n',
  'node_modules/@types/alpha/package.json': JSON.stringify({ name: '@types/alpha', version: '1.4.2', types: 'index.d.ts' }),
  'node_modules/@types/alpha/index.d.ts': [
    '/**',
    ' * Runs alpha on a number.',
    ' * @param x The number.',
    ' */',
    'export declare function alphaRun(x: number): string;',
    'export declare function alphaRun(x: string): string;',
    'export interface AlphaOptions {',
    '  depth: number',
    '  /** How loud. */',
    '  verbose?: boolean',
    '}',
    '',
  ].join('\n'),
  'node_modules/@types/alpha/ts4.0/index.d.ts': 'export declare function alphaRun(x: number): string;\n',
  'node_modules/@scope/gamma/package.json': JSON.stringify({ name: '@scope/gamma', version: '1.0.3', exports: { '.': { import: { types: './dist/index.d.mts', default: './dist/index.mjs' } } } }),
  'node_modules/@scope/gamma/dist/index.d.mts': "export * from './util'\nexport declare const VERSION: string;\n",
  'node_modules/@scope/gamma/dist/util.d.mts': 'export declare class Gamma {\n  run(times: number): void;\n  stop(): void;\n}\nexport declare function makeGamma(): Gamma;\n',
  'src/app.ts': "import { alphaRun } from 'alpha'\n",
}

const env = (root: string, extra: PackageEnv['env'] = {}): PackageEnv => ({ home: path.join(root, 'home'), platform: 'linux', env: extra })
const lookup = (root: string, pkg: NonNullable<Awaited<ReturnType<typeof findPackage>>>) => ({ pkg, display: (file: string) => path.relative(root, file).split(path.sep).join('/'), from: root, root })

describe("the project's dependencies, as installed", () => {
  it('reads npm packages from the manifests and node_modules, leaving out the workspace\'s own', async () => {
    const root = await tempWorkspace(NPM)
    const packages = await projectPackages(root, env(root))
    assert.deepEqual(packages.map((entry) => `${entry.name} ${entry.version ?? '-'}${entry.dev ? ' dev' : ''}`), ['alpha 1.4.0', 'beta -', '@scope/gamma 1.0.3', '@types/alpha 1.4.2 dev'])
    assert.equal(renderPackages(packages, 500), 'npm: alpha 1.4.0, beta not installed, @scope/gamma 1.0.3')
  })

  it("shows a package's export with its documentation, from @types when it has no types of its own", async () => {
    const root = await tempWorkspace(NPM)
    const alpha = (await findPackage(root, root, 'alpha', env(root)))!
    const text = await packageSymbol(lookup(root, alpha), 'alphaRun', 8_000)
    assert.equal(
      text,
      [
        'alpha 1.4.0 (npm, installed at node_modules/alpha, types from @types/alpha 1.4.2)',
        '',
        'node_modules/@types/alpha/index.d.ts:5',
        '/**',
        ' * Runs alpha on a number.',
        ' * @param x The number.',
        ' */',
        'export declare function alphaRun(x: number): string;',
        'export declare function alphaRun(x: string): string;',
      ].join('\n'),
    )
    assert.match(await packageSymbol(lookup(root, alpha), 'AlphaOptions', 8_000), /export interface AlphaOptions \{\n {2}depth: number\n {2}\/\*\* How loud\. \*\/\n {2}verbose\?: boolean\n\}/)
    assert.match(await packageSymbol(lookup(root, alpha), 'alphaWalk', 8_000), /Nothing named alphaWalk is declared in it\. Names like it: alphaRun, AlphaOptions\. It may not exist in this version\./)
  })

  it('follows a types entry through `exports` and `export * from`, and searches by words', async () => {
    const root = await tempWorkspace(NPM)
    const gamma = (await findPackage(root, root, '@scope/gamma', env(root)))!
    const overview = await packageOverview(lookup(root, gamma), 8_000)
    assert.match(overview, /^@scope\/gamma 1\.0\.3 \(npm, installed at node_modules\/@scope\/gamma\)\nExports, by file and line/)
    assert.match(overview, /node_modules\/@scope\/gamma\/dist\/index\.d\.mts\n {2}2 export declare const VERSION: string;/)
    assert.match(overview, /dist\/util\.d\.mts\n {2}1 export declare class Gamma\n {4}2 run\(times: number\): void;/)
    const found = await packageQuery(lookup(root, gamma), ['make'], 8_000)
    assert.match(found, /\n {2}5 export declare function makeGamma\(\): Gamma;/)
    assert.doesNotMatch(found, /stop\(\)/)
  })

  it('reads Python packages from the folder\'s virtual environment, by the name they are installed under', async () => {
    const root = await tempWorkspace({
      'requirements.txt': 'PyYAML>=6.0  # parsing\n-r more.txt\nrequests[socks]==2.31.0\n',
      '.venv/lib/python3.12/site-packages/PyYAML-6.0.1.dist-info/METADATA': 'Metadata-Version: 2.1\nName: PyYAML\nVersion: 6.0.1\n',
      '.venv/lib/python3.12/site-packages/PyYAML-6.0.1.dist-info/top_level.txt': '_yaml\nyaml\n',
      '.venv/lib/python3.12/site-packages/yaml/__init__.py': 'def safe_load(stream):\n    """\n    Parse the first YAML document in a stream\n    and produce the corresponding Python object.\n    """\n    return load(stream)\n\ndef _private():\n    pass\n',
    })
    const packages = await projectPackages(root, env(root))
    assert.deepEqual(packages.map((entry) => `${entry.name} ${entry.version ?? '-'}`), ['PyYAML 6.0.1', 'requests -'])
    const yaml = (await findPackage(root, root, 'PyYAML', env(root)))!
    assert.equal(path.basename(yaml.dir!), 'yaml')
    const text = await packageSymbol(lookup(root, yaml), 'safe_load', 8_000)
    assert.match(text, /\.venv\/lib\/python3\.12\/site-packages\/yaml\/__init__\.py:1\ndef safe_load\(stream\):\n {4}"""\n {4}Parse the first YAML document in a stream\n {4}and produce the corresponding Python object\.\n {4}"""$/)
    assert.doesNotMatch(await packageOverview(lookup(root, yaml), 8_000), /_private/)
  })

  it("reads a crate at the version Cargo.lock pins, from Cargo's cache, with its doc comments", async () => {
    const root = await tempWorkspace({
      'Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\n\n[dev-dependencies.tempfile]\nversion = "3"\n',
      'Cargo.lock': '[[package]]\nname = "serde"\nversion = "1.0.190"\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\n\n[[package]]\nname = "tempfile"\nversion = "3.8.0"\n',
      'cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.200/src/lib.rs': '/// Serializes a value\n/// as text.\npub fn to_string<T: Serialize>(value: &T) -> Result<String> {\n    todo!()\n}\nfn hidden() {}\n',
    })
    const cargoEnv = env(root, { CARGO_HOME: path.join(root, 'cargo') })
    const packages = await projectPackages(root, cargoEnv)
    assert.deepEqual(packages.map((entry) => `${entry.name} ${entry.version}${entry.dir ? '' : ' (not in the cache)'}${entry.dev ? ' dev' : ''}`), ['serde 1.0.200', 'tempfile 3.8.0 (not in the cache) dev'])
    const serde = (await findPackage(root, root, 'serde', cargoEnv))!
    assert.match(await packageSymbol(lookup(root, serde), 'to_string', 8_000), /src\/lib\.rs:3\n\/\/\/ Serializes a value\n\/\/\/ as text\.\npub fn to_string<T: Serialize>\(value: &T\) -> Result<String> \{$/)
    assert.doesNotMatch(await packageOverview(lookup(root, serde), 8_000), /hidden/)
  })

  it("reads a Go module at go.mod's version from the module cache, capitals spelled as it spells them", async () => {
    const root = await tempWorkspace({
      'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/Foo/bar v1.2.3 // indirect\n)\n',
      'gomod/github.com/!foo/bar@v1.2.3/bar.go': 'package bar\n\n// Do does the work\n// and says when it fails.\nfunc Do(ctx context.Context) error {\n\treturn nil\n}\n\nfunc hidden() {}\n',
      'gomod/github.com/!foo/bar@v1.2.3/bar_test.go': 'package bar\n\nfunc TestDo() {}\n',
    })
    const goEnv = env(root, { GOMODCACHE: path.join(root, 'gomod') })
    const bar = (await findPackage(root, root, 'github.com/Foo/bar', goEnv))!
    assert.equal(bar.version, 'v1.2.3')
    assert.match(await packageSymbol(lookup(root, bar), 'Do', 8_000), /bar\.go:5\n\/\/ Do does the work\n\/\/ and says when it fails\.\nfunc Do\(ctx context\.Context\) error \{$/)
    const overview = await packageOverview(lookup(root, bar), 8_000)
    assert.doesNotMatch(overview, /hidden|TestDo/)
  })

  it('lists the FiveM resources the folder depends on, with their versions', async () => {
    const root = await tempWorkspace({
      'resources/[ox]/ox_lib/fxmanifest.lua': "fx_version 'cerulean'\nversion '3.30.6'\n",
      'resources/[ox]/ox_lib/imports/callback/server.lua': 'function lib.callback.register(name, cb) end\n',
      'resources/garage/fxmanifest.lua': "fx_version 'cerulean'\nshared_scripts { '@ox_lib/init.lua' }\ndependencies { 'ox_lib', '/server:6683', 'oxmysql' }\n",
    })
    const packages = await projectPackages(root, env(root))
    assert.deepEqual(packages.map((entry) => `${entry.name} ${entry.version ?? '-'}${entry.dir ? '' : ' (not here)'}`), ['ox_lib 3.30.6', 'oxmysql - (not here)'])
    assert.equal(renderPackages(packages, 500), 'FiveM resources: ox_lib 3.30.6, oxmysql (no version)')
  })

  it('never reads outside where a package may be, whatever name it is given', async () => {
    const root = await tempWorkspace({ ...NPM, 'secret/package.json': JSON.stringify({ version: '9.9.9' }) })
    for (const name of ['../secret', 'node_modules/../secret', '/etc', '..', 'alpha/../../secret', 'C:\\secret']) assert.equal((await findPackage(root, root, name, env(root)))?.dir, undefined, name)
  })

  it('shows a class too long to show whole as its header and a line for each member, overloads counted', async () => {
    const events = Array.from({ length: 30 }, (_, n) => `  on(event: 'e${n}', listener: () => void): this;`)
    const methods = Array.from({ length: 45 }, (_, n) => `  method${n}(value: number): void;`)
    const root = await tempWorkspace({
      'package.json': JSON.stringify({ dependencies: { win: '1.0.0' } }),
      'node_modules/win/package.json': JSON.stringify({ name: 'win', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/win/index.d.ts': ['export declare class Window extends Base {', ...events, '  constructor(options?: Options);', ...methods, '}', ''].join('\n'),
    })
    const win = (await findPackage(root, root, 'win', env(root)))!
    const lines = (await packageSymbol(lookup(root, win), 'Window', 8_000)).split('\n')
    assert.deepEqual(lines.slice(2, 6), ['node_modules/win/index.d.ts:1', 'export declare class Window extends Base {', "  on(event: 'e0', listener: () => void): this; (30 forms)", '  constructor(options?: Options);'])
    assert.equal(lines.at(-1), '  … and 7 more members (symbol Window.member shows one)')
    assert.match(await packageSymbol(lookup(root, win), 'Window.method44', 8_000), /index\.d\.ts:77\n {2}method44\(value: number\): void;$/)
  })

  it("reads no file a link takes out of the package, nor one the person's rules forbid", async () => {
    const root = await tempWorkspace({
      'package.json': JSON.stringify({ dependencies: { delta: '1.0.0' } }),
      'node_modules/delta/package.json': JSON.stringify({ name: 'delta', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/delta/index.d.ts': "export * from './inner'\nexport * from './outside'\nexport declare function deltaOpen(): void;\n",
      'node_modules/delta/inner.d.ts': 'export declare function deltaInner(): void;\n',
      'keys.d.ts': 'export declare const API_TOKEN_VALUE: string;\n',
    })
    await fs.symlink(path.join(root, 'keys.d.ts'), path.join(root, 'node_modules/delta/outside.d.ts'))
    const delta = (await findPackage(root, root, 'delta', env(root)))!
    const all = await packageOverview(lookup(root, delta), 8_000)
    assert.match(all, /deltaOpen/)
    assert.match(all, /deltaInner/)
    assert.doesNotMatch(all, /API_TOKEN_VALUE/)
    assert.doesNotMatch(await packageSymbol(lookup(root, delta), 'API_TOKEN_VALUE', 8_000), /keys|string;/)
    const denied = await packageOverview({ ...lookup(root, delta), readable: (file) => !file.endsWith(`${path.sep}inner.d.ts`) }, 8_000)
    assert.match(denied, /deltaOpen/)
    assert.doesNotMatch(denied, /deltaInner/)
    assert.doesNotMatch(await packageQuery({ ...lookup(root, delta), readable: (file) => !file.endsWith(`${path.sep}inner.d.ts`) }, ['delta'], 8_000), /deltaInner/)
  })

  it('compares versions by their numbers', () => {
    assert.deepEqual(['1.10.0', '1.9.3', '1.0.200', 'v1.2.3', '1.0.190'].sort(compareVersions), ['1.0.190', '1.0.200', 'v1.2.3', '1.9.3', '1.10.0'])
  })
})

const NATIVES: NativeDoc[] = [
  { name: 'GetEntityCoords', side: 'both', params: [{ name: 'entity', type: 'number', optional: false, doc: 'The entity.' }, { name: 'alive', type: 'boolean', optional: true }], returns: ['vector3'], returnDoc: 'Its coordinates.', doc: ['Gets the coordinates of an entity.'] },
  { name: 'GetVehicleFuelLevel', side: 'client', params: [{ name: 'vehicle', type: 'number', optional: false }], returns: ['number'], doc: ['GET_VEHICLE_FUEL_LEVEL', 'The fuel left in a vehicle.'] },
  { name: 'SetVehicleFuelLevel', side: 'client', params: [{ name: 'vehicle', type: 'number', optional: false }, { name: 'level', type: 'number', optional: false }], returns: [], doc: [] },
  { name: 'DropPlayer', side: 'server', params: [{ name: 'playerSrc', type: 'string|integer', optional: false }, { name: 'reason', type: 'string', optional: false }], returns: [], doc: ['Kicks a player.'] },
]

describe("FiveM's natives in CodeMap", () => {
  const run = async (input: Record<string, unknown>, natives: readonly NativeDoc[] | null = NATIVES) => {
    const root = await tempWorkspace({ 'client/main.lua': 'local function refuel() end\n', 'server/main.lua': 'function Pay() end\n', 'shared/a.lua': 'function A() end\n' })
    const ctx = testContext(root, { codeMap: { files: async () => ({ files: [], truncated: false }), natives: () => natives ?? undefined } })
    const outcome = await codeMapTool.run(input, ctx)
    return { ok: outcome.ok, text: textOf(outcome.content) }
  }

  it('shows one native in full, on its own or as a symbol the project does not define', async () => {
    const full = ['GetEntityCoords: a FiveM native, client and server.', 'GetEntityCoords(entity: number, alive?: boolean): vector3', 'Gets the coordinates of an entity.', '- entity: The entity.', 'Returns: Its coordinates.'].join('\n')
    assert.equal((await run({ package: 'natives', symbol: 'GetEntityCoords' })).text, full)
    assert.equal((await run({ symbol: 'GetEntityCoords' })).text, full)
    assert.match((await run({ package: 'natives', symbol: 'GetVehicleFuel' })).text, /^No FiveM native is named GetVehicleFuel\.\nFiveM natives for "get vehicle fuel"/)
  })

  it('searches the natives by the words of their names, then of their descriptions', async () => {
    const found = (await run({ package: 'natives', query: 'vehicle fuel' })).text
    assert.match(found, /^FiveM natives for "vehicle fuel" \(CodeMap with symbol shows one in full\):\nGetVehicleFuelLevel\(vehicle: number\): number \(client\): The fuel left in a vehicle\.\nSetVehicleFuelLevel\(vehicle: number, level: number\) \(client\)$/)
    assert.match(searchNatives(NATIVES, 'kicks', 1_000), /DropPlayer\(playerSrc: string\|integer, reason: string\) \(server\): Kicks a player\./)
  })

  it('says how to install them when they are not', async () => {
    const missing = await run({ package: 'natives', query: 'fuel' }, null)
    assert.equal(missing.ok, false)
    assert.match(missing.text, /Settings > Language servers/)
  })
})

describe('CodeMap with a package', () => {
  it('answers from node_modules, and names a package that is not there', async () => {
    const root = await tempWorkspace(NPM)
    const ctx = testContext(root)
    const text = textOf((await codeMapTool.run({ package: 'alpha', symbol: 'alphaRun' }, ctx)).content)
    assert.match(text, /^alpha 1\.4\.0 \(npm, installed at node_modules\/alpha, types from @types\/alpha 1\.4\.2\)\n\nnode_modules\/@types\/alpha\/index\.d\.ts:5/)
    assert.match(textOf((await codeMapTool.run({ package: 'beta' }, ctx)).content), /^beta is named by the project but not installed/)
    assert.match(textOf((await codeMapTool.run({ package: 'nothing-here' }, ctx)).content), /^nothing-here is not a dependency the project has installed/)
    // Reads where the package is, which the permission rules then judge.
    assert.deepEqual(await codeMapTool.access({ package: 'alpha' }, ctx), { type: 'read', paths: [await fs.realpath(path.join(root, 'node_modules/alpha'))] })
    assert.deepEqual(await codeMapTool.access({ package: 'natives' }, ctx), { type: 'none' })
  })
})
