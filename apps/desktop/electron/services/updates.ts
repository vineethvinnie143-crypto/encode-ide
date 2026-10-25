/**
 * Tester builds update themselves (ADR 0127). Each tester build is a GitHub release that carries the installer, the
 * portable program and encode-update.json, which names the build and each file's size and SHA-256. This reads that
 * file when eNCode starts and every four hours, downloads a newer installer in the background, checks its size and
 * fingerprint, and runs it when the person restarts for it, never while an agent works. Electron's parts (the fetch,
 * starting the installer, quitting) are behind `UpdateEffects`, so the rules are unit tested.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { UpdateBuild, UpdateOutcome, UpdateStatus } from '../../shared/types'
import { writePrivateFile } from './private-file'

export const REPOSITORY = 'vineethvinnie143-crypto/encode-ide'

/** Where the releases are: the newest one's description, and each one's files and page. */
export interface UpdateFeed {
  manifest: string
  /** `<downloads>/build-<n>/<file>` is a file of build n's release. */
  downloads: string
  /** Whether a response may come from this address, after any redirects. */
  trusted(url: string): boolean
}

export const GITHUB_FEED: UpdateFeed = {
  manifest: `https://github.com/${REPOSITORY}/releases/latest/download/encode-update.json`,
  downloads: `https://github.com/${REPOSITORY}/releases/download`,
  // GitHub answers a release file with a redirect to its storage.
  trusted: (url) => {
    const parsed = safeUrl(url)
    return parsed?.protocol === 'https:' && (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.githubusercontent.com'))
  },
}

/** A release's page, which the person opens for a build the updater does not install itself. */
export const releasePage = (build: number): string => `https://github.com/${REPOSITORY}/releases/tag/build-${build}`

/** The first look waits until the start is over; then every four hours, and half an hour after one that failed. */
export const FIRST_CHECK_MS = 30_000
export const CHECK_EVERY_MS = 4 * 60 * 60_000
export const RETRY_MS = 30 * 60_000
/** While a restart waits for the agents, how often it looks again. */
export const BUSY_POLL_MS = 5_000
/** A description that takes longer than this, or a download that stalls this long, is given up on. */
export const MANIFEST_TIMEOUT_MS = 30_000
export const STALL_MS = 60_000
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_PROGRAM_BYTES = 1024 ** 3
const PROGRESS_EVERY_MS = 400
/** Builds whose update did not take, remembered so that one is not offered again and again. */
const FAILED_KEPT = 10
/**
 * The installer that updated this copy starts it before it exits, and holds its own file until then: what the start
 * could not delete is tried again after 2 s, 4 s, 8 s and so on, six times in all.
 */
export const SWEEP_MS = 2_000
const SWEEPS = 6

/**
 * The feed a run uses, from ENCODE_UPDATE_FEED: unset is GitHub, "off" is none, and a page on this computer
 * (http://127.0.0.1 or http://localhost) is a test's, whose files are under `<origin>/download`. Anything else is
 * ignored: no setting sends the updater to another server.
 */
export function feedFromEnv(value: string | undefined): UpdateFeed | null {
  const named = value?.trim()
  if (!named) return GITHUB_FEED
  if (named === 'off') return null
  const url = safeUrl(named)
  if (!url || url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) return GITHUB_FEED
  return { manifest: url.href, downloads: `${url.origin}/download`, trusted: (candidate) => safeUrl(candidate)?.origin === url.origin }
}

export const isTestFeed = (feed: UpdateFeed | null): boolean => feed !== null && feed !== GITHUB_FEED

export interface ReleaseFile {
  name: string
  size: number
  sha256: string
}

/** encode-update.json, written by scripts/release-manifest.mjs. */
export interface UpdateManifest {
  schema: 1
  channel: string
  version: string
  build: number
  commit: string
  publishedAt: string
  notes: string[]
  installer: ReleaseFile
  portable?: ReleaseFile
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function releaseFile(value: unknown, what: string): ReleaseFile {
  if (!isRecord(value)) throw new Error(`it names no ${what}`)
  const { name, size, sha256 } = value
  // A plain file name: it is put after the release's address and on this computer's disk.
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.exe$/.test(name) || name.includes('..')) throw new Error(`the ${what}'s name is not a program's`)
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_PROGRAM_BYTES) throw new Error(`the ${what}'s size is not one`)
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`the ${what}'s fingerprint is not a SHA-256`)
  return { name, size, sha256 }
}

