import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SHELL_APP, TASKBAR_APP, classifyApp, labelFor, pointerOnly } from './apps'

describe('which applications the agent may operate', () => {
  it('refuses terminals, editors with a terminal, password managers, system tools and remote desktops', () => {
    for (const app of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'WindowsTerminal.exe', 'bash.exe', 'wsl.exe']) assert.match(classifyApp(app).blocked ?? '', /command approval/, app)
    for (const app of ['code.exe', 'cursor.exe', 'devenv.exe', 'idea64.exe']) assert.match(classifyApp(app).blocked ?? '', /built-in terminal/, app)
    for (const app of ['keepassxc.exe', '1password.exe', 'bitwarden.exe']) assert.match(classifyApp(app).blocked ?? '', /credentials/, app)
    for (const app of ['taskmgr.exe', 'regedit.exe', 'mmc.exe', 'consent.exe']) assert.match(classifyApp(app).blocked ?? '', /system tools/, app)
    for (const app of ['mstsc.exe', 'anydesk.exe', 'virtualbox.exe']) assert.match(classifyApp(app).blocked ?? '', /other machines/, app)
    assert.match(classifyApp(SHELL_APP).blocked ?? '', /Start menu, search and the Run box/)
    assert.match(classifyApp(SHELL_APP).blocked ?? '', /command approval/)
  })

  it('lets the taskbar take clicks, with a warning, and no keys (ADR 0121)', () => {
    assert.equal(classifyApp(TASKBAR_APP).blocked, undefined)
    assert.match(classifyApp(TASKBAR_APP).caution ?? '', /quick settings/)
    assert.match(pointerOnly(TASKBAR_APP) ?? '', /clicks only/)
    assert.equal(pointerOnly('notepad.exe'), undefined)
    assert.equal(pointerOnly('explorer.exe'), undefined)
    assert.equal(labelFor(TASKBAR_APP), 'Taskbar')
  })

  it('allows the rest, and warns about browsers, messaging and the file manager', () => {
    assert.deepEqual(classifyApp('notepad.exe'), {})
    assert.deepEqual(classifyApp('calc.exe'), {})
    assert.match(classifyApp('chrome.exe').caution ?? '', /steer the agent/)
    assert.match(classifyApp('slack.exe').caution ?? '', /cannot be taken back/)
    assert.match(classifyApp('explorer.exe').caution ?? '', /checkpoints/)
    assert.match(classifyApp('explorer.exe').caution ?? '', /desktop/)
    assert.match(classifyApp('explorer.exe').caution ?? '', /program or script opened here runs without the command approval/)
    assert.equal(classifyApp('chrome.exe').blocked, undefined)
  })

  it('names applications for people', () => {
    assert.equal(labelFor('chrome.exe'), 'Google Chrome')
    assert.equal(labelFor('someapp.exe'), 'someapp')
    assert.equal(labelFor('chrome.exe', ' Chrome Beta '), 'Chrome Beta')
  })
})
