import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { LANGUAGE_LIBRARIES, LANGUAGE_SERVERS } from '../catalog'
import { mergeSettings } from '../hub'
import { installedDir, installedLaunch, installServer, planInstall, removeInstall, type InstallContext, type NpmLock } from '../install'
import { NPM_LOCKS } from '../npm-locks'
import { makeTar } from '../test-archives'
import { CFX_SYMBOLS, FIVEM_NATIVES, findResources, importedResources, installedNatives, manifestImports, prepareLua, serverPath, writeCfxSupport } from '.'
import { CFX_PLUGIN, CFX_RUNTIME } from './lua-files'
import { luaType, nativesLibrary, parseNatives } from './natives'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-fivem-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(file: string, text = ''): string {
  const full = path.join(dir, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
  return full
}

const CLIENT = [
  '/**',
  ' * Gets the coordinates of an entity. See [GET_ENTITY_HEADING](#\\_0xE83D4F9BA2A38914).',
  ' * ![a picture](https://example.invalid/a.png)',
  ' * @param entity The entity.',
  ' * @param alive Whether it is alive.',
  ' * @return Its coordinates.',
  ' */',
  'declare function GetEntityCoords(entity: number, alive?: boolean): number[];',
  '',
  '/**',
  ' * _ACTIVATE_DAMAGE_TRACKER_ON_PLAYER',
  ' */',
  'declare function ActivateDamageTrackerOnPlayer(player: number, toggle: boolean): void;',
  '/**',
  ' * _ACTIVATE_DAMAGE_TRACKER_ON_PLAYER',
  ' */',
  'declare function N_0xbec0816ff5acbcda(player: number, toggle: boolean): void;',
  '',
  '/**',
  ' * A tuple, a hash and a keyword for a name.',
  ' */',
  'declare function GetGroundZFor_3dCoord(x: number, y: number, z: number, end: string | number): [boolean, number];',
  '',
  'declare function IsPedArmed(ped: number, p1: number): any /* actually bool */;',
  '',
  '/**',
  ' * GET_PLAYER_NAME',
  ' */',
  'declare function GetPlayerName(player: number): string;',
  '',
].join('\n')

const SERVER = [
  '/**',
  ' * DROP_PLAYER',
  ' */',
  'declare function DropPlayer(playerSrc: string, reason: string): void;',
  '',
  '/**',
  ' * GET_PLAYER_NAME',
  ' */',
  'declare function GetPlayerName(playerSrc: string): string;',
  '',
].join('\n')

describe("FiveM's natives", () => {
  it('reads each declaration with its types, its docs and the names that are another native under an old name', () => {
    const natives = parseNatives(CLIENT)
    assert.deepEqual(
      natives.map((native) => native.name),
      ['GetEntityCoords', 'ActivateDamageTrackerOnPlayer', 'N_0xbec0816ff5acbcda', 'GetGroundZFor_3dCoord', 'IsPedArmed', 'GetPlayerName'],
    )
    const coords = natives[0]!
    assert.deepEqual(coords.params, [
      { name: 'entity', type: 'number', optional: false, doc: 'The entity.' },
      { name: 'alive', type: 'boolean', optional: true, doc: 'Whether it is alive.' },
    ])
    assert.deepEqual(coords.returns, ['vector3'])
    assert.equal(coords.returnDoc, 'Its coordinates.')
    assert.deepEqual(coords.doc, ['Gets the coordinates of an entity. See `GET_ENTITY_HEADING`.', '(picture: a picture)'])
    assert.equal(natives[1]!.aliasOf, undefined)
    assert.equal(natives[2]!.aliasOf, 'ActivateDamageTrackerOnPlayer')
    const ground = natives[3]!
    assert.deepEqual(ground.returns, ['boolean', 'number'])
    assert.deepEqual(ground.params.at(-1), { name: 'end_', type: 'string|integer', optional: false })
    assert.deepEqual(natives[4]!.returns, ['boolean'])
    assert.equal(luaType('Function'), 'function')
    assert.equal(luaType('SomethingElse'), 'any')
  })

  it('writes both sides once each, says which side has a native, and takes a server id as a number where a player is named', () => {
    const files = nativesLibrary(CLIENT, SERVER, '@citizenfx/client and @citizenfx/server 1.0')
    assert.equal(files.length, 1)
    const text = files[0]!.text
    assert.match(text, /^---@meta _\n/)
    assert.match(text, /---@deprecated Use ActivateDamageTrackerOnPlayer\.\nfunction N_0xbec0816ff5acbcda\(player, toggle\) end/)
    assert.match(text, /--- \*Client only\.\*\n---@param entity number The entity\.\n---@param alive\? boolean Whether it is alive\.\n---@return vector3 # Its coordinates\.\nfunction GetEntityCoords\(entity, alive\) end/)
    assert.match(text, /--- \*Server only\.\*\n---@param playerSrc string\|integer\n---@param reason string\nfunction DropPlayer\(playerSrc, reason\) end/)
    // Both sides have it, with other parameters: the client's form, and the server's as an overload.
    assert.match(text, /--- \*Client and server; the second form is the server's\.\*\n---@param player number\n---@return string\n---@overload fun\(playerSrc: string\|integer\): string\nfunction GetPlayerName\(player\) end/)
    assert.equal(text.match(/^function GetPlayerName/gm)?.length, 1)
  })

  it('keeps every word from the typings in a comment, so nothing in them can become code', () => {
    const hostile = [
      '/**',
      ' * Ends here ]] end os.execute("x") --[[',
      ' * line\u2028break\u0007bell',
      ' * @param a ok\rend',
      ' */',
      'declare function Fine(a: number): void;',
      '',
      'declare function os.execute(a: number): void;',
      'declare function end(a: number): void;',
      'declare function Bad(a: number): void; os.exit()',
      '',
    ].join('\n')
    const text = nativesLibrary(hostile, '', 'test').map((file) => file.text).join('\n')
    for (const line of text.split('\n')) {
      assert.ok(line === '' || line.startsWith('--') || /^function [A-Za-z_][A-Za-z0-9_]*\(([A-Za-z_][A-Za-z0-9_]*(, )?)*\) end$/.test(line), `not a comment or a declaration: ${JSON.stringify(line)}`)
    }
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/)
    assert.match(text, /function Fine\(a\) end/)
    assert.doesNotMatch(text, /function (os|end|Bad)\b/)
  })

  it('splits the definitions into files small enough for the server to read them all', () => {
    const many = Array.from({ length: 3000 }, (_, index) => `/**\n * Native number ${index}, with some words to make it long enough to count.\n */\ndeclare function Native${index}(a: number, b: string): boolean;\n`).join('\n')
    const files = nativesLibrary(many, '', 'test')
    assert.ok(files.length > 1)
    for (const file of files) {
      assert.ok(file.text.length <= 410_000, `${file.name} is ${file.text.length} characters`)
      assert.match(file.name, /^natives-\d{2}\.lua$/)
      assert.match(file.text, /^---@meta _\n/)
    }
    assert.equal(files.map((file) => file.text.match(/^function /gm)?.length ?? 0).reduce((a, b) => a + b, 0), 3000)
  })

  it("are installed from Cfx.re's own packages, pinned like the servers, and written as definitions without the typings", async () => {
    const client = makeTar([{ name: 'package/natives_universal.d.ts', data: CLIENT }, { name: 'package/package.json', data: '{}' }], true)
    const server = makeTar([{ name: 'package/natives_server.d.ts', data: SERVER }, { name: 'package/package.json', data: '{}' }], true)
    const sha512 = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`
    const lock: NpmLock = {
      packages: { '@citizenfx/client': '9.0.1-1', '@citizenfx/server': '9.0.1-1' },
      files: [
        { path: 'node_modules/@citizenfx/client', version: '9.0.1-1', url: 'https://registry.npmjs.org/@citizenfx/client/-/client-9.0.1-1.tgz', integrity: sha512(client), size: client.length },
        { path: 'node_modules/@citizenfx/server', version: '9.0.1-1', url: 'https://registry.npmjs.org/@citizenfx/server/-/server-9.0.1-1.tgz', integrity: sha512(server), size: server.length },
      ],
    }
    const routes: Record<string, Buffer> = { [lock.files[0]!.url]: client, [lock.files[1]!.url]: server }
    const fetchImpl = (async (input: string | URL | Request) => {
      const body = routes[String(input)]
      return body ? new Response(new Uint8Array(body)) : new Response('no', { status: 404 })
    }) as typeof fetch
    const context: InstallContext = {
      toolsDir: path.join(dir, 'tools'),
      cacheDir: path.join(dir, 'cache'),
      root: dir,
      platform: 'win32',
      arch: 'x64',
      node: { file: 'node' },
      which: () => null,
      env: {},
      fetch: fetchImpl,
    }
    const spec = { ...FIVEM_NATIVES, installer: { ...FIVEM_NATIVES.installer, lock } }
    const plan = await planInstall(spec, context)
    assert.ok(!('unavailable' in plan))
    assert.equal(plan.what, "FiveM's natives for Lua")
    assert.match(plan.steps.join(' '), /@citizenfx\/client 9\.0\.1-1 and @citizenfx\/server 9\.0\.1-1 from the npm registry: 2 packages/)
    assert.match(plan.steps.join(' '), /Writes Lua definitions of FiveM's natives from them\. Nothing in them is run\./)
    const installed = await installServer(spec, context)
    assert.deepEqual(fs.readdirSync(installed).sort(), ['encode-install.json', 'library', 'natives.json'])
    assert.match(fs.readFileSync(path.join(installed, 'library', 'natives-01.lua'), 'utf8'), /function DropPlayer\(playerSrc, reason\) end/)
    assert.equal(installedDir(FIVEM_NATIVES, context.toolsDir)?.dir, installed)
    // The agent's lookups read the same natives, with the side that has each.
    const natives = installedNatives(context.toolsDir)!
    const coords = natives.find((native) => native.name === 'GetEntityCoords')!
    assert.equal(coords.side, 'client')
    assert.deepEqual(coords.params.map((param) => `${param.name}${param.optional ? '?' : ''}: ${param.type}`), ['entity: number', 'alive?: boolean'])
    assert.deepEqual(coords.returns, ['vector3'])
    assert.equal(natives.find((native) => native.name === 'DropPlayer')?.side, 'server')
    // Not a server: nothing of it is ever started.
    assert.equal(installedLaunch({ ...LANGUAGE_SERVERS.find((item) => item.id === 'lua')!, id: FIVEM_NATIVES.id, installer: spec.installer }, context.toolsDir, context), null)
    removeInstall(FIVEM_NATIVES, context.toolsDir)
    assert.equal(installedDir(FIVEM_NATIVES, context.toolsDir), null)
    assert.equal(installedNatives(context.toolsDir), undefined)
  })

  it('are pinned to two packages of the npm registry, listed as a library of the Lua server', () => {
    assert.deepEqual(LANGUAGE_LIBRARIES, [FIVEM_NATIVES])
    assert.equal(FIVEM_NATIVES.server, 'lua')
    assert.ok(LANGUAGE_SERVERS.some((spec) => spec.id === FIVEM_NATIVES.server))
    const lock = NPM_LOCKS[FIVEM_NATIVES.installer.lock as string]!
    assert.deepEqual(Object.keys(lock.packages), ['@citizenfx/client', '@citizenfx/server'])
    for (const file of lock.files) {
      assert.match(file.url, /^https:\/\/registry\.npmjs\.org\/@citizenfx\//)
      assert.match(file.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/)
    }
  })
})

describe('a folder of FiveM resources', () => {
  it('finds its resources and what their manifests import, and a folder inside a resource', () => {
    write('resources/[core]/bank/fxmanifest.lua', "fx_version 'cerulean'\nshared_script '@ox_lib/init.lua'\nclient_scripts { '@qbx_core/modules/lib.lua', 'client.lua' }\n")
    write('resources/[core]/bank/client.lua')
    write('resources/[core]/bank/stream/x/fxmanifest.lua', 'not a resource of its own')
    write('resources/old/__resource.lua', "client_script 'a.lua'\n")
    write('resources/node_modules/pkg/fxmanifest.lua')
    const found = findResources(path.join(dir, 'resources'))
    assert.deepEqual(found?.resources.map((item) => path.relative(dir, item).split(path.sep).join('/')).sort(), ['resources/[core]/bank', 'resources/old'])
    assert.deepEqual(found?.imports.sort(), ['ox_lib', 'qbx_core'])
    assert.deepEqual(findResources(path.join(dir, 'resources', '[core]', 'bank', 'client'))?.resources, [path.join(dir, 'resources', '[core]', 'bank')])
    write('plain/init.lua')
    assert.equal(findResources(path.join(dir, 'plain')), null)
    assert.deepEqual(manifestImports("'@a/b.lua' \"@c-d.e/f\" '@../x' '@nope' '@g/'"), ['a', 'c-d.e'])
  })

  it('finds the resources it imports from beside it or in a [category] folder above it, never inside it', () => {
    write('server/resources/[local]/shop/fxmanifest.lua', "shared_script '@ox_lib/init.lua'\nshared_script '@es_extended/imports.lua'\nshared_script '@missing/x.lua'\n")
    write('server/resources/[ox]/ox_lib/fxmanifest.lua')
    write('server/resources/[framework]/[esx]/es_extended/fxmanifest.lua')
    const root = path.join(dir, 'server', 'resources', '[local]', 'shop')
    const folder = findResources(root)!
    assert.deepEqual(importedResources(root, folder).sort(), [path.join(dir, 'server', 'resources', '[framework]', '[esx]', 'es_extended'), path.join(dir, 'server', 'resources', '[ox]', 'ox_lib')].sort())
    // Opened at the top, every resource is in the folder already.
    const top = path.join(dir, 'server', 'resources')
    assert.deepEqual(importedResources(top, findResources(top)!), [])
  })

  it("tells the Lua server CfxLua's syntax, the runtime, the natives once installed and the resources imported", () => {
    write('res/[ox]/ox_lib/fxmanifest.lua')
    const root = path.dirname(write('res/[mine]/hud/fxmanifest.lua', "shared_script '@ox_lib/init.lua'\n"))
    const tools = { dir: path.join(dir, 'tools'), cacheDir: path.join(dir, 'cache') }
    const prepared = prepareLua({ root, platform: process.platform, tools })!
    const lua = (prepared.settings as { Lua: { runtime: Record<string, unknown>; workspace: { library: string[] } } }).Lua
    const support = writeCfxSupport(tools.cacheDir, process.platform)
    assert.equal(lua.runtime.version, 'Lua 5.4')
    assert.deepEqual(lua.runtime.nonstandardSymbol, CFX_SYMBOLS)
    assert.equal(lua.runtime.plugin, support.plugin)
    assert.deepEqual(lua.workspace.library, [support.runtime, path.join(dir, 'res', '[ox]', 'ox_lib')])
    assert.deepEqual(prepared.args, [`--logpath=${support.log}`])
    // The natives, once installed, are read too.
    const natives = path.join(tools.dir, 'fivem-natives', '1.0')
    fs.mkdirSync(path.join(natives, 'library'), { recursive: true })
    fs.writeFileSync(path.join(natives, 'encode-install.json'), JSON.stringify({ id: 'fivem-natives', version: '1.0' }))
    const again = prepareLua({ root, platform: process.platform, tools })!
    assert.deepEqual((again.settings as { Lua: { workspace: { library: string[] } } }).Lua.workspace.library, [support.runtime, path.join(natives, 'library'), path.join(dir, 'res', '[ox]', 'ox_lib')])
    // Anywhere else, nothing.
    write('nvim/init.lua')
    assert.equal(prepareLua({ root: path.join(dir, 'nvim'), platform: process.platform, tools }), null)
  })

  it("writes eNCode's plugin and definitions, trusts only that plugin, and writes a file that changed again", () => {
    const cache = path.join(dir, 'cache')
    const support = writeCfxSupport(cache, process.platform)
    assert.equal(fs.readFileSync(support.plugin, 'utf8'), CFX_PLUGIN)
    assert.equal(fs.readFileSync(path.join(support.runtime, 'cfx-runtime.lua'), 'utf8'), CFX_RUNTIME)
    assert.equal(fs.readFileSync(path.join(support.log, 'trusted'), 'utf8'), `${serverPath(support.plugin, process.platform)}\n`)
    fs.writeFileSync(support.plugin, 'os.execute("changed")')
    fs.writeFileSync(path.join(support.log, 'trusted'), `${support.plugin}\n/elsewhere/plugin.lua\n`)
    fs.mkdirSync(path.join(cache, 'lua', 'cfx-000000000000'))
    writeCfxSupport(cache, process.platform)
    assert.equal(fs.readFileSync(support.plugin, 'utf8'), CFX_PLUGIN)
    assert.equal(fs.readFileSync(path.join(support.log, 'trusted'), 'utf8'), `${serverPath(support.plugin, process.platform)}\n`)
    assert.deepEqual(fs.readdirSync(path.join(cache, 'lua')).sort(), [path.basename(path.dirname(support.plugin)), 'log'].sort())
    assert.equal(serverPath('C:/Users/a//b\\plugin.lua', 'win32'), 'C:\\Users\\a\\b\\plugin.lua')
    assert.equal(serverPath('/home/a//plugin.lua', 'linux'), '/home/a/plugin.lua')
  })

  it('keeps the Lua files and the module made from them the same', () => {
    const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'packages', 'lsp', 'src', 'fivem', 'lua', name), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(CFX_PLUGIN, read('plugin.lua'), 'run node scripts/fivem-lua.mjs')
    assert.equal(CFX_RUNTIME, read('runtime.lua'), 'run node scripts/fivem-lua.mjs')
  })

  it('lays the folder settings over the server own, object by object', () => {
    assert.deepEqual(mergeSettings({ Lua: { runtime: { version: 'Lua 5.1', path: ['?.lua'] }, hint: { enable: true } } }, { Lua: { runtime: { version: 'Lua 5.4', path: ['x'] } } }), {
      Lua: { runtime: { version: 'Lua 5.4', path: ['x'] }, hint: { enable: true } },
    })
    assert.equal(mergeSettings(undefined, undefined), undefined)
  })
})

/**
 * Against a real lua-language-server, when one is named: ENCODE_LUALS=<path to the program>. CI has none, so this is run
 * by hand (and was, against 3.19.0) after a change to the plugin or the definitions.
 */
describe('with lua-language-server', { skip: !process.env.ENCODE_LUALS }, () => {
  it('reads CfxLua and the runtime with no problem, and finds the problems there are', () => {
    const cache = path.join(dir, 'cache')
    const support = writeCfxSupport(cache, process.platform)
    const natives = path.join(dir, 'natives')
    fs.mkdirSync(natives)
    for (const file of nativesLibrary(CLIENT, SERVER, 'test')) fs.writeFileSync(path.join(natives, file.name), file.text)
    const root = path.join(dir, 'res')
    write('res/fxmanifest.lua', ["fx_version 'cerulean'", "game 'gta5'", "lua54 'yes'", "my_own_key 'anything'", "shared_script '@ox_lib/init.lua'", "client_scripts { 'client.lua' }", "data_file 'DLC_ITYP_REQUEST' 'stream/props.ytyp'", ''].join('\n'))
    write(
      'res/client.lua',
      [
        'local model = `adder`',
        'local cfg = { a = 1, b = { c = 2 } }',
        'local deep = cfg?.b?.c',
        'local idx = cfg?["a"]',
        'local set = { .alpha, .beta }',
        'local a, b in cfg',
        'local x <const>, y in cfg.b',
        'local pos = vector3(1.0, 2.0, 3.0)',
        'local far = #(GetEntityCoords(0) - pos) /* C comment */',
        'CreateThread(function() Wait(0) TriggerServerEvent("x", model, deep, idx, set.alpha, a, b, x, y, far) end)',
        'local count = 1',
        'count += 1',
        '---@type string',
        'local wrong = `adder`',
        'GetEntityCoords()',
        'print(wrong, count)',
        '',
      ].join('\n'),
    )
    const config = path.join(dir, 'luarc.json')
    fs.writeFileSync(config, JSON.stringify({ 'runtime.version': 'Lua 5.4', 'runtime.plugin': support.plugin, 'runtime.nonstandardSymbol': CFX_SYMBOLS, 'workspace.library': [support.runtime, natives], 'workspace.checkThirdParty': false, 'diagnostics.disable': ['unused-local'] }))
    const out = path.join(dir, 'out.json')
    const ran = spawnSync(process.env.ENCODE_LUALS!, [`--check=${root}`, `--configpath=${config}`, '--checklevel=Hint', '--check_format=json', `--check_out_path=${out}`, `--logpath=${support.log}`], { encoding: 'utf8', timeout: 120_000 })
    // It exits with 1 when it found problems.
    assert.ok(ran.status === 0 || ran.status === 1, `exit ${ran.status}: ${ran.stderr}`)
    const found = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, { code: string; range: { start: { line: number } } }[]>) : {}
    const problems = Object.entries(found).flatMap(([uri, items]) => items.map((item) => `${path.basename(decodeURIComponent(uri))}:${item.range.start.line + 1}:${item.code}`))
    assert.deepEqual(problems.sort(), ['client.lua:14:assign-type-mismatch', 'client.lua:15:missing-parameter'])
  })
})
