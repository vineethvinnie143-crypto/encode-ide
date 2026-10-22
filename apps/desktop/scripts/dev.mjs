import { context } from 'esbuild'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { mainBuildOptions } from './main-build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let child = null
let exiting = false
let firstBuild = true

function startElectron(url) {
  const args = ['.']
  if (process.env.ENCODE_DEBUG) {
    args.push(`--remote-debugging-port=${process.env.ENCODE_DEBUG_PORT || '9222'}`)
  }
  child = spawn(electronPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: url,
      NODE_ENV: 'development',
    },
  })
  child.on('exit', (code) => {
    if (exiting) return
    if (child) child = null
    shutdown(code ?? 0)
  })
}

async function stopElectron() {
  if (!child) return
  const proc = child
  child = null
  proc.removeAllListeners('exit')
  proc.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function shutdown(code) {
  if (exiting) return
  exiting = true
  if (child) child.kill()
  process.exit(code)
}

async function main() {
  // 1. Vite dev server for the renderer
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts') })
  await server.listen()
  const url = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.server.port}/`
  console.log(`[dev] renderer at ${url}`)

  // 2. esbuild watch for main + preload, restart electron on rebuild
  const ctx = await context({
    ...mainBuildOptions({ production: false }),
    logLevel: 'warning',
    plugins: [
      {
        name: 'eNCode-restart',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return
            if (firstBuild) {
              firstBuild = false
              console.log('[dev] starting electron')
              startElectron(url)
              return
            }
            console.log('[dev] main changed — restarting electron')
            await stopElectron()
            if (!exiting) startElectron(url)
          })
        },
      },
    ],
  })
  await ctx.watch()

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
