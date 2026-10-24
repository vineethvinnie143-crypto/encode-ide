/**
 * What eNCode's own page may ask the browser engine for. Pure, so the rule is tested without Electron.
 *
 * - `local-fonts`: the list of installed fonts, for Settings > Appearance.
 * - `clipboard-sanitized-write`: the Copy buttons, which put plain text on the clipboard. Reading the clipboard stays
 *   refused; the editor pastes from the paste event, which needs no permission.
 *
 * Nothing else, and nothing for another page or a frame inside one.
 */
const RENDERER_PERMISSIONS: ReadonlySet<string> = new Set(['local-fonts', 'clipboard-sanitized-write'])

export function rendererMayUse(permission: string, url: string | undefined, mainFrame: boolean | undefined, isRenderer: (url: string) => boolean): boolean {
  return RENDERER_PERMISSIONS.has(permission) && mainFrame === true && url !== undefined && isRenderer(url)
}
