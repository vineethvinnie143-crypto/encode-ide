import { useEffect } from 'react'
import { useChat } from '../stores/chat'
import { useUi } from '../stores/ui'
import { commandRegistry } from './app'

/** A second Esc within this long stops the agent. */
const STOP_WINDOW_MS = 1500
let disarm: ReturnType<typeof setTimeout> | undefined

/** True while the user is typing in a field, where plain keys must stay typing. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || !element.tagName) return false
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable
}

/** True while a dialog, the quick opener or the palette is open: shortcuts leave the keyboard to it. */
export function modalOpen(): boolean {
  const ui = useUi.getState()
  return (
    ui.settingsOpen ||
    ui.pluginsOpen ||
    ui.automationOpen ||
    ui.shortcutsOpen ||
    ui.aboutOpen ||
    ui.statusOpen ||
    ui.quickOpenOpen ||
    ui.paletteOpen ||
    ui.confirm !== null ||
    ui.prompt !== null
  )
}

/**
 * Esc in the message box or on the thread while the agent works: the first press arms Stop (the message box says
 * so), a second within 1.5 s stops the agent. Keys a field or a card already used, and the terminal's and the
 * editor's Esc, are left alone, as is an approval or a question waiting for an answer, where Esc answers it.
 */
function stopOnDoubleEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.defaultPrevented) return false
  const chat = useChat.getState()
  if (!chat.running || chat.approvals.length > 0 || chat.ask || chat.plan) return false
  const target = event.target as HTMLElement | null
  const inComposer = Boolean(target?.classList?.contains('composer-input'))
  const onThread = !isTyping(target) && (target === document.body || Boolean(target?.closest?.('.app-main')))
  if (!inComposer && !onThread) return false
  const ui = useUi.getState()
  clearTimeout(disarm)
  if (ui.stopArmed) {
    ui.setStopArmed(false)
    void chat.stop()
  } else {
    ui.setStopArmed(true)
    disarm = setTimeout(() => useUi.getState().setStopArmed(false), STOP_WINDOW_MS)
  }
  return true
}

/** The one keyboard handler: every shortcut comes from the command registry. Also the mouse's Back and Forward buttons. */
export function useKeymap(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape' && useUi.getState().quickOpenOpen) {
        useUi.getState().setQuickOpenOpen(false)
        return
      }
      if (!modalOpen() && stopOnDoubleEscape(event)) {
        event.preventDefault()
        return
      }
      const command = commandRegistry.forEvent(event, isTyping(event.target), modalOpen())
      if (!command) return
      event.preventDefault()
      void command.run()
    }
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      commandRegistry.run(event.button === 3 ? 'session.back' : 'session.forward')
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])
}
