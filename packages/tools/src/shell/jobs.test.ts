import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { describe, it } from 'node:test'
import { createJobManager } from './jobs'
import type { ManagedShell } from './run'

/** A shell whose one background command prints and ends when the test says so. */
function scripted() {
  let print: (text: string) => void = () => {}
  let end: (exitCode: number) => void = () => {}
  const shell = {
    dialect: 'bash',
    program: '/bin/bash',
    removedEnv: [],
    state: () => ({ cwd: '/work', env: {}, dialect: 'bash' }),
    run: async () => {
      throw new Error('This test runs nothing in the foreground.')
    },
    setCwd: async () => true,
    dispose: async () => {},
    start: async (_command: string, options: { onOutput?(text: string): void }) => {
      print = (text) => options.onOutput?.(text)
      const done = new Promise<{ exitCode: number | null; signal: string | null; cwdFile: string }>((resolve) => {
        end = (exitCode) => resolve({ exitCode, signal: null, cwdFile: '' })
      })
      return { child: {} as ChildProcess, done, kill: async () => end(143) }
    },
  } as unknown as ManagedShell
  return { shell, print: (text: string) => print(text), end: (exitCode: number) => end(exitCode) }
}

const never = () => new AbortController().signal
const later = (ms: number, then: () => void) => setTimeout(then, ms)

describe('waiting for a background command (ADR 0153)', () => {
  it('returns at once for output not read yet, a command that ended, one that is not known, or a wait already stopped', async () => {
    const { shell, print, end } = scripted()
    const jobs = createJobManager(shell)
    const job = await jobs.start('build', {})
    const timed = async (id: string, signal = never()) => {
      const started = Date.now()
      await jobs.wait(id, 10_000, signal)
      return Date.now() - started
    }
    print('compiling\n')
    assert.ok((await timed(job.id)) < 1_000, 'output not read yet')
    jobs.read(job.id)
    const stopped = new AbortController()
    stopped.abort()
    assert.ok((await timed(job.id, stopped.signal)) < 1_000, 'a wait already stopped')
    assert.ok((await timed('bash_99')) < 1_000, 'not known')
    end(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok((await timed(job.id)) < 1_000, 'ended')
  })

  it('returns when output comes, with the rest of that burst', async () => {
    const { shell, print } = scripted()
    const jobs = createJobManager(shell)
    const job = await jobs.start('build', {})
    later(50, () => print('one\n'))
    later(120, () => print('two\n'))
    const started = Date.now()
    await jobs.wait(job.id, 10_000, never())
    assert.ok(Date.now() - started < 5_000)
    assert.equal(jobs.read(job.id)?.output, 'one\ntwo\n')
  })

  it('returns when the command ends, with its status', async () => {
    const { shell, end } = scripted()
    const jobs = createJobManager(shell)
    const job = await jobs.start('build', {})
    later(50, () => end(2))
    const started = Date.now()
    await jobs.wait(job.id, 10_000, never())
    assert.ok(Date.now() - started < 5_000)
    assert.deepEqual([jobs.read(job.id)?.job.status, jobs.read(job.id)?.job.exitCode], ['error', 2])
  })

  it('returns when the time is up, and when it is stopped, and then holds nothing back', async () => {
    const { shell, print } = scripted()
    const jobs = createJobManager(shell)
    const job = await jobs.start('build', {})
    let started = Date.now()
    await jobs.wait(job.id, 150, never())
    const waited = Date.now() - started
    assert.ok(waited >= 100 && waited < 5_000, `${waited} ms`)

    const stop = new AbortController()
    later(50, () => stop.abort())
    started = Date.now()
    await jobs.wait(job.id, 10_000, stop.signal)
    assert.ok(Date.now() - started < 5_000)

    // Output that comes after a wait is over wakes no one and breaks nothing; the next wait sees it at once.
    print('late\n')
    started = Date.now()
    await jobs.wait(job.id, 10_000, never())
    assert.ok(Date.now() - started < 1_000)
    assert.equal(jobs.read(job.id)?.output, 'late\n')
  })

  it('ends every wait when the manager is disposed', async () => {
    const { shell } = scripted()
    const jobs = createJobManager(shell)
    const job = await jobs.start('build', {})
    const waiting = jobs.wait(job.id, 60_000, never())
    await jobs.dispose()
    await waiting
  })
})
