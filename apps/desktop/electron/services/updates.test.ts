import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import type { UpdateStatus } from '../../shared/types'
import {
  BUSY_POLL_MS,
  CHECK_EVERY_MS,
  feedFromEnv,
  FIRST_CHECK_MS,
  GITHUB_FEED,
  installerArgs,
  parseManifest,
  RETRY_MS,
  SWEEP_MS,
  Updater,
  type UpdateEffects,
  type UpdaterOptions,
} from './updates'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const program = Buffer.from('MZ pretend installer '.repeat(5000))
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    channel: 'tester',
    version: '0.1.0',
    build: 292,
    commit: COMMIT,
    publishedAt: '2026-10-25T14:00:00Z',
    notes: ['The agent tells its work (#90)', '  Updates   itself (#91) '],
    installer: { name: 'eNCode-0.1.0-setup.exe', size: program.length, sha256: sha(program) },
    portable: { name: 'eNCode-0.1.0-portable.exe', size: 10, sha256: 'a'.repeat(64) },
    ...overrides,
  }
}

describe('a release description', () => {
  it('is read with its notes tidied', () => {
    const read = parseManifest(JSON.stringify(manifest()))
    assert.equal(read.build, 292)
    assert.deepEqual(read.notes, ['The agent tells its work (#90)', 'Updates itself (#91)'])
    assert.equal(read.installer.sha256, sha(program))
    assert.equal(read.portable?.name, 'eNCode-0.1.0-portable.exe')
  })

  it('is refused when a file name could leave the release or the folder, or a value is not one', () => {
    const bad = (overrides: Record<string, unknown>) => assert.throws(() => parseManifest(JSON.stringify(manifest(overrides))))
    for (const name of ['../eNCode-setup.exe', 'a/b.exe', 'a\\b.exe', 'setup.msi', '.exe', 'x..exe', '%2e%2e.exe']) bad({ installer: { name, size: 5, sha256: 'a'.repeat(64) } })
    bad({ installer: { name: 'ok.exe', size: 5, sha256: 'A'.repeat(64) } })
    bad({ installer: { name: 'ok.exe', size: 0, sha256: 'a'.repeat(64) } })
    bad({ installer: { name: 'ok.exe', size: 2 * 1024 ** 3, sha256: 'a'.repeat(64) } })
    bad({ installer: undefined })
    bad({ schema: 2 })
    bad({ build: 0 })
    bad({ build: 1.5 })
    bad({ commit: 'abc' })
    bad({ channel: 'Tester!' })
    bad({ version: 'latest' })
    bad({ publishedAt: 'soon' })
    assert.throws(() => parseManifest('not json'), /not JSON/)
    assert.throws(() => parseManifest('[]'), /not an object/)
  })
})

describe('where updates come from', () => {
  it('is GitHub unless a test names a page on this computer, or turns it off', () => {
    assert.equal(feedFromEnv(undefined), GITHUB_FEED)
    assert.equal(feedFromEnv(''), GITHUB_FEED)
    assert.equal(feedFromEnv('off'), null)
    assert.equal(feedFromEnv('https://example.com/encode-update.json'), GITHUB_FEED, 'no setting sends the updater to another server')
    assert.equal(feedFromEnv('http://192.168.1.4:8080/encode-update.json'), GITHUB_FEED)
    const local = feedFromEnv('http://127.0.0.1:4567/encode-update.json')!
    assert.equal(local.manifest, 'http://127.0.0.1:4567/encode-update.json')
    assert.equal(local.downloads, 'http://127.0.0.1:4567/download')
    assert.ok(local.trusted('http://127.0.0.1:4567/download/build-3/x.exe'))
    assert.ok(!local.trusted('http://127.0.0.1:4568/download/build-3/x.exe'))
  })

  it('trusts GitHub and its storage over HTTPS only', () => {
    assert.ok(GITHUB_FEED.trusted('https://github.com/vineethvinnie143-crypto/encode-ide/releases/download/build-1/a.exe'))
    assert.ok(GITHUB_FEED.trusted('https://release-assets.githubusercontent.com/github-production-release-asset/1'))
    assert.ok(GITHUB_FEED.trusted('https://objects.githubusercontent.com/x'))
    assert.ok(!GITHUB_FEED.trusted('http://github.com/x'))
    assert.ok(!GITHUB_FEED.trusted('https://githubusercontent.com.example.com/x'))
    assert.ok(!GITHUB_FEED.trusted('https://example.com/github.com'))
    assert.ok(!GITHUB_FEED.trusted('not a url'))
  })

  it('runs the installer silently into the running copy, with the folder last', () => {
    assert.deepEqual(installerArgs('C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\eNCode'), ['--updated', '/S', '--force-run', '/D=C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\eNCode'])
  })
})

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-updates-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

