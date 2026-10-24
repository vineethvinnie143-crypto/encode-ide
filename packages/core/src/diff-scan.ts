/**
 * The scan of a request's changes (ADR 0096): before the agent finishes, eNCode reads the lines the request added for
 * the mistakes that are easy to make and costly to ship, and sends the agent back once to fix them or say why they
 * are safe. It reads shapes, not meaning, so each rule is narrow:
 *
 * - a credential written into code (a provider's key shape, or a long literal assigned to a name like `apiKey`);
 * - SQL or a shell line built by joining text with a value, where the call runs it;
 * - eval of something other than a literal, HTML set from a value, TLS checks turned off;
 * - FiveM: a server event or callback that pays out, gives items or acts on a player from a value the client sent,
 *   with no check of it, and a client that sends the server a price.
 *
 * Only added lines count, so code that was there before is not the agent's to answer for. The Reviewer gets the
 * findings as notes.
 */
import { diffHunks } from '@encode/diff'
import { redactSecrets } from '@encode/providers'

export interface ChangedText {
  /** Relative to the workspace with `/`, or absolute where the file lies outside it. */
  path: string
  /** The file before the request; null when the request made it. */
  before: string | null
  /** The file now; null when the request deleted it. */
  after: string | null
  /** Why the file's text is not here (binary, too large): neither side is then given. */
  note?: string
}

export type ScanRule = 'secret' | 'sql' | 'command' | 'eval' | 'html' | 'tls' | 'fivem-client-value' | 'fivem-client-target' | 'fivem-client-price'

export interface ScanFinding {
  rule: ScanRule
  file: string
  line: number
  /** The line, trimmed and cut short. */
  code: string
  message: string
}

const MAX_LINE = 2_000
const MAX_FINDINGS = 12
/** A handler longer than this is read only this far. */
const MAX_BODY_LINES = 200

type Lang = 'js' | 'py' | 'lua' | 'go' | 'other'

function langOf(file: string): Lang {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase() ?? ''
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'html', 'htm'].includes(ext)) return 'js'
  if (ext === 'py') return 'py'
  if (ext === 'lua') return 'lua'
  if (ext === 'go') return 'go'
  return 'other'
}

