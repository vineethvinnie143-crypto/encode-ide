import { cx } from './cx'
import { shortcutKeys } from './shortcut'

/** A shortcut drawn as keys: <Kbd keys="Ctrl+Shift+P" />. */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cx('ui-kbd-group', className)} aria-label={shortcutKeys(keys).join(' ')}>
      {shortcutKeys(keys).map((key, index) => (
        <kbd key={`${key}-${index}`} className="ui-kbd" aria-hidden="true">
          {key}
        </kbd>
      ))}
    </span>
  )
}
