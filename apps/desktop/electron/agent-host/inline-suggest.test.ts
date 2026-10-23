import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ClientEvent, CompletionOutcome, CompletionRequest, ModelClient } from '@encode/providers'
import { INLINE_MAX_LINES, cleanSuggestion, inlineInput, inlinePrompt, isSecretFile, redactForSuggestion, suggestInline, type InlineSuggestInput } from './inline-suggest'

function clientAnswering(answer: string | CompletionOutcome, events: ClientEvent[] = []): ModelClient & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    requests,
    budget: async () => ({ model: 'test', contextWindow: 128_000, maxOutputTokens: 8_000 }),
    complete: async (request) => {
      requests.push(request)
      for (const event of events) request.onEvent?.(event)
      if (request.signal.aborted) throw request.signal.reason
      if (typeof answer !== 'string') return answer
      return {
        kind: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        finish: 'stop',
      }
    },
  }
}

const input = (over: Partial<InlineSuggestInput> = {}): InlineSuggestInput => ({
  path: 'client/main.lua',
  language: 'lua',
  prefix: 'local function heal(ped)\n  ',
  suffix: '\nend\n',
  multiline: true,
  snippets: [],
  ...over,
})

describe('a suggestion as you type', () => {
  it('is asked of the Inline suggestions model with the file around the cursor, briefly and without tools', async () => {
    const client = clientAnswering('SetEntityHealth(ped, 200)')
    const answer = await suggestInline(client, input({ snippets: [{ path: 'client/utils.lua', text: 'function Notify(text)\nend' }] }), new AbortController().signal)
    assert.deepEqual(answer, { kind: 'text', text: 'SetEntityHealth(ped, 200)' })
    const [request] = client.requests
    assert.equal(request.role, 'inline')
    assert.equal(request.tool, 'InlineSuggestion')
    assert.equal(request.sticky, 'editor-inline')
    assert.deepEqual(request.payload.tools, [])
    assert.equal(request.payload.maxOutputTokens, 320)
    assert.equal(request.payload.temperature, 0.2)
    assert.equal(request.requirements.tools, false)
    const prompt = (request.payload.messages[0].content[0] as { text: string }).text
    assert.equal(
      prompt,
      '<snippets>\n<snippet path="client/utils.lua">\nfunction Notify(text)\nend\n</snippet>\n</snippets>\n\n<file path="client/main.lua" language="lua">\nlocal function heal(ped)\n  <cursor/>\nend\n\n</file>\n\nWrite the text that goes at <cursor/>: at most 12 lines.',
    )
    assert.match(inlinePrompt(input({ multiline: false })), /the rest of its line only\.$/)
    assert.match(inlinePrompt(input({ path: 'a"b<c>.lua' })), /path="a&quot;b&lt;c&gt;\.lua"/)
  })

  it('is given up at once when the router would wait for the free models, and says until when', async () => {
    const until = Date.now() + 30_000
    const client = clientAnswering('x', [{ type: 'wait', until, reason: 'The free models take only so many requests a minute.' }])
    assert.deepEqual(await suggestInline(client, input(), new AbortController().signal), { kind: 'paused', message: 'The free models take only so many requests a minute.', until })
  })

  it('passes on why no model can answer, and stops asking when only the settings can fix it', async () => {
    const paused = (reason: 'rate-limit' | 'auth', retryAt?: number): CompletionOutcome => ({ kind: 'paused', reason, message: `because ${reason}`, ...(retryAt ? { retryAt } : {}) })
    assert.deepEqual(await suggestInline(clientAnswering(paused('rate-limit', 5)), input(), new AbortController().signal), { kind: 'paused', message: 'because rate-limit', until: 5 })
    assert.deepEqual(await suggestInline(clientAnswering(paused('auth')), input(), new AbortController().signal), { kind: 'paused', message: 'because auth', stop: true })
    assert.deepEqual(await suggestInline(clientAnswering({ kind: 'compact', window: 10 }), input(), new AbortController().signal), { kind: 'none' })
    assert.deepEqual(await suggestInline(clientAnswering('   '), input(), new AbortController().signal), { kind: 'none' })
  })

  it('rejects when the editor no longer wants it', async () => {
    const controller = new AbortController()
    controller.abort(new Error('typed on'))
    await assert.rejects(suggestInline(clientAnswering('x'), input(), controller.signal), /typed on/)
  })
})

