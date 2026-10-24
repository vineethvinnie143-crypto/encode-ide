/**
 * Fix this folder (ADR 0118) as far as it can be checked without Windows: which folders it takes, the scripts it
 * builds, and how it reads the answers. grant.windows.test.ts runs it for real.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Finished } from './client'
import { CANCELLED, GRANTED_AS_OWNER, GRANT_FAILED, OWNER_FAILED, elevatedScript, encodeCommand, grantFolder, grantProblem, launcherScript } from './grant'

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001'
const env = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\hi\\AppData\\Local\\Temp' }
const decode = (encoded: string) => Buffer.from(encoded, 'base64').toString('utf16le')
const fromBase64 = (script: string, name: string) => {
  const found = script.match(new RegExp(`\\$${name} = \\[Text\\.Encoding\\]::UTF8\\.GetString\\(\\[Convert\\]::FromBase64String\\('([A-Za-z0-9+/=]+)'\\)\\)`))
  assert.ok(found, `the script sets $${name}`)
  return Buffer.from(found[1]!, 'base64').toString('utf8')
}

interface Call {
  file: string
  args: readonly string[]
  timeoutMs: number
}

function fake(answers: { whoami?: Finished; shell?: Finished }, log = '') {
  const calls: Call[] = []
  let taken = 0
  return {
    calls,
    taken: () => taken,
    options: {
      env,
      log: 'C:\\Users\\hi\\AppData\\Roaming\\eNCode\\sandbox\\grant.log',
      run: async (file: string, args: readonly string[], timeoutMs: number): Promise<Finished> => {
        calls.push({ file, args, timeoutMs })
        if (file.endsWith('whoami.exe')) return answers.whoami ?? { code: 0, stdout: `"desktop-lei8n94\\hi","${SID}"\r\n`, stderr: '' }
        return answers.shell ?? { code: 0, stdout: '', stderr: '' }
      },
      takeLog: async () => {
        taken++
        return taken > 1 ? log : ''
      },
    },
  }
}

describe('Fix this folder: which folders', () => {
  it('takes a folder on a drive of this computer, by its full path', () => {
    assert.equal(grantProblem('D:\\TEST SERVEr'), undefined)
    assert.equal(grantProblem("E:\\FiveM server's files & 100% (old)"), undefined)
  })

  it('refuses a share, a relative path, a whole drive, a name Windows does not allow, and one too long for the command line', () => {
    assert.match(grantProblem('\\\\nas\\share\\server') ?? '', /drives/)
    assert.match(grantProblem('TEST SERVEr') ?? '', /drives/)
    assert.match(grantProblem('\\\\?\\D:\\TEST SERVEr') ?? '', /drives/)
    assert.match(grantProblem('D:\\') ?? '', /whole drive/)
    assert.match(grantProblem('D:\\a"b') ?? '', /not a folder name/)
    assert.match(grantProblem('D:\\a\nb') ?? '', /not a folder name/)
    assert.match(grantProblem('D:\\a:stream') ?? '', /not a folder name/)
    assert.match(grantProblem(`D:\\${'a'.repeat(1100)}`) ?? '', /too long/)
  })
})

describe('Fix this folder: the scripts', () => {
  it('carries the folder and the log as base64, so no quoting is involved, and the account only as a SID', () => {
    const folder = "E:\\FiveM server's files & 100% $env:x `n"
    const script = elevatedScript(folder, SID, 'C:\\log dir\\grant.log')
    assert.equal(fromBase64(script, 'folder'), folder)
    assert.equal(fromBase64(script, 'log'), 'C:\\log dir\\grant.log')
    assert.ok(!script.includes('FiveM'), 'the folder is not in the script as text')
    assert.match(script, new RegExp(`\\$sid = '${SID}'`))
    assert.throws(() => elevatedScript(folder, "S-1-5'; Remove-Item C:\\ -Recurse; '", 'C:\\l'), /Not an account's SID/)
  })

  it('adds one inherited Full control entry, and takes ownership only when Windows refuses that', () => {
    const script = elevatedScript('D:\\TEST SERVEr', SID, 'C:\\l')
    assert.match(script, /& \$icacls \$folder \/grant "\*\$\{sid\}:\(OI\)\(CI\)F"/)
    assert.match(script, /System32\\icacls\.exe/)
    assert.match(script, /System32\\takeown\.exe/)
    const lines = script.split('\n')
    const first = lines.findIndex((line) => line === 'if ((AddEntry) -eq 0) { exit 0 }')
    const take = lines.findIndex((line) => line.includes('& $takeown /F $folder'))
    assert.ok(first > 0 && take > first, 'the owner changes only after a plain grant failed')
    assert.ok(lines.includes(`if ($LASTEXITCODE -ne 0) { exit ${OWNER_FAILED} }`))
    assert.ok(lines.includes(`if ((AddEntry) -eq 0) { exit ${GRANTED_AS_OWNER} }`))
    assert.equal(lines.at(-1), `exit ${GRANT_FAILED}`)
    assert.ok(!/\/T\b|\/R\b|\/reset|\/remove|\/deny|\/inheritance/i.test(script), 'nothing else is changed, and not file by file')
  })

  it('asks Windows to start it elevated, hidden, and turns a no into the cancelled code', () => {
    const elevated = elevatedScript('D:\\TEST SERVEr', SID, 'C:\\l')
    const launcher = launcherScript(elevated)
    const passed = launcher.match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/)?.[1]
    assert.ok(passed)
    assert.equal(decode(passed), elevated)
    assert.match(launcher, /Start-Process -FilePath \$shell -ArgumentList \$arguments -Verb RunAs -WindowStyle Hidden -PassThru/)
    assert.match(launcher, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/)
    assert.match(launcher, new RegExp(`NativeErrorCode -eq ${CANCELLED}\\) \\{ exit ${CANCELLED} \\}`))
    assert.match(launcher, /\$null = \$process\.Handle\n\$process\.WaitForExit\(\)\nexit \$process\.ExitCode$/)
  })
})

describe('Fix this folder: the answers', () => {
  it('runs Windows’ own programs by their full paths, and reports a plain grant', async () => {
    const run = fake({})
    assert.deepEqual(await grantFolder('D:\\TEST SERVEr\\', run.options), { ok: true, owner: false })
    assert.equal(run.calls[0]!.file, 'C:\\Windows\\System32\\whoami.exe')
    assert.deepEqual(run.calls[0]!.args, ['/user', '/fo', 'csv', '/nh'])
    assert.equal(run.calls[1]!.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(run.calls[1]!.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    const elevated = decode(decode(run.calls[1]!.args[5]!).match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/)![1]!)
    assert.equal(fromBase64(elevated, 'folder'), 'D:\\TEST SERVEr', 'without the trailing separator, which would end the quoted argument')
    assert.ok(elevated.includes(`$sid = '${SID}'`))
    assert.equal(fromBase64(elevated, 'log'), 'C:\\Users\\hi\\AppData\\Roaming\\eNCode\\sandbox\\grant.log')
    assert.ok(run.calls[1]!.timeoutMs >= 5 * 60_000, 'the person has time to answer the prompt')
    assert.equal(run.taken(), 2, 'an old log is cleared first and this one is read and removed after')
  })

  it('says when ownership had to be taken first', async () => {
    assert.deepEqual(await grantFolder('D:\\TEST SERVEr', fake({ shell: { code: GRANTED_AS_OWNER, stdout: '', stderr: '' } }).options), { ok: true, owner: true })
  })

  it('is cancelled, not failed, when the person says no to Windows', async () => {
    assert.deepEqual(await grantFolder('D:\\TEST SERVEr', fake({ shell: { code: CANCELLED, stdout: '', stderr: '' } }).options), { ok: false, cancelled: true })
  })

  it('gives Windows’ own words when even an administrator may not change the folder', async () => {
    const log = 'D:\\TEST SERVEr: Access is denied.\r\nSuccessfully processed 0 files; Failed processing 1 files\r\n'
    const outcome = await grantFolder('D:\\TEST SERVEr', fake({ shell: { code: GRANT_FAILED, stdout: '', stderr: '' } }, log).options)
    assert.deepEqual(outcome, { ok: false, reason: 'Windows did not let an administrator change the permissions of D:\\TEST SERVEr. Windows said: D:\\TEST SERVEr: Access is denied.' })
    const owner = await grantFolder('D:\\TEST SERVEr', fake({ shell: { code: OWNER_FAILED, stdout: '', stderr: '' } }, 'ERROR: The current logged on user does not have ownership privileges.').options)
    assert.ok(!owner.ok && !owner.cancelled && /ownership privileges/.test(owner.reason))
  })

  it('says when PowerShell could not ask, or the answer did not come in time', async () => {
    const launch = await grantFolder('D:\\TEST SERVEr', fake({ shell: { code: 20, stdout: '', stderr: 'Start-Process : This command cannot be run.\r\n' } }).options)
    assert.ok(!launch.ok && !launch.cancelled && /could not be asked for an administrator \(code 20\)\. Windows said: Start-Process : This command cannot be run\./.test(launch.reason))
    const late = await grantFolder('D:\\TEST SERVEr', fake({ shell: { code: null, stdout: '', stderr: '' } }).options)
    assert.ok(!late.ok && !late.cancelled && /did not answer in time/.test(late.reason))
  })

  it('stops before asking Windows when the folder is not one it takes, or the account is unknown', async () => {
    const share = fake({})
    const refused = await grantFolder('\\\\nas\\share', share.options)
    assert.ok(!refused.ok && !refused.cancelled)
    assert.equal(share.calls.length, 0)
    const nobody = fake({ whoami: { code: 1, stdout: '', stderr: 'ERROR: Access denied.' } })
    const unknown = await grantFolder('D:\\TEST SERVEr', nobody.options)
    assert.ok(!unknown.ok && !unknown.cancelled && /did not say which account this is\. ERROR: Access denied\./.test(unknown.reason))
    assert.equal(nobody.calls.length, 1, 'Windows was not asked for an administrator')
  })
})
