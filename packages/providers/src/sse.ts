/**
 * A server-sent events reader (the WHATWG event-stream format) over a fetch
 * body. It yields one item per dispatched event and one per comment line,
 * since providers use comments as keepalives.
 */
import { TransportError } from './errors'

export type SseItem = { kind: 'event'; event: string; data: string; id?: string } | { kind: 'comment'; text: string }

/** Largest event the reader buffers (a tool call's whole input can arrive in one event). */
const MAX_EVENT_BYTES = 32 * 1024 * 1024

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseItem> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  let dataSize = 0
  let id: string | undefined
  let sawCarriageReturn = false

  const dispatch = (): SseItem | undefined => {
    const item: SseItem | undefined = data.length ? { kind: 'event', event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) } : undefined
    event = ''
    data = []
    dataSize = 0
    return item
  }

  /** Processes one line; returns an item when the line completes one. */
  const line = (text: string): SseItem | undefined => {
    if (text === '') return dispatch()
    if (text.startsWith(':')) return { kind: 'comment', text: text.slice(1).trimStart() }
    const colon = text.indexOf(':')
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? '' : text.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      dataSize += value.length + 1
      if (dataSize > MAX_EVENT_BYTES) throw new TransportError('protocol', 'A server-sent event exceeded 32 MB.')
      data.push(value)
    } else if (field === 'event') event = value
    else if (field === 'id' && !value.includes('\0')) id = value
    return undefined
  }

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      // What is left from the last chunk holds no line break, so the scan resumes after it.
      const from = buffer.length
      buffer += decoder.decode(value, { stream: true })
      let start = 0
      for (let index = from; index < buffer.length; index++) {
        const char = buffer.charCodeAt(index)
        if (char !== 10 && char !== 13) continue
        // A \r\n pair split across two chunks: the \n ends nothing new.
        if (char === 10 && sawCarriageReturn && index === start) {
          sawCarriageReturn = false
          start = index + 1
          continue
        }
        sawCarriageReturn = char === 13 && index + 1 === buffer.length
        const item = line(buffer.slice(start, index))
        if (char === 13 && buffer.charCodeAt(index + 1) === 10) index++
        start = index + 1
        if (item) yield item
      }
      buffer = buffer.slice(start)
      if (buffer.length > MAX_EVENT_BYTES) throw new TransportError('protocol', 'A server-sent event line exceeded 32 MB.')
    }
    buffer += decoder.decode()
    // A stream may end without the final blank line; deliver what is complete.
    if (buffer) {
      const item = line(buffer)
      if (item) yield item
    }
    const last = dispatch()
    if (last) yield last
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed or errored.
    }
    reader.releaseLock()
  }
}
