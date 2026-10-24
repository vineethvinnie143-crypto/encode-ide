import { useEffect, useState } from 'react'
import { ROLE_INFO } from '@shared/models'
import type { AgentCreateInput, AgentDefinitionInfo, ModelRole, SkillInfo } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { Button, IconButton } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Eye, FolderOpen, Plus, Puzzle, Trash2 } from '../../ui/icons'
import { Chip } from '../../ui/Pill'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { SkeletonRows } from '../../ui/Skeleton'
import { SettingsGroup } from './Section'

/** The tools a built-in agent that only reads gets; an agent with no tool outside them changes nothing. */
const READ_ONLY = new Set(['Bash', 'BashOutput', 'Glob', 'Grep', 'CodeMap', 'Read', 'LSP', 'WebFetch', 'WebSearch', 'ToolSearch'])
const SOURCE: Record<AgentDefinitionInfo['source'], string> = { builtin: 'Built in', user: 'Yours', workspace: 'This project' }

type Viewing = { kind: 'skill' | 'agent'; name: string; text: string | null; reveal: boolean }

const notify = (kind: 'success' | 'error', text: string, action?: { label: string; run: () => void }) => useUi.getState().notify(kind, text, action)

/** Settings > Skills and agents: the playbooks the agent can load and the agents it can hand work to, to add, read and remove. */
export function SkillsSection() {
  const root = useWorkspace((state) => state.workspace?.root ?? null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [agents, setAgents] = useState<AgentDefinitionInfo[] | null>(null)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [creating, setCreating] = useState<'skill' | 'agent' | null>(null)

  const refresh = async () => {
    const [nextSkills, nextAgents] = await Promise.all([api.skills.list().catch(() => []), api.agents.list().catch(() => [])])
    setSkills(nextSkills)
    setAgents(nextAgents)
  }

  useEffect(() => {
    void refresh()
  }, [root])

  const view = async (kind: 'skill' | 'agent', name: string, reveal: boolean) => {
    setViewing({ kind, name, text: null, reveal })
    try {
      const text = kind === 'skill' ? await api.skills.read(name) : await api.agents.read(name)
      setViewing((current) => (current?.name === name && current.kind === kind ? { ...current, text } : current))
    } catch (error) {
      setViewing(null)
      notify('error', errorText(error))
    }
  }

  const reveal = (kind: 'skill' | 'agent', name: string) => void (kind === 'skill' ? api.skills.reveal(name) : api.agents.reveal(name)).catch((error) => notify('error', errorText(error)))

  const remove = async (kind: 'skill' | 'agent', name: string) => {
    const confirmed = await useUi.getState().askConfirm({
      title: `Remove ${name}?`,
      body: `The ${kind === 'skill' ? 'skill' : 'agent'} goes to the Recycle Bin, where you can get it back. The agent stops seeing it from its next request.`,
      confirmLabel: 'Move to the Recycle Bin',
      danger: true,
    })
    if (!confirmed) return
    try {
      await (kind === 'skill' ? api.skills.remove(name) : api.agents.remove(name))
      notify('success', `Moved ${name} to the Recycle Bin.`)
    } catch (error) {
      notify('error', errorText(error))
    }
    await refresh()
  }

  return (
    <>
      <SettingsGroup
        title="Skills"
        description="Playbooks in Markdown. The agent sees each skill’s name and when to use it, and reads the whole skill when a request fits. Type / and its name to use one yourself. Yours are in .encode/skills in your home folder; a project’s in its own .encode/skills."
      >
        <div className="settings-card-list" data-setting="skills.skills">
          {skills === null ? (
            <SkeletonRows rows={2} label="Loading skills" className="settings-list-loading" />
          ) : skills.length ? (
            skills.map((skill) => (
              <div key={`${skill.source}:${skill.name}`} className="item-row" data-skill={skill.name}>
                <span className="item-text">
                  <span className="item-title">
                    <code>{skill.name}</code>
                    <Chip tone={skill.source === 'user' ? 'accent' : 'neutral'}>{skill.source === 'user' ? 'Yours' : 'This project'}</Chip>
                  </span>
                  <span className="item-meta">{skill.description}</span>
                </span>
                <IconButton label="Read it" size="sm" onClick={() => void view('skill', skill.name, true)}>
                  <Eye size={14} />
                </IconButton>
                <IconButton label="Show in folder" size="sm" onClick={() => reveal('skill', skill.name)}>
                  <FolderOpen size={14} />
                </IconButton>
                {skill.source === 'user' && (
                  <IconButton label="Remove…" size="sm" onClick={() => void remove('skill', skill.name)}>
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </div>
            ))
          ) : (
            <div className="settings-empty">
              <Puzzle size={18} aria-hidden="true" />
              <span>No skills yet. A skill is a few steps the agent follows the same way each time: how to release, how this team writes tests.</span>
            </div>
          )}
          <div className="item-actions">
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setCreating('skill')}>
              New skill
            </Button>
            <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void api.skills.openFolder()}>
              Open your skills folder
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Agents"
        description="The main agent can hand a self-contained piece of work to one of these, which works on its own and reports back. The built-in ones are always there; yours are in .encode/agents in your home folder, a project’s in its own .encode/agents."
      >
        <div className="settings-card-list" data-setting="skills.agents">
          {agents === null ? (
            <SkeletonRows rows={3} label="Loading agents" className="settings-list-loading" />
          ) : (
            agents.map((agent) => (
              <div key={`${agent.source}:${agent.name}`} className="item-row" data-agent={agent.name}>
                <span className="item-text">
                  <span className="item-title">
                    <code>{agent.name}</code>
                    <Chip tone={agent.source === 'user' ? 'accent' : 'neutral'}>{SOURCE[agent.source]}</Chip>
                    {agent.role && agent.role in ROLE_INFO && <Chip>{ROLE_INFO[agent.role as ModelRole].label} model</Chip>}
                    {agent.tools && agent.tools.every((tool) => READ_ONLY.has(tool)) && <Chip>Reads only</Chip>}
                  </span>
                  <span className="item-meta">{agent.description}</span>
                </span>
                {agent.path && (
                  <>
                    <IconButton label="Read it" size="sm" onClick={() => void view('agent', agent.name, true)}>
                      <Eye size={14} />
                    </IconButton>
                    <IconButton label="Show in folder" size="sm" onClick={() => reveal('agent', agent.name)}>
                      <FolderOpen size={14} />
                    </IconButton>
                  </>
                )}
                {agent.source === 'user' && (
                  <IconButton label="Remove…" size="sm" onClick={() => void remove('agent', agent.name)}>
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </div>
            ))
          )}
          <div className="item-actions">
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setCreating('agent')}>
              New agent
            </Button>
            <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void api.agents.openFolder()}>
              Open your agents folder
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing?.name ?? ''}
        description={viewing?.kind === 'agent' ? 'Agent' : 'Skill'}
        width={680}
        footer={
          viewing && (
            <>
              {viewing.reveal && (
                <Button variant="ghost" icon={<FolderOpen size={14} />} onClick={() => reveal(viewing.kind, viewing.name)}>
                  Show in folder
                </Button>
              )}
              <Button variant="primary" onClick={() => setViewing(null)}>
                Done
              </Button>
            </>
          )
        }
      >
        {viewing?.text === null ? <SkeletonRows rows={6} label="Reading it" /> : <pre className="item-source">{viewing?.text}</pre>}
      </Dialog>

      {creating === 'skill' && <NewSkill onClose={() => setCreating(null)} onCreated={() => void refresh()} />}
      {creating === 'agent' && <NewAgent onClose={() => setCreating(null)} onCreated={() => void refresh()} />}
    </>
  )
}