describe('what of a reply is shown', () => {
  const at = (prefix: string, suffix: string, multiline = !suffix.split('\n')[0].trim()) => ({ prefix, suffix, multiline })

  it('is the text alone: no fences, no cursor marker, no trailing space', () => {
    assert.equal(cleanSuggestion('```lua\nreturn ped\n```', at('  ', '\nend')), 'return ped')
    assert.equal(cleanSuggestion('```\nreturn ped', at('  ', '\nend')), 'return ped')
    assert.equal(cleanSuggestion('return ped<cursor/>  \n\n', at('  ', '\nend')), 'return ped')
    assert.equal(cleanSuggestion('', at('x', '')), null)
    assert.equal(cleanSuggestion('\n\n  \n', at('x', '')), null)
  })

  it('leaves out what it repeats of the text before the cursor', () => {
    assert.equal(cleanSuggestion('local hp = GetEntityHealth(ped)', at('  local hp = ', '\n')), 'GetEntityHealth(ped)')
    assert.equal(cleanSuggestion('local function heal(ped)\n  SetEntityHealth(ped, 200)\nend', at('local function heal(ped)\n  ', '\n')), 'SetEntityHealth(ped, 200)\nend')
    assert.equal(cleanSuggestion('    return x', at('function f()\n    ', '\nend')), 'return x', 'the indentation the cursor stands after')
    assert.equal(cleanSuggestion('return x', at('function f()\n    ', '\nend')), 'return x')
  })

  it('in the middle of a line is the rest of that line, without what the line already has after the cursor', () => {
    assert.equal(cleanSuggestion('ped, 200)', at('SetEntityHealth(', ')')), 'ped, 200')
    assert.equal(cleanSuggestion('GetPlayerPed(-1))', at('SetEntityHealth(', ')')), 'GetPlayerPed(-1)', 'its own brackets stay')
    assert.equal(cleanSuggestion('hello")', at('print("', '")')), 'hello')
    assert.equal(cleanSuggestion('a, b)\nprint(1)', at('add(', ')')), 'a, b')
    assert.equal(cleanSuggestion('\nprint(1)', at('add(', ')')), null, 'a reply on a new line does not fit mid-line')
    assert.equal(cleanSuggestion(')', at('add(', ')')), null, 'what is there already is no suggestion')
  })

  it('over several lines stops before the lines that follow the cursor and at the limit', () => {
    assert.equal(cleanSuggestion('\n  return x\nend\nreturn M', at('local function f()', '\nend\nreturn M')), '\n  return x', 'not the end the file already has')
    assert.equal(cleanSuggestion('\n  return x\nend', at('local function f()', '\n\nend')), '\n  return x')
    assert.equal(cleanSuggestion('end', at('  ', '\nend')), null, 'the next line itself')
    assert.equal(cleanSuggestion('\n\nreturn x', at('', '')), 'return x', 'an empty line starts on itself')
    const long = Array.from({ length: 30 }, (_, index) => `line${index}`).join('\n')
    assert.equal(cleanSuggestion(long, at('', ''))!.split('\n').length, INLINE_MAX_LINES)
  })

  it('is refused when it holds characters that draw differently from what they are, or a redaction', () => {
    const rlo = String.fromCodePoint(0x202e)
    const zeroWidth = String.fromCodePoint(0x200b)
    const bell = String.fromCodePoint(7)
    for (const sneaky of [`if admin${rlo} then`, `x${zeroWidth}y`, `a${bell}b`, `x${String.fromCodePoint(0xfeff)}`]) assert.equal(cleanSuggestion(sneaky, at('', '')), null, JSON.stringify(sneaky))
    assert.equal(cleanSuggestion('local key = "[redacted]"', at('', '')), null)
    assert.equal(cleanSuggestion('local s = "tab\there"', at('', '')), 'local s = "tab\there"', 'a tab is fine')
  })
})