/** Reads a release's description; throws with what is wrong in it. */
export function parseManifest(text: string): UpdateManifest {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('it is not JSON')
  }
  if (!isRecord(data)) throw new Error('it is not an object')
  if (data.schema !== 1) throw new Error('it is of a kind this build does not read')
  const { channel, version, build, commit, publishedAt, notes } = data
  if (typeof channel !== 'string' || !/^[a-z]{1,20}$/.test(channel)) throw new Error('its channel is not one')
  if (typeof version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/.test(version)) throw new Error('its version is not one')
  if (typeof build !== 'number' || !Number.isSafeInteger(build) || build < 1 || build > 999_999_999) throw new Error('its build number is not one')
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('its commit is not one')
  if (typeof publishedAt !== 'string' || publishedAt.length > 40 || Number.isNaN(Date.parse(publishedAt))) throw new Error('its date is not one')
  const lines = Array.isArray(notes) ? notes.filter((line): line is string => typeof line === 'string') : []
  return {
    schema: 1,
    channel,
    version,
    build,
    commit,
    publishedAt,
    // Shown as plain text: a line each, short, at most twenty.
    notes: lines.map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 20),
    installer: releaseFile(data.installer, 'installer'),
    ...(data.portable === undefined ? {} : { portable: releaseFile(data.portable, 'portable program') }),
  }
}

/** The installer's arguments for an update: silent, as an update, into the running copy's folder, and started after. */
export function installerArgs(installDir: string): string[] {
  // NSIS reads the folder from the end of the line, unquoted, so /D comes last.
  return ['--updated', '/S', '--force-run', `/D=${installDir}`]
}

export interface UpdateEffects {
  fetch(url: string, signal: AbortSignal): Promise<Response>
  /** Closes eNCode, and starts the installer once it has closed. */
  restartInto(installer: string, args: string[]): void
  /** An agent is working, or waiting for the person in a request. */
  busy(): boolean
  /** Settings > General: look for updates by itself. */
  autoCheck(): boolean
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  onStatus(status: UpdateStatus): void
  log(line: string): void
}

export interface UpdaterOptions {
  /** This program's tester build and channel. */
  own: { build: number; channel: string }
  /** How this copy came to be on the computer; only an installed one installs updates itself. */
  kind: 'installed' | 'portable' | 'unpacked'
  /** The running program's folder, which the installer replaces. */
  installDir: string
  /** Where a download waits for the restart; eNCode keeps nothing else in it. */
  dir: string
  /** The record of a restart to update, read when eNCode starts again. */
  recordFile: string
  feed: UpdateFeed | null
  firstCheckMs?: number
}

interface Downloaded extends UpdateBuild {
  file: string
  sha256: string
}

interface UpdateRecord {
  attempt?: { from: number; to: number; at: number }
  failed: number[]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** The status without what every one of them carries. */
type Phase = DistributiveOmit<UpdateStatus, 'build' | 'auto' | 'checkedAt'>

const READY_FILE = 'ready.json'

/** What a failed look or download tells the person: one sentence, never a server's own text. */
class UpdateError extends Error {}

export class Updater {
  private phase: Phase = { state: 'idle' }
  private checkedAt: number | null = null
  private timer: unknown = null
  private busyTimer: unknown = null
  private sweepTimer: unknown = null
  private running: Promise<UpdateStatus> | null = null
  private readonly abort = new AbortController()
  private downloaded: Downloaded | null = null
  private told: UpdateOutcome | null = null
  private failed: number[] = []
  private disposed = false

