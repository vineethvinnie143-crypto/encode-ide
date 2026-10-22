/**
 * Unit tests for every workspace package.
 *
 * Finds *.test.ts under apps/ and packages/, bundles each one with esbuild
 * (so extensionless imports, path aliases and workspace packages resolve the
 * same way as in the app build) and runs the bundles with node:test.
 *
 *   pnpm test                    everything
 *   pnpm test permissions shell  only files whose path contains a filter
 *
 * Unit tests run in plain Node. A test that pulls in Electron, directly or
 * through the module it tests, fails to build: inject the dependency instead.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(root, '.test-dist')
const skipDirs = new Set(['node_modules', 'dist', 'release', '.test-dist', '.git'])

async function findTests(dir, found = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await findTests(full, found)
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(full)
  }
  return found
}

const toPosix = (file) => path.relative(root, file).split(path.sep).join('/')
const filters = process.argv.slice(2)
const files = (await Promise.all(['apps', 'packages'].map((dir) => findTests(path.join(root, dir)))))
  .flat()
  .filter((file) => !filters.length || filters.some((filter) => toPosix(file).includes(filter)))
  .sort()

if (!files.length) {
  console.error(filters.length ? `No test files match: ${filters.join(', ')}` : 'No test files found.')
  process.exit(1)
}

const forbidElectron = {
  name: 'forbid-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron(\/.*)?$/ }, (args) => ({
      errors: [
        {
          text: `Unit tests cannot load Electron (imported by ${toPosix(args.importer)}). Inject the dependency instead.`,
        },
      ],
    }))
  },
}

await fs.rm(outdir, { recursive: true, force: true })
try {
  await build({
    absWorkingDir: root,
    entryPoints: files,
    outdir,
    outbase: root,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: 'inline',
    logLevel: 'silent',
    // The Windows desktop helper's C# sources are embedded in the bundle as text.
    loader: { '.cs': 'text', '.manifest': 'text' },
    plugins: [forbidElectron],
  })
} catch (error) {
  for (const message of error.errors ?? []) {
    const where = message.location ? `${message.location.file}:${message.location.line}: ` : ''
    console.error(`${where}${message.text}`)
  }
  if (!error.errors) console.error(error)
  process.exit(1)
}

const bundles = files.map((file) => path.join(outdir, path.relative(root, file)).replace(/\.ts$/, '.mjs'))
console.log(`Running ${bundles.length} test file${bundles.length === 1 ? '' : 's'}`)
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--enable-source-maps', ...bundles], {
  cwd: root,
  stdio: 'inherit',
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
