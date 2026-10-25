import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_APPEARANCE } from '../../shared/appearance'
import type { AboutInfo, Settings } from '../../shared/types'
import { diagnosticsFileName, diagnosticsReport, type DiagnosticsInput } from './diagnostics'

const KEY = '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'
const COMMIT = '502645ee4cfcac52646f6e6e2acc0bd9cabf7dce'

const about: AboutInfo = {
  name: 'eNCode',
  version: '0.1.0',
  commit: COMMIT,
  dirty: false,
  builtAt: '2026-10-22T06:12:00.000Z',
  channel: 'tester',
  build: 291,
  packaged: true,
  platform: 'win32',
  arch: 'x64',
  os: 'Windows 11 (10.0.26100)',
  electron: '44.9.2',
  chrome: '140.0.7339.0',
  node: '22.18.0',
}

const settings: Settings = {
  profiles: [
    { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' },
    { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', hasApiKey: true },
    { id: 'paid', name: 'Paid key', kind: 'custom', baseUrl: 'https://api.example.com/v1', model: '', hasApiKey: false },
  ],
  activeProfileId: 'or',
  policy: 'workspace-write',
  maxSteps: 30,
  maxGoalRounds: 8,
  contextCap: 200_000,
  computer: false,
  computerSupported: true,
  recentWorkspaces: ['C:\\Users\\ana\\private-project', 'D:\\clients\\secret'],
  lastWorkspace: 'C:\\Users\\ana\\private-project',
  agentMode: 'code',
  followUp: 'queue',
  sendKey: 'ctrl-enter',
  keepAwake: true,
  languageServers: true,
  formatOnSave: false,
  formatOnType: false,
  inlineSuggest: 'auto',
  errorGate: 'auto',
  guide: 'auto',
  checkGate: 'auto',
  reviewWork: 'auto',
  askAgain: 'on',
  learnConventions: 'on',
  helpSmaller: 'auto',
  offerStronger: 'ask',
  notifyDone: 'background',
  notifyNeeds: 'always',
  flashTaskbar: false,
  autoUpdate: true,
  chatsFolder: 'C:\\Users\\ana\\Documents\\eNCode',
  chatsFolderDefault: 'C:\\Users\\ana\\Documents\\eNCode',
  appearance: { ...DEFAULT_APPEARANCE },
  roles: { reviewer: ['paid:big-model'] },
  efforts: {},
  keybindings: { 'edit.find': ['Ctrl+Alt+F'], 'view.bottomPanel': [] },
  freeOnly: false,
  freeProfileId: null,
  setupDone: true,
  searchProvider: 'brave',
  searchKeys: ['brave'],
  keyStorage: { mode: 'keychain' },
}

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    about,
    generatedAt: Date.UTC(2026, 9, 22, 6, 30, 0),
    system: { totalMemory: 16 * 1024 ** 3, freeMemory: 7.25 * 1024 ** 3, cpuCount: 12, cpuModel: 'Test CPU @ 3.00GHz', locale: 'en-US', displays: [{ width: 2560, height: 1440, scale: 1.25, primary: true }, { width: 1920, height: 1080, scale: 1, primary: false }] },
    settings,
    agentHost: { running: true, failures: 0, working: 1 },
    sessions: { total: 12, archived: 3 },
    workspaceOpen: true,
    languageServers: null,
    environment: ['ENCODE_DEVTOOLS'],
    logLines: ['2026-10-22T06:29:59.000Z INFO  [agent-host] started', '2026-10-22T06:30:00.000Z ERROR something failed'],
    logDir: 'C:\\Users\\ana\\AppData\\Roaming\\eNCode\\logs',
    redact: { home: 'C:\\Users\\ana', secrets: [KEY] },
    ...overrides,
  }
}

