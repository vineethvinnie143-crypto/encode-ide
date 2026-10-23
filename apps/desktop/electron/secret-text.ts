/**
 * What never leaves the computer with a file's text: files that are a secret or hold them, by name, and anything in a
 * text shaped like a credential. Suggestions as you type (ADR 0087) send only what passes, and a report of an editor
 * issue (ADR 0088) carries a file's own words only when nothing in them looks like one.
 */
import { redactSecrets } from '@encode/providers'

export { isSecretFile } from '../shared/secret-files'

/** Settings files written as `name value` lines, FiveM's server.cfg among them. */
const CONFIG_FILES = /\.(?:cfg|conf|ini|properties)$/i
/** A line of one that sets something named like a credential: `sv_licenseKey ...`, `set mysql_connection_string ...`, `rcon_password ...`. */
const CONFIG_SECRET = /^([^\S\n]*(?:set[rs]?[^\S\n]+)?)(\S*(?:key|pass|secret|token|licen[cs]e|connection|webhook|auth|credential)\S*)([^\S\n]+)(\S.*)$/gim
/** An assignment of a value to a name like a credential that the general patterns miss, in code or in data. */
const NAMED_SECRET = /\b((?:\w*[_-])?(?:licen[cs]e[_-]?key|webhook(?:[_-]?url)?|connection[_-]?string|client[_-]?secret|private[_-]?key|passwd|pwd)["']?\s*[:=]\s*)(["']?)[^\s"',;)}]{6,}/gi
const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g
const URL_USER = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const DISCORD_WEBHOOK = /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[\w/-]+/gi
const CFX_KEY = /\bcfxk_[A-Za-z0-9_]{10,}/g
/** A long run of letters and digits in both cases, with several digits: almost always a key or a token; a hash, a hex id or a long name is not. */
const OPAQUE = /[A-Za-z0-9_-]{32,}/g
export const REDACTED = '[redacted]'

function looksOpaque(run: string): boolean {
  if (/^[0-9a-f-]+$/i.test(run)) return false
  const digits = run.replace(/[^0-9]/g, '').length
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && (digits >= 4 || (digits >= 2 && run.length >= 40))
}

/** `text` with credentials replaced, for a file at `relative`: key shapes, assignments to names like a credential, private keys and the like. */
export function redactForSuggestion(text: string, relative: string): string {
  let out = text.replace(PRIVATE_KEY, REDACTED)
  out = out.replace(URL_USER, `$1${REDACTED}@`)
  out = out.replace(DISCORD_WEBHOOK, `https://discord.com/api/webhooks/${REDACTED}`)
  out = out.replace(CFX_KEY, REDACTED)
  out = out.replace(NAMED_SECRET, `$1$2${REDACTED}`)
  if (CONFIG_FILES.test(relative)) out = out.replace(CONFIG_SECRET, (_line, lead: string, name: string, gap: string) => `${lead}${name}${gap}"${REDACTED}"`)
  out = redactSecrets(out)
  return out.replace(OPAQUE, (run) => (looksOpaque(run) ? REDACTED : run))
}
