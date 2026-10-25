/**
 * eNCode's command line as one file (ADR 0108): apps/cli bundled for Node 22, as the Windows build ships it and as
 * scripts/encode.mjs runs it.
 *
 *   node scripts/cli-bundle.mjs out/encode.mjs     writes it, for a machine with Node and without this checkout, such
 *                                                  as a Terminal-Bench task's container (ADR 0138)
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Writes the bundle to `outfile`; on a build error, prints where and returns false. */
export async function bundleCli(outfile) {
  try {
    await build({
      absWorkingDir: root,
      entryPoints: [path.join(root, 'apps/cli/src/bin.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outfile,
      // The Windows sandbox helper's C# sources are embedded in the bundle as text, as in the app.
      loader: { '.cs': 'text', '.manifest': 'text' },
      logLevel: 'silent',
    })
    return true
  } catch (error) {
    for (const message of error.errors ?? []) console.error(`${message.location ? `${message.location.file}:${message.location.line}: ` : ''}${message.text}`)
    if (!error.errors) console.error(error)
    return false
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2]
  if (!out) {
    console.error('Usage: node scripts/cli-bundle.mjs <out.mjs>')
    process.exit(2)
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  process.exit((await bundleCli(path.resolve(out))) ? 0 : 1)
}
