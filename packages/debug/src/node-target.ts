/**
 * One Node.js program, debugged through its inspector (ADR 0143): its scripts and their source maps, the breakpoints
 * placed in them, where it is paused, and its scopes and values while it is.
 *
 * A breakpoint in a JavaScript file is placed by the file's name, so V8 places it in the script the moment it is
 * compiled; so is one in TypeScript that Node.js runs with its types stripped (22.6 and later), whose lines stay where
 * they are. A breakpoint in a file that only a source map knows (TypeScript compiled or run through tsx, a bundle's
 * sources) is placed in each script whose map names the file, before the script runs: V8 stops before an ES module
 * with a map runs (an instrumentation breakpoint), and the bootloader stops before a CommonJS module with a map
 * compiles (boot.ts); the map is read, the breakpoints go in, and the program goes on.
 *
 * Stepping skips what maps to nothing in a mapped script, and Node.js's own code, as people expect.
 */
import { BEFORE_MODULE, BOOTLOADER_NAME } from './boot'
import { CdpError, type CdpConnection } from './cdp'
import { breakpointUrlRegex, fileKey, isScriptFile, isTypeScriptFile, scriptPath, scriptUrl } from './paths'
import { dataUrlText, SourceMap } from './sourcemap'
import type { Breakpoint, BreakpointStatus, EvaluateContext, EvaluateResult, ExceptionFilters, FrameView, OutputLine, PauseReason, ScopeView, StepKind, VariableView } from './types'
import { consoleText, hasChildren, typeText, valueText, type RemoteObject } from './values'

/** What a target asks of the world outside it. */
export interface TargetHost {
  platform: NodeJS.Platform
  /** A source map's text from disk, or null; the caller bounds its size. */
  readText(file: string): Promise<string | null>
  /** A new number for a variable reference, unique in the session. */
  nextRef(): number
  /** A new number for a frame, unique in the session. */
  nextFrame(): number
}

export type TargetEvent =
  | { type: 'paused'; reason: PauseReason; exception?: string; frames: FrameView[] }
  | { type: 'resumed' }
  | { type: 'breakpoints'; file: string }
  | { type: 'output'; line: OutputLine }
  | { type: 'closed'; reason: string }

export interface TargetOptions {
  /** The program's console calls are its output (attached to a program whose output is not read). */
  console: boolean
  /** It strips TypeScript's types itself, and loads no code that may turn TypeScript into JavaScript another way. */
  stripsTypes: boolean
  /** Scripts stepped over and shown dimmed, as regular expressions on their names. */
  skip: string[]
}

interface Script {
  id: string
  url: string
  path: string | null
  /** Its map, once read; null when it has none or it could not be read. */
  map?: Promise<SourceMap | null>
  /** The keys of the files its map names, once read. */
  sources?: Map<string, number>
  /** Breakpoints going in, which its instrumentation stop waits for. */
  placing?: Promise<void>
}

/** Where a CDP breakpoint went, in the file the person set it in (0-based); with the map that says so, when one does. */
interface Resolved {
  places: { line: number; column: number }[]
  map?: SourceMap
  source?: number
}

/** A breakpoint as placed in this program: its CDP breakpoints and where V8 put them. */
interface Placed {
  spec: Breakpoint
  file: string
  cdp: Map<string, Resolved>
  /** By script: its placing there, so that it goes in once. */
  scripts: Map<string, Promise<void>>
  hits: number
}

interface Paused {
  reason: PauseReason
  frames: FrameView[]
  /** By frame id: the CDP call frame, for scopes and evaluation. */
  calls: Map<number, { callFrameId?: string; scopeChain?: { type: string; name?: string; object: RemoteObject }[]; thisObject?: RemoteObject; returnValue?: RemoteObject }>
}

type Ref =
  | { kind: 'object'; objectId: string; subtype?: string; description?: string }
  | { kind: 'scope'; objectId: string; thisObject?: RemoteObject; returnValue?: RemoteObject }
  | { kind: 'chunk'; objectId: string; start: number; count: number }
  | { kind: 'getter'; objectId: string; name: string }

const PAUSED_GROUP = 'encode-paused'
const CONSOLE_GROUP = 'encode-console'
/** Arrays longer than this show their items in groups of this many, or of its square, and so on. */
export const CHUNK = 100
/** How many steps in a row a step may take to get out of code that maps nowhere. */
const SMART_STEPS = 30
/** The frames a pause shows, async ones included. */
const MAX_FRAMES = 200

