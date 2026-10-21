import { useMemo } from 'react'
import { renderMarkdown } from '../../markdown'

/** Agent text as markdown. Links open outside the app; a code block's Copy button copies its code. */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="markdown"
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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
