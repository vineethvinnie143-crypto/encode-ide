/**
 * Writes packages/lsp/src/fivem/lua-files.ts from the Lua files beside it (packages/lsp/src/fivem/lua/*.lua): the
 * CfxLua plugin and the runtime's definitions eNCode gives lua-language-server in a FiveM folder (ADR 0084). The Lua
 * files are the ones to change; run this after, and a test fails while the two differ.
 *
 *   node scripts/fivem-lua.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'packages', 'lsp', 'src', 'fivem')

export function luaFilesModule(read) {
  const plugin = read('plugin.lua')
  const runtime = read('runtime.lua')
  return [
    '// Written by scripts/fivem-lua.mjs from ./lua/plugin.lua and ./lua/runtime.lua: change those, then run it again.',
    '',
    '/** The CfxLua plugin for lua-language-server. */',
    `export const CFX_PLUGIN = ${JSON.stringify(plugin)}`,
    '',
    "/** FiveM's Lua runtime, as definitions. */",
    `export const CFX_RUNTIME = ${JSON.stringify(runtime)}`,
    '',
  ].join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (name) => fs.readFileSync(path.join(dir, 'lua', name), 'utf8').replace(/\r\n/g, '\n')
  fs.writeFileSync(path.join(dir, 'lua-files.ts'), luaFilesModule(read))
  console.log('wrote packages/lsp/src/fivem/lua-files.ts')
}