/** Generated, vendored and lock files: nobody wrote their lines. */
const UNREAD = /(?:^|[\\/])(?:node_modules|dist|build|out|vendor|\.git|\.next|target)[\\/]|\.min\.(?:js|css)$|\.map$|(?:^|[\\/])(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/i
/** A file meant to hold this machine's secrets, kept out of version control by habit. */
const SECRETS_FILE = /(?:^|[\\/])\.env(?:\.(?!example$|sample$|template$|dist$)[\w-]+)?$/i
const TEST_FILE = /(?:^|[\\/])(?:tests?|__tests__|spec|specs|fixtures?|__mocks__)[\\/]|[._-](?:test|spec)\.[A-Za-z]+$|(?:^|[\\/])test_[^\\/]*\.py$|_test\.(?:go|py)$/i

/** A test file, or a file in a folder of tests or fixtures. */
export const isTestPath = (path: string): boolean => TEST_FILE.test(path)

/** The lines a request added to a file, with their numbers in it now. */
export function addedLines(before: string | null, after: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  for (const hunk of diffHunks(before ?? '', after, 0)) {
    for (const line of hunk.lines) if (line.type === 'add' && line.newNo !== undefined) out.push({ line: line.newNo, text: line.text.replace(/\r$/, '') })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Credentials

const KEY_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, 'a private key'],
  [/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'a GitLab token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{20,}/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
  [/\b[sr]k_live_[0-9A-Za-z]{20,}/, 'a Stripe live key'],
  [/\bsk-(?:ant-(?:api\d+-)?|or-v1-|proj-)?[A-Za-z0-9_-]{32,}/, 'an API key'],
]
const CREDENTIAL_NAME =
  /\b(?:\w{0,40}_)?(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|webhook[_-]?secret|bot[_-]?token)\b["']?\s*[:=]\s*(["'])([^"'\s]{12,200})\1/i
/** What example and test values are made of. */
const FAKE = /x{4,}|\*{3,}|0{6,}|1234|abcd|example|dummy|fake|test|sample|placeholder|your|redacted|changeme|secret|password|<[^>]*>|\$\{|\{\{|(.)\1{5,}/i

function looksReal(value: string): boolean {
  return !FAKE.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value)
}

function secretIn(text: string, test: boolean): string | undefined {
  for (const [shape, what] of KEY_SHAPES) {
    const found = shape.exec(text)
    if (found && (what === 'a private key' || looksReal(found[0]))) return what
  }
  if (test) return undefined
  const assigned = CREDENTIAL_NAME.exec(text)
  return assigned && looksReal(assigned[2]) ? 'a credential' : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Text joined into something that runs

/** SQL by its shape, not one word of it: `select … from`, `insert into`, `update … set`, `where x =`. */
const SQL_WORDS = /\b(?:select\b[^;]*\bfrom|insert\s+into|update\b[^;]*\bset|delete\s+from|replace\s+into|upsert|truncate\s+table|drop\s+table|alter\s+table)\b|\bwhere\b[^;]*[=<>]/i
/** A call's first argument that joins text with a value: `"... " + x`, `'...' .. x`, a template with `${}` in it. */
const JOINED_JS = /^(?:`[^`]*\$\{|"[^"\n]*"\s*\+|'[^'\n]*'\s*\+)/
const JOINED_PY = /^(?:\bf"[^"\n]*\{|\bf'[^'\n]*\{|"[^"\n]*"\s*(?:%|\+|\.format\()|'[^'\n]*'\s*(?:%|\+|\.format\())/
const JOINED_LUA = /^(?:"[^"\n]*"\s*\.\.|'[^'\n]*'\s*\.\.|\[\[[^\]\n]*\]\]\s*\.\.|\bstring\.format\s*\(|\(\s*(?:"[^"\n]*"|'[^'\n]*')\s*\)\s*:\s*format\s*\(|[\w.]+\s*\.\.)/
const JOINED_GO = /^(?:\bfmt\.Sprintf\s*\(|"[^"\n]*"\s*\+)/

const SQL_CALLS: Record<Exclude<Lang, 'other'>, RegExp> = {
  js: /\.(?:query|execute|raw|exec|run|all|get|prepare|unsafe|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*(.*)$/,
  py: /\.(?:execute|executemany|executescript|mogrify|raw)\s*\(\s*(.*)$/,
  lua: /(?:\bMySQL\.[\w.]+|\bexports\s*(?:\.\s*(?:oxmysql|ghmattimysql)|\[\s*["'](?:oxmysql|ghmattimysql|mysql-async)["']\s*\])\s*:\s*\w+)\s*\(\s*(.*)$/,
  go: /\.(?:Query|QueryRow|Exec|QueryContext|ExecContext|QueryRowContext|Prepare|PrepareContext)\s*\(\s*(?:ctx\s*,\s*)?(.*)$/,
}
const JOINED: Record<Exclude<Lang, 'other'>, RegExp> = { js: JOINED_JS, py: JOINED_PY, lua: JOINED_LUA, go: JOINED_GO }

const COMMAND_CALLS: Record<Exclude<Lang, 'other'>, RegExp> = {
  js: /(?<![\w$.])(?:exec|execSync)\s*\(\s*(.*)$|\bchild_process\.(?:exec|execSync)\s*\(\s*(.*)$/,
  py: /\bos\.(?:system|popen)\s*\(\s*(.*)$|\bsubprocess\.\w+\s*\(\s*(.*\bshell\s*=\s*True.*)$/,
  lua: /\b(?:os\.execute|io\.popen|ExecuteCommand)\s*\(\s*(.*)$/,
  go: /\bexec\.Command(?:Context)?\s*\(\s*(?:ctx\s*,\s*)?"(?:sh|bash|cmd|cmd\.exe|powershell|pwsh)"\s*,\s*"(?:-c|\/c|\/C|-Command)"\s*,\s*(.*)$/,
}

/** A call with something other than one string literal in it. */
const LITERAL_ONLY = /^\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)\s*\)/

const EVAL_CALLS: Partial<Record<Lang, RegExp>> = {
  js: /(?<![\w$.])eval\s*\(\s*(.*)$/,
  py: /(?<![\w.])(?:eval|exec)\s*\(\s*(.*)$|\byaml\.load\s*\(((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|Base)Loader).*)$/,
  lua: /(?<![\w.:])(?:load|loadstring)\s*\(\s*(.*)$/,
}

const HTML_SINKS: RegExp[] = [
  /\.(?:innerHTML|outerHTML)\s*\+?=\s*(?!\s*(?:"[^"$\n]*"|'[^'$\n]*'|`[^`$\n]*`)\s*;?\s*$)\S/,
  /\.insertAdjacentHTML\s*\(\s*[^,]+,\s*(?!(?:"[^"$\n]*"|'[^'$\n]*'|`[^`$\n]*`)\s*\))\S/,
  /\bdocument\.write(?:ln)?\s*\(\s*(?!(?:"[^"$\n]*"|'[^'$\n]*'|`[^`$\n]*`)\s*\))\S/,
  /\bdangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!(?:"[^"$\n]*"|'[^'$\n]*'|`[^`$\n]*`)\s*\})\S/,
  /\{@html\s+(?!["'`])\S/,
  /\bv-html\s*=\s*["']\s*\S/,
  /\$\([^)\n]*\)\s*\.(?:html|append|prepend)\s*\(\s*(?![)"'`]|(?:"[^"$\n]*"|'[^'$\n]*')\s*\))\S/,
]

const TLS_OFF: RegExp[] = [
  /\brejectUnauthorized\s*:\s*false\b/,
  /\bNODE_TLS_REJECT_UNAUTHORIZED\b["']?\]?\s*=\s*["']?0/,
  /\bverify\s*=\s*False\b/,
  /\bInsecureSkipVerify\s*:\s*true\b/,
  /\bCURLOPT_SSL_VERIFY(?:PEER|HOST)\b[^\n]{0,24}\b(?:false|0)\b/i,
  /\bssl\._create_unverified_context\b/,
  /\bcheck_hostname\s*=\s*False\b/,
]

// ---------------------------------------------------------------------------------------------------------------
// FiveM

/** A file FiveM runs on the server: `server/…`, `sv_…`, `…_server.lua`, `server.lua`. */
const SERVER_FILE = /(?:^|[\\/])(?:server|sv)[\\/]|(?:^|[\\/])sv_[^\\/]*$|_(?:sv|server)\.(?:lua|js|ts)$|(?:^|[\\/])server\.(?:lua|js|ts)$/i
const CLIENT_FILE = /(?:^|[\\/])(?:client|cl)[\\/]|(?:^|[\\/])cl_[^\\/]*$|_(?:cl|client)\.(?:lua|js|ts)$|(?:^|[\\/])client\.(?:lua|js|ts)$/i

/** Where a handler of something the client sends starts, and which of its parameters are the client's. */
const HANDLERS: ReadonlyArray<{ pattern: RegExp; kind: 'event' | 'callback'; registered?: true }> = [
  { pattern: /\b(?:RegisterNetEvent|RegisterServerEvent)\s*\(\s*(["'][^"'\n]+["'])\s*,\s*function\s*\(([^)]*)\)/, kind: 'event' },
  { pattern: /\bAddEventHandler\s*\(\s*(["'][^"'\n]+["'])\s*,\s*function\s*\(([^)]*)\)/, kind: 'event', registered: true },
  { pattern: /\blib\.callback\.register\s*\(\s*(["'][^"'\n]+["'])\s*,\s*function\s*\(([^)]*)\)/, kind: 'callback' },
  { pattern: /\b(?:ESX\.RegisterServerCallback|QBCore\.Functions\.CreateCallback)\s*\(\s*(["'][^"'\n]+["'])\s*,\s*function\s*\(([^)]*)\)/, kind: 'callback' },
  { pattern: /\bonNet\s*\(\s*(["'][^"'\n]+["'])\s*,\s*(?:async\s+)?(?:function\s*\(([^)]*)\)|\(([^)]*)\)\s*=>)/, kind: 'event' },
]
const NOT_CLIENTS = new Set(['source', 'src', '_source', 'cb', 'callback', '...', 'self'])
/** What pays out, gives or takes items: ESX, QBCore, ox_inventory and the names resources give their own. */
const PAYOUTS =
  /\b(?:add(?:Account)?Money|remove(?:Account)?Money|set(?:Account)?Money|AddMoney|RemoveMoney|SetMoney|addInventoryItem|removeInventoryItem|AddItem|RemoveItem|giveMoney|GiveMoney|giveItem|GiveItem|addBank|AddBank|addCash|AddCash|addWeapon|AddWeapon|giveWeapon|GiveWeapon)\s*\(([^\n]*)/
/** Where a handler finds a player by an id it was given. */
const PLAYER_BY_ID = /\b(?:GetPlayerFromId|GetPlayer|Player)\s*\(\s*(?:tonumber\s*\(\s*)?([A-Za-z_]\w*)/
/** A check that the caller may act on another player: a permission, or how near the other player is. */
const PERMISSION_CHECK = /\b(?:IsPlayerAceAllowed|IsAceAllowed|IsPrincipalAceAllowed|getGroup|GetPermission|HasPermission|hasPermission|isAdmin|IsAdmin|IsPlayerAdmin|hasGroup|HasGroup|Vdist2?|GetDistanceBetweenCoords)\b|#\s*\(|\bdistance\b/i
const CLIENT_PRICE = /\b(?:TriggerServerEvent|emitNet)\s*\(\s*["'][^"'\n]+["']\s*,([^\n]*)/
const PRICE_WORDS = /\b(?:price|cost|reward|payment|payout|salary|money|cash|bank)\b/i

function paramsOf(list: string): string[] {
  return list
    .split(',')
    .map((part) => part.trim().replace(/[:=].*$/, '').trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name) && !NOT_CLIENTS.has(name))
}

/** A line without its strings and comments, for counting blocks. */
function bare(text: string, lang: Lang): string {
  const strings = text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
  return lang === 'lua' ? strings.replace(/--.*$/, '') : strings.replace(/\/\/.*$/, '')
}

/** How far a Lua or JavaScript block opened on `start` goes: the index of its last line. */
function blockEnd(lines: readonly string[], start: number, lang: Lang): number {
  let depth = 0
  for (let index = start; index < lines.length && index < start + MAX_BODY_LINES; index++) {
    const text = bare(lines[index], lang)
    if (lang === 'lua') {
      const opens = (text.match(/\b(?:function|do|then|repeat)\b/g)?.length ?? 0) - (text.match(/\belseif\b/g)?.length ?? 0)
      const closes = text.match(/\b(?:end|until)\b/g)?.length ?? 0
      depth += opens - closes
    } else {
      depth += (text.match(/[{(]/g)?.length ?? 0) - (text.match(/[})]/g)?.length ?? 0)
    }
    if (depth <= 0 && index > start) return index
    if (depth <= 0 && index === start && /\bend\b|\}\s*\)/.test(text)) return index
  }
  return Math.min(lines.length - 1, start + MAX_BODY_LINES - 1)
}

/** Whether a line checks a value: compares it, or looks it up in a table the server holds. */
function checks(body: readonly string[], name: string): boolean {
  const word = `\\b${name}\\b`
  const compared = new RegExp(`\\b(?:if|elseif|while|assert)\\b[^\\n]*(?:${word}\\s*(?:[<>]=?|==|~=|!==?)|(?:[<>]=?|==|~=|!==?)\\s*${word})`)
  const lookedUp = new RegExp(`\\[\\s*${name}\\s*\\]|\\b(?:math\\.min|math\\.max|math\\.clamp|Math\\.min|Math\\.max|clamp)\\s*\\([^\\n]*${word}`)
  return body.some((line) => compared.test(line) || lookedUp.test(line))
}

function fivemServer(file: string, lines: readonly string[], added: ReadonlySet<number>, lang: Lang, out: ScanFinding[]): void {
  const text = lines.join('\n')
  for (let index = 0; index < lines.length; index++) {
    for (const handler of HANDLERS) {
      const match = handler.pattern.exec(lines[index])
      if (!match) continue
      if (handler.registered && !new RegExp(`\\b(?:RegisterNetEvent|RegisterServerEvent)\\s*\\(\\s*${escape(match[1])}\\s*\\)`).test(text)) continue
      const event = `\`${match[1].slice(1, -1)}\``
      const end = blockEnd(lines, index, lang)
      let touched = false
      for (let line = index + 1; line <= end + 1; line++) if (added.has(line)) touched = true
      if (!touched) continue
      const params = paramsOf(match[2] ?? match[3] ?? '')
      if (!params.length) continue
      const body = lines.slice(index + 1, end + 1)
      const guarded = body.some((line) => PERMISSION_CHECK.test(line))
      body.forEach((line, offset) => {
        const at = index + offset + 2
        const payout = PAYOUTS.exec(line)
        if (payout) {
          const used = params.find((name) => new RegExp(`\\b${name}\\b`).test(payout[1]) && !checks(body, name))
          if (used) {
            out.push(finding('fivem-client-value', file, at, line, `It takes \`${used}\` from the client's ${event} ${handler.kind}, and nothing checks it. A cheater sends any value: work it out on the server (a price list, the inventory, the distance), or check it against what the server knows.`))
            return
          }
        }
        const target = PLAYER_BY_ID.exec(line)
        if (target && !guarded && params.includes(target[1])) {
          out.push(finding('fivem-client-target', file, at, line, `It acts on the player the client names with \`${target[1]}\` in ${event}, and nothing checks that the caller may. Use \`source\`, or check the caller's permission (and how near the target is) first.`))
        }
      })
      break
    }
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cut = (text: string, most = 160) => {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat
}
const finding = (rule: ScanRule, file: string, line: number, code: string, message: string): ScanFinding => ({ rule, file, line, code: cut(code), message })

// ---------------------------------------------------------------------------------------------------------------

function scanLine(file: string, lang: Lang, test: boolean, line: number, text: string, out: ScanFinding[]): void {
  if (text.length > MAX_LINE) return
  const secret = secretIn(text, test)
  if (secret) {
    out.push(finding('secret', file, line, redactSecrets(text).replace(/(["'`])[^"'`]{6,}\1/g, '$1…$1'), `It writes ${secret} into the code, where everyone who can read the repository has it. Read it from the environment or a file kept out of version control.`))
    return
  }
  if (!test && TLS_OFF.some((pattern) => pattern.test(text))) {
    out.push(finding('tls', file, line, text, 'It turns off the check of the other side’s certificate, so anyone on the network can pose as that server. Keep the check; trust a private certificate authority instead if you need one.'))
    return
  }
  if (lang === 'other') return
  const sql = SQL_CALLS[lang].exec(text)
  if (sql && JOINED[lang].test(sql[1]) && SQL_WORDS.test(sql[1])) {
    out.push(finding('sql', file, line, text, 'It builds SQL by joining text with a value, which lets the value rewrite the query. Pass values as parameters (`?` or `$1` placeholders).'))
    return
  }
  const command = COMMAND_CALLS[lang].exec(text)
  const commandArgs = command?.slice(1).find((group) => group !== undefined)
  if (commandArgs !== undefined && (lang === 'py' && /shell\s*=\s*True/.test(text) ? JOINED_PY.test(commandArgs) : !LITERAL_ONLY.test(commandArgs) && JOINED[lang].test(commandArgs))) {
    out.push(finding('command', file, line, text, 'It builds a command line by joining text with a value, which lets the value add commands of its own. Pass the program and its arguments separately, or check the value against a fixed list.'))
    return
  }
  const evaluated = EVAL_CALLS[lang]?.exec(text)
  const evalArgs = evaluated?.slice(1).find((group) => group !== undefined)
  if (evalArgs !== undefined && !LITERAL_ONLY.test(evalArgs) && !/^\s*\)/.test(evalArgs)) {
    out.push(finding('eval', file, line, text, 'It runs text as code. If any of that text can come from outside (a player, a request, a file), so can the code: parse the data instead.'))
    return
  }
  if (lang === 'js' && HTML_SINKS.some((pattern) => pattern.test(text))) {
    out.push(finding('html', file, line, text, 'It puts a value into the page as HTML, so markup or script in it runs. Set text instead (`textContent`), or escape the value first.'))
  }
}

/** What the scan finds in the lines a request added, most at MAX_FINDINGS. */
export function scanChanges(files: readonly ChangedText[]): ScanFinding[] {
  const out: ScanFinding[] = []
  for (const change of files) {
    if (change.after === null || UNREAD.test(change.path) || SECRETS_FILE.test(change.path)) continue
    const lang = langOf(change.path)
    const test = TEST_FILE.test(change.path)
    const added = addedLines(change.before, change.after)
    if (!added.length) continue
    for (const { line, text } of added) scanLine(change.path, lang, test, line, text, out)
    if (test || (lang !== 'lua' && lang !== 'js')) continue
    if (SERVER_FILE.test(change.path)) {
      fivemServer(change.path, change.after.split('\n').map((line) => line.replace(/\r$/, '')), new Set(added.map((item) => item.line)), lang, out)
    } else if (CLIENT_FILE.test(change.path) || lang === 'lua') {
      for (const { line, text } of added) {
        const sent = CLIENT_PRICE.exec(text)
        if (sent && PRICE_WORDS.test(sent[1])) {
          out.push(finding('fivem-client-price', change.path, line, text, 'The client sends the server a price or an amount of money. A cheater sends any value: send what is bought, and let the server work out what it costs.'))
        }
      }
    }
  }
  const seen = new Set<string>()
  return out
    .filter((item) => {
      const key = `${item.file}:${item.line}:${item.rule}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_FINDINGS)
}

/** One line a person or a model reads: where, what, and why. */
export const scanLineText = (item: ScanFinding) => `\`${item.file}:${item.line}\` \`${item.code}\`: ${item.message}`

export function scanReminder(findings: readonly ScanFinding[]): string {
  return [
    "eNCode's scan of the lines your changes added found what is often a security bug:",
    ...findings.map((item) => `- ${scanLineText(item)}`),
    'Fix each, or say in your reply why it is safe here.',
  ].join('\n')
}
