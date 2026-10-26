import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseRule, RuleSet, type RuleBehavior } from '@encode/permissions'
import type { ShellCommandAssessor, ToolAccess } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { alwaysAllowFor, createDefaultAssessor, decideApproval, grantKey, hostOf, isPlainCommandLine, type ApprovalContext } from './approval'
import type { ApprovalPolicy } from './ui'

const allowing: ShellCommandAssessor = async () => ({ decision: 'allow', reason: 'read-only' })
const asking: ShellCommandAssessor = async () => ({ decision: 'ask', reason: 'Not proven read-only: it writes.' })
const denying: ShellCommandAssessor = async () => ({ decision: 'deny', reason: 'Rule: never push.' })

async function context(policy: ApprovalPolicy, overrides: Partial<ApprovalContext> = {}): Promise<ApprovalContext> {
  const root = await tempWorkspace({ 'a.txt': 'a' })
  return {
    policy,
    root,
    home: os.homedir(),
    platform: process.platform,
    approvedHosts: new Set(),
    approvedApps: new Set(),
    shell: { cwd: root, env: { PATH: process.env.PATH ?? '' }, dialect: 'bash' },
    assessor: allowing,
    ...overrides,
  }
}

const write = (...paths: string[]): ToolAccess => ({ type: 'write', paths })
const read = (...paths: string[]): ToolAccess => ({ type: 'read', paths })
const command = (line: string, cwd: string): ToolAccess => ({ type: 'command', command: line, cwd, background: false })

describe('edits', () => {
  it('run unasked inside the workspace under Workspace Write, Auto review and Full access', async () => {
    for (const policy of ['workspace-write', 'auto-review', 'full-access'] as const) {
      const ctx = await context(policy)
      assert.deepEqual(await decideApproval(write(path.join(ctx.root, 'src', 'new.ts')), ctx), { kind: 'allow' })
    }
  })

  it('are refused under Read Only, with a reason the model can relay', async () => {
    const ctx = await context('read-only')
    const decision = await decideApproval(write(path.join(ctx.root, 'a.txt')), ctx)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.kind === 'deny' ? decision.reason : '', /Read Only/)
  })

  it('ask outside the workspace and in protected folders, except under Full access', async () => {
    const ctx = await context('workspace-write')
    const outside = await decideApproval(write(path.join(os.tmpdir(), 'elsewhere.txt')), ctx)
    assert.equal(outside.kind, 'ask')
    for (const guarded of ['.git/config', '.encode/settings.json', '.GIT/hooks/pre-commit']) {
      const decision = await decideApproval(write(path.join(ctx.root, guarded)), ctx)
      assert.equal(decision.kind, 'ask', guarded)
      assert.match(decision.kind === 'ask' ? decision.reason : '', /protected folder/)
    }
    const full = await context('full-access')
    assert.equal((await decideApproval(write(path.join(full.root, '.git', 'config'), '/etc/hosts'), full)).kind, 'allow')
  })

  it('ask before the MCP file at the top of the workspace is written, whatever a rule says, and not for one further down', async () => {
    const ctx = await context('workspace-write')
    const decision = await decideApproval(write(path.join(ctx.root, '.mcp.json')), ctx)
    assert.equal(decision.kind, 'ask')
    assert.match(decision.kind === 'ask' ? decision.reason : '', /protected file/)
    assert.equal(decision.kind === 'ask' && decision.grantable, false)
    assert.equal((await decideApproval(write(path.join(ctx.root, 'sub', '.mcp.json')), ctx)).kind, 'allow')
    const full = await context('full-access')
    assert.equal((await decideApproval(write(path.join(full.root, '.mcp.json')), full)).kind, 'allow')
  })

  it('let the user approve for the session what is outside the workspace or a command, but never a protected folder', async () => {
    const ctx = await context('workspace-write')
    const outside = await decideApproval(write(path.join(os.tmpdir(), 'elsewhere.txt')), ctx)
    assert.equal(outside.kind === 'ask' && outside.grantable, true)
    const guarded = await decideApproval(write(path.join(ctx.root, '.git', 'config')), ctx)
    assert.equal(guarded.kind === 'ask' && guarded.grantable, false)
    const command = await decideApproval({ type: 'command', command: 'npm test', cwd: ctx.root, background: false }, ctx)
    assert.equal(command.kind === 'ask' && command.grantable, true)
    const site = await decideApproval({ type: 'web', url: 'https://example.com/' }, ctx)
    assert.equal(site.kind === 'ask' && site.grantable, false)
    const external = await decideApproval({ type: 'external', server: 'github' }, ctx)
    assert.equal(external.kind === 'ask' && external.grantable, false)
  })

  it('key a grant by the paths, or by the command and where it runs', () => {
    assert.equal(grantKey(write('/b', '/a')), grantKey(write('/a', '/b')))
    assert.notEqual(grantKey(write('/a')), grantKey(read('/a')))
    const run = (command: string, cwd = '/w'): ToolAccess => ({ type: 'command', command, cwd, background: false })
    assert.equal(grantKey(run('npm   test')), grantKey(run(' npm test ')))
    assert.notEqual(grantKey(run('npm test')), grantKey(run('npm test', '/other')))
    assert.notEqual(grantKey(run('npm test')), grantKey(run('npm test -- --watch')))
    assert.equal(grantKey({ type: 'web', url: 'https://example.com/' }), undefined)
    assert.equal(grantKey(write()), undefined)
  })

  it('treat a symlink that leaves the workspace as outside it', async (t) => {
    const ctx = await context('workspace-write')
    const outside = await tempWorkspace({ 'secret.txt': 's' })
    const link = path.join(ctx.root, 'link')
    try {
      await fs.symlink(outside, link, 'junction')
    } catch {
      t.skip('this system will not create the link')
      return
    }
    assert.equal((await decideApproval(write(path.join(link, 'secret.txt')), ctx)).kind, 'ask')
  })
})