  constructor(
    private readonly options: UpdaterOptions,
    private readonly effects: UpdateEffects,
  ) {}

  /** Reads how the last restart to update ended, keeps a download that is still newer, and plans the first look. */
  start(): void {
    const reason = this.offReason()
    if (reason) {
      this.phase = { state: 'off', reason }
      return
    }
    this.readRecord()
    this.restoreDownload()
    if (this.downloaded) this.phase = { state: 'ready', next: publicBuild(this.downloaded), waiting: false }
    this.schedule(this.options.firstCheckMs ?? FIRST_CHECK_MS)
  }

  status(): UpdateStatus {
    return { build: this.options.own.build, auto: this.effects.autoCheck(), checkedAt: this.checkedAt, ...this.phase } as UpdateStatus
  }

  /** How the last restart to update ended; told once. */
  outcome(): UpdateOutcome | null {
    const told = this.told
    this.told = null
    return told
  }

  /** Looks at the release now (the person asked, or the timer), and downloads a newer installer. */
  check(): Promise<UpdateStatus> {
    if (this.phase.state === 'off' || this.phase.state === 'installing' || this.disposed) return Promise.resolve(this.status())
    if (this.running) return this.running
    this.running = this.look().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** The person asked to restart: now, or once no agent is busy. */
  async install(): Promise<UpdateStatus> {
    if (this.phase.state !== 'ready' || this.disposed) return this.status()
    if (this.effects.busy()) {
      this.phase = { ...this.phase, waiting: true }
      this.emit()
      this.waitForAgents()
      return this.status()
    }
    await this.restart()
    return this.status()
  }

  /** Stops waiting to restart; the download stays ready. */
  cancel(): UpdateStatus {
    if (this.phase.state === 'ready' && this.phase.waiting) {
      this.phase = { ...this.phase, waiting: false }
      this.stopWaiting()
      this.emit()
    }
    return this.status()
  }

  /** The setting changed: plan the next look, or stop looking by itself. */
  settingsChanged(): void {
    if (this.phase.state === 'off' || this.disposed) return
    if (!this.effects.autoCheck()) this.unschedule()
    else if (this.timer === null) {
      const due = this.checkedAt === null ? (this.options.firstCheckMs ?? FIRST_CHECK_MS) : this.checkedAt + CHECK_EVERY_MS - this.effects.now()
      this.schedule(Math.max(due, 1_000))
    }
    this.emit()
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.unschedule()
    this.stopWaiting()
    if (this.sweepTimer !== null) this.effects.clearTimer(this.sweepTimer)
    this.sweepTimer = null
  }

  private offReason(): string | null {
    const { own, kind, feed } = this.options
    if (own.channel !== 'tester' || own.build < 1) return 'Only the tester builds update themselves, and this one was built elsewhere.'
    if (kind === 'unpacked') return 'This copy was not installed with the installer, so it does not update itself.'
    if (!feed) return 'Turned off for this run.'
    return null
  }

  private async look(): Promise<UpdateStatus> {
    const feed = this.options.feed!
    const before = this.phase
    if (before.state !== 'ready') {
      this.phase = { state: 'checking' }
      this.emit()
    }
    let failed = false
    try {
      const manifest = await this.readManifest(feed)
      this.checkedAt = this.effects.now()
      this.decide(manifest, before)
      if (this.phase.state === 'downloading') {
        this.emit()
        await this.download(feed, manifest)
      }
    } catch (error) {
      failed = true
      if (this.disposed) return this.status()
      const message = error instanceof UpdateError ? error.message : 'Could not look for updates.'
      this.effects.log(`[updates] ${message}${error instanceof UpdateError ? '' : ` (${(error as Error).message})`}`)
      // A ready download stays ready when a later look fails.
      this.phase = this.downloaded ? { state: 'ready', next: publicBuild(this.downloaded), waiting: before.state === 'ready' && before.waiting } : { state: 'error', message }
    }
    this.emit()
    if (this.effects.autoCheck()) this.schedule(failed ? RETRY_MS : CHECK_EVERY_MS)
    return this.status()
  }

  private decide(manifest: UpdateManifest, before: Phase): void {
    const { own, kind } = this.options
    const next = buildOf(manifest)
    if (manifest.channel !== own.channel || manifest.build <= own.build) {
      this.phase = { state: 'idle' }
    } else if (this.failed.includes(manifest.build)) {
      this.phase = { state: 'manual', next, reason: `The update to build ${manifest.build} did not install, so it is not tried again. Install it from its release page.` }
    } else if (kind === 'portable') {
      this.phase = { state: 'manual', next, reason: 'This is the portable program, which does not replace itself. Download the new one from the release page.' }
    } else if (this.downloaded && this.downloaded.build >= manifest.build) {
      this.phase = { state: 'ready', next: publicBuild(this.downloaded), waiting: before.state === 'ready' && before.waiting }
    } else {
      this.phase = { state: 'downloading', next, received: 0 }
    }
  }

  private async readManifest(feed: UpdateFeed): Promise<UpdateManifest> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)])
    let response: Response
    try {
      response = await this.effects.fetch(feed.manifest, signal)
    } catch {
      throw new UpdateError('Could not reach GitHub to look for updates.')
    }
    if (!feed.trusted(response.url || feed.manifest)) throw new UpdateError('The release answered from an address eNCode does not trust, so it was not read.')
    // No release yet, or none published as the newest.
    if (response.status === 404) throw new UpdateError('No tester build is published yet.')
    if (!response.ok) throw new UpdateError(`GitHub answered ${response.status} for the newest release.`)
    const bytes = await readCapped(response, MAX_MANIFEST_BYTES)
    if (!bytes) throw new UpdateError('The newest release’s description is too large to be one.')
    try {
      return parseManifest(new TextDecoder().decode(bytes))
    } catch (error) {
      throw new UpdateError(`The newest release’s description is not valid: ${(error as Error).message}.`)
    }
  }

  private async download(feed: UpdateFeed, manifest: UpdateManifest): Promise<void> {
    const { dir } = this.options
    const want = manifest.installer
    if (this.clearDir().length) this.sweepLater()
    this.downloaded = null
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `eNCode-build-${manifest.build}-setup.exe`)
    const partial = `${file}.partial`
    const url = `${feed.downloads}/build-${manifest.build}/${encodeURIComponent(want.name)}`
    this.effects.log(`[updates] build ${manifest.build} is out; downloading ${want.name} (${want.size} bytes)`)

    // A download that stops sending is given up on; the next look tries again.
    const stall = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, stall.signal])
    let stallTimer: unknown = null
    const touch = () => {
      if (stallTimer !== null) this.effects.clearTimer(stallTimer)
      stallTimer = this.effects.setTimer(() => stall.abort(), STALL_MS)
    }
    touch()
    const handle = await fs.promises.open(partial, 'w')
    let completed = false
    try {
      let response: Response
      try {
        response = await this.effects.fetch(url, signal)
      } catch {
        throw new UpdateError('Could not download the new build.')
      }
      if (!feed.trusted(response.url || url)) throw new UpdateError('The download came from an address eNCode does not trust, so it was not kept.')
      if (!response.ok || !response.body) throw new UpdateError(`GitHub answered ${response.status} for the new build.`)
      const length = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(length) && length > 0 && length !== want.size) throw new UpdateError('The download is not the size its release says, so it was not kept.')
      const hash = createHash('sha256')
      let received = 0
      let shownAt = 0
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          touch()
          received += chunk.byteLength
          if (received > want.size) throw new UpdateError('The download is larger than its release says, so it was not kept.')
          hash.update(chunk)
          await handle.write(chunk)
          if (this.effects.now() - shownAt >= PROGRESS_EVERY_MS) {
            shownAt = this.effects.now()
            this.phase = { state: 'downloading', next: buildOf(manifest), received }
            this.emit()
          }
        }
      } catch (error) {
        if (error instanceof UpdateError) throw error
        throw new UpdateError(stall.signal.aborted ? 'The download stopped, so it was given up on; eNCode tries again later.' : 'The download broke off; eNCode tries again later.')
      }
      if (received !== want.size) throw new UpdateError('The download ended early; eNCode tries again later.')
      if (hash.digest('hex') !== want.sha256) throw new UpdateError('The download did not match its fingerprint (SHA-256), so it was deleted.')
      completed = true
    } finally {
      if (stallTimer !== null) this.effects.clearTimer(stallTimer)
      await handle.close().catch(() => undefined)
      if (!completed) fs.rmSync(partial, { force: true })
    }
    await renameWithRetry(partial, file)
    const downloaded: Downloaded = { ...buildOf(manifest), file, sha256: want.sha256 }
    writePrivateFile(path.join(dir, READY_FILE), `${JSON.stringify(downloaded)}\n`)
    this.downloaded = downloaded
    this.phase = { state: 'ready', next: publicBuild(downloaded), waiting: false }
    this.effects.log(`[updates] build ${manifest.build} downloaded and its fingerprint checked`)
  }

  private waitForAgents(): void {
    if (this.busyTimer !== null) return
    this.busyTimer = this.effects.setTimer(() => {
      this.busyTimer = null
      if (this.disposed || this.phase.state !== 'ready' || !this.phase.waiting) return
      if (this.effects.busy()) this.waitForAgents()
      else void this.restart()
    }, BUSY_POLL_MS)
  }

  private stopWaiting(): void {
    if (this.busyTimer === null) return
    this.effects.clearTimer(this.busyTimer)
    this.busyTimer = null
  }

  private async restart(): Promise<void> {
    const downloaded = this.downloaded
    if (!downloaded) return
    this.stopWaiting()
    this.unschedule()
    this.phase = { state: 'installing', next: publicBuild(downloaded) }
    this.emit()
    // Read again: the file sat on the disk since it was checked.
    if ((await sha256Of(downloaded.file).catch(() => '')) !== downloaded.sha256) {
      this.effects.log(`[updates] the downloaded build ${downloaded.build} no longer matches its fingerprint; deleted`)
      this.clearDir()
      this.downloaded = null
      this.phase = { state: 'error', message: 'The downloaded update changed on the disk, so it was deleted. eNCode downloads it again at the next look.' }
      this.emit()
      if (this.effects.autoCheck()) this.schedule(FIRST_CHECK_MS)
      return
    }
    this.writeRecord({ attempt: { from: this.options.own.build, to: downloaded.build, at: this.effects.now() }, failed: this.failed })
    this.effects.log(`[updates] restarting into build ${downloaded.build}`)
    this.effects.restartInto(downloaded.file, installerArgs(this.options.installDir))
  }

  private readRecord(): void {
    let record: UpdateRecord = { failed: [] }
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.options.recordFile, 'utf8'))
      if (isRecord(data)) {
        const failed = Array.isArray(data.failed) ? data.failed.filter((build): build is number => Number.isSafeInteger(build)) : []
        const attempt = isRecord(data.attempt) && Number.isSafeInteger(data.attempt.from) && Number.isSafeInteger(data.attempt.to) ? (data.attempt as UpdateRecord['attempt']) : undefined
        record = { failed, ...(attempt ? { attempt } : {}) }
      }
    } catch {
      // No record: no restart to update happened, or it was never readable.
    }
    this.failed = record.failed.slice(-FAILED_KEPT)
    const attempt = record.attempt
    if (!attempt) return
    const updated = this.options.own.build >= attempt.to
    this.told = { updated, from: attempt.from, to: attempt.to }
    if (!updated && !this.failed.includes(attempt.to)) this.failed = [...this.failed, attempt.to].slice(-FAILED_KEPT)
    this.effects.log(updated ? `[updates] updated from build ${attempt.from} to build ${this.options.own.build}` : `[updates] the update to build ${attempt.to} did not install; still build ${this.options.own.build}`)
    this.writeRecord({ failed: this.failed })
  }

  private writeRecord(record: UpdateRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.options.recordFile), { recursive: true })
      writePrivateFile(this.options.recordFile, `${JSON.stringify(record)}\n`)
    } catch (error) {
      this.effects.log(`[updates] could not write ${path.basename(this.options.recordFile)}: ${(error as Error).message}`)
    }
  }

  /** A download from an earlier run that is still newer than this build waits on; anything else in the folder goes. */
  private restoreDownload(): void {
    const { dir, own } = this.options
    let kept: Downloaded | null = null
    try {
      const data: unknown = JSON.parse(fs.readFileSync(path.join(dir, READY_FILE), 'utf8'))
      if (isRecord(data) && typeof data.file === 'string' && typeof data.sha256 === 'string' && Number.isSafeInteger(data.build) && Number.isSafeInteger(data.size)) {
        const candidate = data as unknown as Downloaded
        const inside = path.dirname(path.resolve(candidate.file)) === path.resolve(dir)
        if (inside && candidate.build > own.build && !this.failed.includes(candidate.build) && fs.statSync(candidate.file).size === candidate.size) {
          kept = { ...candidate, notes: Array.isArray(candidate.notes) ? candidate.notes.filter((line) => typeof line === 'string') : [] }
        }
      }
    } catch {
      kept = null
    }
    this.downloaded = kept
    if (this.clearDir(this.keptNames()).length) this.sweepLater()
  }

  /** The files of the download that waits for the restart, which a clear leaves. */
  private keptNames(): string[] {
    return this.downloaded ? [path.basename(this.downloaded.file), READY_FILE] : []
  }

  /** Empties the download folder, but for the files named; returns what it could not delete. */
  private clearDir(keep: string[] = []): string[] {
    const { dir } = this.options
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const left: string[] = []
    for (const name of names) {
      if (keep.includes(name)) continue
      try {
        fs.rmSync(path.join(dir, name), { force: true, recursive: true })
      } catch {
        // Held open: by the installer that is still finishing, or by a scanner for a moment.
        left.push(name)
      }
    }
    return left
  }

  /** Clears the download folder again later, until what was held is gone. */
  private sweepLater(attempt = 0): void {
    if (this.disposed || this.sweepTimer !== null) return
    this.sweepTimer = this.effects.setTimer(() => {
      this.sweepTimer = null
      if (this.disposed) return
      // A look that is downloading owns the folder for now.
      if (this.running) return this.sweepLater(attempt)
      const left = this.clearDir(this.keptNames())
      if (!left.length) return
      if (attempt + 1 < SWEEPS) this.sweepLater(attempt + 1)
      else this.effects.log(`[updates] could not delete ${left.join(', ')} from the download folder; the next start tries again`)
    }, SWEEP_MS * 2 ** attempt)
  }

  private schedule(ms: number): void {
    this.unschedule()
    if (this.disposed || !this.effects.autoCheck()) return
    this.timer = this.effects.setTimer(() => {
      this.timer = null
      void this.check()
    }, ms)
  }

  private unschedule(): void {
    if (this.timer === null) return
    this.effects.clearTimer(this.timer)
    this.timer = null
  }

  private emit(): void {
    if (!this.disposed) this.effects.onStatus(this.status())
  }
}

function buildOf(manifest: UpdateManifest): UpdateBuild {
  return { build: manifest.build, version: manifest.version, size: manifest.installer.size, publishedAt: manifest.publishedAt, notes: manifest.notes }
}

function publicBuild(downloaded: Downloaded): UpdateBuild {
  return { build: downloaded.build, version: downloaded.version, size: downloaded.size, publishedAt: downloaded.publishedAt, notes: downloaded.notes }
}

/** A response's body, or null when it is longer than `cap` bytes. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array()
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > cap) return null
    parts.push(chunk)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Windows' scanner holds a new program open for a moment after it is written. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt === 20) throw new UpdateError('The download could not be kept on the disk.')
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
}
