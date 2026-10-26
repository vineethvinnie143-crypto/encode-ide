/**
 * The names Node.js gives the code it runs, and the files they are: a CommonJS module is named by its path, an ES
 * module by its `file:` URL, Node.js's own code by `node:…`. A breakpoint by name matches both spellings of a file.
 */
import path from 'node:path'
import { documentKey, pathToUri, uriToPath } from '@encode/lsp'

/** The file a script's name stands for, or null for code that is not a file. */
export function scriptPath(url: string, platform: NodeJS.Platform): string | null {
  if (!url) return null
  if (/^file:/i.test(url)) return uriToPath(url, platform)
  if (platform === 'win32') return /^[A-Za-z]:[\\/]|^\\\\[^\\]/.test(url) ? path.win32.normalize(url) : null
  return url.startsWith('/') ? path.posix.normalize(url) : null
}

/** A script name as a URL, for resolving what it names relative to it (its source map). */
export function scriptUrl(url: string, platform: NodeJS.Platform): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[A-Za-z]:[\\/]/.test(url)) return url
  const file = scriptPath(url, platform)
  return file ? pathToUri(file, platform) : null
}

/** One key per file, however it is spelled. */
export const fileKey = (file: string, platform: NodeJS.Platform): string => documentKey(file, platform)

const SPECIAL = /[\\^$.*+?()[\]{}|/-]/

/** A character as a regular expression: itself (any case on Windows, letters only), or its percent-encoding. */
function charPattern(char: string, windows: boolean): string {
  if (/[A-Za-z]/.test(char)) return windows && char.toLowerCase() !== char.toUpperCase() ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char
  if (/[0-9_]/.test(char)) return char
  const literal = SPECIAL.test(char) ? `\\${char}` : char
  const encoded = [...Buffer.from(char, 'utf8')].map((byte) => {
    const hex = byte.toString(16).toUpperCase().padStart(2, '0')
    return `%${/[A-F]/.test(hex) ? hex.replace(/[A-F]/g, (letter) => `[${letter}${letter.toLowerCase()}]`) : hex}`
  })
  return `(?:${literal}|${encoded.join('')})`
}

/**
 * The `urlRegex` of a breakpoint by file: the file's path as a CommonJS module is named, and its `file:` URL as an ES
 * module is, with any character percent-encoded or not, and on Windows in any case with either slash.
 */
export function breakpointUrlRegex(file: string, platform: NodeJS.Platform): string {
  const windows = platform === 'win32'
  const normal = windows ? path.win32.normalize(file) : path.posix.normalize(file)
  let body = ''
  for (const char of normal) body += char === '/' || (windows && char === '\\') ? '[\\\\/]' : charPattern(char, windows)
  return windows ? `^(?:[fF][iI][lL][eE]:///)?${body}$` : `^(?:file://)?${body}$`
}

const JS_FILE = /\.(?:[cm]?js|jsx)$/i
const TS_FILE = /\.(?:[cm]?ts|tsx)$/i

/** A file Node.js runs as it is written: a breakpoint by its name lands where it is set. */
export const isScriptFile = (file: string): boolean => JS_FILE.test(file)

/** A file Node.js runs only after something turns it into JavaScript. */
export const isTypeScriptFile = (file: string): boolean => TS_FILE.test(file)
