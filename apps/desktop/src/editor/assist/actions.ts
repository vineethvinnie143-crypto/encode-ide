import type { EditorAction } from '@shared/types'

/** The menu's sections, in this order; an action of no kind the editor knows goes under More. */
const SECTIONS = [
  { kind: 'quickfix', label: 'Quick fixes' },
  { kind: 'refactor', label: 'Refactor' },
  { kind: 'source', label: 'Source' },
] as const

const isOfKind = (action: EditorAction, kind: string): boolean => action.kind === kind || Boolean(action.kind?.startsWith(`${kind}.`))

/** The actions in the menu's sections, the server's preferred ones first in each, otherwise in the server's order. */
export function actionSections(actions: readonly EditorAction[]): { label: string; actions: EditorAction[] }[] {
  const sections: { label: string; actions: EditorAction[] }[] = SECTIONS.map(({ kind, label }) => ({ label, actions: actions.filter((action) => isOfKind(action, kind)) }))
  sections.push({ label: 'More', actions: actions.filter((action) => !SECTIONS.some(({ kind }) => isOfKind(action, kind))) })
  for (const section of sections) section.actions.sort((a, b) => Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)))
  return sections.filter((section) => section.actions.length)
}
