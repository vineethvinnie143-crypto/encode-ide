import type { CSSProperties } from 'react'
import { cx } from './cx'

/** A placeholder bar with a 1.6 s shimmer, for content that is still loading. */
export function Skeleton({
  width = '100%',
  height = 12,
  radius,
  className,
}: {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  radius?: CSSProperties['borderRadius']
  className?: string
}) {
  return <span className={cx('ui-skeleton', className)} style={{ width, height, borderRadius: radius }} aria-hidden="true" />
}

const WIDTHS = ['92%', '76%', '84%', '64%', '88%', '70%']

/** Several skeleton rows, announced once as loading. */
export function SkeletonRows({ rows = 3, label = 'Loading', className }: { rows?: number; label?: string; className?: string }) {
  return (
    <div className={cx('ui-skeleton-rows', className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={WIDTHS[index % WIDTHS.length]} />
      ))}
    </div>
  )
}
