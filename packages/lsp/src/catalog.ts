/**
 * The language servers eNCode knows how to start, by the files they cover. Each is a separate program the person
 * installs (ADR 0072): eNCode carries none of them and none comes from VS Code's sources, so the JSON, CSS and HTML
 * servers extracted from VS Code are not here. A server is found in the project's own `node_modules/.bin` first, then
 * on the PATH; the first candidate found is the one used.
 */
import path from 'node:path'

export interface ServerCandidate {
  /** The program's name, without `.exe` or `.cmd`. */
  command: string
  args: string[]
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

export const LANGUAGE_SERVERS: readonly ServerSpec[] = [
  {
    id: 'typescript',
    label: 'TypeScript and JavaScript',
    extensions: ts,
    candidates: [{ command: 'typescript-language-server', args: ['--stdio'] }],
    install: 'npm install -g typescript-language-server typescript',
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
    settings: { python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' } } },
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: { '.rs': 'rust' },
    candidates: [{ command: 'rust-analyzer', args: [] }],
    install: 'rustup component add rust-analyzer',
  },
  {
    id: 'go',
    label: 'Go',
    extensions: { '.go': 'go' },
    fileNames: { 'go.mod': 'go.mod' },
    candidates: [{ command: 'gopls', args: [] }],
    install: 'go install golang.org/x/tools/gopls@latest',
    // gopls gives semantic tokens and hints only when asked to.
    settings: { gopls: { semanticTokens: true, hints: { assignVariableTypes: true, compositeLiteralFields: true, constantValues: true, functionTypeParameters: true, parameterNames: true, rangeVariableTypes: true } } },
  },
  {
    id: 'c',
    label: 'C and C++',
    extensions: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.ipp': 'cpp', '.m': 'objective-c', '.mm': 'objective-cpp' },
    candidates: [{ command: 'clangd', args: ['--background-index'] }],
    install: 'install clangd (it comes with LLVM: https://clangd.llvm.org/installation)',
  },
  {
    id: 'lua',
    label: 'Lua',
    extensions: { '.lua': 'lua' },
    candidates: [{ command: 'lua-language-server', args: [] }],
    install: 'install lua-language-server (https://luals.github.io/#install)',
    // FiveM's resources run Lua 5.4 with CfxLua's additions; its natives are globals the server cannot know.
    settings: { Lua: { runtime: { version: 'Lua 5.4' }, telemetry: { enable: false }, workspace: { checkThirdParty: false }, hint: { enable: true }, semantic: { enable: true } } },
  },
  {
    id: 'csharp',
    label: 'C#',
    extensions: { '.cs': 'csharp', '.csx': 'csharp' },
    candidates: [{ command: 'csharp-ls', args: [] }],
    install: 'dotnet tool install --global csharp-ls',
  },
  {
    id: 'bash',
    label: 'Shell scripts',
    extensions: { '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript' },
    candidates: [{ command: 'bash-language-server', args: ['start'] }],
    install: 'npm install -g bash-language-server',
  },
  {
    id: 'yaml',
    label: 'YAML',
    extensions: { '.yaml': 'yaml', '.yml': 'yaml' },
    candidates: [{ command: 'yaml-language-server', args: ['--stdio'] }],
    install: 'npm install -g yaml-language-server',
    settings: { yaml: { validate: true, hover: true, completion: true, schemaStore: { enable: false } } },
  },
]

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
