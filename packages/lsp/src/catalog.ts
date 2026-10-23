/**
 * The language servers eNCode knows how to start, by the files they cover. Each is a separate program (ADR 0072):
 * eNCode carries none of them and none comes from VS Code's sources, so the JSON, CSS and HTML servers extracted from
 * VS Code are not here. A server is found in the project's own `node_modules/.bin` first, then on the PATH, then in
 * eNCode's tools folder, where eNCode installs one when the person asks (ADR 0083); the first found is the one used.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FIVEM_NATIVES, prepareLua } from './fivem'
import type { LaunchContext, ServerInstall } from './install'

export interface ServerCandidate {
  /** The program's name, without `.exe` or `.cmd`. */
  command: string
  args: string[]
}

/** Something eNCode installs with one click: a language server, or a library a server reads (ADR 0084). */
export interface Installable {
  id: string
  label: string
  /** How to get it by hand, for the message that says eNCode cannot. */
  install: string
  installer?: ServerInstall
  /** What it is, for a title, when it is not a server: "FiveM's natives for Lua". */
  what?: string
}

/** What a server is told for one folder, worked out each time it starts (FiveM's resources, ADR 0084). */
export interface Prepared {
  /** Laid over the spec's `settings`: objects merge, anything else replaces. */
  settings?: Record<string, unknown>
  /** Added after the program's own arguments. */
  args?: string[]
}

export interface PrepareContext {
  root: string
  platform: NodeJS.Platform
  /** eNCode's tools folder and its cache folder, when the program has them. */
  tools?: { dir: string; cacheDir: string }
}

/** A library eNCode installs for a server to read, such as FiveM's natives for the Lua server. */
export interface LibrarySpec extends Installable {
  what: string
  /** The server that reads it, by id. */
  server: string
  /** File names that show a folder wants it, lower case. */
  markers: string[]
  installer: Extract<ServerInstall, { kind: 'library' }>
}

export interface ServerSpec {
  /** Stable, for settings and logs: "typescript". */
  id: string
  /** For people: "TypeScript and JavaScript". */
  label: string
  /** Language ids by file extension (lower case, with the dot). */
  extensions: Record<string, string>
  /** Whole file names some servers take (`CMakeLists.txt`); lower case. */
  fileNames?: Record<string, string>
  candidates: ServerCandidate[]
  /** How to install it, for the message that says it is missing. */
  install: string
  /** What the server is told in `initialize`, given the folder. */
  initializationOptions?(root: string, exists: (file: string) => boolean): unknown
  /** What `workspace/configuration` answers, by section. */
  settings?: Record<string, unknown>
  /** File names that show a folder uses the language (`go.mod`), lower case; `*.csproj` matches the end. */
  markers?: string[]
  /** How eNCode installs it with one click, when it can. */
  installer?: ServerInstall
  /** What the folder adds to its settings and arguments, as it starts; null for nothing. Bounded and synchronous. */
  prepare?(context: PrepareContext): Prepared | null
}

const ts = { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact' }

const TS_HINTS = {
  includeInlayParameterNameHints: 'literals',
  includeInlayParameterNameHintsWhenArgumentMatchesName: false,
  includeInlayFunctionParameterTypeHints: true,
  includeInlayVariableTypeHints: true,
  includeInlayVariableTypeHintsWhenTypeMatchesName: false,
  includeInlayPropertyDeclarationTypeHints: true,
  includeInlayFunctionLikeReturnTypeHints: true,
  includeInlayEnumMemberValueHints: true,
}

const JDTLS = 'jdt-language-server-1.63.0-202610191322.tar.gz'

/**
 * Eclipse's Java server is a Java program: started with the Java found through JAVA_HOME or the PATH, its shared
 * settings read from where it was installed, its own settings and the project's index kept in eNCode's cache.
 */
function jdtlsLaunch(dir: string, context: LaunchContext): { file: string; args: string[]; command: string } | { missing: string } {
  const windows = context.platform === 'win32'
  const home = context.env.JAVA_HOME
  const fromHome = home ? path.join(home, 'bin', windows ? 'java.exe' : 'java') : null
  const java = fromHome && fs.existsSync(fromHome) ? fromHome : context.which('java')
  if (!java) return { missing: 'The Java language server needs Java 21 or newer, which was not found (JAVA_HOME, or java on the PATH). Install a JDK, such as Eclipse Temurin.' }
  let launcher: string | undefined
  try {
    launcher = fs.readdirSync(path.join(dir, 'plugins')).find((name) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name))
  } catch {
    launcher = undefined
  }
  if (!launcher) return { missing: 'The Java language server eNCode installed is incomplete. Install it again from Settings > Language servers.' }
  const arm = context.arch === 'arm64'
  const config = windows ? 'config_win' : context.platform === 'darwin' ? (arm ? 'config_mac_arm' : 'config_mac') : arm ? 'config_linux_arm' : 'config_linux'
  const project = createHash('sha256').update(context.root).digest('hex').slice(0, 16)
  const cache = path.join(context.cacheDir, 'jdtls')
  return {
    file: java,
    command: 'jdtls',
    args: [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dosgi.checkConfiguration=true',
      `-Dosgi.sharedConfiguration.area=${path.join(dir, config)}`,
      '-Dosgi.sharedConfiguration.area.readOnly=true',
      '-Dosgi.configuration.cascaded=true',
      '-Xms256m',
      '-Xmx2G',
      '--add-modules=ALL-SYSTEM',
      '--add-opens',
      'java.base/java.util=ALL-UNNAMED',
      '--add-opens',
      'java.base/java.lang=ALL-UNNAMED',
      '-jar',
      path.join(dir, 'plugins', launcher),
      '-configuration',
      path.join(cache, 'config'),
      '-data',
      path.join(cache, project),
    ],
  }
}

