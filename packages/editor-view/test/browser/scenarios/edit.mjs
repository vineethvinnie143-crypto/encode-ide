export const edit = [
  {
    name: 'typing conveniences: brackets close and are stepped over, Enter indents, Tab and Shift+Tab indent',
    async run({ mount, typeKeys, press, text, selection, assert }) {
      await mount({ text: '', path: 'a.ts' })
      await typeKeys('if (x) {')
      assert.equal(await text(), 'if (x) {}')
      await press('Enter')
      assert.equal(await text(), 'if (x) {\n  \n}')
      await typeKeys('f(')
      assert.equal(await text(), 'if (x) {\n  f()\n}')
      await typeKeys(')')
      assert.equal(await text(), 'if (x) {\n  f()\n}')
      assert.deepEqual(await selection(), [[14, 14]])
      // Tab after code goes to the next multiple of the indent unit (2); Shift+Tab takes a level off the line.
      await press('Tab')
      assert.equal(await text(), 'if (x) {\n  f() \n}')
      await press('Tab', { shift: true })
      assert.equal(await text(), 'if (x) {\nf() \n}')
    },
  },
  {
    name: 'Escape, then Tab, leaves the editor; Tab on its own still indents',
    async run({ mount, ev, press, text, assert }) {
      await mount({ text: 'x', path: 'a.txt' })
      const focused = () => ev(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName)
      await press('Tab')
      const indented = await text()
      assert.equal(indented, '  x', 'Tab indented')
      assert.equal(await focused(), 'enc-input', 'focus is still in the editor')
      await press('Escape')
      await press('Tab')
      assert.equal(await text(), indented, 'the Tab after Escape did not edit')
      assert.equal(await focused(), 'after', 'it moved focus out of the editor')
      // Any other key in between disarms it.
      await ev(() => window.view.focus())
      await press('Escape')
      await press('ArrowRight')
      await press('Tab')
      assert.ok((await text()).length > indented.length, 'a Tab after other keys indents again')
      assert.equal(await focused(), 'enc-input')
      // Shift on its own does not disarm it, and Shift+Tab goes back.
      await press('Escape')
      await press('Tab', { shift: true })
      assert.notEqual(await focused(), 'enc-input', 'Escape then Shift+Tab leaves too')
    },
  },
  {
    name: 'shortcuts: comment, move line, delete line, duplicate, select occurrences, word delete',
    async run({ mount, press, text, selection, assert }) {
      await mount({ text: 'one\ntwo\nthree\nthree', path: 'a.ts' })
      await press('/', { ctrl: true })
      assert.equal(await text(), '// one\ntwo\nthree\nthree')
      await press('/', { ctrl: true })
      assert.equal(await text(), 'one\ntwo\nthree\nthree')
      await press('ArrowDown', { alt: true })
      assert.equal(await text(), 'two\none\nthree\nthree')
      await press('ArrowUp', { alt: true })
      assert.equal(await text(), 'one\ntwo\nthree\nthree')
      await press('ArrowDown', { shift: true, alt: true })
      assert.equal(await text(), 'one\none\ntwo\nthree\nthree')
      await press('k', { ctrl: true, shift: true })
      assert.equal(await text(), 'one\ntwo\nthree\nthree')
      // Ctrl+D selects the word and then the next occurrence of it.
      await press('ArrowDown')
      await press('ArrowDown')
      await press('d', { ctrl: true })
      await press('d', { ctrl: true })
      assert.equal((await selection()).length, 2)
      await press('Backspace')
      assert.equal(await text(), 'one\ntwo\n\n')
      await press('z', { ctrl: true })
      await press('End', { ctrl: true })
      await press('Backspace', { ctrl: true })
      assert.equal(await text(), 'one\ntwo\nthree\n')
    },
  },
  {
    name: 'events: focus, blur, context menu, request and navigate',
    async run({ mount, ev, page, press, at, assert, settle }) {
      await mount({ text: 'alpha beta\ngamma', path: 'a.ts', focus: false })
      await ev(() => {
        window.log = []
        const view = window.view
        for (const name of ['focus', 'blur']) view.on(name, () => window.log.push(name))
        view.on('contextmenu', (event) => window.log.push(`contextmenu@${event.pos}`))
        view.on('request', (name) => window.log.push(`request:${name}`))
        view.on('navigate', (event) => window.log.push(`navigate@${event.pos}`))
        view.on('transaction', (tr) => window.log.push(`tr:${tr.origin ?? ''}`))
      })
      const p = await at(1, 7)
      await page.click(p.x, p.y)
      await settle()
      assert.deepEqual((await ev(() => window.log)).slice(0, 2).sort(), ['focus', 'tr:select'], 'a click selects and focuses')
      await ev(() => (window.log.length = 0))
      await page.click(p.x, p.y, { button: 'right' })
      await settle()
      const log = await ev(() => window.log)
      assert.ok(log.some((entry) => entry === 'contextmenu@7'), `the right click asks for a menu at the position: ${JSON.stringify(log)}`)
      await ev(() => (window.log.length = 0))
      await press('g', { ctrl: true })
      assert.ok((await ev(() => window.log)).includes('request:gotoLine'), 'Ctrl+G is a request to the host')
      await ev(() => (window.log.length = 0))
      await page.click(p.x, p.y, { ctrl: true })
      assert.ok((await ev(() => window.log)).includes('navigate@7'), 'Ctrl+click navigates')
      await ev(() => window.view.textarea.blur())
      assert.ok((await ev(() => window.log)).includes('blur'))
      assert.equal(await ev(() => window.view.root.classList.contains('enc-focused')), false)
    },
  },
  {
    name: 'dropping text inserts it where it lands',
    async run({ mount, ev, page, at, text, selection, assert }) {
      await mount({ text: 'alpha beta', path: 'a.txt' })
      const p = await at(1, 5)
      const dropped = await ev(
        (x, y) => {
          const data = new DataTransfer()
          data.setData('text/plain', ' dropped')
          const target = document.querySelector('.enc-scroller')
          const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y })
          target.dispatchEvent(over)
          const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y })
          target.dispatchEvent(drop)
          return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented }
        },
        p.x,
        p.y,
      )
      assert.deepEqual(dropped, { overPrevented: true, dropPrevented: true })
      assert.equal(await text(), 'alpha dropped beta')
      assert.deepEqual(await selection(), [[5, 13]])
    },
  },
]
