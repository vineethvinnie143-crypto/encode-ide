/**
 * The eNCode mark, "Trace N": one line drawn between two nodes, from the
 * request to working code. build/icon.svg is the same drawing at 256 px;
 * build/make-icon.py renders the app icon from it.
 */
import { useId } from 'react'

/** Unique, url()-safe ids for the gradients of one rendered mark. */
function useMarkId(): string {
  return `enc-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

export function LogoMark({
  size = 22,
  variant = 'dark',
  className,
  title,
}: {
  size?: number
  /** dark: the app icon's graphite tile; light: a white tile for light surfaces. */
  variant?: 'dark' | 'light'
  className?: string
  /** Set when the mark stands alone and must be announced; otherwise it is decorative. */
  title?: string
}) {
  const id = useMarkId()
  const light = variant === 'light'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className ? `logo-mark ${className}` : 'logo-mark'}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d2330" />
          <stop offset="1" stopColor="#0b0c10" />
        </linearGradient>
        <linearGradient id={`${id}-line`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor={light ? '#3d6bea' : '#5b8cff'} />
          <stop offset="1" stopColor={light ? '#1fb8d6' : '#3fd6ee'} />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="58" fill={light ? '#ffffff' : `url(#${id}-tile)`} />
      <rect
        x="1.5"
        y="1.5"
        width="253"
        height="253"
        rx="56.5"
        fill="none"
        stroke={light ? '#0f172a' : '#ffffff'}
        strokeOpacity={light ? 0.1 : 0.14}
        strokeWidth="3"
      />
      <path
        d="M80 180V76L176 180V76"
        fill="none"
        stroke={`url(#${id}-line)`}
        strokeWidth="22"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="80" cy="180" r="17" fill={light ? '#3d6bea' : '#5b8cff'} />
      <circle cx="176" cy="76" r="17" fill={light ? '#1fb8d6' : '#3fd6ee'} />
    </svg>
  )
}

/** The one-colour glyph, without the tile, for small or monochrome places. */
export function LogoGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className ? `logo-glyph ${className}` : 'logo-glyph'}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M80 180V76L176 180V76"
        fill="none"
        stroke="currentColor"
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="80" cy="180" r="20" fill="currentColor" />
      <circle cx="176" cy="76" r="20" fill="currentColor" />
    </svg>
  )
}

/** "eNCode", with the N in the mark's gradient. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `wordmark ${className}` : 'wordmark'}>
      e<span className="wordmark-n">N</span>Code
    </span>
  )
}