describe('what is sent', () => {
  it('never includes a file that holds secrets by its name', () => {
    for (const name of ['.env', '.env.local', 'config/.ENV.production', 'certs/server.pem', 'keys/app.key', 'id_ed25519', '.npmrc', 'creds/credentials.json', 'infra/prod.tfvars', 'store.p12']) assert.ok(isSecretFile(name), name)
    for (const name of ['.env.example', '.env.sample', 'server.cfg', 'client/main.lua', 'keymap.ts', 'environment.ts', 'id_ed25519.pub']) assert.ok(!isSecretFile(name), name)
  })

  it('takes out what is shaped like a credential, FiveM server.cfg lines included', () => {
    const cfg = [
      'ensure ox_lib',
      'sv_licenseKey "cfxk_abcdefghijklmnopqrst_123456"',
      'set mysql_connection_string "mysql://root:hunter2@localhost/qb"',
      'rcon_password hunter2',
      'set steam_webApiKey ABCDEF0123456789',
      'sets tags "roleplay"',
    ].join('\n')
    const out = redactForSuggestion(cfg, 'server.cfg')
    assert.equal(
      out,
      ['ensure ox_lib', 'sv_licenseKey "[redacted]"', 'set mysql_connection_string "[redacted]"', 'rcon_password "[redacted]"', 'set steam_webApiKey "[redacted]"', 'sets tags "roleplay"'].join('\n'),
    )
    const lua = [
      "Config.Webhook = 'https://discord.com/api/webhooks/123456/abcDEF-ghi'",
      'PerformHttpRequest("https://discord.com/api/webhooks/42/xyzXYZ_123", cb)',
      "local api_key = 'sk-or-v1-0123456789abcdef'",
      'local url = "postgres://admin:s3cret@db.local/app"',
      'local token = "ghp_abcdefghijklmnopqrstuvwxyz0123"',
      'local blob = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O"',
      'local hash = "3f2a9c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c"',
      'local SomeVeryLongFunctionNameForTheHud = 1',
    ].join('\n')
    const cleaned = redactForSuggestion(lua, 'client/main.lua')
    assert.doesNotMatch(cleaned, /abcDEF-ghi|xyzXYZ|0123456789abcdef|s3cret|ghp_|Zm9vYmFy/)
    assert.match(cleaned, /Config\.Webhook = '\[redacted\]'/)
    assert.match(cleaned, /PerformHttpRequest\("https:\/\/discord\.com\/api\/webhooks\/\[redacted\]", cb\)/)
    assert.match(cleaned, /postgres:\/\/\[redacted\]@db\.local\/app/)
    assert.match(cleaned, /3f2a9c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c/, 'a hash stays')
    assert.match(cleaned, /SomeVeryLongFunctionNameForTheHud/, 'a long name stays')
    assert.equal(redactForSuggestion('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nnext', 'a.txt'), '[redacted]\nnext')
    assert.equal(redactForSuggestion('rcon_password hunter2', 'client/main.lua'), 'rcon_password hunter2', 'a code file is not read as settings lines')
  })

  it('leaves out the file and the snippets the folder keeps from the agent, and the line whose secret was taken out', () => {
    const denied = (relative: string) => relative.startsWith('private/')
    assert.equal(inlineInput(input({ path: 'private/a.lua' }), denied), null)
    assert.equal(inlineInput(input({ path: '.env' }), denied), null)
    const kept = inlineInput(
      input({
        snippets: [
          { path: 'private/b.lua', text: 'secret' },
          { path: '.env', text: 'A=1' },
          { path: 'shared/c.lua', text: "local api_key = 'sk-or-v1-0123456789abcdef'" },
        ],
      }),
      denied,
    )
    assert.deepEqual(kept?.snippets, [{ path: 'shared/c.lua', text: "local api_key = '[redacted]'" }])
    assert.equal(inlineInput(input({ prefix: "local api_key = 'sk-or-v1-0123456789" }), denied), null, 'no suggestion while typing a key')
    assert.equal(inlineInput(input({ prefix: "local api_key = 'sk-or-v1-0123456789abcdef'\n" }), denied)?.prefix, "local api_key = '[redacted]'\n")
  })
})
