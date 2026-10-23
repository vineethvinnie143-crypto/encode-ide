/**
 * Stream filters (PDF 32000-1:2008, 7.4): the ones text lives behind. Image-only filters (DCT, JPX, CCITT, JBIG2)
 * are not decoded; a reader of text never needs their output.
 *
 * Every decoder stops at a size limit, so a small file cannot expand into gigabytes (a "zip bomb").
 */
import zlib from 'node:zlib'
import { nameOf, numberOf, PdfDict, PdfError, PdfName, type PdfObject } from './objects'

export interface DecodeBudget {
  /** Bytes one stream may decode to. */
  perStream: number
  /** What is left for the whole read; decoders take from it. */
  left: number
}

export class DecodeLimitError extends PdfError {
  constructor() {
    super('A stream decodes to more data than eNCode reads from one PDF.')
  }
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode'])

function take(budget: DecodeBudget, size: number): void {
  if (size > budget.perStream || size > budget.left) throw new DecodeLimitError()
  budget.left -= size
}

const tooBig = (error: unknown) => error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'

function flate(data: Uint8Array, limit: number): Uint8Array {
  // A sync flush at the end: a stream cut short gives what it holds instead of an error.
  const options = { maxOutputLength: limit, finishFlush: zlib.constants.Z_SYNC_FLUSH }
  try {
    return zlib.inflateSync(data, options)
  } catch (error) {
    if (tooBig(error)) throw new DecodeLimitError()
    // Some writers leave out the zlib header, or write a damaged one; the deflate data itself may still be good.
    for (const body of [data, data.subarray(2)]) {
      try {
        return zlib.inflateRawSync(body, options)
      } catch (raw) {
        if (tooBig(raw)) throw new DecodeLimitError()
      }
    }
    throw new PdfError('A compressed stream is damaged.')
  }
}

/** LZW (7.4.4): 9 to 12 bit codes, 256 clears the table, 257 ends the data. */
function lzw(data: Uint8Array, earlyChange: number, limit: number): Uint8Array {
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  const lengths = new Uint16Array(4096)
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1
    suffix[i] = i
    first[i] = i
    lengths[i] = 1
  }
  let output = new Uint8Array(Math.min(limit, Math.max(1024, data.length * 3)))
  let length = 0
  const room = (more: number) => {
    if (length + more <= output.length) return
    if (length + more > limit) throw new DecodeLimitError()
    const bigger = new Uint8Array(Math.min(limit, Math.max(length + more, output.length * 2)))
    bigger.set(output.subarray(0, length))
    output = bigger
  }
  const write = (code: number) => {
    const size = lengths[code]
    room(size)
    let at = code
    for (let k = size - 1; k >= 0; k--) {
      output[length + k] = suffix[at]
      at = prefix[at]
    }
    length += size
  }
  let next = 258
  let codeLength = 9
  let previous = -1
  let bits = 0
  let bitCount = 0
  for (let i = 0; ; ) {
    while (bitCount < codeLength && i < data.length) {
      bits = ((bits << 8) | data[i++]) >>> 0
      bitCount += 8
    }
    if (bitCount < codeLength) break
    const code = (bits >>> (bitCount - codeLength)) & ((1 << codeLength) - 1)
    bitCount -= codeLength
    bits &= (1 << bitCount) - 1
    if (code === 256) {
      next = 258
      codeLength = 9
      previous = -1
      continue
    }
    if (code === 257) break
    let firstByte: number
    if (code < 256 || (code >= 258 && code < next)) {
      write(code)
      firstByte = first[code]
    } else if (code === next && previous >= 0) {
      // The code being defined right now: the previous entry and its own first byte.
      firstByte = first[previous]
      write(previous)
      room(1)
      output[length++] = firstByte
    } else {
      break
    }
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous
      suffix[next] = firstByte
      first[next] = first[previous]
      lengths[next] = lengths[previous] + 1
      next++
    }
    previous = code
    if (next + earlyChange >= 1 << codeLength && codeLength < 12) codeLength++
  }
  return output.subarray(0, length)
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2))
  let length = 0
  let high = -1
  for (const c of data) {
    if (c === 0x3e) break
    const value = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1
    if (value < 0) continue
    if (high < 0) high = value
    else {
      out[length++] = high * 16 + value
      high = -1
    }
  }
  if (high >= 0) out[length++] = high * 16
  return out.subarray(0, length)
}

function ascii85(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((data.length * 4) / 5) + 4)
  let length = 0
  const group: number[] = []
  const flush = (count: number) => {
    while (group.length < 5) group.push(84)
    let value = 0
    for (const digit of group) value = value * 85 + digit
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    for (let i = 0; i < count - 1; i++) out[length++] = bytes[i]
    group.length = 0
  }
  let i = 0
  // An optional <~ opening.
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x0a || data[i] === 0x0d || data[i] === 0x09)) i++
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2
  for (; i < data.length; i++) {
    const c = data[i]
    if (c === 0x7e) break
    if (c === 0x7a && !group.length) {
      out[length++] = 0
      out[length++] = 0
      out[length++] = 0
      out[length++] = 0
      continue
    }
    if (c < 0x21 || c > 0x75) continue
    group.push(c - 0x21)
    if (group.length === 5) flush(5)
  }
  if (group.length > 1) flush(group.length)
  return out.subarray(0, length)
}

