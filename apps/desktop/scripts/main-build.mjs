/**
 * How the main process, the preload script and the agent host are bundled, for `pnpm build` and `pnpm dev`
 * alike, and the stamp every build carries: which version and commit it was made from.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Provided by the Electron runtime; everything else is bundled. */
const external = ['electron']

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The commit a build was made from. CI names it (ENCODE_COMMIT is the head of a pull request, not the merge
 * commit GitHub builds); otherwise it is the checkout's own, and empty outside a checkout.
 */
function commitOf(env) {
  const named = (env.ENCODE_COMMIT ?? '').trim().toLowerCase()
  const commit = /^[0-9a-f]{40}$/.test(named) ? named : git('rev-parse', 'HEAD').toLowerCase()
  return /^[0-9a-f]{40}$/.test(commit) ? commit : ''
}

/** What the About box and a diagnostics report say about the build. Mirrors BuildStamp in electron/build-info.ts. */
export function buildStamp(env = process.env) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  return {
    version: String(pkg.version),
    commit: commitOf(env),
    // Only a build on a developer's machine can differ from its commit.
    dirty: !env.ENCODE_COMMIT && git('status', '--porcelain').length > 0,
    builtAt: new Date().toISOString(),
    // CI sets "tester" for the builds that are handed out.
    channel: env.ENCODE_CHANNEL?.trim() || 'dev',
  }
}

export function mainBuildOptions({ production = true } = {}) {
  return {
    absWorkingDir: root,
    entryPoints: {
      main: path.join(root, 'electron/main.ts'),
      preload: path.join(root, 'electron/preload.ts'),
      // The agent runs in a utility process of its own.
      'agent-host': path.join(root, 'electron/agent-host/entry.ts'),
    },
    outdir: path.join(root, 'dist/electron'),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: production ? false : 'inline',
    external,
    // The Windows desktop helper's C# sources are embedded in the host bundle as text.
    loader: { '.cs': 'text', '.manifest': 'text' },
    define: {
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
      __ENCODE_BUILD__: JSON.stringify(buildStamp()),
    },
    logLevel: 'info',
  }
}