export const LANGUAGE_SERVERS: readonly ServerSpec[] = [
  {
    id: 'typescript',
    label: 'TypeScript and JavaScript',
    extensions: ts,
    candidates: [{ command: 'typescript-language-server', args: ['--stdio'] }],
    install: 'npm install -g typescript-language-server typescript@6',
    markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    installer: { kind: 'npm', lock: 'typescript', script: 'node_modules/typescript-language-server/lib/cli.mjs', args: ['--stdio'] },
    // Inlay hints are off in the server until asked for: the names of literal arguments, and the types it worked out
    // where none is written (a name that already says its type gets none).
    settings: { typescript: { inlayHints: TS_HINTS }, javascript: { inlayHints: TS_HINTS } },
    // The project's own TypeScript, when it has one, so that the errors are the ones its build reports.
    initializationOptions: (root, exists) => {
      const lib = path.join(root, 'node_modules', 'typescript', 'lib')
      return { hostInfo: 'eNCode', ...(exists(path.join(lib, 'tsserver.js')) ? { tsserver: { path: lib } } : {}) }
    },
  },
  {
    id: 'python',
    label: 'Python',
    extensions: { '.py': 'python', '.pyi': 'python' },
    candidates: [
      { command: 'basedpyright-langserver', args: ['--stdio'] },
      { command: 'pyright-langserver', args: ['--stdio'] },
      { command: 'pylsp', args: [] },
    ],
    install: 'npm install -g pyright (or pip install pyright)',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pipfile'],
    installer: { kind: 'npm', lock: 'python', script: 'node_modules/pyright/langserver.index.js', args: ['--stdio'] },
    settings: { python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' } } },
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: { '.rs': 'rust' },
    candidates: [{ command: 'rust-analyzer', args: [] }],
    install: 'rustup component add rust-analyzer',
    markers: ['cargo.toml'],
    installer: { kind: 'toolchain', program: 'rustup', args: ['component', 'add', 'rust-analyzer'], version: 'rustup', needs: 'Rust (rustup)' },
  },
  {
    id: 'go',
    label: 'Go',
    extensions: { '.go': 'go' },
    fileNames: { 'go.mod': 'go.mod' },
    candidates: [{ command: 'gopls', args: [] }],
    install: 'go install golang.org/x/tools/gopls@latest',
    markers: ['go.mod', 'go.work'],
    installer: { kind: 'toolchain', program: 'go', args: ['install', 'golang.org/x/tools/gopls@v0.24.0'], env: { GOBIN: '{dir}' }, version: '0.24.0', needs: 'Go', bin: 'gopls' },
    // gopls gives semantic tokens and hints only when asked to.
    settings: { gopls: { semanticTokens: true, hints: { assignVariableTypes: true, compositeLiteralFields: true, constantValues: true, functionTypeParameters: true, parameterNames: true, rangeVariableTypes: true } } },
  },
  {
    id: 'c',
    label: 'C and C++',
    extensions: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.ipp': 'cpp', '.m': 'objective-c', '.mm': 'objective-cpp' },
    candidates: [{ command: 'clangd', args: ['--background-index'] }],
    install: 'install clangd (it comes with LLVM: https://clangd.llvm.org/installation)',
    markers: ['compile_commands.json', 'cmakelists.txt', '.clangd', 'meson.build', '*.vcxproj'],
    installer: {
      kind: 'download',
      from: 'github.com/clangd/clangd',
      release: { github: 'clangd/clangd' },
      assets: {
        'win32-x64': { name: 'clangd-windows-{version}.zip', archive: 'zip', bin: 'bin/clangd.exe' },
        'linux-x64': { name: 'clangd-linux-{version}.zip', archive: 'zip', bin: 'bin/clangd' },
        'darwin-x64': { name: 'clangd-mac-{version}.zip', archive: 'zip', bin: 'bin/clangd' },
        'darwin-arm64': { name: 'clangd-mac-{version}.zip', archive: 'zip', bin: 'bin/clangd' },
      },
      args: ['--background-index'],
    },
  },
  {
    id: 'lua',
    label: 'Lua',
    extensions: { '.lua': 'lua' },
    candidates: [{ command: 'lua-language-server', args: [] }],
    install: 'install lua-language-server (https://luals.github.io/#install)',
    markers: ['fxmanifest.lua', '__resource.lua', '.luarc.json', '.luarc.jsonc'],
    installer: {
      kind: 'download',
      from: 'github.com/LuaLS/lua-language-server',
      release: { github: 'LuaLS/lua-language-server' },
      assets: {
        'win32-x64': { name: 'lua-language-server-{version}-win32-x64.zip', archive: 'zip', bin: 'bin/lua-language-server.exe' },
        'linux-x64': { name: 'lua-language-server-{version}-linux-x64.tar.gz', archive: 'tar', bin: 'bin/lua-language-server' },
        'linux-arm64': { name: 'lua-language-server-{version}-linux-arm64.tar.gz', archive: 'tar', bin: 'bin/lua-language-server' },
        'darwin-x64': { name: 'lua-language-server-{version}-darwin-x64.tar.gz', archive: 'tar', bin: 'bin/lua-language-server' },
        'darwin-arm64': { name: 'lua-language-server-{version}-darwin-arm64.tar.gz', archive: 'tar', bin: 'bin/lua-language-server' },
      },
      args: [],
    },
    settings: { Lua: { telemetry: { enable: false }, workspace: { checkThirdParty: false }, hint: { enable: true }, semantic: { enable: true } } },
    // FiveM's resources run CfxLua (Lua 5.4 with additions), with the runtime's globals and the natives.
    prepare: prepareLua,
  },
  {
    id: 'java',
    label: 'Java',
    extensions: { '.java': 'java' },
    candidates: [{ command: 'jdtls', args: [] }],
    install: 'install Eclipse JDT Language Server (https://github.com/eclipse-jdtls/eclipse.jdt.ls) and Java 21 or newer',
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    installer: {
      kind: 'download',
      from: 'download.eclipse.org/jdtls',
      release: { version: '1.63.0', base: 'https://download.eclipse.org/jdtls/milestones/1.63.0/', sha256: { [JDTLS]: 'b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4' } },
      assets: Object.fromEntries(['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].map((key) => [key, { name: JDTLS, archive: 'tar', bin: 'plugins' }])),
      args: [],
      needs: 'Java 21 or newer',
      launch: jdtlsLaunch,
    },
  },
  {
    id: 'csharp',
    label: 'C#',
    extensions: { '.cs': 'csharp', '.csx': 'csharp' },
    candidates: [{ command: 'csharp-ls', args: [] }],
    install: 'dotnet tool install --global csharp-ls',
    markers: ['*.csproj', '*.sln', '*.slnx', 'global.json'],
    installer: { kind: 'toolchain', program: 'dotnet', args: ['tool', 'install', 'csharp-ls', '--version', '0.28.0', '--tool-path', '{dir}'], version: '0.28.0', needs: 'the .NET SDK', bin: 'csharp-ls' },
  },
  {
    id: 'bash',
    label: 'Shell scripts',
    extensions: { '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript' },
    candidates: [{ command: 'bash-language-server', args: ['start'] }],
    install: 'npm install -g bash-language-server',
    installer: { kind: 'npm', lock: 'bash', script: 'node_modules/bash-language-server/out/cli.js', args: ['start'] },
  },
  {
    id: 'yaml',
    label: 'YAML',
    extensions: { '.yaml': 'yaml', '.yml': 'yaml' },
    candidates: [{ command: 'yaml-language-server', args: ['--stdio'] }],
    install: 'npm install -g yaml-language-server',
    installer: { kind: 'npm', lock: 'yaml', script: 'node_modules/yaml-language-server/bin/yaml-language-server', args: ['--stdio'] },
    settings: { yaml: { validate: true, hover: true, completion: true, schemaStore: { enable: false } } },
  },
]

/** Libraries eNCode installs for the servers above. */
export const LANGUAGE_LIBRARIES: readonly LibrarySpec[] = [FIVEM_NATIVES]

/** The server that covers a file, and the file's language id, or null when none does. */
export function serverFor(file: string, catalog: readonly ServerSpec[] = LANGUAGE_SERVERS): { spec: ServerSpec; languageId: string } | null {
  // Either separator: the file may be a Windows path read on another system, as in tests.
  const base = (file.split(/[\\/]/).pop() ?? file).toLowerCase()
  const extension = path.extname(base)
  for (const spec of catalog) {
    const byName = spec.fileNames?.[base]
    if (byName) return { spec, languageId: byName }
    const byExtension = extension ? spec.extensions[extension] : undefined
    if (byExtension) return { spec, languageId: byExtension }
  }
  return null
}
