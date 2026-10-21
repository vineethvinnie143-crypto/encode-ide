/**
 * The HTTP plumbing adapters share: one POST that turns transport failures
 * into TransportErrors, and body readers that respect the caller's abort.
 */
import { classifyHttpFailure, classifyNetworkFailure, TransportError } from './errors'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Error bodies are read up to this size: enough for any provider's message, bounded for a hostile one. */
const MAX_ERROR_BODY = 64 * 1024
/** A reply that is not streamed is read up to this size. */
const MAX_JSON_BODY = 32 * 1024 * 1024

/** The endpoint's origin, for messages: never the path or a key. */
export function describeEndpoint(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'the provider'
  }
}

/** Reads a body as text, stopping at `limit` bytes. */
export async function readText(response: Response, signal: AbortSignal, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  let truncated = false
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        text += decoder.decode(value.subarray(0, value.byteLength - (size - limit)), { stream: true })
        truncated = true
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    return { text: text + decoder.decode(), truncated }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed.
    }
    reader.releaseLock()
  }
}

/**
 * POSTs JSON. Resolves with a 2xx response; otherwise fails with the
 * classified error, or with signal.reason once the caller aborted.
 */
export async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw classifyNetworkFailure(error, describeEndpoint(url))
  }
  if (response.ok) return response
  let text = ''
  try {
    text = (await readText(response, signal, MAX_ERROR_BODY)).text
  } catch (error) {
    if (signal.aborted) throw signal.reason
    // The error body was lost; the status alone still classifies it.
    void error
  }
  throw classifyHttpFailure(response.status, response.headers, text)
}

/** Reads a non-streamed JSON reply. */
export async function readJson(response: Response, signal: AbortSignal, where: string): Promise<unknown> {
  let text: string
  try {
    const read = await readText(response, signal, MAX_JSON_BODY)
    if (read.truncated) throw new TransportError('protocol', `The reply from ${where} was larger than 32 MB.`)
    text = read.text
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw classifyNetworkFailure(error, where)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new TransportError('protocol', `${where} returned a reply that is not JSON.`)
  }
}

export function isJsonResponse(response: Response): boolean {
  return /\bjson\b/i.test(response.headers.get('content-type') ?? '')
}

/** Wraps a stream read so a dropped connection becomes a TransportError, and an abort its reason. */
export async function* guardStream<T>(source: AsyncIterable<T>, signal: AbortSignal, where: string): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      let next: IteratorResult<T>
      try {
        next = await iterator.next()
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw classifyNetworkFailure(error, where)
      }
      if (next.done) return
      yield next.value
    }
  } finally {
    await iterator.return?.()
  }
}
