/**
 * Session titles. A session is named from its first message at once (the first words, cut to length) and,
 * when the first turn has ended, by one small call to the utility model that says it in a few words.
 */

export const MAX_TITLE_CHARS = 60

/** Longest first line that is already a fine title: naming it again would spend a call to say the same. */
const SHORT_ENOUGH = 28
const MAX_TITLE_WORDS = 8
const MAX_PROMPT_CHARS = 800

export const TITLE_SYSTEM =
  'You name a coding conversation from its first message. Reply with the name only: two to five words, in the language of the message, no quotes, no label, no full stop.'

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ')

/** The first words of a message, cut at a word to fit a sidebar row. */
export function titleFrom(text: string): string {
  const line = firstLine(text)
  if (line.length <= MAX_TITLE_CHARS) return line
  const cut = line.slice(0, MAX_TITLE_CHARS - 1)
  // Back to the last whole word, unless the cut already ends one or there is hardly a word to keep.
  const at = cut.lastIndexOf(' ')
  const whole = line[MAX_TITLE_CHARS - 1] === ' ' || at <= MAX_TITLE_CHARS / 2
  return `${(whole ? cut : cut.slice(0, at)).trimEnd()}…`
}

/** Whether a first message is worth a call to name it: a longer request, not a greeting, a command or a few words. */
export function worthNaming(text: string): boolean {
  const line = firstLine(text)
  if (line.length <= SHORT_ENOUGH || line.startsWith('/')) return false
  return true
}

/** What the model is shown: the start of the first message, so the call stays small whatever was pasted. */
export function titlePrompt(text: string): string {
  return text.trim().slice(0, MAX_PROMPT_CHARS)
}

const LABEL = /^(?:title|name|session|conversation)[\s*_`]*[:\-\u2013\u2014]\s*/i
const WRAPPERS = /^["'`*_#\s\u201c\u201d\u2018\u2019]+|["'`*_\s\u201c\u201d\u2018\u2019]+$/g
const TRAILING = /[.:;,!?\u2026\s]+$/

/** Peels what a model wraps a name in (quotes, markdown, a "Title:" label, a full stop), as often as it did so. */
function peel(text: string): string {
  let current = text
  for (let round = 0; round < 4; round++) {
    const next = current.replace(WRAPPERS, '').replace(LABEL, '').replace(TRAILING, '')
    if (next === current) break
    current = next
  }
  return current.replace(/\s+/g, ' ').trim()
}

/**
 * The model's reply as a title, or null when it is not one: empty, a sentence rather than a name, or
 * too long for a row. Anything null leaves the first words in place.
 */
export function cleanTitle(reply: string): string | null {
  const line = reply.split(/\r?\n/).map((part) => part.trim()).find(Boolean)
  if (!line) return null
  const title = peel(line)
  if (!title || title.length > MAX_TITLE_CHARS) return null
  if (title.split(' ').length > MAX_TITLE_WORDS) return null
  return title
}
