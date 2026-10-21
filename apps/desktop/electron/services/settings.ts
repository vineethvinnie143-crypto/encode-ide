import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../../shared/appearance'
import type { AgentMode, ApprovalPolicy, ModelProfile, ProfileKind, Settings } from '../../shared/types'
import { secureExisting, writePrivateFile } from './private-file'
import { type Cipher, KeyVault } from './secrets'

interface StoredProfile extends Omit<ModelProfile, 'hasApiKey'> {
  /** A key sealed by the OS keychain; see KeyVault. Never plain text. */
  apiKeyEnc?: string
}

interface StoredSettings extends Omit<Settings, 'profiles' | 'keyStorage'> {
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
    maxSteps: 30,
    maxGoalRounds: 8,
    recentWorkspaces: [],
    lastWorkspace: null,
    agentMode: 'code',
    appearance: { ...DEFAULT_APPEARANCE },
  }
}

const POLICIES: ApprovalPolicy[] = ['read-only', 'workspace-write', 'full-access', 'auto-review']

function normalizePolicy(value: unknown, fallback: ApprovalPolicy): ApprovalPolicy {
  return POLICIES.includes(value as ApprovalPolicy) ? (value as ApprovalPolicy) : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** The server a profile's requests, and so its key, go to. */
function serverOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).origin
  } catch {
    return ''
  }
}

const MAX_KEY_LENGTH = 4096

/** Keys travel in an HTTP header, so they must be one line of printable characters. */
function checkKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) throw new Error(`An API key is at most ${MAX_KEY_LENGTH} characters.`)
  if (key && !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('An API key is a single line of printable characters without spaces.')
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export class SettingsService {
  private readonly file: string
  private readonly vault: KeyVault
  private data: StoredSettings

  /** `cipher` is Electron's safeStorage; tests pass a fake. */
  constructor(dir: string, cipher: Cipher, platform: NodeJS.Platform = process.platform) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, 'eNCode-settings.json')
    this.vault = new KeyVault(cipher, platform)
    secureExisting(this.file)
    this.data = this.load()
    if (this.upgradeKeys()) this.persist()
  }

  /** Seals or evicts keys an earlier build stored in plain text. True when the file must be rewritten. */
  private upgradeKeys(): boolean {
    let changed = false
    for (const profile of this.data.profiles) {
      const next = this.vault.load(profile.id, profile.apiKeyEnc)
      if (next !== profile.apiKeyEnc) {
        profile.apiKeyEnc = next
        changed = true
      }
    }
    return changed
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
      maxSteps: clamp(input.maxSteps, 1, 100, base.maxSteps),
      maxGoalRounds: clamp(input.maxGoalRounds, 1, 100, base.maxGoalRounds),
      recentWorkspaces: Array.isArray(input.recentWorkspaces)
        ? input.recentWorkspaces.filter((r): r is string => typeof r === 'string').slice(0, 12)
        : [],
      lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : null,
      agentMode: input.agentMode === 'ask' || input.agentMode === 'plan' ? input.agentMode : 'code',
      appearance: normalizeAppearance(input.appearance),
    }
  }

  private persist(): void {
    try {
      writePrivateFile(this.file, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.error('[settings] failed to persist', err)
    }
  }

  /** Settings safe to hand to the renderer (no secrets). */
  get(): Settings {
    const profiles: ModelProfile[] = this.data.profiles.map((p) => {
      const { apiKeyEnc, ...rest } = p
      return { ...rest, hasApiKey: this.vault.has(p.id, apiKeyEnc) }
    })
    return {
      profiles,
      activeProfileId: this.data.activeProfileId,
      policy: this.data.policy,
      maxSteps: this.data.maxSteps,
      maxGoalRounds: this.data.maxGoalRounds,
      recentWorkspaces: [...this.data.recentWorkspaces],
      lastWorkspace: this.data.lastWorkspace,
      agentMode: this.data.agentMode,
      appearance: { ...this.data.appearance },
      keyStorage: this.vault.storage,
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
          const baseUrl = str(p.baseUrl)
          // A key stays with the server it was entered for: pointing its profile elsewhere drops it.
          const sameServer = prev !== undefined && serverOf(prev.baseUrl) === serverOf(baseUrl)
          if (prev && !sameServer) this.vault.forget(prev.id)
          return {
            id: p.id,
            name: str(p.name, 'Model'),
            kind: p.kind === 'openrouter' || p.kind === 'demo' ? p.kind : 'custom',
            baseUrl,
            model: str(p.model),
            models: Array.isArray(p.models) ? p.models : prev?.models,
            apiKeyEnc: sameServer ? prev.apiKeyEnc : undefined,
          }
        })
      if (!next.profiles.length) next.profiles = [{ ...DEMO_PROFILE }]
      const kept = new Set(next.profiles.map((p) => p.id))
      for (const id of existing.keys()) if (!kept.has(id)) this.vault.forget(id)
    }

    if (typeof patch.activeProfileId === 'string' && next.profiles.some((p) => p.id === patch.activeProfileId)) {
      next.activeProfileId = patch.activeProfileId
    } else if (!next.profiles.some((p) => p.id === next.activeProfileId)) {
      next.activeProfileId = next.profiles[0].id
    }

    if (patch.policy !== undefined) next.policy = normalizePolicy(patch.policy, next.policy)
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
    // A partial appearance changes only the fields it names.
    if (patch.appearance !== undefined) next.appearance = normalizeAppearance(patch.appearance, next.appearance)

    this.data = next
    this.persist()
    return this.get()
  }

  /** Stores, replaces or (with an empty key) removes a profile's key, for the server it points at now. */
  setProfileKey(profileId: string, key: string): Settings {
    const trimmed = key.trim()
    checkKey(trimmed)
    const profile = this.data.profiles.find((p) => p.id === profileId)
    if (profile) {
      profile.apiKeyEnc = this.vault.put(profile.id, trimmed)
      this.persist()
    }
    return this.get()
  }

  keyFor(profileId: string): string {
    const profile = this.data.profiles.find((p) => p.id === profileId)
    return profile ? this.vault.get(profile.id, profile.apiKeyEnc) : ''
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