describe('reads', () => {
  it('run unasked inside the workspace and the extra read roots, and ask elsewhere', async () => {
    const extra = await tempWorkspace({ 'skill.md': 's' })
    const ctx = await context('workspace-write', { readRoots: [extra] })
    assert.equal((await decideApproval(read(path.join(ctx.root, 'a.txt')), ctx)).kind, 'allow')
    assert.equal((await decideApproval(read(path.join(extra, 'skill.md')), ctx)).kind, 'allow')
    const outside = await decideApproval(read(path.join(os.homedir(), '.ssh', 'id_ed25519')), ctx)
    assert.equal(outside.kind, 'ask')
    assert.match(outside.kind === 'ask' ? outside.reason : '', /sent to the model/)
    const readOnly = await context('read-only')
    assert.equal((await decideApproval(read(path.join(os.homedir(), 'notes.txt')), readOnly)).kind, 'ask')
    const full = await context('full-access')
    assert.equal((await decideApproval(read(path.join(os.homedir(), 'notes.txt')), full)).kind, 'allow')
  })
})

describe('commands', () => {
  it('ask before every command under Workspace Write', async () => {
    const ctx = await context('workspace-write')
    assert.deepEqual(await decideApproval(command('ls', ctx.root), ctx), { kind: 'ask', reason: 'Workspace Write asks before every command.', grantable: true })
  })

  it('run unasked under Auto review when the assessor proves them read-only, and ask when it does not', async () => {
    const proven = await context('auto-review')
    assert.equal((await decideApproval(command('ls', proven.root), proven)).kind, 'allow')
    const unproven = await context('auto-review', { assessor: asking })
    assert.deepEqual(await decideApproval(command('rm -rf x', unproven.root), unproven), { kind: 'ask', reason: 'Not proven read-only: it writes.', grantable: true, reviewable: true })
  })

  it('run only proven read-only commands under Read Only', async () => {
    const proven = await context('read-only')
    assert.equal((await decideApproval(command('git status', proven.root), proven)).kind, 'allow')
    const unproven = await context('read-only', { assessor: asking })
    const decision = await decideApproval(command('touch x', unproven.root), unproven)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.kind === 'deny' ? decision.reason : '', /Not proven read-only: it writes\. Ask the user to switch to Workspace Write/)
  })

  it('never run what the assessor denies, whatever the policy', async () => {
    for (const policy of ['read-only', 'workspace-write', 'auto-review', 'full-access'] as const) {
      const ctx = await context(policy, { assessor: denying })
      assert.deepEqual(await decideApproval(command('git push', ctx.root), ctx), { kind: 'deny', reason: 'Rule: never push.' })
    }
  })

  it('run everything unasked under Full access', async () => {
    const ctx = await context('full-access', { assessor: asking })
    assert.equal((await decideApproval(command('rm -rf x', ctx.root), ctx)).kind, 'allow')
  })

  it('hand the assessor the shell\'s state', async () => {
    let seen: unknown
    const ctx = await context('auto-review', {
      assessor: async (line, c) => {
        seen = { line, cwd: c.cwd, dialect: c.dialect, root: c.root }
        return { decision: 'allow', reason: 'ok' }
      },
    })
    const cwd = path.join(ctx.root, 'sub')
    await decideApproval(command('ls', cwd), ctx)
    assert.deepEqual(seen, { line: 'ls', cwd, dialect: 'bash', root: ctx.root })
  })
})

