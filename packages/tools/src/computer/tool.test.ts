import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createToolRegistry } from '../builtin'
import { FakeDesktop, testContext, testDesktop, textOf, type FakeElement, type FakeWindow } from '../testing'
import type { ToolContext, ToolOutcome } from '../types'
import { computerTool, startMatches, TAKEN_OVER_DISPLAY, type ComputerInput } from './tool'

/** A text editor with a menu, an edit field and a status bar. */
function editor(): { window: FakeWindow; menu: FakeElement; file: FakeElement; field: FakeElement; saveAs: FakeElement } {
  const saveAs: FakeElement = { role: 'menuitem', name: 'Save as…', can: ['invoke'] }
  const file: FakeElement = { role: 'menuitem', name: 'File', can: ['invoke', 'expand'] }
  const menu: FakeElement = { role: 'menubar', children: [file, { role: 'menuitem', name: 'Edit', can: ['invoke'] }] }
  const field: FakeElement = { role: 'edit', name: 'Text editor', value: '', can: ['set_value'] }
  file.invoke = () => {
    menu.children = [...(menu.children ?? []), saveAs]
  }
  return {
    window: { app: 'notepad.exe', label: 'Notepad', title: 'Untitled - Notepad', elements: [menu, field, { role: 'text', name: 'Ln 1, Col 1' }] },
    menu,
    file,
    field,
    saveAs,
  }
}

const NOTEPAD = ['notepad.exe']

function setup(windows: FakeWindow[], options: Parameters<typeof testDesktop>[1] = { permitted: NOTEPAD }) {
  const backend = new FakeDesktop(windows)
  const desktop = testDesktop(backend, options)
  const context = (overrides: Partial<ToolContext> = {}) => testContext('/workspace', { desktop, ...overrides })
  const call = (input: ComputerInput, overrides: Partial<ToolContext> = {}): Promise<ToolOutcome> => computerTool.run(input, context(overrides))
  return { backend, desktop, context, call }
}

const images = (outcome: ToolOutcome) => (typeof outcome.content === 'string' ? [] : outcome.content.filter((part) => part.type === 'image'))

