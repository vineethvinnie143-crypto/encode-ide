import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { HookRun, HookRunner } from '@encode/hooks'
import type { RuleQuery } from '@encode/permissions'
import { Sandbox, type EnginePolicy, type SandboxEngine } from '@encode/sandbox'
import { tempWorkspace } from '@encode/tools/testing'
import { actOn } from './actions'
import { WorkspaceConfig } from './config'
import { rememberRules, keepLocalSettingsOutOfGit, whereOf } from './remember'
import { addRuleTo, approveFolder, removeRuleFrom, reportOn, revokeFolder, trustFolder } from './report'
import { Workspaces } from './scope'
import { nodeWorkspaceFs } from './fs'

async function setup(files: Record<string, string> = {}, homeFiles: Record<string, string> = {}) {
  const root = await fs.realpath(await tempWorkspace(files))
  const home = await fs.realpath(await tempWorkspace(homeFiles))
  const config = new WorkspaceConfig({ root, home })
  await config.refresh()
  return { root, home, config }
}

const json = (value: unknown) => JSON.stringify(value)
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>
const exists = async (file: string) => fs.access(file).then(() => true, () => false)

describe('saving what Always allow offered', () => {
  it('writes an allow rule into the user\'s settings, where it applies at once', async () => {
    const { home, config } = await setup()
    const remember = rememberRules(config)
    assert.deepEqual(await remember(['Bash(npm test:*)'], 'user'), { ok: true, where: 'your user settings', approved: true, changed: true })
    assert.deepEqual((await readJson(path.join(home, '.encode', 'settings.json'))).permissions.allow, ['Bash(npm test:*)'])
    const snapshot = await config.refresh()
    assert.deepEqual(snapshot.effective.rules.map((rule) => rule.text), ['Bash(npm test:*)'])
    // Again: nothing to change.
    assert.deepEqual(await remember(['Bash(npm test:*)'], 'user'), { ok: true, where: 'your user settings', approved: true, changed: false })
  })

  it('leaves the rest of the file as it was', async () => {
    const { home, config } = await setup({}, { '.encode/settings.json': json({ theme: 'dark', permissions: { deny: ['Read(./.env)'] } }) })
    await rememberRules(config)(['WebFetch(domain:docs.example.com)'], 'user')
    const saved = await readJson(path.join(home, '.encode', 'settings.json'))
    assert.equal(saved.theme, 'dark')
    assert.deepEqual(saved.permissions, { deny: ['Read(./.env)'], allow: ['WebFetch(domain:docs.example.com)'] })
  })

  it('keeps a rule in a folder that is not trusted yet out of effect, and says so', async () => {
    const { root, config } = await setup()
    const result = await rememberRules(config)(['Bash(npm test:*)'], 'local')
    assert.deepEqual(result, { ok: true, where: '.encode/settings.local.json', approved: false, changed: true })
    assert.ok(await exists(path.join(root, '.encode', 'settings.local.json')))
    assert.deepEqual((await config.refresh()).effective.rules, [])
    // Trusting the folder approves the settings as they are, with the rule the user saw.
    assert.deepEqual(await trustFolder(config), { ok: true })
    assert.deepEqual((await config.refresh()).effective.rules.map((rule) => rule.text), ['Bash(npm test:*)'])
  })

  it('applies a rule saved into a folder the user trusted, and keeps the approval current', async () => {
    const { config } = await setup()
    await trustFolder(config)
    const first = await rememberRules(config)(['Bash(npm test:*)'], 'local')
    assert.deepEqual(first, { ok: true, where: '.encode/settings.local.json', approved: true, changed: true })
    const second = await rememberRules(config)(['Bash(npm run build:*)'], 'local')
    assert.equal(second.ok && second.approved, true)
    assert.deepEqual((await config.refresh()).effective.rules.map((rule) => rule.text), ['Bash(npm test:*)', 'Bash(npm run build:*)'])
  })

  it('does not approve a folder\'s other changes on the way', async () => {
    const { root, config } = await setup({ '.encode/settings.local.json': json({ permissions: { allow: ['Bash(ls:*)'] } }) })
    await trustFolder(config)
    // Something else in the folder's settings changed since the user approved them (a pull, or the agent).
    await fs.writeFile(path.join(root, '.encode', 'settings.local.json'), json({ permissions: { allow: ['Bash(ls:*)', 'Bash(curl:*)'] } }))
    const result = await rememberRules(config)(['Bash(npm test:*)'], 'local')
    assert.equal(result.ok && result.approved, false)
    assert.equal((await config.refresh()).folder.configApproved, false)
  })

  it('refuses to overwrite a settings file that is not JSON', async () => {
    const { root, config } = await setup({ '.encode/settings.local.json': '{ not json' })
    const result = await rememberRules(config)(['Bash(npm test:*)'], 'local')
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /not valid JSON/)
    assert.equal(await fs.readFile(path.join(root, '.encode', 'settings.local.json'), 'utf8'), '{ not json')
  })

  it('refuses a rule that is not a rule', async () => {
    const { config } = await setup()
    const result = await rememberRules(config)(['Bash('], 'user')
    assert.equal(result.ok, false)
  })

  it('names the files in words', () => {
    assert.equal(whereOf('user'), 'your user settings')
    assert.equal(whereOf('project'), '.encode/settings.json')
    assert.equal(whereOf('local'), '.encode/settings.local.json')
  })
})

