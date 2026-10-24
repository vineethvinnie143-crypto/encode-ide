/**
 * The programs a task's checks run, found on this machine the way a person's shell would find them. A program that
 * is missing skips the tasks that need it rather than failing them: a missing Lua says nothing about the agent.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { Program } from './task'

/** The words that start the program: `py -3` is one program on Windows. */
export type Programs = Partial<Record<Program, string[]>>

/** Variables a program needs to run as itself, such as ELECTRON_RUN_AS_NODE for the app's own Node.js. */
export type ProgramEnv = Partial<Record<Program, Record<string, string>>>

const CANDIDATES: Record<Exclude<Program, 'node'>, { win32: string[][]; other: string[][]; version: RegExp; flag: string }> = {
  // `python3` on Windows can be the Store's stand-in, which opens the Store: py and python come first there.
  python: { win32: [['py', '-3'], ['python'], ['python3']], other: [['python3'], ['python']], version: /^Python 3\.\d+/m, flag: '--version' },
  lua: { win32: [['lua54'], ['lua'], ['luajit']], other: [['lua5.4'], ['lua'], ['luajit']], version: /^Lua(?:JIT)? \d/m, flag: '-v' },
}

function answers(words: string[], flag: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(words[0]!, [...words.slice(1), flag], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => child.kill(), 5_000)
    const take = (chunk: Buffer) => {
      if (out.length < 1_000) out += chunk.toString('utf8')
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out : '')
    })
  })
}

/** The first candidate for each program that answers with its version; Node.js is always the one running this. */
export async function findPrograms(wanted: Iterable<Program>, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<Programs> {
  const found: Programs = { node: [process.execPath] }
  for (const program of new Set(wanted)) {
    if (program === 'node') continue
    const spec = CANDIDATES[program]
    for (const words of platform === 'win32' ? spec.win32 : spec.other) {
      if (spec.version.test(await answers(words, spec.flag, env))) {
        found[program] = words
        break
      }
    }
  }
  return found
}
