import type { ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { POLICY_LABELS } from '../../policies'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { Eye, EyeOff, Lock, MousePointer, ShieldCheck, Square } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import { Toggle } from '../../ui/Toggle'
import { SettingRow, SettingsGroup } from './Section'

/** Settings > Computer use: whether the agent may see and use other applications, what it is never shown, and how to stop it. */
export function ComputerSection({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  if (!settings.computerSupported) {
    return (
      <div className="settings-empty">
        <MousePointer size={18} aria-hidden="true" />
        <span>Computer use works on Windows for now. On this system the agent works in files and the terminal only.</span>
      </div>
    )
  }
  const fullAccess = settings.policy === 'full-access'
  return (
    <>
      <SettingsGroup>
        <SettingRow
          id="computer.enabled"
          htmlFor="computer-use"
          label="Let the agent use this computer"
          help="It can look at another application and use the mouse and keyboard in it, one application at a time. Each request asks before it uses an application for the first time in a session. Applies from the agent’s next request."
        >
          <Toggle id="computer-use" checked={settings.computer} onChange={(computer) => void save({ computer })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="While it works">
        <div className="computer-facts">
          <Fact icon={<Eye size={16} />} title="You see when it does">
            A banner at the top of the screen says which application it is using and what it is doing.
          </Fact>
          <Fact icon={<ShieldCheck size={16} />} title={fullAccess ? `${POLICY_LABELS['full-access']} lets it go without asking` : 'It asks for each application'}>
            {fullAccess ? (
              <>
                Under {POLICY_LABELS['full-access']} it uses an application without asking first.{' '}
                <Button size="sm" variant="ghost" className="inline-link" onClick={() => useUi.getState().openSettings('agent', 'agent.policy')}>
                  Change the approvals
                </Button>
              </>
            ) : (
              'You allow an application once for the session. A new session asks again.'
            )}
          </Fact>
          <Fact icon={<EyeOff size={16} />} title="What it never sees or uses">
            eNCode’s own windows and programs running as administrator. Other applications’ windows and password fields are painted over in what it is shown, and it will not type into a password field. Terminals, password managers and system tools are refused.
          </Fact>
          <Fact icon={<Lock size={16} />} title="One session at a time">
            Only one session uses the computer at once, and the agents it starts never do.
          </Fact>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Stopping it">
        <SettingRow id="computer.stop" label="Stop at once" help="The banner’s Stop and the shortcut end the request; what it did so far stays. If you move the mouse or type while it works, it stops and waits for you to say go on.">
          <span className="computer-stops">
            <span className="computer-stop">
              <Square size={12} aria-hidden="true" /> Stop on the banner
            </span>
            <span className="computer-stop">
              <Kbd keys="Ctrl+Alt+Esc" /> from any window
            </span>
          </span>
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

function Fact({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="computer-fact">
      <span className="computer-fact-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="computer-fact-text">
        <span className="computer-fact-title">{title}</span>
        <span className="computer-fact-body">{children}</span>
      </span>
    </div>
  )
}
