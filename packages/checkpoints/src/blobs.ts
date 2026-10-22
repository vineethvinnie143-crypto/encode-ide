import { createHash } from 'node:crypto'
import type path from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { CheckpointFs, Hash } from './types'

/**
 * File contents in the store: gzip-compressed, named by the SHA-256 of the
 * original bytes, one level of folders by the first two hex digits. A name
 * that is its own content hash means a blob is written once, shared by every
 * snapshot of the same bytes, and checkable when it is read back: a blob
 * that was damaged or swapped on disk never restores.
 */

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** The most a blob may inflate to when read; far above any file the store keeps, below a decompression bomb. */
const HARD_MAX_BYTES = 256 * 1024 * 1024

export class BlobError extends Error {
  constructor(
    readonly kind: 'missing' | 'damaged',
    message: string,
  ) {
    super(message)
    this.name = 'BlobError'
  }
}

export function sha256(bytes: Uint8Array): Hash {
  return createHash('sha256').update(bytes).digest('hex')
}

export function blobFile(dir: string, hash: Hash, api: typeof path.posix): string {
  return api.join(dir, 'blobs', hash.slice(0, 2), hash)
}

export async function putBlob(fs: CheckpointFs, dir: string, bytes: Buffer, hash: Hash, api: typeof path.posix): Promise<void> {
  const file = blobFile(dir, hash, api)
  if (await fs.exists(file)) return
  await fs.writeOnce(file, await gzipAsync(bytes))
}

/** The bytes saved under `hash`, checked against it. */
export async function getBlob(fs: CheckpointFs, dir: string, hash: Hash, api: typeof path.posix): Promise<Buffer> {
  const stored = await fs.read(blobFile(dir, hash, api))
  if (!stored) throw new BlobError('missing', 'its saved copy is missing')
  let bytes: Buffer
  try {
    bytes = await gunzipAsync(stored, { maxOutputLength: HARD_MAX_BYTES })
  } catch {
    throw new BlobError('damaged', 'its saved copy is damaged')
  }
  if (sha256(bytes) !== hash) throw new BlobError('damaged', 'its saved copy is damaged')
  return bytes
}
