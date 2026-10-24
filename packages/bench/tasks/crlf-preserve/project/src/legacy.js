// Settings of the sync client as the Windows team keeps them; this file is edited on Windows and has CRLF line ends.
export const RETRY_LIMIT = 3
export const RETRY_DELAY_MS = 1000

export function nextDelay(attempt) {
  return RETRY_DELAY_MS * 2 ** attempt
}
