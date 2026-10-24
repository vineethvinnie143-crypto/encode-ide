/**
 * The `encode` program: this process's input, output and signals, handed to main.ts. In the Windows build it runs
 * inside the app's own executable, which `encode.cmd` starts as Node (ELECTRON_RUN_AS_NODE). That variable is taken
 * out first, so the agent's commands, and any Electron app they start, run as themselves.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerTools } from '@encode/workspace'
import { main } from './main'
import { cliProfile, desktopProfile } from './runtime'

delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.NODE_TEST_CONTEXT

/** The servers the app installed, run by the same Node.js the app uses; and eNCode's own, beside this file in the build. */
function serverTools(): ServerTools {
  const home = os.homedir()
  const here = typeof __dirname === 'string' ? __dirname : undefined
  const builtin = here && fs.existsSync(path.join(here, 'weblang-server.cjs')) ? here : undefined
  return {
    dir: path.join(desktopProfile(home, process.platform, process.env), 'tools'),
    cacheDir: path.join(cliProfile(home), 'server-cache'),
    node: { file: process.execPath, ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) },
    ...(builtin ? { builtinDir: builtin } : {}),
  }
}

/** Standard input is a pipe (`git diff | encode -p ...`) or a file (`encode -p ... < notes.txt`). */
function stdinIsPipe(): boolean {
  try {
    const stat = fs.fstatSync(0)
    return stat.isFIFO() || stat.isFile()
  } catch {
    return false
  }
}

/** Ctrl+C goes to the handler; a second one within a moment leaves at once. */
function onInterrupt(handler: () => void): () => void {
  let last = 0
  const listener = () => {
    const now = Date.now()
    if (now - last < 1_500) process.exit(130)
    last = now
    handler()
  }
  process.on('SIGINT', listener)
  return () => process.off('SIGINT', listener)
}

// `encode -p ... | head` closes the pipe early; that is the reader's choice, not a failure.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0)
    throw error
  })
}

/** Leaves once what was written has reached its reader; a server or socket left open does not hold the program. */
function leave(code: number): void {
  process.exitCode = code
  let waiting = 2
  const done = () => {
    if (--waiting === 0) process.exit(code)
  }
  process.stdout.write('', done)
  process.stderr.write('', done)
  setTimeout(() => process.exit(code), 5_000).unref()
}

main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  tools: serverTools(),
  stdinIsPipe: stdinIsPipe(),
  onInterrupt,
}).then(leave, (error: unknown) => {
  process.stderr.write(`encode: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  leave(1)
})
