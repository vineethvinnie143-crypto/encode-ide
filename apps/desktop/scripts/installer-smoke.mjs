/**
 * Installs the Windows installer silently, starts the installed program with packaged-smoke.mjs, and
 * uninstalls it again, checking what a tester sees: the program in the folder, a Start menu shortcut while
 * it is installed and none after, and the user's own data left alone.
 *
 *   pnpm package && node scripts/installer-smoke.mjs
 *
 * Windows and CI only, like packaged-smoke.mjs: the program uses the real profile.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(root, 'release')

function fail(message) {
  console.error(`[installer] ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32') fail('The installer is for Windows.')
if (!process.env.CI) fail('This installs and removes a program and runs it on the real profile. Run it in CI.')
// On a runner of our own, only a machine set up for CI (scripts/ci/windows-runner.ps1) lends its profile: never an
// everyday account that happens to run a runner.
if (process.env.RUNNER_ENVIRONMENT === 'self-hosted' && process.env.ENCODE_CI_MACHINE !== '1') {
  fail('This self-hosted runner was not set up by scripts/ci/windows-runner.ps1, and this installs a program on the real profile. Run it on a machine set up for CI.')
}

const setup = fs.readdirSync(release).find((name) => /-setup\.exe$/.test(name))
if (!setup) fail(`No *-setup.exe in ${release}. Run pnpm package first.`)

// A folder without spaces: the installer reads its target from the end of the command line, unquoted.
const target = path.join(fs.realpathSync.native(process.env.RUNNER_TEMP || os.tmpdir()), 'encode-installed')
const shortcut = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'eNCode.lnk')
fs.rmSync(target, { recursive: true, force: true })

console.log(`[installer] installing ${setup} into ${target}`)
const install = spawnSync(path.join(release, setup), ['/S', `/D=${target}`], { stdio: 'inherit', timeout: 5 * 60_000 })
if (install.error || install.status !== 0) fail(`the installer failed: ${install.error?.message ?? `exit code ${install.status}`}`)

const exe = path.join(target, 'eNCode.exe')
if (!fs.existsSync(exe)) fail(`the installer did not put eNCode.exe in ${target}`)
if (!fs.existsSync(shortcut)) fail(`the installer made no Start menu shortcut (${shortcut})`)
console.log('[installer] installed, with a Start menu shortcut')

const smoke = spawnSync(process.execPath, [path.join(root, 'scripts', 'packaged-smoke.mjs'), exe], { stdio: 'inherit', timeout: 5 * 60_000 })

// The uninstaller copies itself aside and returns at once unless it is told to stay where it is.
const uninstaller = path.join(target, 'Uninstall eNCode.exe')
console.log('[installer] uninstalling')
const uninstall = fs.existsSync(uninstaller) ? spawnSync(uninstaller, ['/S', `_?=${target}`], { stdio: 'inherit', timeout: 5 * 60_000 }) : undefined
fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })

if (smoke.error || smoke.status !== 0) fail('the installed program did not pass the packaged smoke')
if (!uninstall || uninstall.error || uninstall.status !== 0) fail(`the uninstaller failed: ${uninstall?.error?.message ?? `exit code ${uninstall?.status}`}`)
if (fs.existsSync(shortcut)) fail('the Start menu shortcut is still there after uninstalling')
console.log('[installer] PASS')