describe('Computer: listing windows', () => {
  it('names the windows it may use, and only names the ones that wait for permission', async () => {
    const { call } = setup([
      editor().window,
      { app: 'slack.exe', label: 'Slack', title: 'Secret channel - Slack', elements: [] },
      { app: 'windowsterminal.exe', label: 'Windows Terminal', title: 'PS C:\\', elements: [] },
      { app: 'notepad.exe', label: 'Elevated', title: 'Admin', elements: [], blocked: 'it runs as administrator' },
    ])
    const outcome = await call({ action: 'windows' })
    assert.equal(outcome.ok, true)
    const text = textOf(outcome.content)
    assert.match(text, /Windows you can use:\nw1 Notepad "Untitled - Notepad" 800x600/)
    assert.match(text, /Not allowed yet \(the first use asks the user\): w2 Slack/)
    assert.doesNotMatch(text, /Secret channel/, 'a title is shown only for an application the user allowed')
    assert.match(text, /Never available: .*Windows Terminal \(terminals and shells run commands without the command approval/)
    assert.match(text, /Elevated \(it runs as administrator\)/)
    assert.doesNotMatch(text, /PS C:/)
  })

  it('says so when nothing is open', async () => {
    const { call } = setup([])
    assert.match(textOf((await call({ action: 'windows' })).content), /No window is open in an application you may use yet\.[\s\S]*The desktop shows no windows\./)
  })
})

describe('Computer: looking', () => {
  it('shows the window as an outline with refs and as an image the model can read', async () => {
    const { call, desktop } = setup([editor().window])
    await call({ action: 'windows' })
    const outcome = await call({ action: 'screenshot', window: 'w1' })
    assert.equal(outcome.ok, true)
    const text = textOf(outcome.content)
    assert.match(text, /^w1 Notepad "Untitled - Notepad" 800x600/)
    assert.match(text, /Screenshot s1 is 800x600 pixels\. Coordinates are pixels of this screenshot\./)
    assert.match(text, /<screen_content window="w1">/)
    assert.match(text, /\ne1 menubar\n/)
    assert.match(text, /\n {2}e2 menuitem "File"\n/)
    assert.match(text, /e4 edit "Text editor"/)
    assert.equal(images(outcome).length, 1)
    assert.equal((images(outcome)[0] as { transient?: boolean }).transient, true, 'a screenshot is marked as one that goes stale')
    assert.equal(desktop.state.target, 'w1')
    assert.equal(desktop.state.capture('w1')?.id, 's1')
  })

  it('sends no image to a model that cannot read one, and says how coordinates then work', async () => {
    const { call } = setup([editor().window], { permitted: NOTEPAD, vision: false })
    const outcome = await call({ action: 'screenshot', window: 'w1' })
    assert.equal(images(outcome).length, 0)
    assert.match(textOf(outcome.content), /This model cannot read images, so there is no screenshot: use the refs/)
  })

  it('shrinks a big window and prints positions in the pixels of the image', async () => {
    const big: FakeWindow = { app: 'notepad.exe', title: 'Big', box: [0, 0, 3200, 1800], elements: [{ role: 'pane', box: [1600, 900, 100, 100] }] }
    const { call } = setup([big])
    const text = textOf((await call({ action: 'screenshot', window: 'w1' })).content)
    assert.match(text, /Screenshot s1 is 1430x804 pixels \(the window is 3200x1800, sent smaller\)/)
    assert.match(text, /e1 pane @737,424/)
  })

  it('finds elements by name and role without a screenshot', async () => {
    const { call } = setup([editor().window])
    const outcome = await call({ action: 'find', window: 'w1', text: 'file' })
    assert.equal(images(outcome).length, 0)
    assert.match(textOf(outcome.content), /1 match in w1:[\s\S]*e2 menuitem "File"/)
    const none = await call({ action: 'find', window: 'w1', role: 'slider' })
    assert.match(textOf(none.content), /Nothing in w1 matches/)
  })

  it('refuses a window the user has not allowed, and one that can never be used', async () => {
    const { call, backend } = setup([
      { app: 'slack.exe', title: 'Slack', elements: [] },
      { app: 'cmd.exe', title: 'Command Prompt', elements: [] },
      { app: 'notepad.exe', title: 'Admin', elements: [], blocked: 'it runs as administrator' },
    ])
    const denied = await call({ action: 'screenshot', window: 'w1' })
    assert.equal(denied.ok, false)
    assert.match(textOf(denied.content), /The user has not allowed slack yet/)
    const terminal = await call({ action: 'screenshot', window: 'w2' })
    assert.equal(terminal.ok, false)
    assert.match(textOf(terminal.content), /cmd cannot be used: terminals and shells run commands without the command approval/)
    const elevated = await call({ action: 'screenshot', window: 'w3' })
    assert.match(textOf(elevated.content), /cannot be used: it runs as administrator/)
    assert.equal(backend.calls.filter((item) => item.op === 'look').length, 0, 'nothing was looked at')
  })

  it('tells a window that is gone from one that never was', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'windows' })
    backend.close('w1')
    const outcome = await call({ action: 'screenshot', window: 'w1' })
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /Window w1 is gone\. Call windows to see what is open\./)
    const never = await call({ action: 'screenshot', window: 'w9' })
    assert.match(textOf(never.content), /There is no window w9\. Call windows for the current list\./)
    const unnamed = await setup([]).call({ action: 'screenshot' })
    assert.match(textOf(unnamed.content), /No window is chosen yet/)
  })
})