describe('keeping the private settings out of git', () => {
  it('adds one line to the clone\'s own exclude file, once', async () => {
    const { root } = await setup({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/info/exclude': '# local\n' })
    await keepLocalSettingsOutOfGit(root, nodeWorkspaceFs)
    await keepLocalSettingsOutOfGit(root, nodeWorkspaceFs)
    assert.equal(await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8'), '# local\n.encode/settings.local.json\n')
  })

  it('creates the file when git has none, and starts a new line when the last one has no end', async () => {
    const { root } = await setup({ '.git/HEAD': 'ref: refs/heads/main\n' })
    await keepLocalSettingsOutOfGit(root, nodeWorkspaceFs)
    assert.equal(await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8'), '.encode/settings.local.json\n')
    const other = await setup({ '.git/HEAD': 'x', '.git/info/exclude': 'dist' })
    await keepLocalSettingsOutOfGit(other.root, nodeWorkspaceFs)
    assert.equal(await fs.readFile(path.join(other.root, '.git', 'info', 'exclude'), 'utf8'), 'dist\n.encode/settings.local.json\n')
  })

  it('does nothing where there is no .git folder, or where the line is already there', async () => {
    const plain = await setup()
    await keepLocalSettingsOutOfGit(plain.root, nodeWorkspaceFs)
    assert.equal(await exists(path.join(plain.root, '.git')), false)
    const worktree = await setup({ '.git': 'gitdir: /elsewhere\n' })
    await keepLocalSettingsOutOfGit(worktree.root, nodeWorkspaceFs)
    assert.equal(await fs.readFile(path.join(worktree.root, '.git'), 'utf8'), 'gitdir: /elsewhere\n')
    const done = await setup({ '.git/info/exclude': '/.encode/settings.local.json\n' })
    await keepLocalSettingsOutOfGit(done.root, nodeWorkspaceFs)
    assert.equal(await fs.readFile(path.join(done.root, '.git', 'info', 'exclude'), 'utf8'), '/.encode/settings.local.json\n')
  })

  it('happens when a local rule is saved in a git clone', async () => {
    const { root, config } = await setup({ '.git/HEAD': 'x' })
    await rememberRules(config)(['Bash(npm test:*)'], 'local')
    assert.match(await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /\.encode\/settings\.local\.json/)
    // Not for the shared file or the user's.
    const shared = await setup({ '.git/HEAD': 'x' })
    await rememberRules(shared.config)(['Bash(npm test:*)'], 'project')
    assert.equal(await exists(path.join(shared.root, '.git', 'info', 'exclude')), false)
  })
})

describe('what the Settings screen shows', () => {
  it('lists every rule with where it came from, and which of them wait for approval', async () => {
    const { root, config } = await setup(
      { '.encode/settings.json': json({ permissions: { allow: ['Edit(/scripts/**)'], deny: ['Read(./private/**)'] } }) },
      { '.encode/settings.json': json({ permissions: { allow: ['Bash(ls:*)'] } }) },
    )
    const report = await reportOn(config)
    assert.equal(report.root, root)
    assert.equal(report.trusted, false)
    assert.deepEqual(
      report.rules.map((rule) => [rule.scope, rule.behavior, rule.text, rule.active]),
      [
        ['user', 'allow', 'Bash(ls:*)', true],
        ['project', 'deny', 'Read(./private/**)', true],
        ['project', 'allow', 'Edit(/scripts/**)', false],
      ],
    )
    assert.equal(report.heldBack.length, 1)
    assert.equal(report.waiting.length, 1)
    assert.match(report.waiting[0].text, /"Edit\(\/scripts\/\*\*\)"/)
    assert.equal(report.configApproved, false)
    assert.match(report.files.project, /\.encode[\\/]settings\.json$/)
  })

  it('shows nothing waiting once the folder is trusted, and names the variables the folder sets', async () => {
    const { config } = await setup({ '.encode/settings.local.json': json({ env: { TOKEN_NAME: 'x' }, permissions: { additionalDirectories: ['../x'] } }) })
    await trustFolder(config)
    const report = await reportOn(config)
    assert.equal(report.trusted, true)
    assert.deepEqual(report.waiting, [])
    assert.deepEqual(report.envNames, ['TOKEN_NAME'])
    assert.equal(report.additionalDirectories.length, 1)
  })

  it('asks for a second look before trusting the home folder', async () => {
    const home = await fs.realpath(await tempWorkspace())
    const config = new WorkspaceConfig({ root: home, home })
    await config.refresh()
    assert.equal((await reportOn(config)).trustWarning, 'This is your home folder: trusting it trusts every file in it.')
    const refused = await trustFolder(config)
    assert.equal(refused.ok, false)
    assert.equal((await config.refresh()).folder.trusted, false)
    assert.deepEqual(await trustFolder(config, { acknowledged: true }), { ok: true })
    assert.equal((await config.refresh()).folder.trusted, true)
  })

  it('approves a changed configuration only for a folder that is trusted', async () => {
    const { root, config } = await setup({ '.encode/settings.json': json({ env: { A: '1' } }) })
    assert.deepEqual(await approveFolder(config), { ok: false, reason: 'Trust the folder first.' })
    await trustFolder(config)
    await fs.writeFile(path.join(root, '.encode', 'settings.json'), json({ env: { A: '2' } }))
    assert.equal((await config.refresh()).folder.configApproved, false)
    assert.deepEqual(await approveFolder(config), { ok: true })
    assert.deepEqual((await config.refresh()).effective.env, { A: '2' })
  })

  it('forgets a folder when told to', async () => {
    const { config } = await setup({ '.encode/settings.json': json({ env: { A: '1' } }) })
    await trustFolder(config)
    assert.equal((await config.refresh()).folder.trusted, true)
    await revokeFolder(config)
    const snapshot = await config.refresh()
    assert.equal(snapshot.folder.trusted, false)
    assert.deepEqual(snapshot.effective.env, {})
  })

  it('adds and removes rules in a settings file', async () => {
    const { home, config } = await setup()
    const added = await addRuleTo(config, { scope: 'user', behavior: 'deny', text: 'Read(./.env)' })
    assert.equal(added.ok && added.changed, true)
    assert.deepEqual((await readJson(path.join(home, '.encode', 'settings.json'))).permissions.deny, ['Read(./.env)'])
    assert.equal((await config.refresh()).effective.rules.length, 1)
    const removed = await removeRuleFrom(config, { scope: 'user', behavior: 'deny', text: 'Read(./.env)' })
    assert.equal(removed.ok && removed.changed, true)
    assert.deepEqual((await config.refresh()).effective.rules, [])
    const bad = await addRuleTo(config, { scope: 'user', behavior: 'allow', text: 'Bash(' })
    assert.equal(bad.ok, false)
  })
})

describe('what the Permissions screen can do', () => {
  it('trusts a folder, approves its changed settings and forgets it, answering with the folder as it stands', async () => {
    const { root, config } = await setup({ '.encode/settings.json': json({ env: { A: '1' } }) })
    const trusted = await actOn(config, { type: 'trust' })
    assert.equal(trusted.ok && trusted.report.trusted, true)
    assert.deepEqual(trusted.ok && trusted.report.envNames, ['A'])

    await fs.writeFile(path.join(root, '.encode', 'settings.json'), json({ env: { A: '2', B: '3' } }))
    const waiting = await reportOn(config)
    assert.equal(waiting.configApproved, false)
    assert.equal(waiting.waiting.length, 1)
    const approved = await actOn(config, { type: 'approve' })
    assert.equal(approved.ok && approved.report.configApproved, true)
    assert.deepEqual(approved.ok && approved.report.envNames, ['A', 'B'])

    const revoked = await actOn(config, { type: 'revoke' })
    assert.equal(revoked.ok && revoked.report.trusted, false)
    assert.deepEqual(revoked.ok && revoked.report.envNames, [])
  })

  it('refuses to trust the home folder until the person has seen the warning, and says why', async () => {
    const home = await fs.realpath(await tempWorkspace())
    const config = new WorkspaceConfig({ root: home, home })
    const refused = await actOn(config, { type: 'trust' })
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.reason : '', /home folder/)
    assert.equal(refused.report.trusted, false)
    const trusted = await actOn(config, { type: 'trust', acknowledged: true })
    assert.equal(trusted.ok && trusted.report.trusted, true)
  })

  it('adds and removes rules, and says when there was nothing to do or the rule waits for a review', async () => {
    const { config } = await setup({ '.encode/settings.json': json({ permissions: { deny: ['Read(./a)'] } }) })
    const local = await actOn(config, { type: 'add-rule', scope: 'local', behavior: 'deny', text: 'Read(./.env)' })
    assert.equal(local.ok && local.note, undefined)
    assert.ok(local.ok && local.report.rules.some((rule) => rule.scope === 'local' && rule.text === 'Read(./.env)' && rule.active))
    const again = await actOn(config, { type: 'add-rule', scope: 'local', behavior: 'deny', text: 'Read(./.env)' })
    assert.match(again.ok ? (again.note ?? '') : '', /already in \.encode\/settings\.local\.json/)

    // An allow rule in a folder that is not trusted is saved, and waits.
    const waiting = await actOn(config, { type: 'add-rule', scope: 'project', behavior: 'allow', text: 'Bash(npm test:*)' })
    assert.match(waiting.ok ? (waiting.note ?? '') : '', /applies once you trust this folder/)
    assert.ok(waiting.ok && waiting.report.rules.some((rule) => rule.text === 'Bash(npm test:*)' && !rule.active))

    const removed = await actOn(config, { type: 'remove-rule', scope: 'local', behavior: 'deny', text: 'Read(./.env)' })
    assert.ok(removed.ok && !removed.report.rules.some((rule) => rule.text === 'Read(./.env)'))
    const missing = await actOn(config, { type: 'remove-rule', scope: 'local', behavior: 'deny', text: 'Read(./.env)' })
    assert.match(missing.ok ? (missing.note ?? '') : '', /is not in/)
  })

  it('refuses what is not a rule or not an action, without touching a file', async () => {
    const { home, config } = await setup()
    const bad = await actOn(config, { type: 'add-rule', scope: 'user', behavior: 'allow', text: 'Bash(' })
    assert.equal(bad.ok, false)
    for (const action of [
      null,
      'trust',
      { type: 'format-disk' },
      { type: 'add-rule', scope: 'managed', behavior: 'allow', text: 'Bash(ls:*)' },
      { type: 'add-rule', scope: 'user', behavior: 'permit', text: 'Bash(ls:*)' },
      { type: 'add-rule', scope: 'user', behavior: 'allow', text: '   ' },
      { type: 'add-rule', scope: 'user', behavior: 'allow', text: 'x'.repeat(5_000) },
      { type: 'add-rule', scope: 'user', behavior: 'allow' },
      { type: 'trust', acknowledged: 'yes' },
    ]) {
      const outcome = await actOn(config, action as never)
      assert.equal(outcome.ok, false, JSON.stringify(action))
    }
    assert.equal(await exists(path.join(home, '.encode', 'settings.json')), false)
  })

  it('works on a folder given by any path to it, through the workspaces of a program', async () => {
    const root = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ permissions: { deny: ['Read(./.env)'] } }) }))
    const home = await fs.realpath(await tempWorkspace())
    const link = path.join(await fs.realpath(await tempWorkspace()), 'link')
    await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    const workspaces = new Workspaces({ home })
    const report = await workspaces.report(link)
    assert.equal(report.root, root)
    assert.deepEqual(report.rules.map((rule) => rule.text), ['Read(./.env)'])
    const outcome = await workspaces.act(link, { type: 'trust' })
    assert.equal(outcome.ok && outcome.report.trusted, true)
    // The very picture the sessions of that folder use.
    assert.equal((await workspaces.config(root).refresh()).folder.trusted, true)
  })
})

