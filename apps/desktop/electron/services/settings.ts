import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../../shared/appearance'
import { cleanKeybindings } from '../../shared/keybindings'
import { isInlineSuggest } from '../../shared/inline'
import { cleanEfforts, cleanRoles, isLocalUrl } from '../../shared/models'
import { DEFAULT_SEARCH_PROVIDER, KEYED_SEARCH_PROVIDER_IDS, type KeyedSearchProviderId, type SearchProviderId, isKeyedSearchProvider, isSearchProviderId } from '../../shared/search'
import type { AgentMode, ApprovalPolicy, CheckGate, ErrorGate, FollowUp, Guide, ModelProfile, NotifyWhen, ProfileKind, ReviewWork, SendKey, Settings } from '../../shared/types'
import { secureExisting, writePrivateFile } from './private-file'
import { type Cipher, KeyVault } from './secrets'

interface StoredProfile extends Omit<ModelProfile, 'hasApiKey'> {
  /** A key sealed by the OS keychain; see KeyVault. Never plain text. */
  apiKeyEnc?: string
}

interface StoredSettings extends Omit<Settings, 'profiles' | 'keyStorage' | 'computerSupported' | 'searchKeys' | 'chatsFolder' | 'chatsFolderDefault'> {
  profiles: StoredProfile[]
  /** The keys of the search providers that need one, sealed like a profile's. */
  searchKeysEnc: Partial<Record<KeyedSearchProviderId, string>>
  /** The folder the person chose for chats, or null for the default one. */
  chatsFolder: string | null
}

/** The name a search key has in the vault; a profile's id is a UUID, so the two cannot meet. */
const searchVaultId = (provider: KeyedSearchProviderId): string => `search:${provider}`

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
    computer: false,
    recentWorkspaces: [],
    lastWorkspace: null,
    agentMode: 'code',
    followUp: 'queue',
    sendKey: 'enter',
    keepAwake: true,
    languageServers: true,
    formatOnSave: false,
    formatOnType: false,
    inlineSuggest: 'auto',
    errorGate: 'auto',
    guide: 'auto',
    checkGate: 'auto',
    reviewWork: 'auto',
    notifyDone: 'background',
    notifyNeeds: 'background',
    flashTaskbar: true,
    chatsFolder: null,
    appearance: { ...DEFAULT_APPEARANCE },
    roles: {},
    efforts: {},
    keybindings: {},
    freeOnly: true,
    freeProfileId: null,
    setupDone: false,
    searchProvider: DEFAULT_SEARCH_PROVIDER,
    searchKeysEnc: {},
  }
}

const POLICIES: ApprovalPolicy[] = ['read-only', 'workspace-write', 'full-access', 'auto-review']

function normalizePolicy(value: unknown, fallback: ApprovalPolicy): ApprovalPolicy {
  return POLICIES.includes(value as ApprovalPolicy) ? (value as ApprovalPolicy) : fallback
}

const isFollowUp = (value: unknown): value is FollowUp => value === 'queue' || value === 'steer'
const isSendKey = (value: unknown): value is SendKey => value === 'enter' || value === 'ctrl-enter'
const isNotifyWhen = (value: unknown): value is NotifyWhen => value === 'never' || value === 'background' || value === 'always'
const isErrorGate = (value: unknown): value is ErrorGate => value === 'auto' || value === 'on' || value === 'off'
const isGuide = (value: unknown): value is Guide => value === 'auto' || value === 'full'
const isCheckGate = (value: unknown): value is CheckGate => value === 'auto' || value === 'on' || value === 'off'
const isReviewWork = (value: unknown): value is ReviewWork => value === 'auto' || value === 'on' || value === 'off'

/** The longest folder path kept for chats; Windows' own limit for most programs is 260 characters. */
const MAX_FOLDER_LENGTH = 1024