describe('Computer: input', () => {
  it('acts on an element through its own interface and reports what changed', async () => {
    const { call, desktop } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'left_click', element: 'e2' })
    assert.equal(outcome.ok, true)
    const text = textOf(outcome.content)
    assert.match(text, /Clicked e2 menuitem "File" through its own interface \(invoke\)\./)
    assert.equal(outcome.display?.output, 'click e2 menuitem "File" in Notepad', 'the work log says what was clicked and in which application')
    assert.match(text, /Changes in w1:/)
    assert.match(text, /\+ e\d+ menuitem "Save as…"/)
    assert.equal(images(outcome).length, 1, 'the window changed, so a screenshot comes with it')
    assert.equal(desktop.state.target, 'w1')
  })

  it('says nothing changed, and sends no image, when an input did nothing', async () => {
    const { call } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'left_click', coordinate: [790, 590] })
    assert.equal(outcome.ok, true)
    assert.match(textOf(outcome.content), /Nothing visible changed\./)
    assert.equal(images(outcome).length, 0)
  })

  it('maps a coordinate through the screenshot it was read from', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    // The File item sits at box [108, 54, 200, 22] on screen: its centre is (208, 65), which is (108 + 100, 54 + 11) away from the window's corner (100, 80)... measured from the image origin:
    const info = (await backend.windows())[0]
    await call({ action: 'left_click', coordinate: [info.box[2] - 1, info.box[3] - 1] })
    const act = backend.calls.filter((item) => item.op === 'act').at(-1)!.request as { steps: { target: { point: number[]; capture: string } }[] }
    assert.deepEqual(act.steps[0].target, { point: [799, 599], capture: 's1' })
  })

  it('needs a screenshot before a coordinate, and a coordinate inside it', async () => {
    const { call } = setup([editor().window])
    await call({ action: 'windows' })
    const early = await call({ action: 'left_click', window: 'w1', coordinate: [10, 10] })
    assert.equal(early.ok, false)
    assert.match(textOf(early.content), /Take a screenshot of w1 first: coordinates are pixels of a screenshot\./)
    await call({ action: 'screenshot', window: 'w1' })
    const outside = await call({ action: 'left_click', coordinate: [900, 10] })
    assert.match(textOf(outside.content), /\(900, 10\) is outside the screenshot, which is 800x600 pixels\./)
  })

  it('refuses a coordinate whose window has moved since the screenshot', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    backend.move('w1', [300, 300, 800, 600])
    const outcome = await call({ action: 'left_click', coordinate: [20, 20] })
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /moved or changed size since screenshot s1\. Take a new screenshot and use its coordinates\./)
  })

  it('refuses an input that would land under another window', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    backend.covers.push([100, 80, 400, 300])
    const outcome = await call({ action: 'left_click', coordinate: [50, 50] })
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /Another window is on top of \(150, 130\)\. Take a screenshot to see what is in the way, or use focus/)
  })

  it('types into an element and refuses a password field', async () => {
    const secret: FakeElement = { role: 'edit', name: 'Password', value: 'hunter2', states: ['password'] }
    const { call, backend } = setup([{ app: 'notepad.exe', title: 'Login', elements: [{ role: 'edit', name: 'User', value: '' }, secret] }])
    await call({ action: 'screenshot', window: 'w1' })
    const typed = await call({ action: 'type', element: 'e1', text: 'vineeth' })
    assert.equal(typed.ok, true)
    assert.match(textOf(typed.content), /Typed "vineeth" into e1 edit "User"/)
    assert.match(textOf(typed.content), /~ e1 edit "User" = "vineeth" \[focused\]/)
    const refused = await call({ action: 'type', element: 'e2', text: 'guess' })
    assert.equal(refused.ok, false)
    assert.match(textOf(refused.content), /password field\. Ask the user to type it themselves\./)
    const look = textOf((await call({ action: 'screenshot' })).content)
    assert.doesNotMatch(look, /hunter2/, 'the outline never carries a password')
    assert.equal(secret.value, 'hunter2')
    assert.equal(backend.calls.filter((item) => item.op === 'act').length, 2)
  })

  it('presses keys, and refuses the ones that leave the window', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'key', text: 'ctrl+a delete' })
    assert.equal(outcome.ok, true)
    assert.match(textOf(outcome.content), /Pressed Ctrl\+A Delete\./)
    const step = (backend.calls.filter((item) => item.op === 'act').at(-1)!.request as { steps: unknown[] }).steps[0]
    assert.deepEqual(step, { kind: 'key', combos: [{ modifiers: ['ctrl'], key: 'a' }, { modifiers: [], key: 'delete' }] })
    for (const [text, reason] of [
      ['alt+tab', /switches to another window/],
      ['win+r', /Windows key is not available/],
      ['ctrl+shift+escape', /opens the Start menu or the task manager/],
      ['ctrl+flarp', /"flarp" is not a key name/],
    ] as const) {
      assert.match(computerTool.check!({ action: 'key', text }) ?? '', reason)
    }
  })

  it('sets a value directly, and chooses an item by its name', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const set = await call({ action: 'set_value', element: 'e4', text: 'Hello' })
    assert.match(textOf(set.content), /Set the value of e4 edit "Text editor" to "Hello" through its own interface \(value\)\./)
    const chosen = await call({ action: 'select', text: 'edit' })
    assert.equal(chosen.ok, true)
    const step = (backend.calls.filter((item) => item.op === 'act').at(-1)!.request as { steps: { element: string }[] }).steps[0]
    assert.equal(step.element, 'e3', 'the one element named like "edit"')
    const unclear = await call({ action: 'select', text: 'e' })
    assert.equal(unclear.ok, false)
    assert.match(textOf(unclear.content), /Several elements match "e": .*Pass the ref of the one you mean\./)
    const missing = await call({ action: 'select', text: 'zzz' })
    assert.match(textOf(missing.content), /No element named like "zzz"/)
  })

  it('scrolls and drags with the targets it was given', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const scroll = await call({ action: 'scroll', coordinate: [400, 300], scroll_direction: 'down' })
    assert.equal(scroll.ok, true)
    const drag = await call({ action: 'left_click_drag', start_coordinate: [10, 40], coordinate: [300, 200] })
    assert.equal(drag.ok, true)
    const acts = backend.calls.filter((item) => item.op === 'act').map((item) => (item.request as { steps: { kind: string; amount?: number }[] }).steps[0])
    assert.equal(acts[0].kind, 'scroll')
    assert.equal(acts[0].amount, 3, 'three notches by default')
    assert.equal(acts[1].kind, 'drag')
  })

  it('reports a window the input closed, and forgets it', async () => {
    const closer: FakeElement = { role: 'button', name: 'Close', can: ['invoke'] }
    const { call, backend, desktop } = setup([{ app: 'notepad.exe', title: 'Dialog', elements: [closer] }])
    closer.invoke = () => backend.close('w1')
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'left_click', element: 'e1' })
    assert.equal(outcome.ok, true)
    assert.match(textOf(outcome.content), /Closed: w1\.\nThe window is gone\. Call windows to see what is open\./)
    assert.equal(desktop.state.window('w1'), undefined)
    assert.equal(desktop.state.target, undefined)
  })

  it('names a window an input opened', async () => {
    const dialog: FakeWindow = { app: 'notepad.exe', title: 'Save As', elements: [{ role: 'edit', name: 'File name' }] }
    const opener: FakeElement = { role: 'button', name: 'Open dialog', can: ['invoke'] }
    const { call, backend } = setup([{ app: 'notepad.exe', title: 'Main', elements: [opener] }])
    opener.invoke = () => {
      backend.add(dialog)
    }
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'left_click', element: 'e1' })
    assert.match(textOf(outcome.content), /Opened w2 "Save As"\. Use it with window: "w2"\./)
  })
})

