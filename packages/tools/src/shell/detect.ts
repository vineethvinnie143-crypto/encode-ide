/**
 * Which shell runs the agent's commands.
 *
 * Windows: Git Bash first, because models write bash; PowerShell 7 when Git
 * is not installed; Windows PowerShell as a last resort. C:\Windows\System32\
 * bash.exe is WSL's launcher, not Git Bash, and is never used.
 * macOS and Linux: bash.
 *
 * ENCODE_SHELL names a shell explicitly (an absolute path to bash or pwsh). On Windows a caller may prefer
 * PowerShell: the sandbox can confine it and cannot confine Git Bash.
 */
import path from 'node:path'
import type { ShellDialect } from '../types'
import { envValue, isFile, searchPath, windowsSystemProgram } from './programs'

export interface ShellProgram {
  /** Absolute path. */
  file: string
  dialect: ShellDialect
  /** How it was found, for diagnostics. */
  source: 'setting' | 'git' | 'standard' | 'path' | 'windows-powershell'
}

type Env = Record<string, string | undefined>

function dialectOf(file: string): ShellDialect | undefined {
  const name = path.win32.basename(file).toLowerCase()
  if (name === 'bash' || name === 'bash.exe') return 'bash'
  if (name === 'pwsh' || name === 'pwsh.exe' || name === 'powershell.exe') return 'pwsh'
  return undefined
}

function isWslLauncher(file: string): boolean {
  return /[\\/]windows[\\/](system32|sysnative)[\\/]bash\.exe$/i.test(file)
}

/** Git Bash next to a git.exe on PATH: <Git>\cmd\git.exe, <Git>\bin\git.exe or <Git>\mingw64\bin\git.exe. */
function gitBashFromGit(env: Env): string | undefined {
  const git = searchPath('git', env, 'win32')
  if (!git) return undefined
  let dir = path.win32.dirname(git)
  for (let depth = 0; depth < 3; depth++) {
    const candidate = path.win32.join(dir, 'bin', 'bash.exe')
    if (isFile(candidate) && !isWslLauncher(candidate)) return candidate
    dir = path.win32.dirname(dir)
  }
  return undefined
}

function standardLocations(env: Env, names: string[][]): string[] {
  const roots = [envValue(env, 'ProgramFiles', 'win32'), envValue(env, 'ProgramW6432', 'win32'), envValue(env, 'ProgramFiles(x86)', 'win32')]
  const local = envValue(env, 'LOCALAPPDATA', 'win32')
  const out: string[] = []
  for (const parts of names) {
    for (const root of roots) if (root) out.push(path.win32.join(root, ...parts))
    if (local) out.push(path.win32.join(local, 'Programs', ...parts))
  }
  return out
}

function powerShell(env: Env): ShellProgram | undefined {
  const pwshOnPath = searchPath('pwsh', env, 'win32')
  if (pwshOnPath) return { file: pwshOnPath, dialect: 'pwsh', source: 'path' }
  const pwsh = standardLocations(env, [['PowerShell', '7', 'pwsh.exe'], ['PowerShell', '7-preview', 'pwsh.exe']]).find(isFile)
  if (pwsh) return { file: pwsh, dialect: 'pwsh', source: 'standard' }
  const windowsPowerShell = windowsSystemProgram(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return isFile(windowsPowerShell) ? { file: windowsPowerShell, dialect: 'pwsh', source: 'windows-powershell' } : undefined
}

export function detectShell(env: Env = process.env, platform: NodeJS.Platform = process.platform, prefer?: ShellDialect): ShellProgram | undefined {
  const configured = envValue(env, 'ENCODE_SHELL', platform)?.trim()
  if (configured) {
    const dialect = dialectOf(configured)
    if (dialect && isFile(configured) && !isWslLauncher(configured)) return { file: configured, dialect, source: 'setting' }
  }

  if (platform !== 'win32') {
    const bash = searchPath('bash', env, platform) ?? ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find(isFile)
    if (bash) return { file: bash, dialect: 'bash', source: 'path' }
    const pwsh = searchPath('pwsh', env, platform)
    return pwsh ? { file: pwsh, dialect: 'pwsh', source: 'path' } : undefined
  }

  if (prefer === 'pwsh') {
    const preferred = powerShell(env)
    if (preferred) return preferred
  }
  const fromGit = gitBashFromGit(env)
  if (fromGit) return { file: fromGit, dialect: 'bash', source: 'git' }
  const gitBash = standardLocations(env, [['Git', 'bin', 'bash.exe']]).find(isFile)
  if (gitBash) return { file: gitBash, dialect: 'bash', source: 'standard' }
  return powerShell(env)
}
