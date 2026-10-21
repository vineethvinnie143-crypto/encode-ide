import { useEffect } from 'react'
import { useUi } from '../stores/ui'
import { commandRegistry } from './app'

/** True while the user is typing in a field, where plain keys must stay typing. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || !element.tagName) return false
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable
}

/** True while a dialog or the quick opener is open: shortcuts leave the keyboard to it. */
export function modalOpen(): boolean {
  const ui = useUi.getState()
  return ui.settingsOpen || ui.pluginsOpen || ui.automationOpen || ui.shortcutsOpen || ui.aboutOpen || ui.quickOpenOpen || ui.confirm !== null || ui.prompt !== null
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