interface Served {
  status?: number
  body?: Buffer | string
  /** Where the response says it came from, after redirects. */
  url?: string
  chunks?: number
}

function harness(options: { own?: number; kind?: UpdaterOptions['kind']; auto?: boolean; busy?: boolean; channel?: string; serve?: Record<string, Served | (() => Served)>; feed?: UpdaterOptions['feed'] } = {}) {
  const feed = options.feed === undefined ? feedFromEnv('http://127.0.0.1:9/encode-update.json') : options.feed
  const serve: Record<string, Served | (() => Served)> = options.serve ?? {
    'http://127.0.0.1:9/encode-update.json': { body: JSON.stringify(manifest()) },
    'http://127.0.0.1:9/download/build-292/eNCode-0.1.0-setup.exe': { body: program, chunks: 4 },
  }
  const fetched: string[] = []
  const timers = new Map<number, { run: () => void; ms: number }>()
  let nextTimer = 1
  let clock = 1_000_000
  const statuses: UpdateStatus[] = []
  const restarts: { installer: string; args: string[] }[] = []
  const logs: string[] = []
  const state = { busy: options.busy ?? false, auto: options.auto ?? true }
  const effects: UpdateEffects = {
    fetch: async (url) => {
      fetched.push(url)
      const entry = serve[url]
      const served = typeof entry === 'function' ? entry() : entry
      if (!served) return new Response('missing', { status: 404 })
      const bytes = typeof served.body === 'string' ? Buffer.from(served.body) : (served.body ?? Buffer.alloc(0))
      const parts = served.chunks ?? 1
      const size = Math.ceil(bytes.length / parts)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += size) controller.enqueue(new Uint8Array(bytes.subarray(at, at + size)))
          controller.close()
        },
      })
      const response = new Response(stream, { status: served.status ?? 200 })
      Object.defineProperty(response, 'url', { value: served.url ?? url })
      return response
    },
    restartInto: (installer, args) => restarts.push({ installer, args }),
    busy: () => state.busy,
    autoCheck: () => state.auto,
    now: () => {
      clock += 500
      return clock
    },
    setTimer: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { run, ms })
      return id
    },
    clearTimer: (timer) => {
      timers.delete(timer as number)
    },
    onStatus: (status) => statuses.push(status),
    log: (line) => logs.push(line),
  }
  const dir = path.join(root, 'updates')
  const recordFile = path.join(root, 'profile', 'eNCode-update.json')
  const make = (own = options.own ?? 291) =>
    new Updater({ own: { build: own, channel: options.channel ?? 'tester' }, kind: options.kind ?? 'installed', installDir: 'C:\\eNCode', dir, recordFile, feed }, effects)
  /** Runs the timers due now (the ones set for `ms`), as the clock would. */
  const fire = (ms: number) => {
    const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms)
    for (const [id, timer] of due) {
      timers.delete(id)
      timer.run()
    }
    return due.length
  }
  return { make, effects, fetched, timers, statuses, restarts, logs, state, dir, recordFile, fire, serve }
}

