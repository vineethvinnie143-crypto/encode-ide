import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { AgentHost, createScriptedClient, DEFAULT_SETTINGS, readTurnReport, scrambleRecord, TURN_REPORT_KIND, type AgentSettings, type ScriptedStep, type TurnRecord, type TurnReport } from '@encode/core'
import { Workspaces } from '@encode/workspace'
import { main } from './cli'
import { compareReplay, formatReplay, playReplay, readTask, replayReport, writeReplayTask } from './index'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

// By its real path: Windows' temporary folder can be named in its short form (RUNNER~1), and the host works in the long one.
const temp = async (prefix: string) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

const BEFORE = 'export const limit = 3\nexport const name = "shop"\n'

/** A request the way a person runs one in the app, on the same host and scope, and the record of it the app would save. */
async function recordedRequest(steps: ScriptedStep[]): Promise<TurnRecord> {
  const base = await temp('replay-source-')
  const root = path.join(base, 'shop')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.js'), BEFORE)
  await fs.mkdir(path.join(base, 'home'), { recursive: true })
  const workspaces = new Workspaces({ home: path.join(base, 'home'), checkpoints: { dir: path.join(base, 'checkpoints') }, transcriptPath: (id) => path.join(base, `${id}.jsonl`) })
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, policy: 'workspace-write', computer: false }
  const host: AgentHost = new AgentHost({
    dir: path.join(base, 'sessions'),
    home: path.join(base, 'home'),
    workspace: root,
    client: createScriptedClient(steps),
    settings: () => settings,
    // The person said yes to the command.
    emit: (event) => {
      if (event.type === 'approval-request') setImmediate(() => host.approve(event.request.id, { approved: true }))
    },
    scope: workspaces.scope,
    nameSessions: false,
  })
  try {
    const session = await host.create({ projectRoot: root })
    await host.start(session.id, { text: `Raise the limit in ${path.join(root, 'src', 'a.js')} to 5 and check it`, mode: 'code' })
    const outcome = await host.turnRecord(session.id, undefined, { scramble: false })
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason)
    return outcome.record
  } finally {
    await host.dispose()
    await workspaces.close()
  }
}

const reportOf = (record: TurnRecord): TurnReport => {
  const report = readTurnReport({ kind: TURN_REPORT_KIND, version: 1, createdAt: '2026-10-24T03:00:00.000Z', build: 'eNCode test', system: 'test', description: 'The second edit missed its text.\nIt went on anyway.', ...record })
  assert.equal(typeof report, 'object', String(report))
  return report as TurnReport
}

const STEPS: ScriptedStep[] = [
  { text: 'Reading it.', calls: [{ name: 'Read', input: { file_path: 'src/a.js' } }] },
  { calls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: 'limit = 3', new_string: 'limit = 5' } }] },
  // The model edits from what it remembers, not what the file holds now.
  { calls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: 'name = "store"', new_string: 'name = "Shop"' } }] },
  { calls: [{ name: 'Bash', input: { command: 'node --version', description: 'Check node' } }] },
  { calls: [{ name: 'Read', input: { file_path: 'src/missing.js' } }] },
  { text: 'Raised the limit to 5.' },
]