function reasonOf(cdp: string): PauseReason {
  switch (cdp) {
    case 'exception':
    case 'promiseRejection':
      return 'exception'
    case 'debugCommand':
      return 'pause'
    case 'Break on start':
      return 'entry'
    case 'other':
      return 'debugger'
    default:
      return 'other'
  }
}

/** A hit condition met on this hit, or not; one that does not read always is. */
export function hitConditionMet(condition: string | undefined, hits: number): boolean {
  if (!condition?.trim()) return true
  const match = /^\s*(==|>=|<=|>|<|%)?\s*(\d+)\s*$/.exec(condition)
  if (!match) return true
  const n = Number(match[2])
  switch (match[1]) {
    case '==':
      return hits === n
    case '>':
      return hits > n
    case '<':
      return hits < n
    case '<=':
      return hits <= n
    case '%':
      return n > 0 && hits % n === 0
    default:
      return hits >= n
  }
}

/**
 * The CDP condition of a breakpoint: its own, or for a logpoint a call that prints the message and never stops.
 * `{expression}` in a message is its value; `\{` is a brace.
 */
export function cdpCondition(spec: Pick<Breakpoint, 'condition' | 'logMessage'>): string | undefined {
  const condition = spec.condition?.trim()
  if (spec.logMessage === undefined) return condition || undefined
  let template = ''
  const message = spec.logMessage
  for (let index = 0; index < message.length; index++) {
    const char = message[index]
    if (char === '\\' && (message[index + 1] === '{' || message[index + 1] === '}')) {
      template += message[++index]
      continue
    }
    if (char === '{') {
      const end = message.indexOf('}', index + 1)
      if (end > index + 1) {
        template += `\${(${message.slice(index + 1, end)})}`
        index = end
        continue
      }
    }
    template += char === '`' || char === '\\' || char === '$' ? `\\${char}` : char
  }
  const log = `(console.log(\`${template}\`), false)`
  return condition ? `((${condition}) ? ${log} : false)` : log
}

export class NodeTarget {
  private readonly scripts = new Map<string, Script>()
  /** Scripts by the key of their file, for breakpoints by place in TypeScript run without a map. */
  private readonly byFile = new Map<string, Set<string>>()
  /** Breakpoints by the key of their file. */
  private readonly placed = new Map<string, Placed[]>()
  private readonly byCdp = new Map<string, Placed>()
  private readonly refs = new Map<number, Ref>()
  private paused: Paused | null = null
  /** The step the person asked for, while a step is under way, and how many steps it took so far. */
  private stepping: { kind: StepKind; taken: number } | null = null
  private closedWith: string | null = null
  private exceptions: ExceptionFilters = { uncaught: true, all: false }
  private readonly listeners = new Set<(event: TargetEvent) => void>()
  /** A breakpoint change waits for the one before it. */
  private lane: Promise<unknown> = Promise.resolve()
  private skip: RegExp[]

  constructor(
    private readonly cdp: CdpConnection,
    private readonly host: TargetHost,
    private readonly options: TargetOptions,
  ) {
    this.skip = [...options.skip, `${BOOTLOADER_NAME.replace(/\./g, '\\.')}$`].flatMap((pattern) => {
      try {
        return [new RegExp(pattern)]
      } catch {
        return []
      }
    })
    cdp.onEvent((method, params) => this.event(method, params))
    cdp.onClose((reason) => {
      this.closedWith = reason
      this.paused = null
      this.refs.clear()
      this.emit({ type: 'closed', reason })
    })
  }

  get isPaused(): boolean {
    return this.paused !== null
  }

  get frames(): FrameView[] | undefined {
    return this.paused?.frames
  }

