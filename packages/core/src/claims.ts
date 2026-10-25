/**
 * The claim check (ADR 0095): before the agent's last reply of a request reaches the person, eNCode reads it for three
 * claims it can test against the project, and sends the agent back once when one does not hold:
 *
 * - the tests (or the typecheck, or the build) pass, while no command that checks the code passed since its last change;
 * - a file by a path that does not exist, and that nothing in the session named;
 * - a name in a file ("added `validateToken()` to `src/auth.ts`") that the file does not contain.
 *
 * Each is read conservatively: a hedged sentence ("should pass", "run the tests to confirm") claims nothing, and a
 * sentence about removing or renaming says nothing about what a file holds now. The same reading finds an answer that
 * leaves a check to the person (ADR 0126).
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** The reply's sentences, with code spans kept whole. */
function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z`*_(])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

const CLAIMS = [
  /\b(?:tests?|test suite|specs?|checks|typecheck|type[- ]?check(?:ing|s)?|tsc|build|lint(?:ing)?)\b[^.!?\n]{0,40}?\b(?:pass(?:es|ed)?|passing|green|succeed(?:s|ed)?|clean(?:ly)?)\b/i,
  /\b(?:pass(?:es|ed)?|passing)\b[^.!?\n]{0,20}?\b(?:tests?|checks|type ?checks?)\b/i,
  /\b(?:compiles|builds)\b\s+(?:fine|cleanly|successfully|without (?:any )?errors)/i,
  /\bno (?:more )?(?:type|typescript|tsc|compile|compilation|build|lint) errors\b/i,
]
/** Words that make a sentence a hope, a plan or an instruction rather than a report. */
const HEDGES =
  /\b(?:not|never|unable|cannot|should|would|will|may|might|could|once|if|unless|when you|after you|expect(?:ed)?|hopefully|please|you can|try|before|to (?:verify|confirm|make sure|check))\b|n't\b/i

/** Sentences that say the code's checks pass, as written. */
export function successClaims(reply: string): string[] {
  return sentences(reply).filter((sentence) => CLAIMS.some((claim) => claim.test(sentence)) && !HEDGES.test(sentence))
}

const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/
const PLACEHOLDERS = /[*?<>{}$|]|^~|:\/\/|^www\.|(?:^|\/)path\/to\//
/** A sentence that suggests a file, or tells of one that is gone, names no file that must exist. */
const NOT_THERE = /\b(?:creat|new file|add(?:ing)? a file|could|should|would|suggest|consider|if you|remov|delet|renam|mov(?:ed|e it|ing)|no longer|instead of)\w*/i

function cleanPath(raw: string): string | undefined {
  const text = raw
    .trim()
    .replace(/^["'(]+|["'),;.]+$/g, '')
    .replace(/(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/, '')
  if (!text || PLACEHOLDERS.test(text) || /\s/.test(text) || !EXTENSION.test(text)) return undefined
  // A path has a folder in it; a bare name could be anywhere in the project.
  if (!/[\\/]/.test(text)) return undefined
  return text
}

/** The paths one sentence names: in code spans, links, or plain text with a folder and an extension. */
function pathsOf(sentence: string, out: Set<string>): void {
  const add = (raw: string) => {
    const file = cleanPath(raw)
    if (file) out.add(file)
  }
  for (const match of sentence.matchAll(/`([^`\n]+)`/g)) add(match[1])
  for (const match of sentence.matchAll(/\]\(([^)\s]+)\)/g)) add(match[1])
  const plain = sentence.replace(/`[^`\n]*`|\]\([^)]*\)|\b\w+:\/\/\S+/g, ' ')
  for (const match of plain.matchAll(/(?<![\w/.:@-])((?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+){0,2}\b/g)) add(match[1])
}

/** Paths the reply names as files that are there, leaving out sentences that suggest a file or tell of one that is gone. */
export function pathsIn(reply: string): string[] {
  const out = new Set<string>()
  for (const sentence of sentences(reply)) if (!NOT_THERE.test(sentence)) pathsOf(sentence, out)
  return [...out].slice(0, 20)
}

/** Names too common to say anything about a file. */
const COMMON = new Set(['true', 'false', 'null', 'undefined', 'None', 'nil', 'this', 'self', 'async', 'await', 'return', 'const', 'let', 'var', 'function', 'class', 'import', 'export', 'default', 'new', 'void', 'any', 'string', 'number', 'boolean', 'object', 'int', 'str', 'bool', 'dict', 'list'])
/** A sentence about taking something out says nothing about what the file holds now. */
const GONE = /\b(?:remov|delet|renam|drop|replac|mov|extract|inlin|no longer|instead of|used to|old)\w*/i
/** Nor does a suggestion, or a sentence that says something is not there. */
const SUGGESTED = /\b(?:should|could|would|might|may|you can|if you|consider|suggest|try)\b/i
const NEGATED = /\b(?:no|not|none|never|without|missing|nonexistent|nowhere)\b|n't\b/i

export interface NameClaim {
  sentence: string
  files: string[]
  names: string[]
}

/** Sentences that name code (`validateToken()`, `Auth.check`) together with the file it is in. */
export function nameClaims(reply: string): NameClaim[] {
  const out: NameClaim[] = []
  for (const sentence of sentences(reply)) {
    if (GONE.test(sentence) || SUGGESTED.test(sentence) || NEGATED.test(sentence)) continue
    const found = new Set<string>()
    pathsOf(sentence, found)
    const files = [...found]
    if (!files.length) continue
    const names = new Set<string>()
    for (const match of sentence.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g)) {
      const name = match[1].split('.').pop()!
      if (name.length >= 3 && !COMMON.has(name)) names.add(name)
    }
    if (names.size) out.push({ sentence, files, names: [...names] })
  }
  return out
}

/** Where a path the reply names would be: absolute as it is, otherwise in the folder the agent works in or the project's root. */
export function resolveIn(file: string, roots: readonly string[]): string[] {
  return path.isAbsolute(file) ? [file] : roots.map((root) => path.resolve(root, file))
}

export async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const stats = await fs.stat(candidate).catch(() => undefined)
    if (stats?.isFile()) return candidate
  }
  return undefined
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a file of at most 2 MB holds `name` as a whole word. Unreadable or larger files are taken to hold it. */
export async function fileHolds(file: string, name: string): Promise<boolean> {
  const stats = await fs.stat(file).catch(() => undefined)
  if (!stats?.isFile() || stats.size > 2 * 1024 * 1024) return true
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return true
  return new RegExp(`(?:^|[^\\w$])${escape(name)}(?:[^\\w$]|$)`).test(text)
}

/**
 * Words that leave a check to the person instead of making it (ADR 0126): the agent says it did not test or confirm
 * something, or that the person has to. Suggestions ("you can try it with npm start") are not among them.
 */
const HAND_BACKS = [
  /\bI\s+(?:have\s+not|haven't|did\s+not|didn't|could\s+not|couldn't|cannot|can't|can\s+not|was\s+not\s+able\s+to|wasn't\s+able\s+to|was\s+unable\s+to|am\s+unable\s+to|will\s+not|won't)\s+(?:yet\s+|actually\s+|fully\s+|been\s+able\s+to\s+)?(?:test|verify|check|confirm|try|reproduce)\w*/i,
  /\b(?:you(?:'ll|\s+will)?|he|she|they|the user|the person)\s+(?:will\s+)?(?:need|needs|have|has|must)\s+to\s+(?:test|verify|check|confirm|reproduce)\b/i,
  /\bneeds?\s+(?:you|him|her|them)\s+to\s+(?:test|verify|check|confirm|try)\b/i,
  /\blast mile\b/i,
]

/** The first sentence of the reply that leaves a check to the person, if one does. */
export function handBack(reply: string): string | undefined {
  return sentences(reply).find((sentence) => HAND_BACKS.some((words) => words.test(sentence)))
}

/** Sends the agent back to make the check its answer left to the person, or to say why only the person can. */
export function handBackReminder(sentence: string): string {
  const quoted = sentence.length > 240 ? `${sentence.slice(0, 239)}…` : sentence
  return [
    `Your answer leaves a check to the user: "${quoted}"`,
    "Before you finish, make that check yourself if any harmless way exists: run the program, send a test request, probe the port or the service, read its logs, reproduce the case. Read-only probes of the user's own systems need no asking.",
    'Then report what it showed. Leave the check to the user only when it truly needs them (their device, their account, a real customer), and say why in one line.',
  ].join('\n')
}

export function claimsReminder(found: readonly string[]): string {
  return [
    'Before you finish, check your reply against the project. eNCode could not confirm this in it:',
    ...found.map((line) => `- ${line}`),
    'Correct what is wrong in your reply, or check it (run the command, read the file) and say what you found.',
  ].join('\n')
}

const clip = (text: string, most = 160) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

export const unrunClaim = (sentence: string) =>
  `It says "${clip(sentence)}", but no command that checks the code passed after your last change. Run it, or say that you did not.`
export const missingFiles = (files: readonly string[]) =>
  `It names ${files.length === 1 ? 'a file that does' : 'files that do'} not exist: ${files.map((file) => `\`${file}\``).join(', ')}. If you meant files to create, say so.`
export const missingName = (name: string, files: readonly string[]) =>
  `It says \`${name}\` is in ${files.map((file) => `\`${file}\``).join(' or ')}, which ${files.length === 1 ? 'does' : 'do'} not contain that name.`