describe('a report of a request, played again', () => {
  test('starts from the files as they were, makes each call again, and the tools do what they did then', async () => {
    const record = await recordedRequest(STEPS)
    assert.deepEqual(record.files.find((file) => file.path === 'src/a.js'), { path: 'src/a.js', text: BEFORE })
    const report = reportOf(record)
    const { comparison, run } = await replayReport(report)
    assert.deepEqual(
      comparison.rows.map((row) => [row.tool, row.then, row.now]),
      [
        ['Read', true, true],
        ['Edit', true, true],
        ['Edit', false, false],
        ['Read', false, false],
      ],
    )
    assert.equal(comparison.differs, 0)
    // The command was not run here: the benchmark declined it.
    assert.equal(run.metrics.declined, 1)
    assert.match(formatReplay(comparison), /Every call does what it did then\./)
  })

  test('replays the same with every word replaced, as the words are replaced the same way in the files and the calls', async () => {
    const report = reportOf(scrambleRecord(await recordedRequest(STEPS)))
    assert.equal(JSON.stringify(report).includes('limit'), false)
    const { comparison } = await replayReport(report)
    assert.equal(comparison.differs, 0, JSON.stringify(comparison.rows))
  })

  test('is kept as a task whose replay says what each call does, and a call that does something else is caught', async () => {
    const report = reportOf(await recordedRequest(STEPS))
    const tasks = await temp('replay-tasks-')
    const { dir } = await writeReplayTask(report, 'replay-missed-edit', tasks)
    const task = await readTask(dir)
    assert.equal(task.title, 'Replay: The second edit missed its text.')
    assert.deepEqual(task.tags, ['replay'])
    assert.deepEqual(task.allow, [])
    assert.equal(task.prompt, 'Raise the limit in src/a.js to 5 and check it')
    assert.equal(await fs.readFile(path.join(dir, 'project', 'src', 'a.js'), 'utf8'), BEFORE)
    assert.equal((await playReplay(task)).comparison.differs, 0)
    // As if eNCode had changed how Edit finds its text: the kept replay says so.
    const changed = { ...task, replay: { ...task.replay!, expect: task.replay!.expect.map((result, index) => (index === 2 ? { ...result, ok: true } : result)) } }
    const { comparison } = await playReplay(changed)
    assert.equal(comparison.differs, 1)
    assert.match(formatReplay(comparison), /1 call does something else now\./)
    await assert.rejects(writeReplayTask(report, 'replay-missed-edit', tasks), /there already/)
  })

  test('compares calls made on one side only, and leaves out the ones declined', () => {
    const { rows, differs } = compareReplay(
      [
        { tool: 'Read', ok: true },
        { tool: 'Write', ok: true },
        { tool: 'Edit', ok: false },
      ],
      [
        { tool: 'Read', ok: true },
        { tool: 'Bash', ok: false, declined: true },
        { tool: 'Write', ok: false, declined: true },
      ],
    )
    assert.deepEqual(
      rows.map((row) => [row.tool, row.then, row.now]),
      [
        ['Read', true, true],
        ['Write', true, 'declined'],
        ['Edit', false, undefined],
      ],
    )
    assert.equal(differs, 1)
  })

  test('from the command line: says what the report holds, plays it, and keeps it when asked', async () => {
    const report = reportOf(await recordedRequest(STEPS))
    const dir = await temp('replay-cli-')
    const file = path.join(dir, 'report.json')
    await fs.writeFile(file, JSON.stringify(report))
    const lines: string[] = []
    const run = (argv: string[]) => main(argv, { root: process.cwd(), env: {}, print: (text) => lines.push(text) })
    assert.equal(await run(['replay', file, '--save', 'missed-edit', '--tasks', dir]), 0, lines.join('\n'))
    const text = lines.join('\n')
    assert.match(text, /^What went wrong: The second edit missed its text\.$/m)
    assert.match(text, /^Request: Raise the limit in src\/a\.js to 5 and check it$/m)
    assert.match(text, /^6 steps, 5 tool calls \(2 failed\), 1 file$/m)
    assert.match(text, /Every call does what it did then\./)
    assert.match(text, /Kept as .*replay-missed-edit/)
    assert.ok(await fs.stat(path.join(dir, 'replay-missed-edit', 'replay.json')))
    lines.length = 0
    assert.equal(await run(['replay', file, '--save', 'missed-edit', '--tasks', dir]), 2)
    assert.match(lines.join('\n'), /there already; choose another name/)
    lines.length = 0
    await fs.writeFile(file, JSON.stringify({ ...report, kind: 'other' }))
    assert.equal(await run(['replay', file]), 2)
    assert.match(lines.join('\n'), /not a report of a request/)
    assert.equal(await run(['replay', file, '--save', 'Bad Name']), 2)
  })
})