  get pauseReason(): PauseReason | undefined {
    return this.paused?.reason
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  onEvent(listener: (event: TargetEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: TargetEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  /**
   * Starts debugging: the domains on, the exception filters and breakpoints in, and a program that waits for its
   * debugger let go. Breakpoints are by file, given as whole paths.
   */
  async start(breakpoints: Map<string, Breakpoint[]>, exceptions: ExceptionFilters): Promise<void> {
    this.exceptions = exceptions
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Debugger.enable', { maxScriptsCacheSize: 100_000_000 })
    await Promise.all([
      this.cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 }),
      // Not the bootloader's: V8 does not stop in a script it skips, and the bootloader stops the program on purpose.
      this.cdp.send('Debugger.setBlackboxPatterns', { patterns: this.options.skip }).catch(() => undefined),
      this.applyExceptions(),
      this.cdp.send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptWithSourceMapExecution' }),
      // A program that has finished waits for its debugger to let go: Node.js says when.
      this.cdp.send('NodeRuntime.notifyWhenWaitingForDisconnect', { enabled: true }).catch(() => undefined),
    ])
    for (const [file, list] of breakpoints) await this.setBreakpoints(file, list)
    await this.cdp.send('Runtime.runIfWaitingForDebugger')
  }

  private applyExceptions(): Promise<unknown> {
    const state = this.exceptions.all ? 'all' : this.exceptions.uncaught ? 'uncaught' : 'none'
    return this.cdp.send('Debugger.setPauseOnExceptions', { state })
  }

  async setExceptions(filters: ExceptionFilters): Promise<void> {
    this.exceptions = filters
    if (!this.closed) await this.applyExceptions()
  }

  /** Puts a file's breakpoints in place of the ones it had; the disabled ones are left out. */
  setBreakpoints(file: string, list: Breakpoint[]): Promise<void> {
    const run = this.lane.then(() => this.replace(file, list))
    this.lane = run.catch(() => undefined)
    return run
  }

  private async replace(file: string, list: Breakpoint[]): Promise<void> {
    if (this.closed) return
    const key = fileKey(file, this.host.platform)
    for (const old of this.placed.get(key) ?? []) {
      for (const id of old.cdp.keys()) {
        this.byCdp.delete(id)
        await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined)
      }
    }
    const placed: Placed[] = list.filter((spec) => spec.enabled).map((spec) => ({ spec, file, cdp: new Map(), scripts: new Map(), hits: 0 }))
    this.placed.set(key, placed)
    for (const item of placed) {
      const condition = cdpCondition(item.spec)
      if (this.byName(file)) {
        try {
          const answer = await this.cdp.send<{ breakpointId: string; locations: { scriptId: string; lineNumber: number; columnNumber?: number }[] }>('Debugger.setBreakpointByUrl', {
            urlRegex: breakpointUrlRegex(file, this.host.platform),
            lineNumber: item.spec.line - 1,
            columnNumber: item.spec.column ? item.spec.column - 1 : 0,
            ...(condition ? { condition } : {}),
          })
          item.cdp.set(answer.breakpointId, { places: answer.locations.map((location) => ({ line: location.lineNumber, column: location.columnNumber ?? 0 })) })
          this.byCdp.set(answer.breakpointId, item)
        } catch {
          /* the program left; nothing to place */
        }
      }
      // In the scripts already compiled whose map names the file, or that are the file run without a map.
      for (const script of this.scripts.values()) await this.placeIn(script, item)
    }
    this.emit({ type: 'breakpoints', file })
  }

  /** A file whose breakpoints go in by its name: JavaScript, or TypeScript in a program that strips the types itself. */
  private byName(file: string): boolean {
    return isScriptFile(file) || (this.options.stripsTypes && isTypeScriptFile(file))
  }

  /** Places a breakpoint in a script that maps from its file, or that is its TypeScript file run as it is; once. */
  private placeIn(script: Script, item: Placed): Promise<void> {
    let placing = item.scripts.get(script.id)
    if (!placing) {
      placing = this.closed ? Promise.resolve() : this.placeOnce(script, item).catch(() => undefined)
      item.scripts.set(script.id, placing)
    }
    return placing
  }

  private async placeOnce(script: Script, item: Placed): Promise<void> {
    const key = fileKey(item.file, this.host.platform)
    const map = script.map ? await script.map : null
    const source = map && script.sources ? script.sources.get(key) : undefined
    const condition = cdpCondition(item.spec)
    const set = async (line: number, column: number) => {
      try {
        const answer = await this.cdp.send<{ breakpointId: string; actualLocation: { lineNumber: number; columnNumber?: number } }>('Debugger.setBreakpoint', {
          location: { scriptId: script.id, lineNumber: line, columnNumber: column },
          ...(condition ? { condition } : {}),
        })
        const at = answer.actualLocation
        const original = map ? map.originalFor(at.lineNumber, at.columnNumber ?? 0) : null
        item.cdp.set(answer.breakpointId, { places: [original && source !== undefined && original.source === source ? { line: original.line, column: original.column } : { line: at.lineNumber, column: at.columnNumber ?? 0 }] })
        this.byCdp.set(answer.breakpointId, item)
      } catch {
        /* no code there, or one is there already */
      }
    }
    if (map && source !== undefined) {
      const line = map.nextMappedLine(source, item.spec.line - 1)
      if (line === null) return
      for (const place of map.generatedFor(source, line)) await set(place.line, place.column)
      return
    }
    if (!map && script.path && isTypeScriptFile(item.file) && !this.byName(item.file) && fileKey(script.path, this.host.platform) === key) {
      await set(item.spec.line - 1, item.spec.column ? item.spec.column - 1 : 0)
    }
  }

