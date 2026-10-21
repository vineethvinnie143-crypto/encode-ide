import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMode, ApprovalPolicy, ModelProfile, ProfileKind, Settings } from '../../shared/types'

interface StoredProfile extends Omit<ModelProfile, 'hasApiKey'> {
  apiKeyEnc?: string
}

interface StoredSettings extends Omit<Settings, 'profiles'> {
  profiles: StoredProfile[]
}

const DEMO_PROFILE: StoredProfile = {
  id: 'demo',
  name: 'Demo (offline)',
  kind: 'demo',
  baseUrl: '',
  model: 'eNCode-demo',
  models: ['eNCode-demo'],
}

function defaults(): StoredSettings {
  return {
    profiles: [{ ...DEMO_PROFILE }],
    activeProfileId: DEMO_PROFILE.id,
    policy: 'workspace-write',
    autoApprove: true,
    autoApproveCommands: false,
    maxSteps: 30,
    maxGoalRounds: 8,
    recentWorkspaces: [],
    lastWorkspace: null,
    agentMode: 'code',
  }
}

function encrypt(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    /* fall through to plain encoding */
  }
  return 'plain:' + Buffer.from(value, 'utf8').toString('base64')
}

function decrypt(stored?: string): string {
  if (!stored) return ''
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  } catch {
    /* ignore corrupted secrets */
  }
  return ''
}

const POLICIES: ApprovalPolicy[] = ['read-only', 'workspace-write', 'full-access', 'auto-review']

