/**
 * A command that failed because something it named is not there (ADR 0140): a program that is not installed, an
 * option the program does not take, a script the project does not have, a module or a name a library does not have.
 * A smaller model then guesses another spelling, and another. The result says what was not found and how to look up
 * what is there, at the version installed, before it tries again.
 */

export type UnknownKind = 'command' | 'option' | 'script' | 'module' | 'member'

export interface Unknown {
  kind: UnknownKind
  /** What was not found: the program, the option, the script, the module or the member. */
  name: string
  /** The program an option was given to, as far as the command says (`git commit`). */
  program?: string
  /** What a member was looked for on (a module, a type), when the error says. */
  owner?: string
}

/** The end of an output is read: errors come last. */
const TAIL_CHARS = 6_000

const NAME = String.raw`[\w@./:+-]+`
const MATCHERS: ReadonlyArray<{ kind: UnknownKind; pattern: RegExp; name: number; owner?: number }> = [
  // bash: foo: command not found; sh: 1: foo: not found; /bin/sh: line 1: foo: not found
  { kind: 'command', pattern: new RegExp(String.raw`(?:^|\n)\S*(?:sh|bash|dash)(?:: line \d+)?(?:: \d+)?: (${NAME}): (?:command )?not found`), name: 1 },
  { kind: 'command', pattern: new RegExp(String.raw`(?:^|\n)zsh: command not found: (${NAME})`), name: 1 },
  { kind: 'command', pattern: new RegExp(String.raw`'(${NAME})' is not recognized as an internal or external command`), name: 1 },
  { kind: 'command', pattern: new RegExp(String.raw`The term '(${NAME})' is not recognized as (?:the )?name of a cmdlet`), name: 1 },
  // npm, pnpm and yarn
  { kind: 'script', pattern: /Missing script: "?([\w:.-]+)"?/i, name: 1 },
  { kind: 'script', pattern: /error Command "([\w:.-]+)" not found/, name: 1 },
  // getopt, argparse, commander, click, clap, cobra, Go's flag
  { kind: 'option', pattern: /(?:unrecognized|unknown|invalid) option(?: -- |: | )['"`]?(-{1,2}[\w-]+|[\w])['"`]?/i, name: 1 },
  { kind: 'option', pattern: /unrecognized arguments?: (-{1,2}[\w-]+)/i, name: 1 },
  { kind: 'option', pattern: /unknown (?:flag|shorthand flag): ['"]?(-{1,2}[\w-]+)/i, name: 1 },
  { kind: 'option', pattern: /unexpected argument '(-{1,2}[\w-]+)' found/i, name: 1 },
  { kind: 'option', pattern: /No such option: (-{1,2}[\w-]+)/, name: 1 },
  { kind: 'option', pattern: /flag provided but not defined: (-{1,2}[\w-]+)/, name: 1 },
  // Python
  { kind: 'member', pattern: /ImportError: cannot import name '(\w+)' from '([\w.]+)'/, name: 1, owner: 2 },
  { kind: 'module', pattern: /ModuleNotFoundError: No module named '([\w.]+)'/, name: 1 },
  { kind: 'member', pattern: /AttributeError: (?:module )?'([\w.]+)'(?: object)? has no attribute '(\w+)'/, name: 2, owner: 1 },
  // TypeScript, before Node: tsc says "Cannot find module" too
  { kind: 'member', pattern: /error TS2305: Module '"?([^'"]+)"?' has no exported member '(\w+)'/, name: 2, owner: 1 },
  { kind: 'member', pattern: /error TS2724: '"?([^'"]+)"?' has no exported member named '(\w+)'/, name: 2, owner: 1 },
  { kind: 'member', pattern: /error TS2339: Property '(\w+)' does not exist on type '([^']{1,80})'/, name: 1, owner: 2 },
  { kind: 'module', pattern: /error TS2307: Cannot find module '([^'./][^']*)'/, name: 1 },
  // Node
  { kind: 'module', pattern: /Cannot find (?:module|package) '([^'./][^']*)'/, name: 1 },
  { kind: 'member', pattern: /TypeError: ([\w.$]+)\.(\w+) is not a function/, name: 2, owner: 1 },
  // Ruby, Rust, Go
  { kind: 'member', pattern: /undefined method [`'](\w+[?!]?)' for/, name: 1 },
  { kind: 'member', pattern: /error\[E0599\]: no (?:method|function or associated item) named `(\w+)` found for (?:\w+ )?`([^`]{1,80})`/, name: 1, owner: 2 },
  { kind: 'module', pattern: /error\[E0432\]: unresolved import `([\w:]+)`/, name: 1 },
  { kind: 'member', pattern: /(?:^|\n)\S+\.go:\d+:\d+: undefined: (\w+)\.(\w+)/, name: 2, owner: 1 },
]

/** Words before the program that are not it: variables set for one command, and the runners in front of it. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'npx', 'pnpx', 'bunx', 'exec', 'nohup', 'command'])

/** The program an option went to: the part of the command that has the option, up to its first option. */
function programOf(command: string, option: string): string | undefined {
  const parts = command.split(/&&|\|\||[|;\n]/)
  const part = parts.find((text) => text.includes(option)) ?? parts[0] ?? ''
  const words = part.trim().split(/\s+/).filter(Boolean)
  while (words.length && (WRAPPERS.has(words[0]!) || /^\w+=/.test(words[0]!))) words.shift()
  const program: string[] = []
  for (let index = 0; index < words.length && program.length < 3; index++) {
    const word = words[index]!
    if (word === '-m' && program.length === 1 && words[index + 1]) {
      program.push(word, words[++index]!)
      continue
    }
    if (word.startsWith('-') || /["'`$<>]/.test(word) || (program.length > 0 && /[./\\]/.test(word))) break
    program.push(word)
  }
  return program.length ? program.join(' ') : undefined
}

/** What a failed command's output says was not there, if anything. */
export function unknownIn(command: string, output: string): Unknown | undefined {
  const tail = output.length > TAIL_CHARS ? output.slice(-TAIL_CHARS) : output
  for (const matcher of MATCHERS) {
    const match = matcher.pattern.exec(tail)
    if (!match) continue
    const name = match[matcher.name]!
    const owner = matcher.owner ? match[matcher.owner] : undefined
    if (matcher.kind === 'option') {
      const program = programOf(command, name)
      return { kind: 'option', name, ...(program ? { program } : {}) }
    }
    return { kind: matcher.kind, name, ...(owner ? { owner } : {}) }
  }
  return undefined
}

/** What the agent is told with the failed command's result. */
export function lookUpNote(unknown: Unknown, options: { platform: NodeJS.Platform; codeMap: boolean }): string {
  const code = (text: string) => `\`${text.replace(/`/g, "'")}\``
  const name = code(unknown.name)
  const after = "Don't guess another spelling or another name."
  switch (unknown.kind) {
    case 'command': {
      const where = options.platform === 'win32' ? `\`where.exe ${unknown.name}\`` : `\`command -v ${unknown.name}\``
      return `eNCode: ${name} is not installed here, or not on the PATH (${where} says which). Use what is installed instead: the project's scripts (package.json, Makefile, pyproject.toml and the like) name the commands it uses. Install it only when the task needs it. ${after}`
    }
    case 'option': {
      const program = unknown.program ?? 'the program'
      const help = unknown.program ? ` (\`${unknown.program} --help\`)` : ''
      return `eNCode: ${code(program)} here does not take ${name}. Before you try again, read what this version takes${help}. ${after}`
    }
    case 'script':
      return `eNCode: the project has no ${name} script. Read the scripts it has (package.json's "scripts") before you run another. ${after}`
    case 'module':
      return `eNCode: ${name} is not installed where this ran, or not under that name. Check what is installed (the manifest and lockfile, \`pip show\`, \`npm ls\`, \`cargo tree\`) and how the project already imports it (Grep) before you try again. ${after}`
    case 'member': {
      const owner = unknown.owner ? code(unknown.owner) : 'It'
      const lookUp = options.codeMap
        ? 'CodeMap with package (the dependency) and symbol or query, Grep in its installed folder, or the project for where it is defined'
        : 'its installed source or type declarations, or Grep in the project for where it is defined'
      return `eNCode: ${owner} has no ${name} at the version this ran with. Look up what it has before you try again: ${lookUp}. ${after}`
    }
  }
}