describe("eNCode's own folder", () => {
  // A profile that stands where eNCode keeps one, with the session's results and the sandbox's temp folder in it.
  async function profiled(policy: ApprovalPolicy, overrides: Partial<ApprovalContext> = {}) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-home-')))
    const profile = path.join(home, '.config', 'eNCode')
    const outputs = path.join(profile, 'sessions', 'outputs', 's1')
    const temp = path.join(profile, 'sandbox', 'tmp')
    for (const dir of [outputs, temp, path.join(home, '.config', 'eNCode-dev')]) await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(profile, 'eNCode-settings.json'), '{}')
    const ctx = await context(policy, { home, offLimits: { folders: [profile], except: [outputs, temp] }, ...overrides })
    return { ctx, home, profile, outputs, temp }
  }
  const refused = (decision: Awaited<ReturnType<typeof decideApproval>>) => decision.kind === 'deny' && /eNCode's own folder/.test(decision.reason)

  it('is refused to reads and edits under every policy, Full access and an allow rule included', async () => {
    for (const policy of ['read-only', 'workspace-write', 'auto-review', 'full-access'] as const) {
      const { ctx, profile, home } = await profiled(policy)
      ctx.rules = rulesFor(ctx.root, home, { allow: ['Read(//**)', 'Edit(//**)'] })
      // Without the folder off limits, the rule lets the read through.
      assert.equal((await decideApproval(read(path.join(profile, 'eNCode-settings.json')), { ...ctx, offLimits: undefined })).kind, 'allow', policy)
      assert.ok(refused(await decideApproval(read(path.join(profile, 'eNCode-settings.json')), ctx)), policy)
      assert.ok(refused(await decideApproval(write(path.join(profile, 'Cookies')), ctx)), policy)
      assert.ok(refused(await decideApproval(read(profile), ctx)), policy)
    }
  })

  it("leaves the session's own results and the sandbox's temp folder to the policy", async () => {
    const { ctx, outputs, temp } = await profiled('full-access')
    assert.equal((await decideApproval(read(path.join(outputs, 'Bash-1.txt')), ctx)).kind, 'allow')
    assert.equal((await decideApproval(read(path.join(temp, 'out.txt')), ctx)).kind, 'allow')
    // Another session's results are not this one's.
    assert.ok(refused(await decideApproval(read(path.join(outputs, '..', 's2', 'Bash-1.txt')), ctx)))
  })

  it('sees through a link that leads into it', async (t) => {
    const { ctx, profile } = await profiled('full-access')
    try {
      await fs.symlink(profile, path.join(ctx.root, 'profile'), 'dir')
    } catch {
      t.skip('this system cannot make links')
      return
    }
    assert.ok(refused(await decideApproval(read(path.join(ctx.root, 'profile', 'eNCode-settings.json')), ctx)))
  })

  it('is refused to a command that names it, as it is, from ~ or through a variable that holds a parent of it', async () => {
    const { ctx, home, profile } = await profiled('full-access')
    const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }
    const shell = { ...ctx.shell, env }
    for (const line of [
      `cat ${path.join(profile, 'eNCode-settings.json')}`,
      'cat ~/.config/eNCode/eNCode-settings.json',
      'ls ../../.config/eNCode',
      'tar czf /tmp/x.tgz "$HOME"/.config/eNCode',
      'cp -r ${XDG_CONFIG_HOME}/eNCode /tmp/x',
      'ls $HOME/.config//eNCode/sessions',
    ]) {
      const cwd = line.startsWith('ls ../') ? path.join(home, 'work', 'p') : ctx.root
      assert.ok(refused(await decideApproval(command(line, cwd), { ...ctx, shell })), line)
    }
    for (const line of ['ls ~/.config/eNCode-dev', 'echo eNCode', 'ls $HOME/.config', `cat ${path.join(ctx.root, 'a.txt')}`]) {
      assert.equal((await decideApproval(command(line, ctx.root), { ...ctx, shell })).kind, 'allow', line)
    }
  })

  it("lets a command name the agent's own folders in it as they are, but not lead out of them (ADR 0141)", async () => {
    const { ctx, home, profile, temp } = await profiled('full-access')
    const scratch = path.join(temp, 'scratch', 's1')
    await fs.mkdir(scratch, { recursive: true })
    const limits = { folders: [profile], except: [path.join(profile, 'sessions', 'outputs', 's1'), temp, scratch] }
    const shell = { ...ctx.shell, env: { PATH: process.env.PATH ?? '', HOME: home } }
    const judged = (line: string) => decideApproval(command(line, ctx.root), { ...ctx, shell, offLimits: limits })
    for (const line of [`node ${path.join(scratch, 'probe.mjs')}`, `node --test "${path.join(scratch, 'slug.test.mjs')}"`, `python3 ${path.join(scratch, 'try.py')} && cat ${path.join(scratch, 'out.txt')}`]) {
      assert.equal((await judged(line)).kind, 'allow', line)
    }
    for (const line of [
      `cat ${path.join(scratch, '..', '..', '..', '..', 'eNCode-settings.json')}`,
      `cat ${scratch}/"../../../../eNCode-settings.json"`,
      `node ${path.join(scratch, 'probe.mjs')} ${path.join(profile, 'eNCode-settings.json')}`,
      `ls ${path.join(profile, 'sessions', 'outputs', 's1')}0`,
    ]) {
      assert.ok(refused(await judged(line)), line)
    }
  })

  it('is spelled through the variables of Windows and PowerShell, in any case', async () => {
    const profile = 'C:\\Users\\u\\AppData\\Roaming\\eNCode'
    const ctx = await context('full-access', {
      platform: 'win32',
      home: 'C:\\Users\\u',
      offLimits: { folders: [profile], except: [] },
      shell: { cwd: 'C:\\work\\p', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\u' }, dialect: 'pwsh' },
    })
    for (const line of [
      'Get-Content $env:APPDATA\\eNCode\\eNCode-settings.json',
      'type %appdata%\\encode\\Cookies',
      'Copy-Item "${env:USERPROFILE}\\AppData\\Roaming\\eNCode" C:\\x -Recurse',
      'dir c:/users/u/appdata/roaming/ENCODE',
    ]) {
      assert.ok(refused(await decideApproval(command(line, 'C:\\work\\p'), ctx)), line)
    }
    assert.equal((await decideApproval(command('Get-ChildItem $env:APPDATA\\eNCode-old', 'C:\\work\\p'), ctx)).kind, 'allow')
  })
})