describe('Computer: limits and safety', () => {
  it('stops a turn that has made all the inputs it may, and counts again in the next', async () => {
    const { call } = setup([editor().window], { permitted: NOTEPAD, options: { maxActionsPerTurn: 2 } })
    await call({ action: 'screenshot', window: 'w1' })
    assert.equal((await call({ action: 'mouse_move', coordinate: [5, 5] })).ok, true)
    assert.equal((await call({ action: 'mouse_move', coordinate: [6, 6] })).ok, true)
    const third = await call({ action: 'mouse_move', coordinate: [7, 7] })
    assert.equal(third.ok, false)
    assert.match(textOf(third.content), /already made 2 desktop inputs/)
    assert.equal((await call({ action: 'mouse_move', coordinate: [7, 7] }, { turnId: 'next turn' })).ok, true)
  })

  it('stops when the user moves the mouse, and sends nothing more in that turn', async () => {
    const { call, backend, desktop } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    assert.equal((await call({ action: 'mouse_move', coordinate: [50, 50] })).ok, true)
    backend.cursorAt = [900, 700]
    const stopped = await call({ action: 'mouse_move', coordinate: [60, 60] })
    assert.equal(stopped.ok, false)
    assert.match(textOf(stopped.content), /not where I left it\. I stopped\. Wait for the user to say whether to go on\./)
    assert.equal(stopped.display?.output, TAKEN_OVER_DISPLAY, 'the work log says the person took over')
    assert.equal(desktop.state.takenOverIn, 'turn')
    const calls = backend.calls.length
    const again = await call({ action: 'mouse_move', coordinate: [60, 60] })
    assert.match(textOf(again.content), /The user took over/)
    assert.equal(again.display?.output, TAKEN_OVER_DISPLAY)
    assert.equal(backend.calls.length, calls, 'the backend was not asked')
    backend.cursorAt = [60, 60]
    assert.equal((await call({ action: 'mouse_move', coordinate: [61, 61] }, { turnId: 'after the user spoke' })).ok, true)
  })

  it('reports a desktop that cannot be used', async () => {
    const backend = new FakeDesktop([editor().window], { unavailable: 'the screen is locked' })
    const desktop = testDesktop(backend, { permitted: NOTEPAD })
    const outcome = await computerTool.run({ action: 'windows' }, testContext('/workspace', { desktop }))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /Desktop control is not available: the screen is locked/)
  })

  it('does nothing without a desktop', async () => {
    const outcome = await computerTool.run({ action: 'windows' }, testContext('/workspace'))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /not available in this session/)
  })
})

