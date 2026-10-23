# 0084. FiveM's Lua is read through eNCode's own plugin, runtime definitions, and natives written from Cfx.re's typings

- Status: Accepted, builds on 0072, 0073 and 0083
- Date: 2026-10-23

## Context

FiveM resources are the main thing eNCode's first users write. They are Lua, but not plain Lua: FiveM runs CfxLua, Lua
5.4 with additions (backtick hashes, safe navigation, `local a, b in t`, set constructors, C comments, compound
assignment), a runtime of its own (threads, events, exports, state bags, vectors), and about ten thousand natives, all
globals. lua-language-server (installed by 0083) knows none of it: on a real resource it marks the additions as syntax
errors and every native as an undefined global, and it cannot say what a native takes or gives back.

The committed editor scope (Editor 8) asks for FiveM's Lua to be understood. The usual fix in the community is a set of
definition files from a third party and a plugin from another; eNCode uses its own code only, and must not run anything
a project names.

## Decision

### Where it applies

- **A folder of FiveM resources** is one with a `fxmanifest.lua` or `__resource.lua` in it (a bounded walk: 5,000
  folders, 4 levels, skipping `node_modules`, `.git`, `stream` and build folders; a resource's own folders are not
  searched for more resources), or in a folder up to four levels above it. Anywhere else the Lua server starts as it did.
- **Each server may prepare a folder** (`ServerSpec.prepare`): when it starts, it adds settings (laid over its own,
  object by object) and arguments. A failure there is logged and the server starts plain.

### What the Lua server is told

- `Lua.runtime.version` is Lua 5.4, and `nonstandardSymbol` takes C comments, backticks and the compound assignments
  the server reads itself.
- **eNCode's plugin** (`packages/lsp/src/fivem/lua/plugin.lua`, own code) reads each file's text and says how to read
  the rest as plain Lua, as a list of changes the server maps back to the file: a backtick hash becomes the number
  CfxLua makes of it (`GetHashKey`'s), `a?.b`, `a?[k]` and `a?:m()` read as `a.b`, `a[k]` and `a:m()`, `local a, b in t`
  reads as `local a, b = (t).a, (t).b` (when `t` is a name, a field, an index or a call), and `{ .a, .b }` reads as
  `{ a = true, b = true }`. In a manifest it adds the directives, with their docs, and turns off the checks that would
  mark a key the manifest is free to have. It skips strings and comments, runs nothing and reads no file.
- **The runtime's definitions** (`lua/runtime.lua`, written by eNCode from how the runtime behaves): `Citizen`,
  `CreateThread`, `Wait`, `SetTimeout`, events on both sides, NUI callbacks and messages, `exports`, `source`, state bags
  (`GlobalState`, `LocalPlayer`, `Player()`, `Entity()`), vectors and quaternions with their operators and swizzles,
  `json`, `msgpack` and `promise`. Each says which side has it where that matters.
- **The resources the manifests import from** (`'@ox_lib/init.lua'`) are found beside the folder or in `[category]`
  folders above it, as a server keeps them, and added as libraries, so `lib`, `ESX` or `QBCore` are known without the
  person opening the whole server.
- The two Lua files live in the repository as Lua and are carried as strings in `lua-files.ts`, written by
  `scripts/fivem-lua.mjs`; a test fails while the two differ.

### Trusting the plugin

- lua-language-server asks its client before it loads a plugin a folder names, unless the plugin is listed in a
  `trusted` file in its log folder. eNCode starts the server with `--logpath` in eNCode's cache folder, writes the plugin
  and the definitions there (in a folder named by their hash, checked and written again each time, older ones removed),
  and writes `trusted` with that one path, in the server's own normal form.
- eNCode does not use the server's `trustByClient`, which would load any plugin a project's `.luarc.json` names. A
  project's own plugin still asks first, and eNCode's client answers no.

### The natives: installed on request, written from Cfx.re's typings

- **The source is Cfx.re's own typings of the natives**, the npm packages `@citizenfx/client` (all client natives) and
  `@citizenfx/server` (the server's), pinned by version and sha512 in `npm-locks.ts` like the npm servers (0083), and
  installed the same way: **FiveM natives** sits under the Lua server in Settings, with **Install…**, the same dialog
  (two packages, about 0.5 MB, each checked against its hash), progress, Stop and Remove. The editor offers it above a
  Lua file once the Lua server is there, with "Not now" kept per computer. Cfx.re's JSON native database cannot be
  reached from where eNCode is built, and the typings are what Cfx.re publishes for its JavaScript runtime.
- **eNCode writes the definitions itself** (`natives.ts`): the typings are read as text, never run. Each native becomes
  a `---@meta` declaration with its parameters, types and docs; numbers, strings, booleans and functions keep their
  types, a hash takes a string or an integer, a vector comes back as `vector3`, a tuple as several values, and a
  parameter named as a Lua keyword gets a suffix. Natives under an old name (`N_0x...`, an older spelling) say which
  name to use. A native both sides have is written once, with the server's form as an overload where it differs, and
  each says which side has it; a server native that names a player takes a server id as a number too. Links between
  natives become their names and pictures are left out, so a hover loads nothing.
- **Every word from the typings lands in a `---` comment** (control characters and line separators removed) or as a
  checked identifier; a declaration that does not read as one is skipped. The definitions are split into files of
  about 400 KB, under the size the server reads without asking. The typings are removed once the definitions are
  written, and the Lua server starts again to read them.

### The editor

- The editor's own Lua highlighting reads C comments (across lines) and safe navigation as CfxLua does.

## Consequences

- A FiveM resource opens with no false errors from CfxLua's syntax or the runtime, and with the natives installed,
  hovers, completion, signature help and argument checks know every native, on both sides, and the agent's language
  tools see the same.
- **The definitions follow Cfx.re's typings**, which lag the native database a little and type some parameters loosely
  (`any`); a newer pinned version arrives with a new eNCode build.
- **The plugin reads text, not syntax**: an unusual form (`local a in` over a long expression) is left as it is and
  marked by the server as before. Safe navigation reads as plain indexing, so a value the server knows may be nil can
  still be flagged after `?.`.
- A Lua server already running when a manifest is added, or the natives installed or removed, starts again (install) or
  reads the folder again when it next starts.
- A real lua-language-server (3.19.0) checks the plugin, the runtime and the generated natives in a unit test that runs
  when `ENCODE_LUALS` names one; CI has none, so it is run by hand after a change to either.