describe('the workspaces of a program', () => {
  it('give every session in a folder the same picture of it', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const workspaces = new Workspaces({ home })
    assert.equal(workspaces.config(root), workspaces.config(root))
    assert.notEqual(workspaces.config(root), workspaces.config(home))
  })

  it('make a scope that follows the files: rules the user adds apply to the next call', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const workspaces = new Workspaces({ home })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    assert.equal(scope.rules!.evaluate({ type: 'read', paths: [path.join(root, '.env')] }), null)
    await fs.mkdir(path.join(home, '.encode'), { recursive: true })
    await fs.writeFile(path.join(home, '.encode', 'settings.json'), json({ permissions: { deny: ['Read(./.env)'] } }))
    await scope.refresh!()
    assert.equal(scope.rules!.evaluate({ type: 'read', paths: [path.join(root, '.env')] })?.decision, 'deny')
  })

  it('hand a trusted folder\'s variables to its shells, and nothing before the folder is trusted', async () => {
    const root = await fs.realpath(await tempWorkspace({ '.encode/settings.local.json': json({ env: { PROJECT_MODE: 'dev' } }) }))
    const home = await fs.realpath(await tempWorkspace())
    const workspaces = new Workspaces({ home })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    assert.deepEqual(scope.shell!(), { extraEnv: {} })
    await trustFolder(workspaces.config(root))
    await scope.refresh!()
    assert.deepEqual(scope.shell!(), { extraEnv: { PROJECT_MODE: 'dev' } })
  })

  it('give the shells of a folder the sandbox: the folder and its extra folders to write, and only the tightening its own settings ask for', async () => {
    const root = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ sandbox: { network: 'block', denyWrite: ['secrets'], allowWrite: ['/'], allowUnsandboxed: true } }) }))
    const home = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ permissions: { additionalDirectories: [] } }) }))
    const dir = await fs.realpath(await tempWorkspace())
    const policies: EnginePolicy[] = []
    const engine: SandboxEngine = {
      name: 'bubblewrap',
      limits: { reads: true, network: true, protectedPaths: 'exact', processes: true },
      probe: async () => ({ ok: true }),
      prepare: async () => undefined,
      wrap: (spec, policy) => {
        policies.push(policy)
        return { ...spec, file: '/usr/bin/fake-sandbox', args: [spec.file, ...spec.args] }
      },
    }
    const sandbox = new Sandbox({ home, dir, engine, env: {} })
    const workspaces = new Workspaces({ home, sandbox })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    // The probe has settled by the time the session has its scope, so the first request already says what Bash runs in.
    assert.equal(sandbox.status().state, 'active')
    const shell = scope.shell!()
    assert.deepEqual(shell.sandbox!('/bin/bash'), { active: true, allowUnsandboxed: true })
    const wrapped = await shell.wrapSpawn!({ file: '/bin/bash', args: ['x.sh'], env: { PATH: '/usr/bin' }, cwd: root })
    assert.equal(wrapped.file, '/usr/bin/fake-sandbox')
    assert.ok(policies[0].writable.includes(root))
    assert.ok(!policies[0].writable.includes('/'), 'a folder cannot add where commands may write')
    assert.equal(policies[0].network, false, 'a folder can block the network')
    assert.ok(policies[0].protected.includes(path.join(root, 'secrets')), 'a folder can protect more')
    assert.equal(await shell.scratchRoot!(), policies[0].temp)

    // The person turns it off in their own settings: the next command is not rewritten.
    await fs.writeFile(path.join(home, '.encode', 'settings.json'), json({ sandbox: { enabled: false } }))
    await scope.refresh!()
    assert.equal(shell.sandbox!('/bin/bash').active, false)
    assert.equal((await shell.wrapSpawn!({ file: '/bin/bash', args: ['x.sh'], env: {}, cwd: root })).file, '/bin/bash')
  })

  it('let Always allow save through the scope, and the next call see it', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const workspaces = new Workspaces({ home })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    await trustFolder(workspaces.config(root))
    const saved = await scope.remember!(['Bash(npm test:*)'], 'local')
    assert.equal(saved.ok && saved.approved, true)
    await scope.refresh!()
    const verdict = await scope.assessor!('npm test', { root, cwd: root, home, env: {}, dialect: 'bash' })
    assert.equal(verdict.decision, 'allow')
    assert.equal(verdict.source, 'rule')
  })

  it('stop everything while the settings cannot be read again, and carry on when they can', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ permissions: { deny: ['Read(./.env)'] } }) }))
    let failing = false
    const workspaces = new Workspaces({
      home,
      fs: { ...nodeWorkspaceFs, read: async (file) => (failing && file.endsWith('settings.json') ? Promise.reject(new Error('disk gone')) : nodeWorkspaceFs.read(file)) },
    })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    const query: RuleQuery = { type: 'read', paths: [path.join(root, 'README.md')] }
    assert.equal(scope.rules!.evaluate(query), null)
    failing = true
    await scope.refresh!()
    assert.equal(scope.rules!.evaluate(query)?.decision, 'deny')
    assert.match(scope.rules!.evaluate(query)?.reason ?? '', /disk gone/)
    assert.match((await reportOn(workspaces.config(root))).broken ?? '', /disk gone/)
    failing = false
    await scope.refresh!()
    assert.equal(scope.rules!.evaluate(query), null)
    assert.equal(scope.rules!.evaluate({ type: 'read', paths: [path.join(root, '.env')] })?.decision, 'deny')
    assert.equal((await reportOn(workspaces.config(root))).broken, null)
  })
})