function normalizePolicy(value: unknown, fallback: ApprovalPolicy): ApprovalPolicy {
  return POLICIES.includes(value as ApprovalPolicy) ? (value as ApprovalPolicy) : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export class SettingsService {
  private readonly file: string
  private data: StoredSettings

  constructor() {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'eNCode-settings.json')
    this.data = this.load()
  }

  private load(): StoredSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredSettings>
      return this.normalize(parsed)
    } catch {
      return defaults()
    }
  }

  private normalize(input: Partial<StoredSettings>): StoredSettings {
    const base = defaults()
    const rawProfiles = Array.isArray(input.profiles) ? input.profiles : []
    const profiles: StoredProfile[] = rawProfiles
      .filter((p) => p && typeof p === 'object' && typeof (p as StoredProfile).id === 'string')
      .map((p) => {
        const kind: ProfileKind =
          p.kind === 'openrouter' || p.kind === 'demo' || p.kind === 'custom' ? p.kind : 'custom'
        return {
          id: String(p.id),
          name: str(p.name, 'Model'),
          kind,
          baseUrl: str(p.baseUrl),
          model: str(p.model),
          models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string') : undefined,
          apiKeyEnc: typeof p.apiKeyEnc === 'string' ? p.apiKeyEnc : undefined,
        }
      })

    if (!profiles.length) profiles.push({ ...DEMO_PROFILE })

    const active = profiles.find((p) => p.id === input.activeProfileId) ?? profiles[0]
    return {
      profiles,
      activeProfileId: active.id,
      policy: normalizePolicy(input.policy, base.policy),
      autoApprove: typeof input.autoApprove === 'boolean' ? input.autoApprove : base.autoApprove,
      autoApproveCommands:
        typeof input.autoApproveCommands === 'boolean' ? input.autoApproveCommands : base.autoApproveCommands,
      maxSteps: clamp(input.maxSteps, 1, 100, base.maxSteps),
      maxGoalRounds: clamp(input.maxGoalRounds, 1, 100, base.maxGoalRounds),
      recentWorkspaces: Array.isArray(input.recentWorkspaces)
        ? input.recentWorkspaces.filter((r): r is string => typeof r === 'string').slice(0, 12)
        : [],
      lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : null,
      agentMode: input.agentMode === 'ask' || input.agentMode === 'plan' ? input.agentMode : 'code',
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[settings] failed to persist', err)
    }
  }

  /** Settings safe to hand to the renderer (no secrets). */
  get(): Settings {
    const profiles: ModelProfile[] = this.data.profiles.map((p) => {
      const { apiKeyEnc, ...rest } = p
      return { ...rest, hasApiKey: Boolean(apiKeyEnc) }
    })
    return {
      profiles,
      activeProfileId: this.data.activeProfileId,
      policy: this.data.policy,
      autoApprove: this.data.autoApprove,
      autoApproveCommands: this.data.autoApproveCommands,
      maxSteps: this.data.maxSteps,
      maxGoalRounds: this.data.maxGoalRounds,
      recentWorkspaces: [...this.data.recentWorkspaces],
      lastWorkspace: this.data.lastWorkspace,
      agentMode: this.data.agentMode,
    }
  }

  /** Internal settings including encrypted secrets. Main process only. */
  raw(): StoredSettings {
    return this.data
  }

  save(patch: Partial<Settings>): Settings {
    const next: StoredSettings = { ...this.data }

    if (Array.isArray(patch.profiles)) {
      const existing = new Map(this.data.profiles.map((p) => [p.id, p]))
      next.profiles = patch.profiles
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => {
          const prev = existing.get(p.id)
          return {
            id: p.id,
            name: str(p.name, 'Model'),
            kind: p.kind === 'openrouter' || p.kind === 'demo' ? p.kind : 'custom',
            baseUrl: str(p.baseUrl),
            model: str(p.model),
            models: Array.isArray(p.models) ? p.models : prev?.models,
            apiKeyEnc: prev?.apiKeyEnc,
          }
        })
      if (!next.profiles.length) next.profiles = [{ ...DEMO_PROFILE }]
    }

    if (typeof patch.activeProfileId === 'string' && next.profiles.some((p) => p.id === patch.activeProfileId)) {
      next.activeProfileId = patch.activeProfileId
    } else if (!next.profiles.some((p) => p.id === next.activeProfileId)) {
      next.activeProfileId = next.profiles[0].id
    }

    if (patch.policy) {
      next.policy = patch.policy
      next.autoApprove = patch.policy !== 'read-only'
      next.autoApproveCommands = patch.policy === 'full-access'
    }
    if (typeof patch.autoApprove === 'boolean') next.autoApprove = patch.autoApprove
    if (typeof patch.autoApproveCommands === 'boolean') next.autoApproveCommands = patch.autoApproveCommands
    if (patch.maxSteps !== undefined) next.maxSteps = clamp(patch.maxSteps, 1, 100, 30)
    if (patch.maxGoalRounds !== undefined) next.maxGoalRounds = clamp(patch.maxGoalRounds, 1, 100, 8)
    if (Array.isArray(patch.recentWorkspaces)) {
      next.recentWorkspaces = patch.recentWorkspaces.filter((r): r is string => typeof r === 'string').slice(0, 12)
    }
    if (patch.lastWorkspace === null) next.lastWorkspace = null
    else if (typeof patch.lastWorkspace === 'string') next.lastWorkspace = patch.lastWorkspace
    if (patch.agentMode === 'ask' || patch.agentMode === 'plan' || patch.agentMode === 'code') {
      next.agentMode = patch.agentMode
    }

    this.data = next
    this.persist()
    return this.get()
  }

  setProfileKey(profileId: string, key: string): void {
    const profile = this.data.profiles.find((p) => p.id === profileId)
    if (!profile) return
    const trimmed = key.trim()
    profile.apiKeyEnc = trimmed ? encrypt(trimmed) : undefined
    this.persist()
  }

  keyFor(profileId: string): string {
    const profile = this.data.profiles.find((p) => p.id === profileId)
    return decrypt(profile?.apiKeyEnc)
  }

  touchWorkspace(root: string): void {
    this.data.recentWorkspaces = [root, ...this.data.recentWorkspaces.filter((r) => r !== root)].slice(0, 12)
    this.data.lastWorkspace = root
    this.persist()
  }

  setLastWorkspace(root: string | null): void {
    this.data.lastWorkspace = root
    this.persist()
  }

  newProfileId(): string {
    return randomUUID()
  }

  defaultAgentMode(): AgentMode {
    return this.data.agentMode
  }
}
