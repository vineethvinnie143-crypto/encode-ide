import { EFFORT_INFO, EFFORTS, modelMode } from '@shared/models'
import type { ReasoningEffort } from '@shared/types'
import { commandRegistry } from '../../commands/app'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { ChevronDown, Gauge } from '../../ui/icons'
import { Menu, type MenuEntry } from '../../ui/Menu'
import { Pill } from '../../ui/Pill'

/**
 * The effort chip under the message box: how hard the main model thinks, and the list to change it. Shown while a real
 * model answers; a model without a dial ignores the choice, which the list says.
 */
export default function EffortButton() {
  const settings = useSettings((state) => state.settings)
  const request = useUi((state) => (state.menuRequest?.menu === 'effort' ? state.menuRequest.id : undefined))
  if (!settings || modelMode(settings) !== 'router') return null
  const effort = settings.efforts.main
  const choose = (next: ReasoningEffort | null) => void useSettings.getState().setEffort('main', next)
  const shortcut = commandRegistry.shortcut('agent.effort')

  const entries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-effort', label: 'How hard the model thinks' },
    { id: 'default', label: 'Model default', description: 'The model decides. Models without a thinking dial always do.', checked: !effort, onSelect: () => choose(null) },
    ...EFFORTS.map((level) => ({ id: level, label: EFFORT_INFO[level].label, description: EFFORT_INFO[level].hint, checked: effort === level, onSelect: () => choose(level) })),
    { kind: 'separator', id: 'sep-effort' },
    { id: 'roles', label: 'Effort for each role…', description: 'Explore, Plan, Review, Compaction and Small tasks', onSelect: () => useUi.getState().openSettings('roles') },
  ]

  return (
    <Menu
      label="Effort"
      side="top"
      width={330}
      entries={entries}
      openRequest={request}
      trigger={(props) => (
        <Pill className="effort-chip" icon={<Gauge size={13} />} caret={<ChevronDown size={12} />} title={`How hard the model thinks${shortcut ? ` (${shortcut})` : ''}`} {...props}>
          {effort ? EFFORT_INFO[effort].label : 'Effort'}
        </Pill>
      )}
    />
  )
}
