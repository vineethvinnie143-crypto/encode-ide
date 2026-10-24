/**
 * Fix this folder (ADR 0118): gives the person's own account Full control of a folder Windows would not let the
 * sandbox mark, after Windows asks for an administrator's yes.
 *
 * Marking a folder with the low integrity level needs the right to change its owner (WRITE_OWNER), and plain Modify
 * does not include it. A folder an administrator made, often on a second drive, gives the person only Modify. An
 * elevated icacls adds one entry for the person's account, inherited by what is inside. If even an administrator may
 * not change the folder's permissions, the account that said yes takes ownership of the folder first (takeown, which an
 * administrator may always do), and adds the entry as its owner. Nothing else on the computer changes.
 *
 * The scripts are built here as pure functions: the folder and the account reach the elevated program as base64 inside
 * a constant script, so no quoting of a shell or a command line is involved, and Windows' own icacls does the change.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { GrantOutcome } from '../engine'
import { runHelper, type Finished } from './client'

export interface GrantOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** Runs a program to the end. Default: the helper's runner. */
  run?(file: string, args: readonly string[], timeoutMs: number): Promise<Finished>
  /** How long the whole step may take, the person's answer to Windows included. */
  timeoutMs?: number
  /** A file the elevated step writes icacls' words into, read back for a failure and then removed. */
  log: string
  /** Reads that file and removes it. Default: from the disk. */
  takeLog?(file: string): Promise<string>
}

/** The person said no to Windows (ERROR_CANCELLED). */
export const CANCELLED = 1223
/** Codes of the elevated step: the entry could not be added, ownership could not be taken. */
export const GRANT_FAILED = 11
export const OWNER_FAILED = 12
/** The elevated step added the entry only after taking ownership of the folder. */
export const GRANTED_AS_OWNER = 3
/** PowerShell itself failed before or after Windows was asked. */
const LAUNCH_FAILED = 20

const SID = /^S-1-\d+(-\d+)+$/

/** Why this folder cannot be fixed this way, or nothing. A local folder by its full path, as the sandbox named it. */
export function grantProblem(folder: string): string | undefined {
  if (!/^[a-z]:\\/i.test(folder) || !path.win32.isAbsolute(folder)) return 'Only a folder on one of this computer’s drives can be fixed this way.'
  if (/[\u0000-\u001f"<>|?*:]/.test(folder.slice(2))) return 'That is not a folder name Windows allows.'
  if (/^[a-z]:\\*$/i.test(folder)) return 'A whole drive is never given to the sandbox.'
  // Both scripts travel on one command line, which Windows keeps under 32,767 characters.
  if (folder.length > 1024) return 'That folder’s path is too long to fix this way.'
  return undefined
}

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
/** What `powershell -EncodedCommand` takes: the script as UTF-16LE in base64. */
export const encodeCommand = (script: string) => Buffer.from(script, 'utf16le').toString('base64')

/**
 * The script that runs elevated. It adds an allow entry for `sid` (Full control, inherited by folders and files inside)
 * and, only if Windows refuses that, takes ownership of the folder and adds the entry as its owner. What icacls and
 * takeown say goes to `log`.
 */
export function elevatedScript(folder: string, sid: string, log: string): string {
  if (!SID.test(sid)) throw new Error(`Not an account's SID: ${sid}`)
  return [
    "$ErrorActionPreference = 'Continue'",
    `$folder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(folder)}'))`,
    `$log = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(log)}'))`,
    `$sid = '${sid}'`,
    "$icacls = Join-Path $env:SystemRoot 'System32\\icacls.exe'",
    "$takeown = Join-Path $env:SystemRoot 'System32\\takeown.exe'",
    'function Say($text) { try { Add-Content -LiteralPath $log -Value $text -Encoding UTF8 } catch {} }',
    'function AddEntry() { $said = & $icacls $folder /grant "*${sid}:(OI)(CI)F" 2>&1 | Out-String; Say $said; return $LASTEXITCODE }',
    'if ((AddEntry) -eq 0) { exit 0 }',
    '$said = & $takeown /F $folder 2>&1 | Out-String',
    'Say $said',
    `if ($LASTEXITCODE -ne 0) { exit ${OWNER_FAILED} }`,
    `if ((AddEntry) -eq 0) { exit ${GRANTED_AS_OWNER} }`,
    `exit ${GRANT_FAILED}`,
  ].join('\n')
}

/**
 * The script that runs as the person: it asks Windows to start the elevated one (the UAC prompt) and waits for it.
 * Saying no, or closing the prompt, ends it with CANCELLED.
 */
export function launcherScript(elevated: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$shell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodeCommand(elevated)}'`,
    'try {',
    '  $process = Start-Process -FilePath $shell -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru',
    '} catch {',
    '  $e = $_.Exception',
    `  while ($e) { if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${CANCELLED}) { exit ${CANCELLED} }; $e = $e.InnerException }`,
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    `  exit ${LAUNCH_FAILED}`,
    '}',
    // Without the handle kept, PowerShell 5.1 may lose the exit code of a program it started this way.
    '$null = $process.Handle',
    '$process.WaitForExit()',
    'exit $process.ExitCode',
  ].join('\n')
}