function runLength(data: Uint8Array, limit: number): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < data.length; ) {
    const n = data[i++]
    if (n === 128) break
    if (n < 128) {
      for (let j = 0; j <= n && i < data.length; j++) out.push(data[i++])
    } else {
      const byte = data[i++]
      for (let j = 0; j < 257 - n; j++) out.push(byte)
    }
    if (out.length > limit) throw new DecodeLimitError()
  }
  return Uint8Array.from(out)
}

/** PNG and TIFF predictors (7.4.4.4), which xref and object streams use with Flate and LZW. */
function unpredict(data: Uint8Array, params: PdfDict | undefined): Uint8Array {
  const predictor = numberOf(params?.get('Predictor')) ?? 1
  if (predictor < 2) return data
  const colors = Math.max(1, numberOf(params?.get('Colors')) ?? 1)
  const bits = Math.max(1, numberOf(params?.get('BitsPerComponent')) ?? 8)
  const columns = Math.max(1, numberOf(params?.get('Columns')) ?? 1)
  const pixel = Math.max(1, Math.ceil((colors * bits) / 8))
  const row = Math.ceil((colors * bits * columns) / 8)
  if (predictor === 2) {
    if (bits !== 8) return data
    const out = Uint8Array.from(data)
    for (let start = 0; start < out.length; start += row) for (let i = start + pixel; i < Math.min(start + row, out.length); i++) out[i] = (out[i] + out[i - pixel]) & 0xff
    return out
  }
  const rows = Math.floor(data.length / (row + 1))
  const out = new Uint8Array(rows * row)
  const previous = new Uint8Array(row)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (row + 1)]
    const line = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1))
    const current = out.subarray(r * row, (r + 1) * row)
    for (let i = 0; i < row; i++) {
      const left = i >= pixel ? current[i - pixel] : 0
      const up = previous[i]
      const upLeft = i >= pixel ? previous[i - pixel] : 0
      let value = line[i]
      switch (type) {
        case 1: value += left; break
        case 2: value += up; break
        case 3: value += (left + up) >> 1; break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          break
        }
      }
      current[i] = value & 0xff
    }
    previous.set(current)
  }
  return out
}

/** The filters a stream's dictionary names, with their parameters. */
function filtersOf(dict: PdfDict, resolve: (value: PdfObject | undefined) => PdfObject | undefined): { name: string; params?: PdfDict }[] {
  const filter = resolve(dict.get('Filter') ?? dict.get('F'))
  const params = resolve(dict.get('DecodeParms') ?? dict.get('DP'))
  const names = Array.isArray(filter) ? filter.map((item) => nameOf(resolve(item))) : [nameOf(filter)]
  const paramList = Array.isArray(params) ? params.map((item) => resolve(item)) : [params]
  return names
    .map((name, index) => ({ name: name ?? '', params: paramList[index] instanceof PdfDict ? (paramList[index] as PdfDict) : undefined }))
    .filter((item) => item.name)
}

/** Whether the stream's data is an image eNCode does not decode (its bytes are still copied when pages are). */
export function isImageData(dict: PdfDict, resolve: (value: PdfObject | undefined) => PdfObject | undefined): boolean {
  return filtersOf(dict, resolve).some((filter) => IMAGE_FILTERS.has(filter.name))
}

/** The stream's bytes with its filters undone, or undefined when a filter is one only images use. */
export function decodeStream(dict: PdfDict, raw: Uint8Array, budget: DecodeBudget, resolve: (value: PdfObject | undefined) => PdfObject | undefined): Uint8Array | undefined {
  let data = raw
  for (const { name, params } of filtersOf(dict, resolve)) {
    const limit = Math.min(budget.perStream, budget.left)
    switch (name) {
      case 'FlateDecode':
      case 'Fl':
        data = unpredict(flate(data, limit), params)
        break
      case 'LZWDecode':
      case 'LZW':
        data = unpredict(lzw(data, numberOf(params?.get('EarlyChange')) ?? 1, limit), params)
        break
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHex(data)
        break
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85(data)
        break
      case 'RunLengthDecode':
      case 'RL':
        data = runLength(data, limit)
        break
      case 'Crypt':
        // Identity: what the file's own encryption leaves is what was decrypted already.
        break
      default:
        if (IMAGE_FILTERS.has(name)) return undefined
        throw new PdfError(`The filter ${name} is not one eNCode reads.`)
    }
    take(budget, data.length)
  }
  return data
}

export { PdfName }