function NewSkill({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const skill = await api.skills.create(name.trim(), description.trim() || undefined)
      onCreated()
      onClose()
      notify('success', `Made the skill ${skill.name}. Write its steps in any text editor.`, { label: 'Show in folder', run: () => void api.skills.reveal(skill.name) })
    } catch (error) {
      notify('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="New skill"
      description="A Markdown file in your skills folder, which every project sees."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void create()}>
            Make the skill
          </Button>
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label className="form-field">
          <span className="form-label">Name</span>
          <input className="text-input" data-autofocus value={name} placeholder="release-notes" spellCheck={false} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="form-field">
          <span className="form-label">When to use it</span>
          <input className="text-input" value={description} placeholder="Use when writing the notes for a release." maxLength={300} onChange={(event) => setDescription(event.target.value)} />
          <span className="form-help">The agent decides from this line whether a request needs the skill.</span>
        </label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

const ROLE_CHOICES: { value: '' | NonNullable<AgentCreateInput['role']>; label: string }[] = [
  { value: '', label: 'The main agent’s model' },
  { value: 'explore', label: `${ROLE_INFO.explore.label} role’s model` },
  { value: 'planner', label: `${ROLE_INFO.planner.label} role’s model` },
  { value: 'reviewer', label: `${ROLE_INFO.reviewer.label} role’s model` },
  { value: 'utility', label: `${ROLE_INFO.utility.label} role’s model` },
]

function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [access, setAccess] = useState<'read' | 'write'>('read')
  const [role, setRole] = useState<'' | NonNullable<AgentCreateInput['role']>>('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const create = async () => {
    if (!name.trim() || !description.trim()) return
    setBusy(true)
    setProblem(null)
    try {
      const agent = await api.agents.create({ name: name.trim(), description: description.trim(), readOnly: access === 'read', ...(role ? { role } : {}) })
      onCreated()
      onClose()
      notify('success', `Made the agent ${agent.name}. Write what it does in its file.`, { label: 'Show in folder', run: () => void api.agents.reveal(agent.name) })
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="New agent"
      description="A Markdown file in your agents folder, which every project sees. Its text is the agent’s instructions."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim() || !description.trim()} onClick={() => void create()}>
            Make the agent
          </Button>
        </>
      }
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label className="form-field">
          <span className="form-label">Name</span>
          <input className="text-input" data-autofocus value={name} placeholder="security-reviewer" spellCheck={false} maxLength={41} onChange={(event) => setName(event.target.value)} aria-invalid={problem !== null} />
          <span className="form-help">Letters, digits, - and _, starting with a letter.</span>
        </label>
        <label className="form-field">
          <span className="form-label">When to use it</span>
          <input className="text-input" value={description} placeholder="Reviews a change for injection, secrets and unsafe net events." maxLength={300} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="form-field">
          <span className="form-label">What it may do</span>
          <Segmented
            label="What it may do"
            value={access}
            options={[
              { value: 'read', label: 'Read and search' },
              { value: 'write', label: 'Change files too' },
            ]}
            onChange={setAccess}
          />
          <span className="form-help">{access === 'read' ? 'Like Explore: it reads, searches and runs commands that change nothing.' : 'Every tool the main agent has, except starting agents of its own. What needs your approval still asks.'}</span>
        </div>
        <label className="form-field">
          <span className="form-label">Model</span>
          <Select label="Model" value={role} options={ROLE_CHOICES} onChange={setRole} />
        </label>
        {problem && (
          <p className="form-problem" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