  /** How each breakpoint of a file stands in this program. */
  statuses(file: string): BreakpointStatus[] {
    const placed = this.placed.get(fileKey(file, this.host.platform)) ?? []
    return placed.map((item) => {
      const places = [...item.cdp.values()].flatMap((resolved) => resolved.places)
      if (!places.length) return { id: item.spec.id, verified: false }
      const line = Math.min(...places.map((place) => place.line)) + 1
      return { id: item.spec.id, verified: true, ...(line !== item.spec.line ? { line } : {}) }
    })
  }

  private loadMap(script: Script, sourceMapURL: string): Promise<SourceMap | null> {
    const base = scriptUrl(script.url, this.host.platform)
    return (async () => {
      let text: string | null = null
      let mapBase = base ?? 'file:///'
      if (sourceMapURL.startsWith('data:')) text = dataUrlText(sourceMapURL)
      else if (base) {
        let url: URL
        try {
          url = new URL(sourceMapURL, base)
        } catch {
          return null
        }
        // Only a map on disk is read: a program's map is never fetched from the network.
        if (url.protocol !== 'file:') return null
        const file = scriptPath(url.href, this.host.platform)
        if (!file) return null
        text = await this.host.readText(file)
        mapBase = url.href
      }
      if (text === null) return null
      try {
        const map = SourceMap.parse(text, mapBase)
        const sources = new Map<string, number>()
        map.sources.forEach((source, index) => {
          const file = scriptPath(source, this.host.platform)
          if (file) sources.set(fileKey(file, this.host.platform), index)
        })
        script.sources = sources
        return map
      } catch {
        return null
      }
    })()
  }

