import { useState } from 'react'
import { copyText } from '../copy'
import { Check, ChevronDown, Copy } from './icons'
import { Collapse } from './Collapse'
import { cx } from './cx'

/**
 * The longer account behind a problem or a notice: a toggle, and under it the text in the code font with a copy
 * button. It lays out as two items, so the toggle can sit in a row of buttons and the text take the full width below.
 */
export function Details({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <>
      <button type="button" className="problem-details-toggle" aria-expanded={open} data-find-skip onClick={() => setOpen((value) => !value)}>
        Details
        <ChevronDown size={12} className={cx('problem-chevron', open && 'is-open')} />
      </button>
      <div className="problem-details" data-find-skip>
        <Collapse open={open}>
          <div className="problem-details-body">
            <pre>{text}</pre>
            <button
              type="button"
              className="problem-copy"
              aria-label={copied ? 'Copied' : 'Copy the details'}
              title={copied ? 'Copied' : 'Copy'}
              onClick={() => {
                void copyText(text).then((done) => {
                  if (!done) return
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        </Collapse>
      </div>
    </>
  )
}
