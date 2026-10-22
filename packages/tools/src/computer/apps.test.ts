import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SHELL_APP, classifyApp, labelFor } from './apps'

describe('which applications the agent may operate', () => {
  it('refuses terminals, editors with a terminal, password managers, system tools and remote desktops', () => {
    for (const app of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'WindowsTerminal.exe', 'bash.exe', 'wsl.exe']) assert.match(classifyApp(app).blocked ?? '', /command approval/, app)
    for (const app of ['code.exe', 'cursor.exe', 'devenv.exe', 'idea64.exe']) assert.match(classifyApp(app).blocked ?? '', /built-in terminal/, app)
    for (const app of ['keepassxc.exe', '1password.exe', 'bitwarden.exe']) assert.match(classifyApp(app).blocked ?? '', /credentials/, app)
    for (const app of ['taskmgr.exe', 'regedit.exe', 'mmc.exe', 'consent.exe']) assert.match(classifyApp(app).blocked ?? '', /system tools/, app)
    for (const app of ['mstsc.exe', 'anydesk.exe', 'virtualbox.exe']) assert.match(classifyApp(app).blocked ?? '', /other machines/, app)
    assert.match(classifyApp(SHELL_APP).blocked ?? '', /taskbar/)
  })

  it('allows the rest, and warns about browsers, messaging and the file manager', () => {
    assert.deepEqual(classifyApp('notepad.exe'), {})
    assert.deepEqual(classifyApp('calc.exe'), {})
    assert.match(classifyApp('chrome.exe').caution ?? '', /steer the agent/)
    assert.match(classifyApp('slack.exe').caution ?? '', /cannot be taken back/)
    assert.match(classifyApp('explorer.exe').caution ?? '', /checkpoints/)
    assert.equal(classifyApp('chrome.exe').blocked, undefined)
  })

  it('names applications for people', () => {
    assert.equal(labelFor('chrome.exe'), 'Google Chrome')
    assert.equal(labelFor('someapp.exe'), 'someapp')
    assert.equal(labelFor('chrome.exe', ' Chrome Beta '), 'Chrome Beta')
  })
})
