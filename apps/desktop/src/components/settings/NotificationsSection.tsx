import { useState } from 'react'
import type { NotifyWhen, Settings } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useSettings } from '../../stores/settings'
import { Button } from '../../ui/Button'
import { Bell } from '../../ui/icons'
import { Segmented } from '../../ui/Segmented'
import { Toggle } from '../../ui/Toggle'
import { SettingRow, SettingsGroup } from './Section'

const WHEN = [
  { value: 'never', label: 'Never' },
  { value: 'background', label: 'In the background' },
  { value: 'always', label: 'Always' },
] as const satisfies readonly { value: NotifyWhen; label: string }[]

/** Settings > Notifications: Windows notices when a request finishes or the agent needs you, and the taskbar button. */
export function NotificationsSection({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)

  const test = async () => {
    try {
      await api.app.testNotification()
      setTested({ ok: true, text: 'Sent. If nothing showed, Windows may have notifications for eNCode turned off: Settings > System > Notifications.' })
    } catch (error) {
      setTested({ ok: false, text: `Could not show a notice: ${errorText(error)}` })
    }
  }

  return (
    <>
      <SettingsGroup title="Notices" description="In the background means while another window is in front or eNCode is minimized.">
        <SettingRow id="notifications.done" label="When a request finishes" help="Says which session finished. A request you stop yourself has no notice, and a goal's rounds have one at the end.">
          <Segmented label="Notice when a request finishes" value={settings.notifyDone} options={WHEN} onChange={(notifyDone) => void save({ notifyDone })} />
        </SettingRow>
        <SettingRow id="notifications.needs" label="When the agent needs you" help="An approval, a question or a plan waiting for you. Clicking the notice opens that session.">
          <Segmented label="Notice when the agent needs you" value={settings.notifyNeeds} options={WHEN} onChange={(notifyNeeds) => void save({ notifyNeeds })} />
        </SettingRow>
        <SettingRow
          id="notifications.flash"
          htmlFor="flash-taskbar"
          label="Flash the taskbar button"
          help="While the agent waits for you and eNCode is in the background. It stops when you come back."
        >
          <Toggle id="flash-taskbar" checked={settings.flashTaskbar} onChange={(flashTaskbar) => void save({ flashTaskbar })} />
        </SettingRow>
        <SettingRow
          id="notifications.test"
          label="Show a test notice"
          help="Notices never include what the agent wrote or an error's text, since Windows keeps them after eNCode closes."
          below={
            tested && (
              <div className={tested.ok ? 'ok-text' : 'error-text'} role="status">
                {tested.text}
              </div>
            )
          }
        >
          <Button icon={<Bell size={14} />} onClick={() => void test()}>
            Test
          </Button>
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