describe('diagnostics report', () => {
  it('says what build this is, what it runs on and how it is set up', () => {
    const text = diagnosticsReport(input())
    assert.match(text, /^eNCode diagnostics\n=+\neNCode 0\.1\.0 tester build 291, commit 502645e \(built 2026-10-22T06:12:00\.000Z\)\nReport made 2026-10-22T06:30:00\.000Z/)
    assert.match(text, new RegExp(`Commit +${COMMIT}`))
    assert.match(text, /Operating system +Windows 11 \(10\.0\.26100\) x64/)
    assert.match(text, /Electron +44\.9\.2, Chromium 140\.0\.7339\.0, Node 22\.18\.0/)
    assert.match(text, /Memory +16\.0 GB in all, 7\.3 GB free/)
    assert.match(text, /Displays +2560x1440 at 125% \(main\)\n +1920x1080 at 100%/)
    assert.match(text, /Variables set +ENCODE_DEVTOOLS/)
    assert.match(text, /What the agent may do +workspace-write/)
    assert.match(text, /Shortcuts +edit\.find Ctrl\+Alt\+F, view\.bottomPanel none/)
    assert.match(text, /API keys +sealed by the operating system/)
    assert.match(text, /Process +running, 0 stops in a row, 1 sessions working/)
    assert.match(text, /Sessions +12 \(3 archived\)/)
    assert.match(text, /Tester build +291/)
  })

  it('says where the updater is', () => {
    const ready = diagnosticsReport(
      input({ updates: { build: 291, auto: true, checkedAt: Date.UTC(2026, 9, 22, 6, 0, 0), state: 'ready', waiting: false, next: { build: 292, version: '0.1.0', size: 5, publishedAt: '', notes: [] } } }),
    )
    assert.match(ready, /Updates +looks by itself; Build 292 is ready\. \(last looked 2026-10-22T06:00:00\.000Z\)/)
    const off = diagnosticsReport(input({ updates: { build: 0, auto: true, checkedAt: null, state: 'off', reason: 'Turned off for this run.' } }))
    assert.match(off, /Updates +Turned off for this run\.\n/)
  })

  it('says which search provider answers and whether its key is stored, never the key', () => {
    assert.match(diagnosticsReport(input()), /Web search +Brave Search, key stored/)
    const missing = diagnosticsReport(input({ settings: { ...settings, searchKeys: [] } }))
    assert.match(missing, /Web search +Brave Search, NO KEY/)
    assert.match(diagnosticsReport(input({ settings: { ...settings, searchProvider: 'duckduckgo', searchKeys: [] } })), /Web search +DuckDuckGo, needs no key/)
    assert.match(diagnosticsReport(input({ settings: { ...settings, searchProvider: 'parallel', searchKeys: [] } })), /Web search +Parallel, needs no key/)
  })

  it('says how messages are sent, when notices show and whether the computer is kept awake, without the chats folder', () => {
    const text = diagnosticsReport(input())
    assert.match(text, /Sends with +Ctrl\+Enter/)
    assert.match(text, /Notices +finished background, needs you always, taskbar still/)
    assert.match(text, /Keeps awake +while an agent works/)
    assert.ok(!text.includes('Documents'), 'a folder path is the person\'s own')
  })

  it('says how the open folder\'s language servers stand, with the last words of one that failed', () => {
    const text = diagnosticsReport(
      input({
        languageServers: {
          state: 'on',
          servers: [
            { id: 'typescript', label: 'TypeScript and JavaScript', state: 'running', documents: 2, command: 'typescript-language-server (node_modules/.bin)', install: '', files: ['.ts'] },
            { id: 'rust', label: 'Rust', state: 'failed', detail: 'rust-analyzer exited with code 1.', documents: 0, install: '', files: ['.rs'] },
            { id: 'go', label: 'Go', state: 'missing', detail: 'No language server for Go is installed (gopls).', documents: 0, install: '', files: ['.go'] },
          ],
          logs: { rust: ['error: could not read C:\\Users\\ana\\proj\\Cargo.toml'] },
        },
      }),
    )
    assert.match(text, /Language servers +on, errors before finishing auto/)
    assert.match(text, /^Language servers in the open folder\n {2}on\n {2}TypeScript and JavaScript: running, 2 files open, typescript-language-server \(node_modules\/\.bin\)$/m)
    assert.match(text, /^ {2}Rust: failed, rust-analyzer exited with code 1\.\n {4}\| error: could not read ~\\proj\\Cargo\.toml$/m)
    assert.match(text, /^ {2}Go: missing, No language server for Go is installed \(gopls\)\.$/m)
  })

  it('lists each model with whether a key is stored, and marks the one in use', () => {
    const text = diagnosticsReport(input())
    assert.match(text, /^ {4}Demo \(offline\) \[demo\], model eNCode-demo, needs no key$/m)
    assert.match(text, /^ {2}\* OpenRouter \[openrouter\] https:\/\/openrouter\.ai\/api\/v1, model qwen\/qwen3-coder:free, key stored$/m)
    assert.match(text, /^ {4}Paid key \[custom\] https:\/\/api\.example\.com\/v1, model not chosen, NO KEY$/m)
  })

  it('says whether only free models are allowed, where they come from, and which models each role tries', () => {
    const text = diagnosticsReport(input())
    assert.match(text, /^ {2}Only free models: off; the free models come from OpenRouter$/m)
    assert.match(text, /^ {2}main: OpenRouter: qwen\/qwen3-coder:free$/m)
    assert.match(text, /^ {2}reviewer: Paid key: big-model$/m)
    assert.ok(!/^ {2}explore:/m.test(text), 'a role that follows another is not listed')
  })

  it('leaves out the folders the settings remember, and the home folder is a tilde wherever it shows up', () => {
    const text = diagnosticsReport(input())
    assert.ok(!text.includes('private-project'))
    assert.ok(!text.includes('clients'))
    assert.ok(!text.includes('ana'))
    assert.match(text, /Log: the last 2 lines from ~\\AppData\\Roaming\\eNCode\\logs/)
  })

  it('removes a key that got into the log, whatever its shape and whoever wrote it there', () => {
    const text = diagnosticsReport(
      input({
        logLines: [`ERROR rejected ${KEY}`, 'ERROR the key hunter-two-2 was refused', 'INFO Authorization: Bearer abcdef0123456789 sent'],
        redact: { home: 'C:\\Users\\ana', secrets: ['hunter-two-2'] },
      }),
    )
    assert.ok(!text.includes(KEY))
    assert.ok(!text.includes('hunter-two-2'))
    assert.ok(!text.includes('abcdef0123456789'))
    assert.match(text, /ERROR rejected \[redacted\]/)
  })

  it('says how a folder on another machine is connected and what runs there, without naming the machine', () => {
    const text = diagnosticsReport(input({ workspaceOpen: true, remote: { status: 'lost', node: '22.22.0', system: 'linux x64' } }))
    assert.match(text, /one open on another machine/)
    assert.match(text, /Other machine\s+lost, Node 22\.22\.0 on linux x64/)
    assert.doesNotMatch(diagnosticsReport(input({ workspaceOpen: true })), /Other machine/)
  })

  it("says how much each model read from its prompt cache this week, and which share is low (ADR 0128)", () => {
    const text = diagnosticsReport(
      input({
        cache: [
          { model: 'deepseek/deepseek-v4.1-flash', calls: 412, inputTokens: 18_400_000, cachedTokens: 18_100_000, verdict: 'good' },
          { model: 'anthropic/claude-sonnet-5-5', calls: 60, inputTokens: 2_000_000, cachedTokens: 1_000_000, verdict: 'low' },
          { model: 'local-model', calls: 3, inputTokens: 9_000, cachedTokens: 0, verdict: 'few' },
        ],
      }),
    )
    assert.match(text, /Prompt cache, last 7 days\n  deepseek\/deepseek-v4\.1-flash: 412 calls, 18,400,000 tokens read, 98% from the cache\n/)
    assert.match(text, /claude-sonnet-5-5: 60 calls, 2,000,000 tokens read, 50% from the cache \(LOW\)\. Less than 80%/)
    assert.match(text, /local-model: 3 calls, 9,000 tokens read, 0% from the cache, too few calls to judge/)
    assert.match(diagnosticsReport(input({ cache: null })), /Prompt cache, last 7 days\n  could not read/)
    assert.ok(!diagnosticsReport(input()).includes('Prompt cache'))
  })

  it('says what compaction did this week, and when the model read back too much of what it cut (ADR 0132)', () => {
    const week = { requests: 412, rewrites: 38, summaries: 2, readBacks: 3, editMisses: 1, checkBounces: 4, claimBounces: 1, digests: 0, digestReadBacks: 0 }
    const text = diagnosticsReport(input({ context: { ...week, verdict: 'ok' } }))
    assert.match(text, /Context, last 7 days\n  412 requests, 38 rewrites \(2 summaries\)\n  a shortened output read back 3 times, 1 edit missing its text after a rewrite\n  the project's checks sent the agent back 4 times, the check of its claims 1 time\n/)
    assert.match(diagnosticsReport(input({ context: { ...week, rewrites: 10, verdict: 'high' } })), /after a rewrite \(HIGH\): shortening cut/)
    assert.match(diagnosticsReport(input({ context: { requests: 3, rewrites: 0, summaries: 0, readBacks: 0, editMisses: 0, checkBounces: 0, claimBounces: 0, digests: 0, digestReadBacks: 0, verdict: 'none' } })), /Context, last 7 days\n  3 requests, 0 rewrites \(0 summaries\)\n\n/)
    // Digests (ADR 0133) have their line once there are some.
    assert.match(diagnosticsReport(input({ context: { ...week, digests: 40, digestReadBacks: 1, verdict: 'ok' } })), /\n  40 command outputs went in as a digest, 1 read back whole\n/)
    assert.match(diagnosticsReport(input({ context: null })), /Context, last 7 days\n  could not read/)
    assert.ok(!diagnosticsReport(input()).includes('Context, last'))
  })

  it('copes with what it was not told', () => {
    const text = diagnosticsReport(input({ agentHost: null, sessions: null, environment: [], logLines: [], about: { ...about, build: 0, commit: '', builtAt: '', packaged: false } }))
    assert.match(text, /eNCode 0\.1\.0 tester, no commit recorded\n/)
    assert.ok(!text.includes('Tester build') && !text.includes('Updates'))
    assert.match(text, /Process +unknown/)
    assert.match(text, /Installed as a program +no, run from the sources/)
    assert.ok(!text.includes('Variables set'))
  })

  it('names the file by the user\'s own date and time', () => {
    assert.equal(diagnosticsFileName(new Date(2026, 9, 22, 6, 5).getTime()), 'eNCode-diagnostics-20261022-0605.txt')
  })
})
