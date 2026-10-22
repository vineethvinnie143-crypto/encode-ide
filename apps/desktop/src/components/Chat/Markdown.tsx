import { useLayoutEffect, useMemo, useRef } from 'react'
import { patchBlocks } from '../../dom-blocks'
import { renderMarkdownBlocks } from '../../markdown'

/**
 * Agent text as markdown. Links open outside the app; a code block's Copy button copies its code.
 * The page owns the blocks, not React: a streamed answer changes at its end, so only the blocks that
 * changed are redrawn and the rest keep their selection, scroll and hover.
 */
export default function Markdown({ text }: { text: string }) {
  const container = useRef<HTMLDivElement>(null)
  const shown = useRef<string[]>([])
  const blocks = useMemo(() => renderMarkdownBlocks(text), [text])

  useLayoutEffect(() => {
    if (!container.current) return
    patchBlocks(container.current, shown.current, blocks)
    shown.current = blocks
  }, [blocks])

  return (
    <div
      className="markdown"
      ref={container}
      onClick={(event) => {
        const target = event.target as HTMLElement
        const copy = target.closest<HTMLButtonElement>('.code-copy')
        if (copy) {
          const code = copy.closest('.code-block')?.querySelector('code')?.textContent ?? ''
          void navigator.clipboard.writeText(code).then(() => {
            copy.textContent = 'Copied'
            window.setTimeout(() => {
              copy.textContent = 'Copy'
            }, 1500)
          })
          return
        }
        const anchor = target.closest<HTMLAnchorElement>('a[href]')
        if (!anchor?.href) return
        event.preventDefault()
        window.open(anchor.href, '_blank')
      }}
    />
  )
}
