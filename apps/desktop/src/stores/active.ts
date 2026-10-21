/**
 * Tiny module holding the active session id so the chat and sessions stores can
 * share it without importing each other.
 */
let activeId = ''

export function getActiveSessionId(): string {
  return activeId
}

export function setActiveSessionId(id: string): void {
  activeId = id
}
