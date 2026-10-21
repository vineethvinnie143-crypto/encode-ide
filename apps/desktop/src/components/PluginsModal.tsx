import { useEffect, useState } from 'react'
import { FolderOpen, Plus, Puzzle, Sparkles, X } from '../ui/icons'
import type { SkillInfo } from '@shared/types'
import { api } from '../api'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'

export default function PluginsModal() {
  const setPluginsOpen = useUi((state) => state.setPluginsOpen)
  const openSettings = useUi((state) => state.openSettings)
  const notify = useUi((state) => state.notify)
  const askText = useUi((state) => state.askText)
  const settings = useSettings((state) => state.settings)
  const [skills, setSkills] = useState<SkillInfo[]>([])

  const refresh = async () => {
    try {
      setSkills(await api.skills.list())
    } catch {
      setSkills([])
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const createSkill = async () => {
    const name = await askText('New skill', 'skill-name')
    if (!name) return
    try {
      await api.skills.create(name)
      await refresh()
      notify('success', `Created skill ${name}`)
    } catch (error) {
      notify('error', (error as Error).message)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => setPluginsOpen(false)}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div className="settings-title">
            <Puzzle size={14} /> Plugins
          </div>
          <div className="settings-tabs">
            <button className="is-on">Providers &amp; skills</button>
          </div>
          <button className="icon-btn" onClick={() => setPluginsOpen(false)} title="Close">
            <X size={16} />
          </button>
        </header>

        <div className="settings-body">
          <div className="settings-agent">
            <div className="section-title">Model providers</div>
            {(settings?.profiles ?? []).map((profile) => (
              <div className="plugin-row" key={profile.id}>
                <Sparkles size={13} />
                <span className="plugin-name">{profile.name}</span>
                <span className="plugin-meta">{profile.kind === 'demo' ? 'offline demo' : profile.model || 'no model'}</span>
                {profile.id === settings?.activeProfileId && <span className="plugin-badge">active</span>}
              </div>
            ))}
            <button
              className="btn ghost sm"
              onClick={() => {
                setPluginsOpen(false)
                openSettings('models')
              }}
            >
              Manage providers…
            </button>

            <div className="section-title">Skills</div>
            <div className="info-note">
              Skills are markdown playbooks the agent can load with the <code>skill</code> tool. User skills live in the
              app data folder; workspace skills live in <code>.eNCode/skills</code>.
            </div>
            {skills.map((skill) => (
              <div className="plugin-row" key={`${skill.source}-${skill.name}`}>
                <span className="plugin-name">{skill.name}</span>
                <span className="plugin-meta">{skill.description}</span>
                <span className="plugin-badge">{skill.source}</span>
              </div>
            ))}
            {!skills.length && <div className="rail-empty">No skills yet.</div>}
            <div className="form-actions">
              <button className="btn ghost sm" onClick={() => void createSkill()}>
                <Plus size={12} /> New skill
              </button>
              <button className="btn ghost sm" onClick={() => void api.skills.openFolder()}>
                <FolderOpen size={12} /> Open skills folder
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