/** A runner that answers every hook command the same way, and keeps what each was given. */
function hookRunner(answer: Partial<HookRun> = {}) {
  const calls: Array<{ command: string; env: Record<string, string>; stdin: Record<string, any> }> = []
  const runner: HookRunner = async (command, options) => {
    calls.push({ command, env: options.env, stdin: JSON.parse(options.stdin) })
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...answer }
  }
  return { runner, calls }
}

const GUARD = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } }

describe('hooks in a scope', () => {
  const event = (root: string) => ({ sessionId: 's1', agentId: 'main', root, mode: 'code' as const })
  const call = (root: string) => ({ ...event(root), tool: 'Bash', toolUseId: 'u1', input: { command: 'ls' } })

  it('wait for the folder to be trusted, then guard its calls', async () => {
    const root = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json(GUARD) }))
    const home = await fs.realpath(await tempWorkspace())
    const { runner, calls } = hookRunner({ exitCode: 2, stderr: 'not in this folder' })
    const workspaces = new Workspaces({ home, hookRunner: runner })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    assert.deepEqual(await scope.hooks!.preToolUse!(call(root)), {})
    assert.equal(calls.length, 0, 'a folder\'s own hooks run commands, which only a trusted folder may')
    assert.deepEqual((await reportOn(workspaces.config(root))).hooks, [])

    await trustFolder(workspaces.config(root))
    await scope.refresh!()
    assert.deepEqual(await scope.hooks!.preToolUse!(call(root)), { decision: 'deny', reason: 'not in this folder' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].stdin.cwd, root)
    assert.equal(calls[0].stdin.tool_name, 'Bash')
    const listed = (await reportOn(workspaces.config(root))).hooks
    assert.deepEqual(listed, [{ event: 'PreToolUse', matcher: 'Bash', command: 'guard', timeout: 60, scope: 'project' }])
  })

  it('read the settings again before a prompt, so a hook the person just added counts at once', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const { runner, calls } = hookRunner({ stdout: 'The branch is main.' })
    const workspaces = new Workspaces({ home, hookRunner: runner })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    const prompt = { ...event(root), messageId: 'm1', prompt: 'hello' }
    assert.deepEqual(await scope.hooks!.userPromptSubmit!(prompt), {})
    await fs.mkdir(path.join(home, '.encode'), { recursive: true })
    await fs.writeFile(path.join(home, '.encode', 'settings.json'), json({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'context' }] }] } }))
    assert.deepEqual(await scope.hooks!.userPromptSubmit!(prompt), { context: 'The branch is main.' })
    assert.deepEqual(calls.map((item) => item.command), ['context'])
  })

  it('run with the agent\'s environment: secrets left out, the settings\' variables added', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ ...GUARD, env: { SLACK_TOKEN: 'wanted' } }) }))
    const { runner, calls } = hookRunner()
    const workspaces = new Workspaces({ home, hookRunner: runner, env: { PATH: '/bin', OPENROUTER_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_x', EDITOR: 'vi' } })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    await scope.hooks!.preToolUse!(call(root))
    const { env } = calls[0]
    assert.equal(env.PATH, '/bin')
    assert.equal(env.EDITOR, 'vi')
    assert.equal(env.SLACK_TOKEN, 'wanted')
    assert.equal(env.OPENROUTER_API_KEY, undefined)
    assert.equal(env.GITHUB_TOKEN, undefined)
    assert.equal(env.CLAUDE_PROJECT_DIR, root)
  })

  it('run nothing while the settings cannot be trusted, and a guard that cannot be read stops the folder', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ hooks: { PreToolUse: 'oops' } }) }))
    const { runner, calls } = hookRunner()
    const workspaces = new Workspaces({ home, hookRunner: runner })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: () => undefined })
    assert.deepEqual(await scope.hooks!.preToolUse!(call(root)), {})
    assert.equal(calls.length, 0)
    const verdict = scope.rules!.evaluate({ type: 'read', paths: [path.join(root, 'a.txt')] })
    assert.equal(verdict?.decision, 'deny')
    assert.match(verdict?.reason ?? '', /hooks\.PreToolUse must be a list/)
  })

  it('tell the conversation about a hook that failed', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'format' }] }] } }) }))
    const { runner } = hookRunner({ exitCode: 1, stderr: 'prettier is not installed' })
    const notes: string[] = []
    const workspaces = new Workspaces({ home, hookRunner: runner })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: (text) => notes.push(text) })
    await scope.hooks!.postToolUse!({ ...call(root), ok: true, output: 'done' })
    assert.equal(notes.length, 1)
    assert.match(notes[0], /PostToolUse hook "format" failed \(exit 1\): prettier is not installed/)
  })
})

