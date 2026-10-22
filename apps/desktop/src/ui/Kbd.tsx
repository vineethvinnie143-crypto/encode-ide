import { cx } from './cx'
import { shortcutKeys } from './shortcut'

/** A shortcut drawn as keys: <Kbd keys="Ctrl+Shift+P" />. `plain` writes it as quiet text, Ctrl+Shift+P, for lists and menus. */
export function Kbd({ keys, className, plain }: { keys: string; className?: string; plain?: boolean }) {
  return (
    <span className={cx('ui-kbd-group', plain && 'is-plain', className)} aria-label={shortcutKeys(keys).join(' ')}>
      {shortcutKeys(keys).map((key, index) => (
        <kbd key={`${key}-${index}`} className="ui-kbd" aria-hidden="true">
          {key}
        </kbd>
      ))}
    </span>
  )
}