describe('the web', () => {
  it('asks once per site, and lets refused addresses through to the tool that refuses them', async () => {
    const approved = new Set<string>()
    const ctx = await context('auto-review', { approvedHosts: approved })
    const first = await decideApproval({ type: 'web', url: 'https://docs.example.com/page?q=1' }, ctx)
    assert.equal(first.kind, 'ask')
    assert.match(first.kind === 'ask' ? first.reason : '', /docs\.example\.com/)
    approved.add(hostOf('https://docs.example.com/x')!)
    assert.equal((await decideApproval({ type: 'web', url: 'https://docs.example.com/other' }, ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'web', url: 'http://127.0.0.1:3000/' }, ctx)).kind, 'allow')
    assert.equal(hostOf('http://127.0.0.1:3000/'), null)
    const full = await context('full-access')
    assert.equal((await decideApproval({ type: 'web', url: 'https://new.example.org/' }, full)).kind, 'allow')
  })
})

describe('the desktop', () => {
  const use = (app: string, label: string, blocked?: string): ToolAccess => ({ type: 'desktop', app, label, title: `${label} window`, ...(blocked ? { blocked } : {}) })

  it('asks the first time an application is used, and never again once it is allowed', async () => {
    for (const policy of ['workspace-write', 'auto-review'] as const) {
      const approved = new Set<string>()
      const ctx = await context(policy, { approvedApps: approved })
      const first = await decideApproval(use('notepad.exe', 'Notepad'), ctx)
      assert.equal(first.kind, 'ask', policy)
      assert.equal(first.kind === 'ask' && first.grantable, false, 'the loop remembers the application, so there is nothing to grant')
      assert.match(first.kind === 'ask' ? first.reason : '', /Approving allows Notepad until the session ends/)
      approved.add('notepad.exe')
      assert.equal((await decideApproval(use('notepad.exe', 'Notepad'), ctx)).kind, 'allow')
      assert.equal((await decideApproval(use('calc.exe', 'Calculator'), ctx)).kind, 'ask', 'another application is another question')
    }
  })

  it('warns when an application can carry instructions or cannot undo what is sent', async () => {
    const ctx = await context('workspace-write')
    const browser = await decideApproval(use('chrome.exe', 'Google Chrome'), ctx)
    assert.match(browser.kind === 'ask' ? browser.reason : '', /signed in to your accounts/)
    const chat = await decideApproval(use('slack.exe', 'Slack'), ctx)
    assert.match(chat.kind === 'ask' ? chat.reason : '', /cannot be taken back/)
    const plain = await decideApproval(use('notepad.exe', 'Notepad'), ctx)
    assert.doesNotMatch(plain.kind === 'ask' ? plain.reason : '', /accounts|taken back/)
  })

  it('is allowed under Full access without asking', async () => {
    const ctx = await context('full-access')
    assert.equal((await decideApproval(use('notepad.exe', 'Notepad'), ctx)).kind, 'allow')
  })

  it('is refused under Read Only, with a reason the model can relay', async () => {
    const ctx = await context('read-only', { approvedApps: new Set(['notepad.exe']) })
    const decision = await decideApproval(use('notepad.exe', 'Notepad'), ctx)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.kind === 'deny' ? decision.reason : '', /Read Only/)
  })

  it('refuses the applications that are never used under every policy, like a deny rule', async () => {
    for (const policy of ['read-only', 'workspace-write', 'auto-review', 'full-access'] as const) {
      const ctx = await context(policy, { approvedApps: new Set(['windowsterminal.exe']) })
      const decision = await decideApproval(use('windowsterminal.exe', 'Windows Terminal', 'terminals and shells run commands without the command approval'), ctx)
      assert.equal(decision.kind, 'deny', policy)
      assert.match(decision.kind === 'deny' ? decision.reason : '', /Windows Terminal is never used: terminals and shells/)
    }
  })

  it('is not something to approve for the rest of the session by grant', () => {
    assert.equal(grantKey(use('notepad.exe', 'Notepad')), undefined)
  })
})