describe('checkpoints in a scope', () => {
  const base = (root: string) => ({ sessionId: 's1', agentId: 'main', root, mode: 'code' as const })

  async function open(extra: Record<string, string> = {}) {
    const root = await fs.realpath(await tempWorkspace({ 'a.txt': 'before', ...extra }))
    const home = await fs.realpath(await tempWorkspace())
    const store = await fs.realpath(await tempWorkspace())
    const warnings: string[] = []
    const notes: string[] = []
    const workspaces = new Workspaces({ home, checkpoints: { dir: store }, warn: (message) => warnings.push(message) })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: (text) => notes.push(text) })
    /** What the file tools do: tell the seam, write, and let the post hook record what is there. */
    const edit = async (turn: string, tool: string, file: string, text: string) => {
      const previous = await fs.readFile(file).catch(() => null)
      await scope.beforeWrite!(file, previous, { turnId: turn, toolUseId: tool })
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
      await scope.hooks!.postToolUse!({ ...base(root), tool: 'Edit', toolUseId: tool, input: {}, ok: true, output: '' })
    }
    const begin = (turn: string) => scope.hooks!.userPromptSubmit!({ ...base(root), messageId: turn, prompt: 'go' })
    return { root, home, store, workspaces, scope, edit, begin, warnings, notes }
  }

  it('keep what a turn changed and put it back, with paths relative to the folder', async () => {
    const t = await open()
    await t.begin('m1')
    await t.edit('m1', 'u1', path.join(t.root, 'a.txt'), 'after')
    await t.edit('m1', 'u2', path.join(t.root, 'src', 'new.ts'), 'created')

    const info = await t.scope.checkpoints!.info()
    assert.deepEqual(info, { available: true, turns: [{ turn: 'm1', at: info.turns[0].at, files: 2, outside: 0 }], canUndo: false })
    const plan = await t.scope.checkpoints!.plan('m1')
    assert.deepEqual(plan.files.map((file) => [file.path, file.action, file.conflict]), [['a.txt', 'restore', false], ['src/new.ts', 'delete', false]])

    const outcome = await t.scope.checkpoints!.apply({ kind: 'rewind', turn: 'm1', fingerprint: plan.fingerprint })
    assert.deepEqual(outcome, { ok: true, restored: 1, deleted: 1, skipped: [], failed: [] })
    assert.equal(await fs.readFile(path.join(t.root, 'a.txt'), 'utf8'), 'before')
    assert.equal(await exists(path.join(t.root, 'src', 'new.ts')), false)

    // The rewind can be undone.
    assert.equal((await t.scope.checkpoints!.info()).canUndo, true)
    const redo = await t.scope.checkpoints!.planRedo()
    assert.deepEqual(redo?.files.map((file) => [file.path, file.action]), [['a.txt', 'restore'], ['src/new.ts', 'restore']])
  })

  it('refuse a plan the files have moved past, and leave a file the person changed alone unless told', async () => {
    const t = await open()
    await t.begin('m1')
    await t.edit('m1', 'u1', path.join(t.root, 'a.txt'), 'agent')
    const plan = await t.scope.checkpoints!.plan('m1')
    await fs.writeFile(path.join(t.root, 'a.txt'), 'the person edited this')
    const stale = await t.scope.checkpoints!.apply({ kind: 'rewind', turn: 'm1', fingerprint: plan.fingerprint })
    assert.equal(stale.ok, false)
    assert.equal(!stale.ok && stale.reason, 'stale')

    const fresh = await t.scope.checkpoints!.plan('m1')
    assert.deepEqual(fresh.files.map((file) => [file.action, file.conflict]), [['restore', true]])
    const kept = await t.scope.checkpoints!.apply({ kind: 'rewind', turn: 'm1', fingerprint: fresh.fingerprint })
    assert.deepEqual(kept.ok && kept.skipped, [{ path: 'a.txt', reason: 'changed since the agent last wrote it' }])
    assert.equal(await fs.readFile(path.join(t.root, 'a.txt'), 'utf8'), 'the person edited this')
    const forced = await t.scope.checkpoints!.apply({ kind: 'rewind', turn: 'm1', fingerprint: fresh.fingerprint, force: true })
    assert.equal(forced.ok && forced.restored, 1)
    assert.equal(await fs.readFile(path.join(t.root, 'a.txt'), 'utf8'), 'before')
  })

  it('refuse the write when the earlier version cannot be kept', async () => {
    const t = await open()
    await t.begin('m1')
    await fs.rm(t.store, { recursive: true, force: true })
    await fs.writeFile(t.store, 'a file where the store should be')
    await assert.rejects(
      () => t.scope.beforeWrite!(path.join(t.root, 'a.txt'), Buffer.from('before'), { turnId: 'm1', toolUseId: 'u1' }),
      /could not keep the earlier version of a\.txt so that it can be put back .*so the file was not changed/,
    )
    assert.equal(await fs.readFile(path.join(t.root, 'a.txt'), 'utf8'), 'before')
  })

  it('hear of a record that cannot be updated once, and still run the prompt hooks after it', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace({ '.encode/settings.json': json({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'screen' }] }] } }) }))
    const store = path.join(await fs.realpath(await tempWorkspace()), 'store')
    await fs.writeFile(store, 'a file where the store should be')
    const { runner, calls } = hookRunner({ exitCode: 2, stderr: 'no secrets in prompts' })
    const notes: string[] = []
    const workspaces = new Workspaces({ home, checkpoints: { dir: store }, hookRunner: runner })
    const scope = await workspaces.scope({ sessionId: 's1', root, notice: (text) => notes.push(text) })
    const prompt = (messageId: string) => scope.hooks!.userPromptSubmit!({ ...base(root), messageId, prompt: 'go' })
    // The guard still sees the prompt, and still refuses it, although the record failed before it.
    assert.deepEqual(await prompt('m1'), { block: 'no secrets in prompts' })
    assert.deepEqual(await prompt('m2'), { block: 'no secrets in prompts' })
    assert.equal(calls.length, 2)
    assert.equal(notes.length, 1)
    assert.match(notes[0], /could not update the record of what the agent changes/)
    assert.deepEqual(await scope.checkpoints!.info().then((info) => info.available), true)
  })

  it('count the extra folders the settings name as part of the folder once they apply', async () => {
    const shared = await fs.realpath(await tempWorkspace({ 'lib.ts': 'shared' }))
    const t = await open({ '.encode/settings.local.json': json({ permissions: { additionalDirectories: [shared] } }) })
    await trustFolder(t.workspaces.config(t.root))
    await t.scope.refresh!()
    await t.begin('m1')
    await t.edit('m1', 'u1', path.join(shared, 'lib.ts'), 'changed')
    const info = await t.scope.checkpoints!.info()
    assert.deepEqual(info.turns.map((turn) => [turn.files, turn.outside]), [[1, 0]])
    const plan = await t.scope.checkpoints!.plan('m1')
    assert.deepEqual(plan.files.map((file) => file.path), [path.join(shared, 'lib.ts')], 'a file outside the folder is shown in full')
  })

  it('offer nothing where no store was given', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const scope = await new Workspaces({ home }).scope({ sessionId: 's1', root, notice: () => undefined })
    assert.equal(scope.checkpoints, undefined)
    assert.equal(scope.beforeWrite, undefined)
  })
})