describe('Computer: waiting and zooming', () => {
  it('waits for a name to appear', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    setTimeout(() => backend.change('w1', (elements) => elements.push({ role: 'text', name: 'Saved' })), 30)
    const outcome = await call({ action: 'wait', text: 'saved', duration: 3 })
    assert.equal(outcome.ok, true)
    assert.match(textOf(outcome.content), /"saved" is in w1\./)
    assert.match(textOf(outcome.content), /\+ e\d+ text "Saved"/)
    const never = await call({ action: 'wait', text: 'nothing like this', duration: 0.3 })
    assert.equal(never.ok, false)
    assert.match(textOf(never.content), /did not appear in w1 within 0\.3 seconds/)
  })

  it('zooms into part of a screenshot without moving the coordinates', async () => {
    const { call, desktop } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'zoom', region: [0, 0, 400, 300] })
    assert.equal(outcome.ok, true)
    assert.equal(images(outcome).length, 1)
    assert.match(textOf(outcome.content), /Coordinates for later steps still belong to screenshot s1\./)
    assert.equal(desktop.state.capture('w1')?.id, 's1')
    const beyond = await call({ action: 'zoom', region: [0, 0, 900, 300] })
    assert.match(textOf(beyond.content), /beyond the screenshot/)
    const blind = await setup([editor().window], { permitted: NOTEPAD, vision: false }).call({ action: 'zoom', window: 'w1', region: [0, 0, 10, 10] })
    assert.match(textOf(blind.content), /cannot read images/)
  })

  it('reports where the cursor is in the screenshot', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    backend.cursorAt = [300, 200]
    assert.match(textOf((await call({ action: 'cursor_position' })).content), /The cursor is at \(200, 120\) in screenshot s1 of w1\./)
    backend.cursorAt = [5, 5]
    assert.match(textOf((await call({ action: 'cursor_position' })).content), /outside the window you are working in/)
  })
})

describe('Computer: aiming (ADR 0121)', () => {
  const looks = (backend: FakeDesktop) => backend.calls.filter((item) => item.op === 'look').map((item) => item.request as { marks?: boolean })

  it('numbers the elements on the screenshot for a model that reads images, and not for one that does not', async () => {
    const { call, backend } = setup([editor().window])
    const outcome = await call({ action: 'screenshot', window: 'w1' })
    assert.equal(looks(backend).at(-1)?.marks, true)
    assert.match(textOf(outcome.content), /Coordinates are pixels of this screenshot\. 3 elements carry the number of their ref in a coloured tag beside it: 12 is e12\./)
    await call({ action: 'left_click', element: 'e2' })
    const act = backend.calls.filter((item) => item.op === 'act').at(-1)!.request as { look: { marks?: boolean } }
    assert.equal(act.look.marks, true, 'the picture after an input is numbered too')
    const blind = setup([editor().window], { permitted: NOTEPAD, vision: false })
    const text = textOf((await blind.call({ action: 'screenshot', window: 'w1' })).content)
    assert.equal(looks(blind.backend).at(-1)?.marks, undefined)
    assert.doesNotMatch(text, /coloured tag/)
  })

  it('gives a window that lists nothing to number a grid in its own pixels', async () => {
    const { call } = setup([{ app: 'notepad.exe', title: 'Game', elements: [{ role: 'pane', name: 'Board' }] }])
    const text = textOf((await call({ action: 'screenshot', window: 'w1' })).content)
    assert.match(text, /Nothing in this window is listed to number, so the screenshot has a grid labelled in its own pixels, every 100: read coordinates off it\./)
  })

  it('enlarges a zoom and labels its grid in the pixels of the screenshot it enlarges', async () => {
    const { call, backend } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    const outcome = await call({ action: 'zoom', region: [0, 0, 200, 150] })
    assert.equal(looks(backend).at(-1)?.marks, false, 'a zoom shows the window as it is, with no numbers over it')
    assert.match(textOf(outcome.content), /shown 800x600 \(4\.0 times larger\)\. Its grid lines are labelled with pixels of screenshot s1, every 10: read a coordinate off them\./)
    const big = setup([{ app: 'notepad.exe', title: 'Big', box: [0, 0, 3200, 1800], elements: [] }])
    await big.call({ action: 'screenshot', window: 'w1' })
    const whole = await big.call({ action: 'zoom', region: [0, 0, 1430, 804] })
    assert.match(textOf(whole.content), /shown 1430x804\./)
    assert.doesNotMatch(textOf(whole.content), /times larger/, 'an area too big to enlarge is not said to be')
  })

  it('says what a click by coordinate landed on', async () => {
    const { call } = setup([editor().window])
    await call({ action: 'screenshot', window: 'w1' })
    // The File item is the second row, one level in: its box is [120, 134, 200, 22] on screen, (20, 54) from the window's corner.
    const outcome = await call({ action: 'left_click', coordinate: [120, 65] })
    assert.match(textOf(outcome.content), /^Clicked \(120, 65\) on e2 menuitem "File"\./)
    const by = await call({ action: 'left_click', element: 'e2' })
    assert.doesNotMatch(textOf(by.content), / on e2/, 'a click on an element names it once')
  })

  it('takes clicks on the taskbar and refuses keys there', async () => {
    const taskbar: FakeWindow = { app: 'taskbar', label: 'Taskbar', title: '', box: [0, 1040, 1920, 40], elements: [{ role: 'button', name: 'Discord', can: ['invoke'], box: [600, 1044, 40, 32] }] }
    const { call, backend } = setup([taskbar], { permitted: ['taskbar'] })
    await call({ action: 'screenshot', window: 'w1' })
    assert.equal((await call({ action: 'left_click', element: 'e1' })).ok, true)
    const acts = () => backend.calls.filter((item) => item.op === 'act').length
    const before = acts()
    for (const input of [{ action: 'type', text: 'cmd' }, { action: 'key', text: 'enter' }, { action: 'set_value', element: 'e1', text: 'cmd' }] as ComputerInput[]) {
      const refused = await call(input)
      assert.equal(refused.ok, false)
      assert.match(textOf(refused.content), /The taskbar takes clicks only: keys there could reach Windows search, which runs programs\. To start an application, use open\./)
    }
    assert.equal(acts(), before, 'nothing was sent')
  })
})