describe('everything else', () => {
  it('lets session tools and subagents through, and asks about outside tool servers', async () => {
    const ctx = await context('workspace-write')
    assert.equal((await decideApproval({ type: 'none' }, ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'agent' }, ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'external', server: 'github' }, ctx)).kind, 'ask')
    const full = await context('full-access')
    assert.equal((await decideApproval({ type: 'external', server: 'github' }, full)).kind, 'allow')
  })
})

/** The user's rules, as the settings files would hold them. */
function rulesFor(root: string, home: string, entries: Partial<Record<RuleBehavior, string[]>>): RuleSet {
  const parsed = []
  for (const behavior of ['allow', 'ask', 'deny'] as const) {
    for (const text of entries[behavior] ?? []) {
      const result = parseRule(text, behavior, 'user')
      if (!result.ok) assert.fail(result.reason)
      parsed.push(result.rule)
    }
  }
  return new RuleSet(parsed, { root, home, windows: process.platform === 'win32' })
}

/** A workspace, a home folder with a notes folder in it, and a context whose rules are `entries`. */
async function withRules(policy: ApprovalPolicy, entries: Partial<Record<RuleBehavior, string[]>>, overrides: Partial<ApprovalContext> = {}) {
  const home = await tempWorkspace({ 'notes/todo.md': 'todo' })
  const ctx = await context(policy, { home, ...overrides })
  ctx.rules = rulesFor(ctx.root, home, entries)
  return { ctx, home }
}

