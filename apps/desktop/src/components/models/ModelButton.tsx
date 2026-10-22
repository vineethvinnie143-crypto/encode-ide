import { useRef, useState } from 'react'
import { FREE_REF, mainLabel, mainRefs, modelMode } from '@shared/models'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { ChevronDown, Sparkles } from '../../ui/icons'
import type { Rect } from '../../ui/place'
import { Pill } from '../../ui/Pill'
import type { PickerItem } from './model-list'
import { ModelPicker } from './ModelPicker'

/** The model chip under the message box: what answers now, and the list to change it. */
export default function ModelButton() {
  const settings = useSettings((state) => state.settings)
  const [anchor, setAnchor] = useState<Rect | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)

  const mode = settings ? modelMode(settings) : 'none'
  const label = settings ? mainLabel(settings) : 'No model'
  const selected = settings ? (mode === 'demo' ? ['demo'] : mainRefs(settings)) : []
  const extra = settings ? mainRefs(settings).length - 1 : 0

  const toggle = () => {
    if (anchor) return setAnchor(null)
    const box = trigger.current?.getBoundingClientRect()
    if (box) setAnchor({ left: box.left, top: box.top, width: box.width, height: box.height })
  }

  const pick = (item: PickerItem) => {
    const store = useSettings.getState()
    if (item.kind === 'demo') void store.chooseDemo()
    else void store.chooseMain(item.kind === 'free' ? FREE_REF : item.ref, item.free)
  }

  return (
    <>
      <Pill
        ref={trigger}
        className="model-chip"
        tone={mode === 'none' ? 'warning' : 'neutral'}
        icon={<Sparkles size={13} />}
        caret={<ChevronDown size={12} />}
        title={mode === 'none' ? 'Choose a model' : extra > 0 ? `Model (${extra} more stand by if it fails)` : 'Model'}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={toggle}
      >
        {label}
      </Pill>
      {anchor && (
        <ModelPicker
          anchor={anchor}
          selected={selected}
          demo
          ignore={trigger}
          footer={{
            onConnect: () => useUi.getState().setConnectOpen(true),
            onRoles: () => useUi.getState().openSettings('roles'),
          }}
          onClose={(refocus) => {
            setAnchor(null)
            if (refocus) trigger.current?.focus()
          }}
          onPick={pick}
        />
      )}
    </>
  )
}
