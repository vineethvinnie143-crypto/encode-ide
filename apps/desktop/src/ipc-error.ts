/** What a failed call to the main process says, without Electron's "Error invoking remote method" wrapper. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