describe("the user's rules", () => {
  it('refuse what a deny rule names, under every policy', async () => {
    for (const policy of ['read-only', 'workspace-write', 'auto-review', 'full-access'] as const) {
      const { ctx } = await withRules(policy, { deny: ['Read(./.env)', 'Edit(./secrets/**)', 'WebFetch(domain:evil.test)', 'mcp__github__delete_repo'] })
      const reading = await decideApproval(read(path.join(ctx.root, '.env')), ctx)
      assert.equal(reading.kind, 'deny', policy)
      assert.match(reading.kind === 'deny' ? reading.reason : '', /Denied by user rule Read\(\.\/\.env\)/)
      assert.equal((await decideApproval(write(path.join(ctx.root, 'secrets', 'k.txt')), ctx)).kind, 'deny', policy)
      assert.equal((await decideApproval({ type: 'web', url: 'https://api.evil.test/x' }, ctx)).kind, 'deny', policy)
      assert.equal((await decideApproval({ type: 'external', server: 'github', tool: 'delete_repo' }, ctx)).kind, 'deny', policy)
    }
  })

  it('leave what no rule names to the policy', async () => {
    const { ctx } = await withRules('workspace-write', { deny: ['Read(./.env)'] })
    assert.equal((await decideApproval(read(path.join(ctx.root, 'a.txt')), ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'web', url: 'https://example.com/' }, ctx)).kind, 'ask')
    assert.equal((await decideApproval({ type: 'external', server: 'github', tool: 'list' }, ctx)).kind, 'ask')
  })

  it('ask where the policy would not, and the asking cannot be granted for the session', async () => {
    const { ctx } = await withRules('workspace-write', { ask: ['Read(./a.txt)', 'Edit(./a.txt)'] })
    const reading = await decideApproval(read(path.join(ctx.root, 'a.txt')), ctx)
    assert.deepEqual(reading, { kind: 'ask', reason: 'Asks by user rule Read(./a.txt)', grantable: false, byRule: true })
    const writing = await decideApproval(write(path.join(ctx.root, 'a.txt')), ctx)
    assert.equal(writing.kind === 'ask' && writing.byRule, true)
    // Full access never asks, as before.
    const { ctx: full } = await withRules('full-access', { ask: ['Read(./a.txt)'] })
    assert.equal((await decideApproval(read(path.join(full.root, 'a.txt')), full)).kind, 'allow')
  })

  it('let an allow rule answer the question of reading outside the workspace, of writing there, of a new site and of an outside tool', async () => {
    const { ctx, home } = await withRules('workspace-write', { allow: ['Read(~/notes/**)', 'Edit(~/notes/**)', 'WebFetch(domain:docs.example.com)', 'mcp__github__list_issues'] })
    assert.equal((await decideApproval(read(path.join(home, 'notes', 'todo.md')), ctx)).kind, 'allow')
    assert.equal((await decideApproval(write(path.join(home, 'notes', 'new.md')), ctx)).kind, 'allow')
    assert.equal((await decideApproval(read(path.join(home, 'other.md')), ctx)).kind, 'ask')
    assert.equal((await decideApproval({ type: 'web', url: 'https://docs.example.com/guide' }, ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'web', url: 'https://example.org/' }, ctx)).kind, 'ask')
    assert.equal((await decideApproval({ type: 'external', server: 'github', tool: 'list_issues' }, ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'external', server: 'github', tool: 'create_issue' }, ctx)).kind, 'ask')
  })

  it('let a server rule cover every tool of the server', async () => {
    const { ctx } = await withRules('workspace-write', { allow: ['mcp__github'] })
    assert.equal((await decideApproval({ type: 'external', server: 'github', tool: 'anything' }, ctx)).kind, 'allow')
    assert.equal((await decideApproval({ type: 'external', server: 'gitlab', tool: 'anything' }, ctx)).kind, 'ask')
  })

  it('do not let an allow rule open a protected folder or a Read Only policy', async () => {
    const { ctx, home } = await withRules('workspace-write', { allow: ['Edit(**)', 'Edit(~/notes/**)'] })
    const guarded = await decideApproval(write(path.join(ctx.root, '.git', 'hooks', 'pre-commit')), ctx)
    assert.equal(guarded.kind, 'ask')
    assert.equal(guarded.kind === 'ask' && guarded.grantable, false)
    const { ctx: readOnly } = await withRules('read-only', { allow: ['Edit(**)'] })
    assert.equal((await decideApproval(write(path.join(readOnly.root, 'a.txt')), readOnly)).kind, 'deny')
    assert.ok(home)
  })

  it('count the extra roots as part of the workspace', async () => {
    const extra = await tempWorkspace({ 'lib/a.ts': 'a' })
    const ctx = await context('workspace-write', { extraRoots: [extra] })
    assert.equal((await decideApproval(read(path.join(extra, 'lib', 'a.ts')), ctx)).kind, 'allow')
    assert.equal((await decideApproval(write(path.join(extra, 'lib', 'a.ts')), ctx)).kind, 'allow')
    const plain = await context('workspace-write')
    assert.equal((await decideApproval(write(path.join(extra, 'lib', 'a.ts')), plain)).kind, 'ask')
    // A protected folder inside an extra root still asks.
    const guarded = await decideApproval(write(path.join(extra, '.git', 'config')), ctx)
    assert.equal(guarded.kind === 'ask' && guarded.grantable, false)
  })

  it('apply to rules that name a tool, such as WebSearch, Skill(name) and Task(name)', async () => {
    const { ctx } = await withRules('workspace-write', { deny: ['Skill(deploy)', 'Task(reviewer)'], ask: ['Skill(release)'], allow: ['WebSearch'] })
    const as = (name: string, specifier?: string): ApprovalContext => ({ ...ctx, tool: { name, ...(specifier !== undefined ? { specifier } : {}) } })
    assert.equal((await decideApproval({ type: 'none' }, as('Skill', 'deploy'))).kind, 'deny')
    assert.equal((await decideApproval({ type: 'agent' }, as('Task', 'reviewer'))).kind, 'deny')
    assert.equal((await decideApproval({ type: 'none' }, as('Skill', 'lint'))).kind, 'allow')
    const asking = await decideApproval({ type: 'none' }, as('Skill', 'release'))
    assert.equal(asking.kind === 'ask' && asking.byRule, true)
    // A rule for WebSearch answers the first-visit question of the search site, and only that.
    assert.equal((await decideApproval({ type: 'web', url: 'https://html.duckduckgo.com/html/' }, as('WebSearch'))).kind, 'allow')
    assert.equal((await decideApproval({ type: 'web', url: 'https://html.duckduckgo.com/html/' }, as('WebFetch'))).kind, 'ask')
    // A deny rule for the whole tool refuses it under Full access too.
    const { ctx: full } = await withRules('full-access', { deny: ['WebSearch'] })
    assert.equal((await decideApproval({ type: 'web', url: 'https://html.duckduckgo.com/html/' }, { ...full, tool: { name: 'WebSearch' } })).kind, 'deny')
  })

  it('let a rule-allowed command run unasked, and only a proven one under Read Only', async () => {
    const byRule: ShellCommandAssessor = async () => ({ decision: 'allow', reason: 'Allowed by user rule Bash(npm test:*)', source: 'rule', readOnly: false })
    const byRuleAndProven: ShellCommandAssessor = async () => ({ decision: 'allow', reason: 'Allowed by user rule Bash(cat:*)', source: 'rule', readOnly: true })
    for (const policy of ['workspace-write', 'auto-review', 'full-access'] as const) {
      const ctx = await context(policy, { assessor: byRule })
      assert.equal((await decideApproval(command('npm test', ctx.root), ctx)).kind, 'allow', policy)
    }
    const readOnly = await context('read-only', { assessor: byRule })
    const refused = await decideApproval(command('npm test', readOnly.root), readOnly)
    assert.equal(refused.kind, 'deny')
    assert.match(refused.kind === 'deny' ? refused.reason : '', /proven read-only/)
    const proven = await context('read-only', { assessor: byRuleAndProven })
    assert.equal((await decideApproval(command('cat a.txt', proven.root), proven)).kind, 'allow')
  })

  it('make a command asked by a rule ask under every policy but Full access, without a grant', async () => {
    const byRule: ShellCommandAssessor = async () => ({ decision: 'ask', reason: 'Asks by user rule Bash(git push:*)', source: 'rule' })
    for (const policy of ['workspace-write', 'auto-review'] as const) {
      const ctx = await context(policy, { assessor: byRule })
      assert.deepEqual(await decideApproval(command('git push', ctx.root), ctx), { kind: 'ask', reason: 'Asks by user rule Bash(git push:*)', grantable: false, byRule: true }, policy)
    }
    const full = await context('full-access', { assessor: byRule })
    assert.equal((await decideApproval(command('git push', full.root), full)).kind, 'allow')
  })
})