/** A folder for chats as it can be kept: an absolute path of reasonable length, tidied; anything else is no choice. */
export function chatsFolderOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_FOLDER_LENGTH || value.includes('\0')) return null
  return path.isAbsolute(value) ? path.resolve(value) : null
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** The server a profile's requests, and so its key, go to. */
export function serverOf(baseUrl: string): string {
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

/** The sealed search keys of a settings file: only the providers that exist and only text. */
function storedSearchKeys(value: unknown): StoredSettings['searchKeysEnc'] {
  const keys: StoredSettings['searchKeysEnc'] = {}
  if (typeof value !== 'object' || value === null) return keys
  for (const provider of KEYED_SEARCH_PROVIDER_IDS) {
    const stored = (value as Record<string, unknown>)[provider]
    if (typeof stored === 'string') keys[provider] = stored
  }
  return keys
}

/** The profile that may serve the free models: an OpenRouter one that exists. */
function freeProfileOf(value: unknown, profiles: StoredProfile[]): string | null {
  return typeof value === 'string' && profiles.some((profile) => profile.id === value && profile.kind === 'openrouter') ? value : null
}

/** A folder's path as two are compared: slashes one way, none at the end, and on Windows any case. */
function folderText(folder: string, platform: NodeJS.Platform): string {
  const tidy = folder.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? tidy.toLowerCase() : tidy
}

/** Two folders are the same on Windows whatever their case and slashes. */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return folderText(a, platform) === folderText(b, platform)
}

/** True when `folder` is `parent` or lies in it, judged on the path text. */
function inFolder(folder: string, parent: string, platform: NodeJS.Platform): boolean {
  const child = folderText(folder, platform)
  const base = folderText(parent, platform)
  return child === base || child.startsWith(`${base}/`)
}

export class SettingsService {
  private readonly file: string
  private readonly vault: KeyVault
  private data: StoredSettings
  /** Changes whenever a profile's key does, so the agent host can tell a new key from the old one without seeing either. */
  private readonly revisions = new Map<string, number>()
  private readonly platform: NodeJS.Platform
  /** eNCode's own folder: settings, keys, sessions and checkpoints. */
  private readonly dir: string
  private readonly home: string

  /** Where chats work when the person has not chosen a folder. */
  private readonly defaultChatsFolder: string

