import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blindWait, blindWaitAdvice, topStatements } from './waits'

describe('blindWait', () => {
  it('finds a PowerShell sleep standing on its own, however it is written', () => {
    assert.equal(blindWait('Start-Sleep -Seconds 110; "waited"', 'pwsh'), 110)
    assert.equal(blindWait('Start-Sleep 110', 'pwsh'), 110)
    assert.equal(blindWait('docker ps; Start-Sleep -s 30', 'pwsh'), 30)
    assert.equal(blindWait('Start-Sleep -Seconds:45', 'pwsh'), 45)
    assert.equal(blindWait('sleep -Milliseconds 90000', 'pwsh'), 90)
    assert.equal(blindWait('Start-Sleep -ms 500', 'pwsh'), 0.5)
    assert.equal(blindWait('Start-Sleep -Duration 00:01:50', 'pwsh'), 110)
    assert.equal(blindWait('timeout /t 60 /nobreak', 'pwsh'), 60)
    assert.equal(blindWait('timeout.exe /T -1', 'pwsh'), Number.POSITIVE_INFINITY)
    assert.equal(blindWait('docker compose up -d\nStart-Sleep -Seconds 120 # let it boot\ndocker ps', 'pwsh'), 120)
  })

  it('leaves alone a PowerShell sleep inside a loop or a condition, and waits it cannot read', () => {
    assert.equal(blindWait('for ($i = 0; $i -lt 24; $i++) { if (docker ps | Select-String Up) { break }; Start-Sleep -Seconds 5 }', 'pwsh'), 0)
    assert.equal(blindWait('while ($true) {\n  Start-Sleep 100\n}', 'pwsh'), 0)
    assert.equal(blindWait('if (Test-Path x) { Start-Sleep 100 }', 'pwsh'), 0)
    assert.equal(blindWait('Start-Sleep -Seconds $wait', 'pwsh'), 0)
    assert.equal(blindWait('Write-Output "Start-Sleep 100"; echo \'sleep 90\'', 'pwsh'), 0)
    assert.equal(blindWait('Start-Sleep -Seconds (60 * 2)', 'pwsh'), 0)
    assert.equal(blindWait("@'\nStart-Sleep 100\n'@ | Out-File a.ps1", 'pwsh'), 0)
    assert.equal(blindWait('Get-Process', 'pwsh'), 0)
  })

  it('finds a bash sleep standing on its own, in a chain or a group, but not one run in the background', () => {
    assert.equal(blindWait('sleep 110', 'bash'), 110)
    assert.equal(blindWait('sleep 110; echo waited', 'bash'), 110)
    assert.equal(blindWait('sleep 1m 30s && docker ps', 'bash'), 90)
    assert.equal(blindWait('/usr/bin/sleep 2h', 'bash'), 7200)
    assert.equal(blindWait('(sleep 100)', 'bash'), 100)
    assert.equal(blindWait('sleep infinity', 'bash'), Number.POSITIVE_INFINITY)
    assert.equal(blindWait('sleep 100 & echo started', 'bash'), 0)
  })

  it('leaves alone a bash sleep in a loop, and one it cannot read', () => {
    assert.equal(blindWait('until docker ps | grep -q Up; do sleep 5; done', 'bash'), 0)
    assert.equal(blindWait('for i in $(seq 24); do curl -sf localhost:3000 && break; sleep 5; done', 'bash'), 0)
    assert.equal(blindWait('sleep $N', 'bash'), 0)
    assert.equal(blindWait('echo "sleep 100"', 'bash'), 0)
    assert.equal(blindWait('npm test', 'bash'), 0)
  })
})

describe('topStatements', () => {
  it('splits at ; and line ends outside quotes, brackets and braces', () => {
    assert.deepEqual(topStatements('a; b "x;y"\nc { d; e } ; f'), ['a', 'b "x;y"', 'c { d; e }', 'f'])
    assert.deepEqual(topStatements("Write-Output 'it''s; fine'; g"), ["Write-Output 'it''s; fine'", 'g'])
    assert.deepEqual(topStatements('Write-Output a`;b; c'), ['Write-Output a`;b', 'c'])
  })

  it('reads nothing it cannot split safely', () => {
    assert.equal(topStatements('a "unclosed'), null)
    assert.equal(topStatements('a { b'), null)
    assert.equal(topStatements('<# block #> a'), null)
  })
})

describe('blindWaitAdvice', () => {
  it('says what was not run, to wait for a command in BashOutput and for anything else with a short loop, in the shell in use', () => {
    const pwsh = blindWaitAdvice(110, 'pwsh')
    assert.match(pwsh, /^Not run: this command waits 110 s doing nothing/)
    assert.match(pwsh, /run_in_background and read it with BashOutput: that waits up to 30 s for new output/)
    assert.match(pwsh, /\$i -lt 6[\s\S]*Start-Sleep -Seconds 5 \}/)
    const bash = blindWaitAdvice(Number.POSITIVE_INFINITY, 'bash')
    assert.match(bash, /waits without end[\s\S]*seq 6[\s\S]*sleep 5; done/)
    // The loop takes 30 s at most: a longer one is the stall this advice is there to end.
    assert.ok(!/seq 24|-lt 24/.test(pwsh + bash))
  })
})
