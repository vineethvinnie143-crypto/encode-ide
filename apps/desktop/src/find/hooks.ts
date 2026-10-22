/**
 * How a folded part of the thread (a work log, a group of steps, a step's output, a change card's files) takes part
 * in find: it opens while find looks for words it holds, so every match is on the page to count and mark, and it
 * stays open when the bar closes on a match inside it, so the match the person was reading stays in view.
 */
import { useCallback, useMemo, useState, type RefObject } from 'react'
import { useFind } from '../stores/find'

/** Sent from the match the find bar closes on, up through the folds around it. */
export const REVEAL_EVENT = 'enc-find-reveal'

/**
 * Whether find holds the fold open: while it looks for words that `holds` finds in the fold, unless the person closed
 * the fold by hand during this search (`dismiss`). `holds` should keep its identity while the fold's content does.
 */
export function useFoldFind(holds: (needle: string) => boolean): { found: boolean; dismiss: () => void } {
  const needle = useFind((state) => state.needle)
  const openId = useFind((state) => state.openId)
  const [dismissed, setDismissed] = useState('')
  const found = useMemo(() => needle !== '' && dismissed !== `${openId}\u0000${needle}` && holds(needle), [needle, openId, dismissed, holds])
  const dismiss = useCallback(() => {
    const { openId: id, needle: words } = useFind.getState()
    setDismissed(`${id}\u0000${words}`)
  }, [])
  return { found, dismiss }
}

/**
 * A ref for the fold's outer element: when the find bar closes on a match inside the fold's body (not on the row
 * that opens it), `reveal` opens the fold for good. `reveal` should keep its identity (a state setter in useCallback).
 */
export function useRevealRef(head: RefObject<HTMLElement | null>, reveal: () => void): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return undefined
      const onReveal = (event: Event) => {
        if (!head.current?.contains(event.target as Node)) reveal()
      }
      element.addEventListener(REVEAL_EVENT, onReveal)
      return () => element.removeEventListener(REVEAL_EVENT, onReveal)
    },
    [head, reveal],
  )
}
