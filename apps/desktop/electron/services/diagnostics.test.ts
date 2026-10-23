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
  errorGate: 'auto',
  notifyDone: 'background',
  notifyNeeds: 'always',
  flashTaskbar: false,
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
    assert.match(text, /^eNCode diagnostics\n=+\neNCode 0\.1\.0 tester, commit 502645e \(built 2026-10-22T06:12:00\.000Z\)\nReport made 2026-10-22T06:30:00\.000Z/)
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
  })

  it('says which search provider answers and whether its key is stored, never the key', () => {
    assert.match(diagnosticsReport(input()), /Web search +Brave Search, key stored/)
    const missing = diagnosticsReport(input({ settings: { ...settings, searchKeys: [] } }))
    assert.match(missing, /Web search +Brave Search, NO KEY/)
    assert.match(diagnosticsReport(input({ settings: { ...settings, searchProvider: 'duckduckgo', searchKeys: [] } })), /Web search +DuckDuckGo, needs no key/)
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

  it('copes with what it was not told', () => {
    const text = diagnosticsReport(input({ agentHost: null, sessions: null, environment: [], logLines: [], about: { ...about, commit: '', builtAt: '', packaged: false } }))
    assert.match(text, /eNCode 0\.1\.0 tester, no commit recorded\n/)
    assert.match(text, /Process +unknown/)
    assert.match(text, /Installed as a program +no, run from the sources/)
    assert.ok(!text.includes('Variables set'))
  })

  it('names the file by the user\'s own date and time', () => {
    assert.equal(diagnosticsFileName(new Date(2026, 9, 22, 6, 5).getTime()), 'eNCode-diagnostics-20261022-0605.txt')
  })
})