const system32 = (env: Readonly<Record<string, string | undefined>>, ...parts: string[]) =>
  path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', ...parts)

/** The person's own account, as `whoami` names it. */
export async function currentSid(options: Pick<GrantOptions, 'env' | 'run'> = {}): Promise<string> {
  const run = options.run ?? runHelper
  const done = await run(system32(options.env ?? process.env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], 15_000)
  const sid = done.stdout.match(/"(S-1-\d+(?:-\d+)+)"/)?.[1]
  if (done.code !== 0 || !sid) throw new Error(`Windows did not say which account this is. ${done.stderr.trim().split(/\r?\n/)[0] ?? ''}`.trim())
  return sid
}

/** Asks Windows for an administrator's yes, then gives the person's account Full control of `folder`. */
export async function grantFolder(folder: string, options: GrantOptions): Promise<GrantOutcome> {
  const problem = grantProblem(folder)
  if (problem) return { ok: false, reason: problem }
  const env = options.env ?? process.env
  const run = options.run ?? runHelper
  const target = folder.replace(/\\+$/, '')
  let sid: string
  try {
    sid = await currentSid({ env, run })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const { log } = options
  const takeLog = options.takeLog ?? readAndRemove
  await takeLog(log).catch(() => '')
  const script = launcherScript(elevatedScript(target, sid, log))
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)]
  const done = await run(system32(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, options.timeoutMs ?? 8 * 60_000)
  const said = await takeLog(log).catch(() => '')
  if (done.code === 0) return { ok: true, owner: false }
  if (done.code === GRANTED_AS_OWNER) return { ok: true, owner: true }
  if (done.code === CANCELLED) return { ok: false, cancelled: true }
  const words = lastWords(said) ?? lastWords(done.stderr)
  const because = words ? ` Windows said: ${words}` : ''
  if (done.code === null) return { ok: false, reason: `Windows did not answer in time, so ${target} may be as it was.${because}` }
  if (done.code === OWNER_FAILED || done.code === GRANT_FAILED) {
    return { ok: false, reason: `Windows did not let an administrator change the permissions of ${target}.${because}` }
  }
  return { ok: false, reason: `Windows could not be asked for an administrator (code ${done.code}).${because}` }
}

async function readAndRemove(file: string): Promise<string> {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  await fs.rm(file, { force: true }).catch(() => undefined)
  return text.replace(/^\uFEFF/, '')
}

/** The last line that says something, without icacls' tally of files processed. */
function lastWords(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Successfully processed \d+ files?; Failed processing \d+ files?$/i.test(line))
  return lines.pop()?.slice(0, 300)
}