describe('which questions the Reviewer may answer', () => {
  const reviewable = (decision: Awaited<ReturnType<typeof decideApproval>>): boolean => decision.kind === 'ask' && decision.reviewable === true

  it('is only a command the assessor could not prove read-only, under Auto review', async () => {
    const auto = await context('auto-review', { assessor: asking })
    assert.equal(reviewable(await decideApproval(command('npm test', auto.root), auto)), true)
    for (const policy of ['workspace-write', 'read-only'] as const) {
      const ctx = await context(policy, { assessor: asking })
      assert.equal(reviewable(await decideApproval(command('npm test', ctx.root), ctx)), false, policy)
    }
  })

  it('is never a question about a rule, the outside of the workspace, a protected folder, a site, an outside tool or an application', async () => {
    const byRule: ShellCommandAssessor = async () => ({ decision: 'ask', reason: 'Asks by user rule Bash(git push:*)', source: 'rule' })
    const ruled = await context('auto-review', { assessor: byRule })
    const ctx = await context('auto-review')
    const cases: Array<[string, ToolAccess, ApprovalContext]> = [
      ['a command asked by a rule', command('git push', ruled.root), ruled],
      ['a read outside the workspace', read(path.join(os.homedir(), 'notes.txt')), ctx],
      ['a write outside the workspace', write(path.join(os.tmpdir(), 'elsewhere.txt')), ctx],
      ['a write into a protected folder', write(path.join(ctx.root, '.git', 'config')), ctx],
      ['a first visit to a site', { type: 'web', url: 'https://example.com/docs' }, ctx],
      ['an outside tool', { type: 'external', server: 'github' }, ctx],
      ['an application', { type: 'desktop', app: 'notepad.exe', label: 'Notepad', title: 'Notepad window' }, ctx],
    ]
    for (const [name, access, where] of cases) {
      const decision = await decideApproval(access, where)
      assert.equal(decision.kind, 'ask', name)
      assert.equal(reviewable(decision), false, name)
    }
  })
})

describe('a command that asks to run outside the sandbox', () => {
  const sandbox = (allowUnsandboxed: boolean) => ({ active: true, allowUnsandboxed })
  const outside = (cwd: string): ToolAccess => ({ type: 'command', command: 'git push', cwd, background: false, unsandboxed: true })
  const state = (root: string, view: ApprovalContext['shell']['sandbox']): ApprovalContext['shell'] => ({
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    dialect: 'bash',
    ...(view ? { sandbox: view } : {}),
  })

  it('is the person’s to allow under Workspace Write and Auto review, runs under Full access, is refused by Read Only, and the Reviewer never answers it', async () => {
    const full = await context('full-access', { assessor: allowing })
    assert.deepEqual(await decideApproval(outside(full.root), { ...full, shell: state(full.root, sandbox(true)) }), { kind: 'allow' })
    for (const policy of ['workspace-write', 'auto-review'] as const) {
      const base = await context(policy, { assessor: allowing })
      const ctx = { ...base, shell: state(base.root, sandbox(true)) }
      const decision = await decideApproval(outside(ctx.root), ctx)
      assert.equal(decision.kind, 'ask', policy)
      assert.equal(decision.kind === 'ask' && decision.reviewable, undefined, policy)
      assert.equal(decision.kind === 'ask' && decision.grantable, true, policy)
    }
    const base = await context('read-only', { assessor: allowing })
    const decision = await decideApproval(outside(base.root), { ...base, shell: state(base.root, sandbox(true)) })
    assert.equal(decision.kind, 'deny')
  })

  it('is refused when the settings do not let a command leave the sandbox', async () => {
    const base = await context('full-access', { assessor: allowing })
    const decision = await decideApproval(outside(base.root), { ...base, shell: state(base.root, sandbox(false)) })
    assert.equal(decision.kind, 'deny')
    assert.match(decision.kind === 'deny' ? decision.reason : '', /do not let commands run outside the sandbox/)
  })

  it('is an ordinary command where there is no sandbox to leave, and still refused by a rule that denies it', async () => {
    for (const view of [undefined, { active: false, allowUnsandboxed: true }]) {
      const base = await context('full-access', { assessor: allowing })
      const decision = await decideApproval(outside(base.root), { ...base, shell: state(base.root, view) })
      assert.deepEqual(decision, { kind: 'allow' })
    }
    const base = await context('workspace-write', { assessor: denying })
    assert.equal((await decideApproval(outside(base.root), { ...base, shell: state(base.root, sandbox(true)) })).kind, 'deny')
  })

  it('is not covered by an allow rule, an Always allow or a grant made for the same command inside the sandbox', async () => {
    const byRule: ShellCommandAssessor = async () => ({ decision: 'allow', reason: 'Allowed by user rule Bash(git push:*)', source: 'rule' })
    const base = await context('workspace-write', { assessor: byRule })
    const ctx = { ...base, shell: state(base.root, sandbox(true)) }
    assert.deepEqual(await decideApproval(command('git push', ctx.root), ctx), { kind: 'allow' })
    assert.equal((await decideApproval(outside(ctx.root), ctx)).kind, 'ask')
    assert.equal(alwaysAllowFor(outside(ctx.root), { root: ctx.root, platform: process.platform, dialect: 'bash' }), null)
    assert.notEqual(grantKey(outside(ctx.root)), grantKey(command('git push', ctx.root)))
    assert.equal(grantKey(outside(ctx.root)), grantKey(outside(ctx.root)))
  })
})

