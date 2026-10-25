import type { FollowUp, SendKey, Settings } from '@shared/types'
import { api } from '../../api'
import { commandRegistry } from '../../commands/app'
import { errorText } from '../../ipc-error'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { FolderOpen } from '../../ui/icons'
import { Segmented } from '../../ui/Segmented'
import { Toggle } from '../../ui/Toggle'
import { sendKeys } from '../Chat/send-key'
import { SettingRow, SettingsGroup } from './Section'
import { UpdatesGroup } from './UpdatesGroup'

const SEND_KEYS = [
  { value: 'enter', label: 'Enter' },
  { value: 'ctrl-enter', label: 'Ctrl+Enter' },
] as const satisfies readonly { value: SendKey; label: string }[]

const FOLLOW_UPS = [
  { value: 'queue', label: 'Queue' },
  { value: 'steer', label: 'Steer' },
] as const satisfies readonly { value: FollowUp; label: string }[]

/** Settings > General: how messages are sent, sleep while the agent works, the folder chats work in, and updates. */
export function GeneralSection({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  const keys = sendKeys(settings.sendKey)
  const newChat = commandRegistry.shortcut('file.newChat')
  const chosenFolder = settings.chatsFolder !== settings.chatsFolderDefault

  const chooseFolder = async () => {
    try {
      const saved = await api.settings.chooseChatsFolder()
      if (saved) useSettings.setState({ settings: saved })
    } catch (error) {
      useUi.getState().notify('error', `Could not use that folder: ${errorText(error)}`)
    }
  }
  const resetFolder = async () => {
    try {
      useSettings.setState({ settings: await api.settings.resetChatsFolder() })
    } catch (error) {
      useUi.getState().notify('error', `Could not change the folder: ${errorText(error)}`)
    }
  }

  return (
    <>
      <SettingsGroup title="Messages">
        <SettingRow
          id="general.send"
          label="Send messages with"
          help={settings.sendKey === 'enter' ? 'Shift+Enter starts a new line.' : 'Enter starts a new line, as in an editor, and Ctrl+Enter sends.'}
        >
          <Segmented label="Send messages with" value={settings.sendKey} options={SEND_KEYS} onChange={(sendKey) => void save({ sendKey })} />
        </SettingRow>
        <SettingRow
          id="general.followUp"
          label="While the agent works"
          help={`Queue holds a message until the agent is done, then sends it. Steer hands it to the agent now: it reads it after the step it is on and carries on with it in mind. ${keys.other} does the other one.`}
        >
          <Segmented label={`What ${keys.send} does while the agent works`} value={settings.followUp} options={FOLLOW_UPS} onChange={(followUp) => void save({ followUp })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Power">
        <SettingRow
          id="general.keepAwake"
          htmlFor="keep-awake"
          label="Keep the computer awake while the agent works"
          help="Windows does not go to sleep while an agent thinks or runs a command. The screen can still turn off, and the computer can sleep while the agent waits for you."
        >
          <Toggle id="keep-awake" checked={settings.keepAwake} onChange={(keepAwake) => void save({ keepAwake })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Chats">
        <SettingRow
          id="general.chats"
          label="Folder for chats"
          help={
            <>
              A chat is a session that belongs to no project (File &gt; New chat{newChat ? `, ${newChat}` : ''}). It works in this folder, so the files it makes are
              kept here. Chats you already have stay where they are.
            </>
          }
          below={
            <div className="settings-path">
              <FolderOpen size={14} aria-hidden="true" />
              <code title={settings.chatsFolder}>{settings.chatsFolder}</code>
            </div>
          }
        >
          <div className="settings-actions">
            {chosenFolder && (
              <Button variant="ghost" onClick={() => void resetFolder()}>
                Use the default
              </Button>
            )}
            <Button onClick={() => void chooseFolder()}>Change…</Button>
          </div>
        </SettingRow>
      </SettingsGroup>

      <UpdatesGroup settings={settings} />
    </>
  )
}