describe('the updater', () => {
  it('is off for a build that is not a tester build, a copy that was not installed, and a run that turned it off', () => {
    for (const [options, reason] of [
      [{ channel: 'dev' }, /Only the tester builds/],
      [{ own: 0 }, /Only the tester builds/],
      [{ kind: 'unpacked' as const }, /not installed with the installer/],
      [{ feed: null }, /Turned off/],
    ] as const) {
      const test = harness(options)
      const updater = test.make()
      updater.start()
      const status = updater.status()
      assert.equal(status.state, 'off')
      assert.match(status.state === 'off' ? status.reason : '', reason)
      assert.equal(test.timers.size, 0, 'nothing is planned')
    }
  })

  it('looks first after the start is over, downloads a newer build, checks it, and keeps it for the restart', async () => {
    const test = harness()
    const updater = test.make()
    updater.start()
    assert.equal(updater.status().state, 'idle')
    assert.deepEqual([...test.timers.values()].map((timer) => timer.ms), [FIRST_CHECK_MS])
    test.fire(FIRST_CHECK_MS)
    const status = await updater.check()
    assert.equal(status.state, 'ready')
    assert.equal(status.state === 'ready' && status.next.build, 292)
    assert.deepEqual(status.state === 'ready' && status.next.notes, ['The agent tells its work (#90)', 'Updates itself (#91)'])
    assert.ok(status.checkedAt)
    assert.deepEqual(test.fetched, ['http://127.0.0.1:9/encode-update.json', 'http://127.0.0.1:9/download/build-292/eNCode-0.1.0-setup.exe'])
    const kept = path.join(test.dir, 'eNCode-build-292-setup.exe')
    assert.deepEqual(fs.readFileSync(kept), program)
    assert.deepEqual(fs.readdirSync(test.dir).sort(), ['eNCode-build-292-setup.exe', 'ready.json'])
    assert.ok(test.statuses.some((seen) => seen.state === 'checking'))
    assert.ok(test.statuses.some((seen) => seen.state === 'downloading' && seen.received > 0 && seen.received <= program.length))
    assert.deepEqual([...test.timers.values()].map((timer) => timer.ms), [CHECK_EVERY_MS], 'the next look is in four hours')
    updater.dispose()
  })

  it('stays as it is for the same build, an older one or another channel', async () => {
    for (const changed of [{ build: 291 }, { build: 12 }, { channel: 'beta' }]) {
      const test = harness({ serve: { 'http://127.0.0.1:9/encode-update.json': { body: JSON.stringify(manifest(changed)) } } })
      const updater = test.make()
      updater.start()
      const status = await updater.check()
      assert.equal(status.state, 'idle', JSON.stringify(changed))
      assert.equal(test.fetched.length, 1, 'nothing is downloaded')
    }
  })

  it('throws away a download that does not match its fingerprint or its size, or comes from elsewhere', async () => {
    const other = Buffer.from(program)
    other[10] = 0
    const cases: [Served, RegExp][] = [
      [{ body: other }, /fingerprint/],
      [{ body: Buffer.concat([program, Buffer.from('more')]) }, /larger than its release says/],
      [{ body: program.subarray(0, 100) }, /ended early/],
      [{ body: program, url: 'http://127.0.0.1:10/elsewhere.exe' }, /does not trust/],
      [{ status: 500, body: 'no' }, /answered 500/],
    ]
    for (const [served, message] of cases) {
      const test = harness({
        serve: { 'http://127.0.0.1:9/encode-update.json': { body: JSON.stringify(manifest()) }, 'http://127.0.0.1:9/download/build-292/eNCode-0.1.0-setup.exe': served },
      })
      const updater = test.make()
      updater.start()
      const status = await updater.check()
      assert.equal(status.state, 'error')
      assert.match(status.state === 'error' ? status.message : '', message)
      assert.deepEqual(fs.existsSync(test.dir) ? fs.readdirSync(test.dir) : [], [], 'nothing is kept')
      assert.deepEqual([...test.timers.values()].map((timer) => timer.ms), [RETRY_MS], 'it tries again in half an hour')
    }
  })

  it('says plainly when the description cannot be had or read', async () => {
    const cases: [Served | undefined, RegExp][] = [
      [undefined, /No tester build is published yet/],
      [{ body: 'x'.repeat(70 * 1024) }, /too large/],
      [{ body: '{"schema":1}' }, /not valid: its channel/],
      [{ body: JSON.stringify(manifest()), url: 'http://127.0.0.1:99/encode-update.json' }, /does not trust/],
    ]
    for (const [served, message] of cases) {
      const test = harness({ serve: served ? { 'http://127.0.0.1:9/encode-update.json': served } : {} })
      const updater = test.make()
      updater.start()
      const status = await updater.check()
      assert.match(status.state === 'error' ? status.message : status.state, message)
    }
    const offline = harness()
    offline.effects.fetch = async () => {
      throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
    }
    const updater = offline.make()
    updater.start()
    const status = await updater.check()
    assert.match(status.state === 'error' ? status.message : '', /Could not reach GitHub/)
  })

  it('restarts into the download at once when no agent is busy, after checking it again', async () => {
    const test = harness()
    const updater = test.make()
    updater.start()
    await updater.check()
    const status = await updater.install()
    assert.equal(status.state, 'installing')
    assert.deepEqual(test.restarts, [{ installer: path.join(test.dir, 'eNCode-build-292-setup.exe'), args: installerArgs('C:\\eNCode') }])
    const record = JSON.parse(fs.readFileSync(test.recordFile, 'utf8'))
    assert.deepEqual({ from: record.attempt.from, to: record.attempt.to }, { from: 291, to: 292 })
    assert.equal(test.timers.size, 0, 'no more looks are planned')
    assert.equal((await updater.check()).state, 'installing', 'a look while it installs changes nothing')
  })

  it('waits while an agent works, and can stop waiting', async () => {
    const test = harness({ busy: true })
    const updater = test.make()
    updater.start()
    await updater.check()
    const waiting = await updater.install()
    assert.equal(waiting.state === 'ready' && waiting.waiting, true)
    assert.equal(test.restarts.length, 0)
    assert.equal(test.fire(BUSY_POLL_MS), 1)
    assert.equal(test.restarts.length, 0, 'still busy: it looks again later')
    test.state.busy = false
    test.fire(BUSY_POLL_MS)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(test.restarts.length, 1, 'the agents are done: it restarts')

    const again = harness({ busy: true })
    const other = again.make()
    other.start()
    await other.check()
    await other.install()
    const stopped = other.cancel()
    assert.equal(stopped.state === 'ready' && stopped.waiting, false)
    assert.equal(again.fire(BUSY_POLL_MS), 0, 'the wait is over')
    assert.equal(again.restarts.length, 0)
  })

  it('does not restart into a download that changed on the disk', async () => {
    const test = harness()
    const updater = test.make()
    updater.start()
    await updater.check()
    fs.appendFileSync(path.join(test.dir, 'eNCode-build-292-setup.exe'), 'tampered')
    const status = await updater.install()
    assert.equal(status.state, 'error')
    assert.match(status.state === 'error' ? status.message : '', /changed on the disk/)
    assert.equal(test.restarts.length, 0)
    assert.deepEqual(fs.readdirSync(test.dir), [])
  })

  it('tells once at the next start whether the update took, and does not offer one that did not again', async () => {
    const test = harness()
    const first = test.make()
    first.start()
    await first.check()
    await first.install()

    const updated = test.make(292)
    updated.start()
    assert.deepEqual(updated.outcome(), { updated: true, from: 291, to: 292 })
    assert.equal(updated.outcome(), null, 'told once')
    assert.deepEqual(fs.existsSync(test.dir) ? fs.readdirSync(test.dir) : [], [], 'the download is no longer newer: it goes')
    assert.ok(test.logs.some((line) => /updated from build 291 to build 292/.test(line)))

    const again = harness()
    const before = again.make()
    before.start()
    await before.check()
    await before.install()
    const notTaken = again.make(291)
    notTaken.start()
    assert.deepEqual(notTaken.outcome(), { updated: false, from: 291, to: 292 })
    const status = await notTaken.check()
    assert.equal(status.state, 'manual')
    assert.match(status.state === 'manual' ? status.reason : '', /did not install, so it is not tried again/)
    assert.equal(again.fetched.filter((url) => url.endsWith('.exe')).length, 1, 'not downloaded again')

    const record = JSON.parse(fs.readFileSync(again.recordFile, 'utf8'))
    assert.deepEqual(record, { failed: [292] })
  })

  it('deletes the installer it ran once the installer lets go of it', async () => {
    const test = harness()
    const first = test.make()
    first.start()
    await first.check()
    await first.install()

    // The installer started the new copy and is still finishing, so its own file cannot be deleted yet.
    const rmSync = fs.rmSync.bind(fs)
    const held = new Set(['eNCode-build-292-setup.exe'])
    mock.method(fs, 'rmSync', (target: fs.PathLike, options?: fs.RmOptions) => {
      if (held.has(path.basename(String(target)))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return rmSync(target, options)
    })
    try {
      const updated = test.make(292)
      updated.start()
      assert.deepEqual(fs.readdirSync(test.dir), ['eNCode-build-292-setup.exe'], 'what could go went')
      assert.equal(test.fire(SWEEP_MS), 1)
      assert.deepEqual(fs.readdirSync(test.dir), ['eNCode-build-292-setup.exe'], 'still held')
      held.clear()
      assert.equal(test.fire(SWEEP_MS * 2), 1, 'tried again, later')
      assert.deepEqual(fs.readdirSync(test.dir), [])
      assert.ok(![...test.timers.values()].some((timer) => timer.ms < FIRST_CHECK_MS), 'no more sweeps')
      updated.dispose()

      // Held for good: it gives up after six tries, and says so.
      fs.writeFileSync(path.join(test.dir, 'stuck.exe'), 'x')
      held.add('stuck.exe')
      const stuck = test.make(292)
      stuck.start()
      let tries = 0
      for (let ms = SWEEP_MS; test.fire(ms); ms *= 2) tries++
      assert.equal(tries, 6)
      assert.ok(test.logs.some((line) => /could not delete stuck\.exe from the download folder/.test(line)))
      stuck.dispose()
    } finally {
      mock.restoreAll()
    }
  })

  it('keeps a download that is still newer for the next run, without downloading it again', async () => {
    const test = harness()
    const first = test.make()
    first.start()
    await first.check()
    first.dispose()
    const next = test.make()
    next.start()
    const status = next.status()
    assert.equal(status.state, 'ready')
    assert.equal(test.fetched.length, 2)
    fs.writeFileSync(path.join(test.dir, 'stray.partial'), 'x')
    const third = test.make()
    third.start()
    assert.deepEqual(fs.readdirSync(test.dir).sort(), ['eNCode-build-292-setup.exe', 'ready.json'], 'anything else in the folder goes')
  })

  it('sends the portable program to the release page', async () => {
    const test = harness({ kind: 'portable' })
    const updater = test.make()
    updater.start()
    const status = await updater.check()
    assert.equal(status.state, 'manual')
    assert.match(status.state === 'manual' ? status.reason : '', /portable program/)
    assert.equal(test.fetched.length, 1)
  })

  it('looks by itself only while the setting is on, and always when asked', async () => {
    const test = harness({ auto: false })
    const updater = test.make()
    updater.start()
    assert.equal(test.timers.size, 0)
    assert.equal(updater.status().auto, false)
    assert.equal((await updater.check()).state, 'ready', 'asked: it looks')
    assert.equal(test.timers.size, 0, 'and plans no next look')
    test.state.auto = true
    updater.settingsChanged()
    assert.equal(test.timers.size, 1)
    assert.ok([...test.timers.values()][0]!.ms > CHECK_EVERY_MS - 10_000, 'the next look is four hours after the last')
    test.state.auto = false
    updater.settingsChanged()
    assert.equal(test.timers.size, 0)
  })

  it('looks once at a time', async () => {
    const test = harness()
    const updater = test.make()
    updater.start()
    const [one, two] = await Promise.all([updater.check(), updater.check()])
    assert.equal(one, two)
    assert.equal(test.fetched.length, 2)
  })
})
