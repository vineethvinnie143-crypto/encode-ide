/**
 * `encode`: what the command line was asked, and which way it goes. Help and the version need nothing; `sessions`
 * lists this folder's sessions; a request on a pipe, or `-p`, is print mode (print.ts); anything else is the prompt
 * (repl.ts). Everything a run touches comes in through `MainIo`, so tests run it whole.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createDemoClient } from '@encode/core'
import { redactSecrets } from '@encode/providers'
import type { ServerTools } from '@encode/workspace'
import { USAGE, UsageError, parseArgs, type CliOptions } from './args'
import { chooseModel } from './model'
import { runPrint } from './print'
import { runRepl } from './repl'
import { openRuntime } from './runtime'
import { folderSessions, sessionLine, settingsFor } from './session'
import { plain, styleFor } from './text'
import { VERSION } from './version'

export interface MainIo {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: NodeJS.WritableStream & { isTTY?: boolean }
  home?: string
  platform?: NodeJS.Platform
  /** For tests: where the command line keeps its sessions. */
  profile?: string
  /** eNCode's language servers: the app's tools folder and what runs them. */
  tools?: ServerTools
  /** Standard input is a pipe or a file: what is on it is meant for eNCode, however long it takes to come. */
  stdinIsPipe?: boolean
  /** Called with what Ctrl+C does; returns a function that stops listening. */
  onInterrupt(handler: () => void): () => void
}

/** The most a pipe may bring: a request, not a repository. */
export const STDIN_LIMIT = 4 * 1024 * 1024
export const FREE_WARNING = "OpenRouter's free models may keep what they are sent: keep secrets and private code out."

/**
 * Everything on standard input, as text, up to `limit` bytes. With `quietMs`, input that brings nothing at all in that
 * time is not waited for: a program that starts eNCode with a request often leaves its input open and silent.
 */
export function readAll(stream: NodeJS.ReadableStream, options: { limit?: number; quietMs?: number } = {}): Promise<string> {
  const limit = options.limit ?? STDIN_LIMIT
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      if (error) return reject(error)
      resolve(Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/, ''))
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limit) {
        stream.pause()
        return finish(new UsageError(`standard input is over ${limit / 1024 / 1024} MB; give eNCode the file's path instead`))
      }
      chunks.push(buffer)
    }
    const onEnd = () => finish()
    const onError = (error: Error) => finish(error)
    const timer =
      options.quietMs === undefined
        ? undefined
        : setTimeout(() => {
            if (size > 0) return
            stream.pause()
            finish()
          }, options.quietMs)
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
  })
}

/** How long a request given in words waits for its input to say anything, when the input is not a pipe or a file. */
export const QUIET_INPUT_MS = 1_000

/** The request a run starts with: the words given, then what came on the pipe. */
export function requestText(words: string, piped: string): string {
  const input = piped.replace(/\s+$/, '')
  if (!input.trim()) return words
  return words ? `${words}\n\n${input}` : input
}

export async function main(io: MainIo): Promise<number> {
  const errStyle = styleFor(Boolean(io.stderr.isTTY), io.env)
  let secrets: string[] = []
  const fail = (message: string) => void io.stderr.write(`${errStyle.red('encode:')} ${redactSecrets(plain(message), secrets)}\n`)
  let options: CliOptions
  try {
    options = parseArgs(io.argv, io.env)
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\nencode --help lists the options.`)
    return 2
  }
  if (options.command === 'help') {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (options.command === 'version') {
    io.stdout.write(`eNCode ${VERSION}\n`)
    return 0
  }

  try {
    const root = path.resolve(io.cwd, options.cwd ?? '.')
    const stat = await fs.stat(root).catch(() => null)
    if (!stat?.isDirectory()) throw new UsageError(`${root} is not a folder`)
    const shared = {
      ...(io.home ? { home: io.home } : {}),
      ...(io.platform ? { platform: io.platform } : {}),
      ...(io.profile ? { profile: io.profile } : {}),
      ...(io.tools ? { tools: io.tools } : {}),
    }

    if (options.command === 'sessions') {
      const runtime = await openRuntime({ root, ...shared, env: io.env, client: createDemoClient(), settings: () => settingsFor(options), emit: () => {}, sandbox: false, nameSessions: false, warn: () => {} })
      try {
        const sessions = await folderSessions(runtime.host, runtime.root)
        if (!sessions.length) io.stdout.write(`No sessions in ${plain(runtime.root)} yet.\n`)
        for (const session of sessions) io.stdout.write(`${sessionLine(session)}\n`)
      } finally {
        await runtime.close()
      }
      return 0
    }

    // Nobody can answer at a prompt that reads from a pipe: a request that comes on one is a print-mode request.
    const piped = !io.stdin.isTTY
    const print = options.print || piped
    const quiet = options.prompt && !io.stdinIsPipe ? { quietMs: QUIET_INPUT_MS } : {}
    const prompt = requestText(options.prompt, piped ? await readAll(io.stdin, quiet) : '')
    if (print && !prompt.trim()) throw new UsageError('print mode needs a request: encode -p "what to do", or one on standard input')

    const warn = (text: string) => void io.stderr.write(`${errStyle.dim(`encode: ${plain(text)}`)}\n`)
    const model = await chooseModel(options.model, options.baseUrl, io.env, warn)
    secrets = model.secrets
    if (print) {
      if (model.free) warn(FREE_WARNING)
      return await runPrint(options, prompt, model, root, {
        stdout: (text) => void io.stdout.write(text),
        stderr: (text) => void io.stderr.write(text),
        stderrTty: Boolean(io.stderr.isTTY),
        env: io.env,
        ...shared,
        onInterrupt: io.onInterrupt,
      })
    }
    return await runRepl(options, prompt, model, root, { input: io.stdin, output: io.stdout, env: io.env, ...shared, onInterrupt: io.onInterrupt })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return error instanceof UsageError ? 2 : 1
  }
}
