import { ProtocolError } from './jsonrpc'

/**
 * Server-sent events, read incrementally from a byte stream: chunks may end
 * anywhere (inside a multi-byte character, between the CR and LF of a line
 * break), and the lines of one event are joined only when its blank line
 * arrives. A cap on the size of one event stops a server from making the
 * client buffer without end.
 */

export interface SseEvent {
  /** The event type; "message" when the server named none. */
  event: string
  data: string
  /** The last event id the stream has set, for resuming. */
  id?: string
  retry?: number
}

/** The most one event may hold, in characters. */
export const MAX_EVENT_CHARS = 16 * 1024 * 1024

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8')
  private buffer = ''
  /** The buffer before this offset holds no line break, so a long line is not searched again with every chunk. */
  private scanned = 0
  private data: string[] = []
  private dataChars = 0
  private eventType = ''
  private lastId: string | undefined
  private retry: number | undefined

  constructor(private readonly maxChars = MAX_EVENT_CHARS) {}

  /** Feeds a chunk; returns the events it completed. */
  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  /** Ends the stream. An event the server did not finish with a blank line is dropped, as the standard says. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = []
    let start = 0
    // The next CR and LF at or after `start`; -1 once there are none left in the buffer.
    let cr = this.buffer.indexOf('\r', this.scanned)
    let lf = this.buffer.indexOf('\n', this.scanned)
    for (;;) {
      if (cr !== -1 && cr < start) cr = this.buffer.indexOf('\r', start)
      if (lf !== -1 && lf < start) lf = this.buffer.indexOf('\n', start)
      if (cr === -1 && lf === -1) break
      let end: number
      let next: number
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A CR at the very end may be the first half of a CRLF: wait for the next chunk, unless there is none.
        if (cr === this.buffer.length - 1 && !final) break
        end = cr
        next = cr + (this.buffer[cr + 1] === '\n' ? 2 : 1)
      } else {
        end = lf
        next = lf + 1
      }
      const event = this.line(this.buffer.slice(start, end))
      start = next
      if (event) events.push(event)
    }
    this.buffer = this.buffer.slice(start)
    this.scanned = this.buffer.endsWith('\r') ? this.buffer.length - 1 : this.buffer.length
    if (this.buffer.length + this.dataChars > this.maxChars) throw new ProtocolError('The server sent an event that is too large.')
    return events
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      this.data.push(value)
      this.dataChars += value.length + 1
      if (this.dataChars > this.maxChars) throw new ProtocolError('The server sent an event that is too large.')
    } else if (field === 'event') {
      this.eventType = value
    } else if (field === 'id') {
      if (!value.includes('\u0000')) this.lastId = value
    } else if (field === 'retry') {
      if (/^\d{1,9}$/.test(value)) this.retry = Number(value)
    }
    return null
  }

  private dispatch(): SseEvent | null {
    const had = this.data.length > 0
    const event: SseEvent = {
      event: this.eventType || 'message',
      data: this.data.join('\n'),
      ...(this.lastId === undefined ? {} : { id: this.lastId }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    }
    this.data = []
    this.dataChars = 0
    this.eventType = ''
    return had ? event : null
  }
}

/** Reads a response body to its end, event by event. */
export async function* readEvents(body: ReadableStream<Uint8Array>, maxChars?: number): AsyncGenerator<SseEvent> {
  const parser = new SseParser(maxChars)
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.push(value)) yield event
    }
    for (const event of parser.end()) yield event
  } finally {
    // Release the connection whether the caller read everything or stopped early.
    await reader.cancel().catch(() => {})
  }
}
