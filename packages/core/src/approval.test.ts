import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { ShellCommandAssessor, ToolAccess } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { createDefaultAssessor, decideApproval, grantKey, hostOf, isPlainCommandLine, type ApprovalContext } from './approval'
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
    assert.deepEqual(await decideApproval(command('rm -rf x', unproven.root), unproven), { kind: 'ask', reason: 'Not proven read-only: it writes.', grantable: true })
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
