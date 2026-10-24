/**
 * The eNCode mark: a chrome dice with </> on its top face. build/logo-source.png is the logo as drawn;
 * build/make-icon.py renders the app icon and public/brand/mark-*.png from it. The mark is a picture of
 * chrome and black, so it reads on the dark and the light theme alike.
 */

/** The renders in public/brand, by width; the page picks the one that fits the size and the screen's scale. */
const MARK_WIDTHS = [64, 128, 256] as const
const MARK_SET = MARK_WIDTHS.map((width) => `brand/mark-${width}.png ${width}w`).join(', ')

export function LogoMark({
  size = 22,
  className,
  title,
}: {
  size?: number
  className?: string
  /** Set when the mark stands alone and must be announced; otherwise it is decorative. */
  title?: string
}) {
  return (
    <img
      src={`brand/mark-${MARK_WIDTHS[0]}.png`}
      srcSet={MARK_SET}
      sizes={`${size}px`}
      width={size}
      height={size}
      className={className ? `logo-mark ${className}` : 'logo-mark'}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      draggable={false}
      decoding="async"
    />
  )
}

/** "eNCode", with the N in the mark's chrome. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `wordmark ${className}` : 'wordmark'}>
      e<span className="wordmark-n">N</span>Code
    </span>
  )
}