describe('Computer: opening an application', () => {
  const discordWindow = (): FakeWindow => ({ app: 'discord.exe', label: 'Discord', title: 'Friends - Discord', elements: [{ role: 'button', name: 'Add Friend', can: ['invoke'] }] })
  const startMenu = (backend: FakeDesktop) => {
    backend.addStartApp({ name: 'Discord', id: 'com.squirrel.Discord.Discord', app: 'discord.exe' }, discordWindow())
    backend.addStartApp({ name: 'Uninstall Discord', id: '{GUID}\\Discord\\Update.exe', app: 'update.exe' })
    backend.addStartApp({ name: 'Notepad', id: '{GUID}\\notepad.exe', app: 'notepad.exe' })
    backend.addStartApp({ name: 'Calculator', id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' })
    backend.addStartApp({ name: 'Command Prompt', id: '{GUID}\\cmd.exe', app: 'cmd.exe' })
    backend.addStartApp({ name: 'Terminal', id: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' })
    backend.addStartApp({ name: 'Steam', id: 'C:\\Steam\\steam.exe', app: 'steam.exe' })
    backend.addStartApp({ name: 'Microsoft Teams', id: 'MSTeams_8wekyb3d8bbwe!MSTeams' })
    backend.addStartApp({ name: 'Microsoft Edge', id: 'MSEdge', app: 'msedge.exe' })
  }

  it('finds an application by the name the Start menu shows, by its program, or by the start of its name, and never an uninstaller', () => {
    const apps = [
      { name: 'Discord', id: 'a', app: 'discord.exe' },
      { name: 'Uninstall Discord', id: 'b', app: 'update.exe' },
      { name: 'Discord Setup', id: 'c', app: 'discordsetup.exe' },
      { name: 'Visual Studio Code', id: 'd', app: 'code.exe' },
      { name: 'Microsoft Teams', id: 'e' },
      { name: 'Microsoft Edge', id: 'f', app: 'msedge.exe' },
    ]
    assert.deepEqual(startMatches('discord', apps).map((app) => app.id), ['a'])
    assert.deepEqual(startMatches('  Discord ', apps).map((app) => app.id), ['a'])
    assert.deepEqual(startMatches('code', apps).map((app) => app.id), ['d'], 'by its program when no name is that')
    assert.deepEqual(startMatches('visual', apps).map((app) => app.id), ['d'])
    assert.deepEqual(startMatches('microsoft', apps).map((app) => app.id), ['e', 'f'])
    assert.deepEqual(startMatches('teams', apps).map((app) => app.id), ['e'], 'by a word inside the name last')
    assert.deepEqual(startMatches('uninstall discord', apps), [])
    assert.deepEqual(startMatches('discord setup', apps), [])
  })

  it('opens it through the Start menu, shows the window that came up, and works on it next', async () => {
    const { backend, desktop, call } = setup([], { permitted: ['discord.exe'] })
    startMenu(backend)
    const outcome = await call({ action: 'open', text: 'discord' })
    assert.equal(outcome.ok, true, textOf(outcome.content))
    const text = textOf(outcome.content)
    assert.match(text, /^Opened Discord\.\nw1 Discord "Friends - Discord" 800x600/)
    assert.match(text, /button "Add Friend"/)
    assert.equal(outcome.display?.output, 'opened Discord')
    assert.equal(images(outcome).length, 1)
    assert.deepEqual(backend.calls.find((entry) => entry.op === 'open')?.request, { id: 'com.squirrel.Discord.Discord', name: 'Discord', waitMs: 15_000 })
    assert.equal(desktop.state.target, 'w1')
    const click = await call({ action: 'left_click', element: 'e1' })
    assert.equal(click.ok, true, textOf(click.content))
  })

  it('asks about the program it starts, and refuses terminals and system tools by their program or their name', async () => {
    const { backend, context, call } = setup([], { permitted: [] })
    startMenu(backend)
    assert.deepEqual(await computerTool.access({ action: 'open', text: 'Discord' }, context()), { type: 'desktop', app: 'discord.exe', label: 'Discord', title: 'Start menu' })
    assert.deepEqual(await computerTool.access({ action: 'open', text: 'Calculator' }, context()), { type: 'desktop', app: 'store:calculator', label: 'Calculator', title: 'Start menu' })
    const cmd = await computerTool.access({ action: 'open', text: 'Command Prompt' }, context())
    assert.equal(cmd.type === 'desktop' && cmd.blocked, 'terminals and shells run commands without the command approval; run commands with the Bash tool')
    const terminal = await computerTool.access({ action: 'open', text: 'Terminal' }, context())
    assert.match(terminal.type === 'desktop' ? (terminal.blocked ?? '') : '', /terminals and shells/)
    assert.deepEqual(await computerTool.access({ action: 'open', text: 'Photoshop' }, context()), { type: 'none' })

    const refused = await call({ action: 'open', text: 'Command Prompt' })
    assert.equal(refused.ok, false)
    assert.match(textOf(refused.content), /Command Prompt cannot be used: terminals and shells/)
    const unasked = await call({ action: 'open', text: 'Discord' })
    assert.match(textOf(unasked.content), /The user has not allowed Discord yet/)
    assert.equal(backend.calls.some((entry) => entry.op === 'open'), false, 'nothing was started')
  })

  it('says what matches when a name is not clear, and what is missing when nothing does', async () => {
    const { backend, call } = setup([], { permitted: 'all' })
    startMenu(backend)
    assert.match(textOf((await call({ action: 'open', text: 'microsoft' })).content), /Several applications match "microsoft": "Microsoft Teams", "Microsoft Edge"\. Open one by its full name\./)
    assert.match(textOf((await call({ action: 'open', text: 'Photoshop' })).content), /Nothing in the Start menu is named like "Photoshop"/)
  })

  it('says so when no window shows, and that the program is not to be ended for one', async () => {
    const { backend, call } = setup([], { permitted: 'all' })
    startMenu(backend)
    const outcome = await call({ action: 'open', text: 'Steam' })
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /no window of it showed within 15 seconds\. It may still be starting: call windows in a moment\. Do not end the program to get its window\./)
  })

  it('names a window it may not use yet rather than looking at it', async () => {
    const { backend, call } = setup([], { permitted: ['store:calculator'] })
    backend.addStartApp({ name: 'Calculator', id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, { app: 'calculatorapp.exe', label: 'Calculator', title: 'Calculator', elements: [] })
    const outcome = await call({ action: 'open', text: 'Calculator' })
    assert.equal(outcome.ok, true)
    assert.match(textOf(outcome.content), /^Opened Calculator: w1 "Calculator" \(calculatorapp\.exe\)\. The user has not allowed Calculator yet\. Calling this again asks them\.$/)
    assert.equal(backend.calls.some((entry) => entry.op === 'look'), false)
  })

  it('reads the Start menu once for the approval and the call that follows it', async () => {
    const { backend, context } = setup([], { permitted: 'all' })
    startMenu(backend)
    const ctx = context()
    await computerTool.access({ action: 'open', text: 'Discord' }, ctx)
    await computerTool.run({ action: 'open', text: 'Discord' }, ctx)
    assert.equal(backend.calls.filter((entry) => entry.op === 'apps').length, 1)
  })

  it('opens nothing once the user took over in the turn', async () => {
    const { backend, desktop, call } = setup([], { permitted: 'all' })
    startMenu(backend)
    desktop.state.takenOverIn = 'turn-1'
    const outcome = await call({ action: 'open', text: 'Discord' }, { turnId: 'turn-1' })
    assert.equal(outcome.display?.output, TAKEN_OVER_DISPLAY)
    assert.equal(backend.calls.some((entry) => entry.op === 'open'), false)
  })
})

describe('Computer: approval', () => {
  it('names the application a call would reach, so the policy can decide', async () => {
    const { context } = setup([editor().window, { app: 'cmd.exe', label: 'Command Prompt', title: 'cmd', elements: [] }])
    const access = await computerTool.access({ action: 'screenshot', window: 'w1' }, context())
    assert.deepEqual(access, { type: 'desktop', app: 'notepad.exe', label: 'Notepad', title: 'Untitled - Notepad' })
    const refused = await computerTool.access({ action: 'screenshot', window: 'w2' }, context())
    assert.deepEqual(refused, { type: 'desktop', app: 'cmd.exe', label: 'Command Prompt', title: 'cmd', blocked: 'terminals and shells run commands without the command approval; run commands with the Bash tool' })
    assert.deepEqual(await computerTool.access({ action: 'windows' }, context()), { type: 'none' })
    assert.deepEqual(await computerTool.access({ action: 'screenshot', window: 'w9' }, context()), { type: 'none' })
  })

  it('describes the first step for the approval card, with a warning for a browser', async () => {
    const { context } = setup([editor().window, { app: 'chrome.exe', label: 'Google Chrome', title: 'GitHub', elements: [] }])
    const ctx = context()
    await computerTool.access({ action: 'screenshot', window: 'w1' }, ctx)
    const note = await computerTool.describe({ action: 'left_click', window: 'w1', element: 'e2' }, ctx)
    assert.equal(note.title, 'Use Notepad')
    assert.match(note.detail ?? '', /^w1 "Untitled - Notepad" \(notepad\.exe\)\nFirst step: left click e2$/)
    await computerTool.access({ action: 'screenshot', window: 'w2' }, ctx)
    const browser = await computerTool.describe({ action: 'key', window: 'w2', text: 'ctrl+l' }, ctx)
    assert.match(browser.detail ?? '', /First step: press Ctrl\+L\nWeb pages can hold text that tries to steer the agent/)
  })

  it('checks again before it acts, so a window the policy did not see is still refused', async () => {
    const { call } = setup([editor().window], { permitted: [] })
    const outcome = await call({ action: 'left_click', window: 'w1', coordinate: [1, 1] })
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /has not allowed Notepad yet/)
  })
})

describe('Computer: the registry', () => {
  it('is offered in code mode only, and only when a session asks for it', () => {
    const without = createToolRegistry({ dialect: 'bash', platform: 'win32' })
    assert.equal(without.has('Computer'), false)
    const registry = createToolRegistry({ dialect: 'bash', platform: 'win32', computer: true })
    assert.equal(registry.has('Computer'), true)
    assert.deepEqual(registry.offered('code').map((tool) => tool.definition.name).includes('Computer'), true)
    assert.equal(registry.offered('plan').some((tool) => tool.definition.name === 'Computer'), false)
    assert.equal(registry.offered('ask').some((tool) => tool.definition.name === 'Computer'), false)
  })

  it('checks inputs the way a model can fix them', () => {
    const registry = createToolRegistry({ dialect: 'bash', platform: 'win32', computer: true })
    const check = (input: Record<string, unknown>) => registry.check('Computer', input, 'code')
    assert.equal(check({ action: 'windows' }), undefined)
    assert.equal(check({ action: 'left_click', element: 'e12' }), undefined)
    assert.equal(check({ action: 'left_click', coordinate: [10, 20] }), undefined)
    assert.match(check({ action: 'dance' }) ?? '', /action must be one of: windows, open, focus, screenshot/)
    assert.equal(check({ action: 'open', text: 'Discord' }), undefined)
    assert.match(check({ action: 'open' }) ?? '', /open needs text: the application, by the name the Start menu shows/)
    assert.match(check({ action: 'open', text: 'x'.repeat(201) }) ?? '', /the name of an application, not a command/)
    assert.match(check({ action: 'left_click' }) ?? '', /left_click needs element \(a ref\) or coordinate/)
    assert.match(check({ action: 'left_click', element: 'e1', coordinate: [1, 2] }) ?? '', /give element or coordinate, not both/)
    assert.match(check({ action: 'left_click', element: 'button' }) ?? '', /element is a ref from the outline, such as "e12"/)
    assert.match(check({ action: 'left_click', coordinate: [1] }) ?? '', /coordinate must have at least 2 items/)
    assert.match(check({ action: 'left_click', coordinate: [1.5, 2] }) ?? '', /coordinate\[0\] must be an integer/)
    assert.match(check({ action: 'focus' }) ?? '', /focus needs a window id/)
    assert.match(check({ action: 'type' }) ?? '', /type needs text/)
    assert.match(check({ action: 'type', text: 'x'.repeat(4001) }) ?? '', /at most 4000 characters/)
    assert.match(check({ action: 'scroll' }) ?? '', /scroll needs scroll_direction/)
    assert.match(check({ action: 'scroll', scroll_direction: 'sideways' }) ?? '', /scroll_direction must be one of: up, down, left, right/)
    assert.match(check({ action: 'zoom', region: [10, 10, 5, 20] }) ?? '', /x2 > x1/)
    assert.match(check({ action: 'find' }) ?? '', /find needs text/)
    assert.match(check({ action: 'left_click_drag', coordinate: [1, 1] }) ?? '', /needs start_element or start_coordinate/)
    assert.match(check({ action: 'select' }) ?? '', /select needs element or text/)
    assert.match(check({ action: 'set_value', element: 'e1' }) ?? '', /set_value needs text/)
    assert.equal(check({ action: 'set_value', element: 'e1', text: '' }), undefined, 'an empty value clears a field')
    assert.match(check({ action: 'screenshot', mode: 'fast' }) ?? '', /mode is not a known parameter/)
    assert.match(check({ action: 'screenshot', window: 'main' }) ?? '', /window is an id from windows/)
  })
})