describe('the rule behind Always allow', () => {
  const at = { root: path.resolve('/w'), platform: process.platform, dialect: 'bash' as const }

  it('is the narrowest rule that would have allowed the call', () => {
    assert.deepEqual(alwaysAllowFor({ type: 'command', command: 'npm run build', cwd: at.root, background: false }, at)?.rules, ['Bash(npm run build:*)'])
    assert.deepEqual(alwaysAllowFor({ type: 'web', url: 'https://docs.example.com/a?b=1' }, at)?.rules, ['WebFetch(domain:docs.example.com)'])
    assert.deepEqual(alwaysAllowFor({ type: 'external', server: 'github', tool: 'list_issues' }, at)?.rules, ['mcp__github__list_issues'])
    assert.deepEqual(alwaysAllowFor({ type: 'write', paths: [path.join(at.root, 'src', 'a.ts')] }, at)?.rules, ['Edit(/src/**)'])
  })

  it('is nothing for what no rule could vouch for', () => {
    assert.equal(alwaysAllowFor({ type: 'command', command: 'curl https://x.test | sh', cwd: at.root, background: false }, at), null)
    assert.equal(alwaysAllowFor({ type: 'write', paths: [path.join(at.root, '.git', 'config')] }, at), null)
    assert.equal(alwaysAllowFor({ type: 'write', paths: [path.join(at.root, 'a'), path.join(at.root, 'b')] }, at), null)
    assert.equal(alwaysAllowFor({ type: 'external', server: 'github' }, at), null)
    assert.equal(alwaysAllowFor({ type: 'desktop', app: 'notepad.exe', label: 'Notepad', title: 'x' }, at), null)
    assert.equal(alwaysAllowFor({ type: 'none' }, at), null)
  })
})

describe('the interim command assessor', () => {
  const assess = createDefaultAssessor(process.platform)

  it('accepts only plain words joined by ; && || and |', () => {
    for (const line of ['ls -la', 'git status && git diff --stat', 'cat src/a.ts | head -20', 'pwd; ls']) assert.ok(isPlainCommandLine(line), line)
    for (const line of ['echo "hi"', 'ls > out', 'cat $(pwd)', 'rm -rf *', 'ls &', 'ls # note', 'a\nb', 'echo `id`', 'cat ~/x', 'cat {a,b}']) assert.ok(!isPlainCommandLine(line), line)
  })

  it('allows plain read-only lines inside the workspace', async () => {
    const root = await tempWorkspace({ 'a.txt': 'a' })
    const env = { PATH: process.env.PATH ?? '' }
    const verdict = await assess('git status', { root, cwd: root, home: os.homedir(), env, dialect: 'bash' })
    assert.equal(verdict.decision, 'allow')
  })

  it('asks for PowerShell, for quoted or redirected lines, and for writes', async () => {
    const root = await tempWorkspace()
    const env = { PATH: process.env.PATH ?? '' }
    const base = { root, cwd: root, home: os.homedir(), env }
    assert.equal((await assess('ls', { ...base, dialect: 'pwsh' })).decision, 'ask')
    assert.equal((await assess('echo "x" > y', { ...base, dialect: 'bash' })).decision, 'ask')
    const writing = await assess('rm -rf build', { ...base, dialect: 'bash' })
    assert.equal(writing.decision, 'ask')
    assert.match(writing.reason, /^Not proven read-only/)
  })

  it('asks when a program would run from inside the workspace', async () => {
    const root = await tempWorkspace({ 'tool.sh': '#!/bin/sh\n' })
    const verdict = await assess('git status', { root, cwd: root, home: os.homedir(), env: { PATH: root }, dialect: 'bash' })
    // `git` is not in the workspace, so this still runs; a program named by path inside it asks.
    assert.ok(['allow', 'ask'].includes(verdict.decision))
    const inside = await assess('./tool.sh', { root, cwd: root, home: os.homedir(), env: { PATH: process.env.PATH ?? '' }, dialect: 'bash' })
    assert.equal(inside.decision, 'ask')
  })
})