  private event(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Debugger.scriptParsed':
        return this.scriptParsed(params)
      case 'Debugger.paused':
        void this.onPaused(params).catch(() => undefined)
        return
      case 'Debugger.resumed':
        if (!this.paused) return
        this.paused = null
        this.refs.clear()
        this.emit({ type: 'resumed' })
        return
      case 'Debugger.breakpointResolved': {
        // A breakpoint by name went into a script compiled since.
        const item = this.byCdp.get(String(params.breakpointId))
        const resolved = item?.cdp.get(String(params.breakpointId))
        const location = params.location as { lineNumber: number; columnNumber?: number } | undefined
        if (!item || !resolved || !location) return
        // One placed by a module's map before it compiled resolves in the module's code; the person's file is the map's.
        const original = resolved.map?.originalFor(location.lineNumber, location.columnNumber ?? 0)
        if (resolved.map && (!original || original.source !== resolved.source)) return
        resolved.places.push(original ? { line: original.line, column: original.column } : { line: location.lineNumber, column: location.columnNumber ?? 0 })
        this.emit({ type: 'breakpoints', file: item.file })
        return
      }
      case 'NodeRuntime.waitingForDisconnect':
        this.cdp.close()
        return
      case 'Runtime.consoleAPICalled':
        if (this.options.console) void this.consoleCall(params)
        return
      case 'Runtime.exceptionThrown':
        if (this.options.console) {
          const details = params.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined
          const text = details?.exception?.description ?? details?.text ?? 'Uncaught exception'
          this.emit({ type: 'output', line: { category: 'error', text } })
        }
        return
    }
  }

  private scriptParsed(params: Record<string, unknown>): void {
    const id = String(params.scriptId)
    const url = String(params.url ?? '')
    const script: Script = { id, url, path: scriptPath(url, this.host.platform) }
    const mapUrl = typeof params.sourceMapURL === 'string' ? params.sourceMapURL : ''
    if (mapUrl) script.map = this.loadMap(script, mapUrl)
    this.scripts.set(id, script)
    if (script.path) {
      const key = fileKey(script.path, this.host.platform)
      const known = this.byFile.get(key) ?? new Set()
      known.add(id)
      this.byFile.set(key, known)
    }
    // A script already running (the program was attached to) gets its breakpoints when its map is read; one about
    // to run gets them at its instrumentation stop, which waits for the same placing.
    void this.placeAll(script)
  }

  /** Every breakpoint that belongs in a script goes in; what waits on the script waits for this. */
  private placeAll(script: Script): Promise<void> {
    const run = (script.placing ?? Promise.resolve()).then(async () => {
      const files = new Set<string>()
      for (const list of [...this.placed.values()]) {
        for (const item of list) {
          const known = item.cdp.size
          await this.placeIn(script, item)
          if (item.cdp.size !== known) files.add(item.file)
        }
      }
      for (const file of files) this.emit({ type: 'breakpoints', file })
    })
    script.placing = run.catch(() => undefined)
    return script.placing
  }

  private async onPaused(params: Record<string, unknown>): Promise<void> {
    const reason = String(params.reason ?? '')
    if (reason === 'instrumentation') {
      const data = params.data as { scriptId?: string } | undefined
      const script = data?.scriptId ? this.scripts.get(data.scriptId) : undefined
      if (script) await this.placeAll(script)
      await this.cdp.send('Debugger.resume').catch(() => undefined)
      return
    }
    const callFrames = (params.callFrames as CdpCallFrame[] | undefined) ?? []
    // A call frame's own url is often empty; its script names it.
    if (callFrames[0]?.functionName === BEFORE_MODULE && (this.scripts.get(callFrames[0].location.scriptId)?.url ?? '').endsWith(BOOTLOADER_NAME)) {
      await this.beforeModule(callFrames[0].callFrameId).catch(() => undefined)
      const method = this.stepping ? (this.stepping.kind === 'out' ? 'Debugger.stepOut' : this.stepping.kind === 'into' ? 'Debugger.stepInto' : 'Debugger.stepOver') : 'Debugger.resume'
      await this.cdp.send(method).catch(() => undefined)
      return
    }
    const hit = ((params.hitBreakpoints as string[] | undefined) ?? []).map((id) => this.byCdp.get(id)).filter((item): item is Placed => !!item)
    if (hit.length && reason !== 'exception' && reason !== 'promiseRejection') {
      // A breakpoint whose hit condition is not met on this hit does not stop the program.
      let stop = false
      for (const item of hit) {
        item.hits++
        if (hitConditionMet(item.spec.hitCondition, item.hits)) stop = true
      }
      if (!stop && !this.stepping) {
        await this.cdp.send('Debugger.resume').catch(() => undefined)
        return
      }
    }
    const top = callFrames[0]
    if (this.stepping && top && !hit.length && (await this.stepsOn(top))) {
      this.stepping.taken++
      const method = this.stepping.kind === 'out' ? 'Debugger.stepOut' : this.stepping.kind === 'into' ? 'Debugger.stepInto' : 'Debugger.stepOver'
      await this.cdp.send(method).catch(() => undefined)
      return
    }
    const wasStepping = this.stepping !== null
    this.stepping = null
    const frames: FrameView[] = []
    const calls: Paused['calls'] = new Map()
    for (const frame of callFrames.slice(0, MAX_FRAMES)) {
      const view = await this.frameView(frame.functionName, frame.location.scriptId, frame.location.lineNumber, frame.location.columnNumber ?? 0, frame.url)
      frames.push(view)
      calls.set(view.id, { callFrameId: frame.callFrameId, scopeChain: frame.scopeChain, thisObject: frame.this, ...(frame.returnValue ? { returnValue: frame.returnValue } : {}) })
    }
    let async = params.asyncStackTrace as CdpStackTrace | undefined
    while (async && frames.length < MAX_FRAMES) {
      let first = true
      for (const frame of async.callFrames) {
        if (frames.length >= MAX_FRAMES) break
        const view = await this.frameView(frame.functionName, frame.scriptId, frame.lineNumber, frame.columnNumber, frame.url)
        frames.push({ ...view, noScopes: true, ...(first ? { async: async.description || 'async' } : {}) })
        first = false
      }
      async = async.parent
    }
    const pauseReason: PauseReason = hit.length ? 'breakpoint' : wasStepping && reason !== 'exception' && reason !== 'promiseRejection' ? 'step' : reasonOf(reason)
    const exception = pauseReason === 'exception' ? exceptionText(params.data as RemoteObject | undefined) : undefined
    this.paused = { reason: pauseReason, frames, calls }
    this.emit({ type: 'paused', reason: pauseReason, ...(exception ? { exception } : {}), frames })
  }

  /**
   * The bootloader stopped the program before a CommonJS module with a source map compiles: the breakpoints of the
   * files its map names go in by the module's name, at the places its map gives, so that V8 places them as it compiles.
   */
  private async beforeModule(callFrameId: string): Promise<void> {
    const read = async (expression: string): Promise<unknown> => {
      const answer = await this.cdp.send<{ result: RemoteObject }>('Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: true, silent: true })
      return answer.result.value
    }
    const file = await read('file')
    const mapUrl = await read('map')
    if (typeof file !== 'string' || typeof mapUrl !== 'string' || !scriptPath(file, this.host.platform)) return
    const module: Script = { id: `module:${file}`, url: file, path: scriptPath(file, this.host.platform) }
    module.map = this.loadMap(module, mapUrl)
    const map = await module.map
    if (!map || !module.sources) return
    for (const list of [...this.placed.values()]) {
      for (const item of list) {
        const source = module.sources.get(fileKey(item.file, this.host.platform))
        if (source === undefined) continue
        const line = map.nextMappedLine(source, item.spec.line - 1)
        if (line === null) continue
        const condition = cdpCondition(item.spec)
        for (const place of map.generatedFor(source, line)) {
          try {
            const answer = await this.cdp.send<{ breakpointId: string }>('Debugger.setBreakpointByUrl', {
              urlRegex: breakpointUrlRegex(file, this.host.platform),
              lineNumber: place.line,
              columnNumber: place.column,
              ...(condition ? { condition } : {}),
            })
            item.cdp.set(answer.breakpointId, { places: [], map, source })
            this.byCdp.set(answer.breakpointId, item)
          } catch {
            /* the program left */
          }
        }
      }
    }
  }

  /** Whether a step should go on past this frame: it maps nowhere in a mapped script, or is in code that is skipped. */
  private async stepsOn(frame: CdpCallFrame): Promise<boolean> {
    if (!this.stepping || this.stepping.taken >= SMART_STEPS) return false
    const script = this.scripts.get(frame.location.scriptId)
    if (!script) return false
    if (this.skip.some((pattern) => pattern.test(script.url))) return true
    const map = script.map ? await script.map : null
    return !!map && map.originalFor(frame.location.lineNumber, frame.location.columnNumber ?? 0) === null
  }

  private async frameView(functionName: string, scriptId: string, line: number, column: number, url: string): Promise<FrameView> {
    const script = this.scripts.get(scriptId)
    const id = this.host.nextFrame()
    const name = functionName || '(anonymous)'
    const skipped = this.skip.some((pattern) => pattern.test(script?.url ?? url))
    const map = script?.map ? await script.map : null
    const original = map?.originalFor(line, column)
    if (map && original) {
      const sourceUrl = map.sources[original.source]
      const file = scriptPath(sourceUrl, this.host.platform)
      return { id, name, source: { path: file, name: baseName(file ?? sourceUrl) }, line: original.line + 1, column: original.column + 1, ...(skipped ? { skipped } : {}) }
    }
    const file = script?.path ?? scriptPath(url, this.host.platform)
    // Code that is not a file is named in full: `node:internal/modules/cjs/loader`.
    const label = file ? baseName(file) : script?.url || url || 'eval'
    return { id, name, source: { path: file, name: label }, line: line + 1, column: column + 1, ...(skipped ? { skipped } : {}) }
  }

  // ---- Running ----

  async resume(): Promise<void> {
    this.stepping = null
    await this.cdp.send('Debugger.resume')
  }

  async pause(): Promise<void> {
    await this.cdp.send('Debugger.pause')
  }

  async step(kind: StepKind): Promise<void> {
    if (!this.paused) return
    this.stepping = { kind, taken: 0 }
    await this.cdp.send(kind === 'out' ? 'Debugger.stepOut' : kind === 'into' ? 'Debugger.stepInto' : 'Debugger.stepOver')
  }

  // ---- Values ----

  private register(ref: Ref): number {
    const id = this.host.nextRef()
    this.refs.set(id, ref)
    return id
  }

  hasRef(ref: number): boolean {
    return this.refs.has(ref)
  }

  hasFrame(frame: number): boolean {
    return !!this.paused?.calls.has(frame)
  }

  /** The scopes of a frame of the pause, innermost first. */
  scopes(frameId: number): ScopeView[] {
    const call = this.paused?.calls.get(frameId)
    if (!call?.scopeChain) return []
    return call.scopeChain
      .filter((scope) => scope.object.objectId)
      .map((scope, index) => {
        const isLocal = scope.type === 'local'
        const ref = this.register({ kind: 'scope', objectId: scope.object.objectId!, ...(isLocal && call.thisObject ? { thisObject: call.thisObject } : {}), ...(isLocal && index === 0 && call.returnValue ? { returnValue: call.returnValue } : {}) })
        return { name: scopeName(scope.type, scope.name), ref, expensive: scope.type === 'global' }
      })
  }

  /** What a variable reference holds: its properties, a group of an array's items, or a getter's value. */
  async variables(ref: number): Promise<VariableView[]> {
    const target = this.refs.get(ref)
    if (!target) return []
    const group = this.paused ? PAUSED_GROUP : CONSOLE_GROUP
    if (target.kind === 'getter') {
      const answer = await this.cdp.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string } }>('Runtime.callFunctionOn', {
        objectId: target.objectId,
        functionDeclaration: 'function (name) { return this[name] }',
        arguments: [{ value: target.name }],
        objectGroup: group,
        generatePreview: true,
      })
      if (answer.exceptionDetails) return [{ name: target.name, value: exceptionText(answer.exceptionDetails.exception) ?? answer.exceptionDetails.text ?? 'Error' }]
      return [this.variable(target.name, answer.result)]
    }
    if (target.kind === 'chunk') {
      if (target.count > CHUNK) return this.chunks(target.objectId, target.count, target.start, false)
      const slice = await this.cdp.send<{ result: RemoteObject }>('Runtime.callFunctionOn', {
        objectId: target.objectId,
        functionDeclaration: 'function (start, count) { const out = {}; for (let i = start; i < start + count && i < this.length; i++) out[i] = this[i]; return out }',
        arguments: [{ value: target.start }, { value: target.count }],
        objectGroup: group,
      })
      if (!slice.result.objectId) return []
      return this.properties(slice.result.objectId, { indexesOnly: true })
    }
    const out: VariableView[] = []
    if (target.kind === 'scope') {
      if (target.returnValue) out.push({ ...this.variable('Return value', target.returnValue), kind: 'return' })
      if (target.thisObject && target.thisObject.type !== 'undefined') out.push({ ...this.variable('this', target.thisObject), kind: 'this' })
      out.push(...(await this.properties(target.objectId, {})))
      return out
    }
    if ((target.subtype === 'array' || target.subtype === 'typedarray') && target.description) {
      const length = Number(/\((\d+)\)/.exec(target.description)?.[1] ?? 0)
      if (length > CHUNK) return this.chunks(target.objectId, length)
    }
    return this.properties(target.objectId, {})
  }

  /**
   * An array too long to list at once, in groups: of CHUNK items, or of CHUNK² and so on, so that at most CHUNK groups
   * show; `from` and `length` are the stretch of the array to group. The whole array's groups end with its length.
   */
  private chunks(objectId: string, length: number, from = 0, whole = true): VariableView[] {
    let size = CHUNK
    while (length / size > CHUNK) size *= CHUNK
    const out: VariableView[] = []
    for (let start = from; start < from + length; start += size) {
      const count = Math.min(size, from + length - start)
      const ref = this.register({ kind: 'chunk', objectId, start, count })
      out.push({ name: `[${start} … ${start + count - 1}]`, value: '', ref, kind: 'chunk' })
    }
    if (whole) out.push({ name: 'length', value: String(length), type: 'number', kind: 'property' })
    return out
  }

  private async properties(objectId: string, options: { indexesOnly?: boolean }): Promise<VariableView[]> {
    const answer = await this.cdp.send<{
      result: { name: string; value?: RemoteObject; get?: RemoteObject; isOwn?: boolean; symbol?: RemoteObject }[]
      internalProperties?: { name: string; value?: RemoteObject }[]
      privateProperties?: { name: string; value?: RemoteObject; get?: RemoteObject }[]
    }>('Runtime.getProperties', { objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: true })
    const out: VariableView[] = []
    const indexes: VariableView[] = []
    for (const property of answer.result) {
      if (property.name === '__proto__' && !property.value) continue
      const name = property.symbol ? (property.symbol.description ?? property.name) : property.name
      let view: VariableView
      if (property.value) view = this.variable(name, property.value)
      else if (property.get && property.get.type !== 'undefined') view = { name, value: '(…)', ref: this.register({ kind: 'getter', objectId, name: property.name }), lazy: true, kind: 'property' }
      else continue
      if (/^\d+$/.test(name)) indexes.push(view)
      else out.push(view)
    }
    if (options.indexesOnly) return indexes.sort((a, b) => Number(a.name) - Number(b.name))
    for (const property of answer.privateProperties ?? []) if (property.value) out.push({ ...this.variable(property.name, property.value), kind: 'private' })
    const internal = (answer.internalProperties ?? []).filter((property) => property.value && property.value.subtype !== 'internal#location' && property.name !== '[[Scopes]]')
    const prototype = internal.filter((property) => property.name === '[[Prototype]]')
    for (const property of internal) if (property.name !== '[[Prototype]]') out.push({ ...this.variable(property.name, property.value!), kind: 'internal' })
    for (const property of prototype) out.push({ ...this.variable(property.name, property.value!), kind: 'internal' })
    return [...indexes.sort((a, b) => Number(a.name) - Number(b.name)), ...out]
  }

  private variable(name: string, object: RemoteObject): VariableView {
    const view: VariableView = { name, value: valueText(object), type: typeText(object), kind: 'property' }
    if (hasChildren(object)) view.ref = this.register({ kind: 'object', objectId: object.objectId!, ...(object.subtype ? { subtype: object.subtype } : {}), ...(object.description ? { description: object.description } : {}) })
    return view
  }

  /**
   * Evaluates an expression: in a frame of the pause, or in the program as it runs. A hover runs nothing that has a
   * side effect (V8 refuses it), and a watch or a hover prints nothing.
   */
  async evaluate(expression: string, frameId: number | undefined, context: EvaluateContext): Promise<EvaluateResult> {
    const call = frameId !== undefined ? this.paused?.calls.get(frameId) : this.paused?.frames[0] ? this.paused.calls.get(this.paused.frames[0].id) : undefined
    const quiet = context !== 'repl'
    const group = this.paused ? PAUSED_GROUP : CONSOLE_GROUP
    try {
      const answer = call?.callFrameId
        ? await this.cdp.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string } }>('Debugger.evaluateOnCallFrame', {
            callFrameId: call.callFrameId,
            expression,
            objectGroup: group,
            includeCommandLineAPI: context === 'repl',
            silent: quiet,
            generatePreview: true,
            ...(context === 'hover' ? { throwOnSideEffect: true, timeout: 1_000 } : {}),
          })
        : await this.cdp.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string } }>('Runtime.evaluate', {
            expression,
            objectGroup: group,
            includeCommandLineAPI: context === 'repl',
            silent: quiet,
            generatePreview: true,
            ...(context === 'repl' ? { replMode: true } : {}),
            ...(context === 'hover' ? { throwOnSideEffect: true, timeout: 1_000 } : {}),
          })
      if (answer.exceptionDetails) return { ok: false, message: exceptionText(answer.exceptionDetails.exception) ?? answer.exceptionDetails.text ?? 'Error' }
      const view = this.variable('', answer.result)
      return { ok: true, value: view.value, ...(view.type ? { type: view.type } : {}), ...(view.ref !== undefined ? { ref: view.ref } : {}) }
    } catch (error) {
      return { ok: false, message: error instanceof CdpError ? error.message : String(error) }
    }
  }

  private async consoleCall(params: Record<string, unknown>): Promise<void> {
    const args = (params.args as RemoteObject[] | undefined) ?? []
    const type = String(params.type ?? 'log')
    const text = args.map(consoleText).join(' ')
    const top = (params.stackTrace as CdpStackTrace | undefined)?.callFrames?.[0]
    let source: OutputLine['source']
    if (top) {
      const view = await this.frameView(top.functionName, top.scriptId, top.lineNumber, top.columnNumber, top.url)
      if (view.source?.path) source = { path: view.source.path, line: view.line }
    }
    const category: OutputLine['category'] = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'stderr' : 'console'
    this.emit({ type: 'output', line: { category, text, ...(source ? { source } : {}) } })
  }

  /** Lets the values of a console evaluation go. */
  async releaseConsole(): Promise<void> {
    await this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: CONSOLE_GROUP }).catch(() => undefined)
  }

  close(): void {
    this.cdp.close()
  }
}

interface CdpCallFrame {
  callFrameId: string
  functionName: string
  location: { scriptId: string; lineNumber: number; columnNumber?: number }
  url: string
  scopeChain: { type: string; name?: string; object: RemoteObject }[]
  this?: RemoteObject
  returnValue?: RemoteObject
}

interface CdpStackTrace {
  description?: string
  callFrames: { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number }[]
  parent?: CdpStackTrace
}

function exceptionText(object: RemoteObject | undefined): string | undefined {
  if (!object) return undefined
  if (object.type === 'object' && object.description) return object.description
  return valueText(object)
}

function scopeName(type: string, name: string | undefined): string {
  switch (type) {
    case 'local':
      return 'Local'
    case 'closure':
      return name ? `Closure (${name})` : 'Closure'
    case 'block':
      return 'Block'
    case 'script':
      return 'Script'
    case 'module':
      return 'Module'
    case 'global':
      return 'Global'
    case 'catch':
      return 'Catch'
    case 'with':
      return 'With'
    case 'eval':
      return 'Eval'
    default:
      return type
  }
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}