  /**
   * `cipher` is Electron's safeStorage; tests pass a fake. `chatsFolder` is the default folder for chats, eNCode in
   * Documents, and `home` the person's own folder.
   */
  constructor(dir: string, cipher: Cipher, platform: NodeJS.Platform = process.platform, options: { chatsFolder?: string; home?: string } = {}) {
    this.platform = platform
    this.dir = path.resolve(dir)
    this.home = options.home ?? os.homedir()
    this.defaultChatsFolder = options.chatsFolder ?? path.join(this.home, 'Documents', 'eNCode')
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
    for (const provider of KEYED_SEARCH_PROVIDER_IDS) {
      const stored = this.data.searchKeysEnc[provider]
      const next = this.vault.load(searchVaultId(provider), stored)
      if (next !== stored) {
        if (next === undefined) delete this.data.searchKeysEnc[provider]
        else this.data.searchKeysEnc[provider] = next
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
    // A file from before the model router: whoever already ran a real model keeps being allowed to, and has set up.
    const usesRealModel = profiles.some((p) => p.kind !== 'demo' && (Boolean(p.apiKeyEnc) || isLocalUrl(p.baseUrl)))
    return {
      profiles,
      activeProfileId: active.id,
      policy: normalizePolicy(input.policy, base.policy),
      maxSteps: clamp(input.maxSteps, 1, 100, base.maxSteps),
      maxGoalRounds: clamp(input.maxGoalRounds, 1, 100, base.maxGoalRounds),
      computer: typeof input.computer === 'boolean' ? input.computer : base.computer,
      recentWorkspaces: Array.isArray(input.recentWorkspaces)
        ? input.recentWorkspaces.filter((r): r is string => typeof r === 'string').slice(0, 12)
        : [],
      lastWorkspace: typeof input.lastWorkspace === 'string' ? input.lastWorkspace : null,
      agentMode: input.agentMode === 'ask' || input.agentMode === 'plan' ? input.agentMode : 'code',
      followUp: isFollowUp(input.followUp) ? input.followUp : base.followUp,
      sendKey: isSendKey(input.sendKey) ? input.sendKey : base.sendKey,
      keepAwake: typeof input.keepAwake === 'boolean' ? input.keepAwake : base.keepAwake,
      languageServers: typeof input.languageServers === 'boolean' ? input.languageServers : base.languageServers,
      formatOnSave: typeof input.formatOnSave === 'boolean' ? input.formatOnSave : base.formatOnSave,
      formatOnType: typeof input.formatOnType === 'boolean' ? input.formatOnType : base.formatOnType,
      inlineSuggest: isInlineSuggest(input.inlineSuggest) ? input.inlineSuggest : base.inlineSuggest,
      errorGate: isErrorGate(input.errorGate) ? input.errorGate : base.errorGate,
      guide: isGuide(input.guide) ? input.guide : base.guide,
      checkGate: isCheckGate(input.checkGate) ? input.checkGate : base.checkGate,
      reviewWork: isReviewWork(input.reviewWork) ? input.reviewWork : base.reviewWork,
      notifyDone: isNotifyWhen(input.notifyDone) ? input.notifyDone : base.notifyDone,
      notifyNeeds: isNotifyWhen(input.notifyNeeds) ? input.notifyNeeds : base.notifyNeeds,
      flashTaskbar: typeof input.flashTaskbar === 'boolean' ? input.flashTaskbar : base.flashTaskbar,
      chatsFolder: this.fitForChats(chatsFolderOf(input.chatsFolder)),
      appearance: normalizeAppearance(input.appearance),
      roles: cleanRoles(input.roles, profiles),
      efforts: cleanEfforts(input.efforts),
      keybindings: cleanKeybindings(input.keybindings),
      freeOnly: typeof input.freeOnly === 'boolean' ? input.freeOnly : !usesRealModel,
      freeProfileId: freeProfileOf(input.freeProfileId, profiles),
      setupDone: typeof input.setupDone === 'boolean' ? input.setupDone : usesRealModel,
      searchProvider: isSearchProviderId(input.searchProvider) ? input.searchProvider : base.searchProvider,
      searchKeysEnc: storedSearchKeys(input.searchKeysEnc),
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
      computer: this.data.computer,
      recentWorkspaces: [...this.data.recentWorkspaces],
      lastWorkspace: this.data.lastWorkspace,
      agentMode: this.data.agentMode,
      followUp: this.data.followUp,
      sendKey: this.data.sendKey,
      keepAwake: this.data.keepAwake,
      languageServers: this.data.languageServers,
      formatOnSave: this.data.formatOnSave,
      formatOnType: this.data.formatOnType,
      inlineSuggest: this.data.inlineSuggest,
      errorGate: this.data.errorGate,
      guide: this.data.guide,
      checkGate: this.data.checkGate,
      reviewWork: this.data.reviewWork,
      notifyDone: this.data.notifyDone,
      notifyNeeds: this.data.notifyNeeds,
      flashTaskbar: this.data.flashTaskbar,
      chatsFolder: this.chatsFolder(),
      chatsFolderDefault: this.defaultChatsFolder,
      appearance: { ...this.data.appearance },
      roles: structuredClone(this.data.roles),
      efforts: { ...this.data.efforts },
      keybindings: structuredClone(this.data.keybindings),
      freeOnly: this.data.freeOnly,
      freeProfileId: this.data.freeProfileId,
      setupDone: this.data.setupDone,
      searchProvider: this.data.searchProvider,
      searchKeys: KEYED_SEARCH_PROVIDER_IDS.filter((provider) => this.vault.has(searchVaultId(provider), this.data.searchKeysEnc[provider])),
      keyStorage: this.vault.storage,
      computerSupported: this.platform === 'win32',
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
          if (prev && !sameServer) {
            this.vault.forget(prev.id)
            this.revise(prev.id)
          }
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
      for (const id of existing.keys()) {
        if (kept.has(id)) continue
        this.vault.forget(id)
        this.revise(id)
      }
    }

    if (typeof patch.activeProfileId === 'string' && next.profiles.some((p) => p.id === patch.activeProfileId)) {
      next.activeProfileId = patch.activeProfileId
    } else if (!next.profiles.some((p) => p.id === next.activeProfileId)) {
      next.activeProfileId = next.profiles[0].id
    }

    if (patch.policy !== undefined) next.policy = normalizePolicy(patch.policy, next.policy)
    if (patch.maxSteps !== undefined) next.maxSteps = clamp(patch.maxSteps, 1, 100, 30)
    if (patch.maxGoalRounds !== undefined) next.maxGoalRounds = clamp(patch.maxGoalRounds, 1, 100, 8)
    if (typeof patch.computer === 'boolean') next.computer = patch.computer
    if (Array.isArray(patch.recentWorkspaces)) {
      next.recentWorkspaces = patch.recentWorkspaces.filter((r): r is string => typeof r === 'string').slice(0, 12)
    }
    if (patch.lastWorkspace === null) next.lastWorkspace = null
    else if (typeof patch.lastWorkspace === 'string') next.lastWorkspace = patch.lastWorkspace
    if (patch.agentMode === 'ask' || patch.agentMode === 'plan' || patch.agentMode === 'code') {
      next.agentMode = patch.agentMode
    }
    if (isFollowUp(patch.followUp)) next.followUp = patch.followUp
    if (isSendKey(patch.sendKey)) next.sendKey = patch.sendKey
    if (typeof patch.keepAwake === 'boolean') next.keepAwake = patch.keepAwake
    if (typeof patch.languageServers === 'boolean') next.languageServers = patch.languageServers
    if (typeof patch.formatOnSave === 'boolean') next.formatOnSave = patch.formatOnSave
    if (typeof patch.formatOnType === 'boolean') next.formatOnType = patch.formatOnType
    if (isInlineSuggest(patch.inlineSuggest)) next.inlineSuggest = patch.inlineSuggest
    if (isErrorGate(patch.errorGate)) next.errorGate = patch.errorGate
    if (isGuide(patch.guide)) next.guide = patch.guide
    if (isCheckGate(patch.checkGate)) next.checkGate = patch.checkGate
    if (isReviewWork(patch.reviewWork)) next.reviewWork = patch.reviewWork
    if (isNotifyWhen(patch.notifyDone)) next.notifyDone = patch.notifyDone
    if (isNotifyWhen(patch.notifyNeeds)) next.notifyNeeds = patch.notifyNeeds
    if (typeof patch.flashTaskbar === 'boolean') next.flashTaskbar = patch.flashTaskbar
    // The chats folder is not taken from a patch: only the folder dialog, in this process, chooses one.
    // A partial appearance changes only the fields it names.
    if (patch.appearance !== undefined) next.appearance = normalizeAppearance(patch.appearance, next.appearance)

    // Models for the roles; a profile that went away takes the entries that named it.
    next.roles = cleanRoles(patch.roles !== undefined ? patch.roles : next.roles, next.profiles)
    if (patch.efforts !== undefined) next.efforts = cleanEfforts(patch.efforts)
    if (patch.keybindings !== undefined) next.keybindings = cleanKeybindings(patch.keybindings)
    if (typeof patch.freeOnly === 'boolean') next.freeOnly = patch.freeOnly
    next.freeProfileId = freeProfileOf(patch.freeProfileId !== undefined ? patch.freeProfileId : next.freeProfileId, next.profiles)
    if (typeof patch.setupDone === 'boolean') next.setupDone = patch.setupDone
    if (isSearchProviderId(patch.searchProvider)) next.searchProvider = patch.searchProvider

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
      this.revise(profile.id)
      this.persist()
    }
    return this.get()
  }

  /** Stores, replaces or (with an empty key) removes the key of a search provider that needs one. */
  setSearchKey(provider: SearchProviderId, key: string): Settings {
    if (!isKeyedSearchProvider(provider)) throw new Error('This search provider does not use a key.')
    const trimmed = key.trim()
    checkKey(trimmed)
    const sealed = this.vault.put(searchVaultId(provider), trimmed)
    if (sealed === undefined) delete this.data.searchKeysEnc[provider]
    else this.data.searchKeysEnc[provider] = sealed
    this.persist()
    return this.get()
  }

  /** The key of a search provider, or '' when it has none or it cannot be read. Main process only. */
  searchKeyFor(provider: SearchProviderId): string {
    return isKeyedSearchProvider(provider) ? this.vault.get(searchVaultId(provider), this.data.searchKeysEnc[provider]) : ''
  }

  private revise(profileId: string): void {
    this.revisions.set(profileId, (this.revisions.get(profileId) ?? 0) + 1)
  }

  /** A number that is different after every change of the profile's key. */
  keyRevision(profileId: string): number {
    return this.revisions.get(profileId) ?? 0
  }

  /** Every stored key, so that a log or a report can be scrubbed of exactly these values. */
  secrets(): string[] {
    return [
      ...this.data.profiles.map((profile) => this.vault.get(profile.id, profile.apiKeyEnc)),
      ...KEYED_SEARCH_PROVIDER_IDS.map((provider) => this.vault.get(searchVaultId(provider), this.data.searchKeysEnc[provider])),
    ].filter(Boolean)
  }

  keyFor(profileId: string): string {
    const profile = this.data.profiles.find((p) => p.id === profileId)
    return profile ? this.vault.get(profile.id, profile.apiKeyEnc) : ''
  }

  /** The folder chats work in: the one the person chose, or the default. */
  chatsFolder(): string {
    return this.data.chatsFolder ?? this.defaultChatsFolder
  }

  /**
   * A folder chats may work in, or null. The agent writes in a chat's folder without asking, so it is never a whole
   * drive, the home folder, or a folder that holds eNCode's own files or lies in them, where a write could change its
   * settings or keys.
   */
  private fitForChats(folder: string | null): string | null {
    if (folder === null || path.parse(folder).root === folder || sameFolder(folder, this.home, this.platform)) return null
    return inFolder(folder, this.dir, this.platform) || inFolder(this.dir, folder, this.platform) ? null : folder
  }

  /** Keeps `folder` (from the folder dialog) as the chats folder, or with null goes back to the default. */
  setChatsFolder(folder: string | null): Settings {
    const whole = folder === null ? null : chatsFolderOf(folder)
    if (folder !== null && whole === null) throw new Error('Choose a folder on this computer for chats.')
    const kept = this.fitForChats(whole)
    if (whole !== null && kept === null) throw new Error('Choose a folder of its own for chats: not a whole drive, the home folder, or a folder that holds eNCode settings.')
    // The default needs no entry, so a later change of the default reaches whoever never chose.
    this.data.chatsFolder = kept !== null && path.resolve(kept) === path.resolve(this.defaultChatsFolder) ? null : kept
    this.persist()
    return this.get()
  }

  /** Remembers a folder that was opened. The chats folder is opened like a project but is not one, so it is not listed with them. */
  touchWorkspace(root: string): void {
    if (!sameFolder(root, this.chatsFolder(), this.platform)) {
      this.data.recentWorkspaces = [root, ...this.data.recentWorkspaces.filter((r) => r !== root)].slice(0, 12)
    }
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
