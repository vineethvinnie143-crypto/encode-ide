import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isLoopbackUrl, normalizeBaseUrl } from '@encode/router'
import {
  EFFORTS,
  EFFORT_INFO,
  FREE_REF,
  MAX_ROLE_MODELS,
  addressProblem,
  cleanEfforts,
  cleanRoles,
  demoPatch,
  freeProfile,
  isEffort,
  isFreeRef,
  isLocalUrl,
  labelOfRef,
  mainLabel,
  mainPatch,
  mainRefs,
  modelMode,
  modelRef,
  parseRef,
  withEffort,
} from './models'
import type { ModelProfile, Settings } from './types'

const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
const router = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasApiKey: true, ...patch })
const openai = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'oa', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true, ...patch })
const ollama = (patch: Partial<ModelProfile> = {}): ModelProfile => ({ id: 'ol', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', hasApiKey: false, ...patch })

const settings = (patch: Partial<Settings> = {}): Settings =>
  ({ profiles: [demo], activeProfileId: 'demo', roles: {}, freeOnly: true, freeProfileId: null, setupDone: true, ...patch }) as Settings

describe('model references', () => {
  const profiles = [{ id: 'or' }, { id: 'oa' }, { id: 'a' }, { id: 'a:b' }]

  it('read "@free", and a profile with a model that has colons of its own', () => {
    assert.deepEqual(parseRef(FREE_REF, profiles), { kind: 'free' })
    assert.deepEqual(parseRef('or:qwen/qwen3-coder:free', profiles), { kind: 'model', profileId: 'or', model: 'qwen/qwen3-coder:free' })
    assert.equal(modelRef('or', 'qwen/qwen3-coder:free'), 'or:qwen/qwen3-coder:free')
  })

  it('prefer the longest profile id, and refuse what names no profile or no model', () => {
    assert.deepEqual(parseRef('a:b:gpt', profiles), { kind: 'model', profileId: 'a:b', model: 'gpt' })
    assert.deepEqual(parseRef('a:gpt', profiles), { kind: 'model', profileId: 'a', model: 'gpt' })
    assert.equal(parseRef('gone:gpt', profiles), null)
    assert.equal(parseRef('or:', profiles), null)
    assert.equal(parseRef('or', profiles), null)
    assert.equal(parseRef('', profiles), null)
  })
})

describe('local servers', () => {
  it('agree with the router about which addresses are this machine', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.1.2.3/v1', 'http://[::1]:8080', 'http://app.localhost/v1', 'https://openrouter.ai/api/v1', 'http://192.168.1.5:8000/v1', 'http://localhost.evil.example/v1', 'not a url', '']) {
      assert.equal(isLocalUrl(url), isLoopbackUrl(url), url)
    }
  })
})

describe('connection addresses', () => {
  it('are refused for the same reasons the router refuses them', () => {
    for (const address of [
      'https://api.openai.com/v1',
      ' https://api.openai.com/v1/ ',
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8080',
      'http://api.example.com/v1',
      'http://192.168.1.5:8000/v1',
      'ftp://api.example.com/v1',
      'https://user:secret@api.example.com/v1',
      'https://api.example.com/v1?key=abc',
      'https://api.example.com/v1#top',
      'api.example.com/v1',
      'localhost:11434/v1',
      '',
    ]) {
      assert.equal(addressProblem(address) === null, 'url' in normalizeBaseUrl(address), address)
    }
  })

  it('say what to do', () => {
    assert.match(addressProblem('http://api.example.com/v1') ?? '', /https:\/\/ unless the server runs on this computer/)
    assert.match(addressProblem('https://u:p@api.example.com') ?? '', /key goes in the key field/)
    assert.equal(addressProblem('http://localhost:11434/v1'), null)
  })
})

describe('the connection that serves the free models', () => {
  it('is the one named, else the first OpenRouter profile that has a key', () => {
    const second = router({ id: 'or2', name: 'Second', hasApiKey: true })
    assert.equal(freeProfile(settings({ profiles: [demo, router(), second] }))?.id, 'or')
    assert.equal(freeProfile(settings({ profiles: [demo, router(), second], freeProfileId: 'or2' }))?.id, 'or2')
    assert.equal(freeProfile(settings({ profiles: [demo, router({ hasApiKey: false }), second] }))?.id, 'or2')
  })

  it('is none when there is no OpenRouter profile with a key, or the one named has gone', () => {
    assert.equal(freeProfile(settings({ profiles: [demo, openai()] })), null)
    assert.equal(freeProfile(settings({ profiles: [demo, router({ hasApiKey: false })] })), null)
    assert.equal(freeProfile(settings({ profiles: [demo, openai(), router()], freeProfileId: 'gone' }))?.id, 'or')
  })
})

describe('the main model and what answers', () => {
  it('is the demo until a real model is chosen', () => {
    assert.equal(modelMode(settings()), 'demo')
    assert.equal(mainLabel(settings()), 'Demo (offline)')
  })

  it('is the active profile\'s model when no list names one, and nothing when it has none', () => {
    const chosen = settings({ profiles: [demo, openai()], activeProfileId: 'oa' })
    assert.deepEqual(mainRefs(chosen), ['oa:gpt-4o-mini'])
    assert.equal(modelMode(chosen), 'router')
    assert.equal(mainLabel(chosen), 'gpt-4o-mini')

    const empty = settings({ profiles: [demo, openai({ model: '  ' })], activeProfileId: 'oa' })
    assert.deepEqual(mainRefs(empty), [])
    assert.equal(modelMode(empty), 'none')
    assert.equal(mainLabel(empty), 'No model')
  })

  it('is the list the settings name, which beats the active profile, and says how many stand by', () => {
    const named = settings({ profiles: [demo, openai(), router()], activeProfileId: 'oa', roles: { main: ['or:qwen/qwen3-coder:free', FREE_REF, 'oa:gpt-4o'] } })
    assert.deepEqual(mainRefs(named), ['or:qwen/qwen3-coder:free', FREE_REF, 'oa:gpt-4o'])
    assert.equal(mainLabel(named), 'qwen/qwen3-coder:free +2')
    assert.equal(mainLabel(settings({ profiles: [demo, router()], roles: { main: [FREE_REF] } })), 'Free models')
  })

  it('describes a reference in words', () => {
    const s = settings({ profiles: [demo, openai()] })
    assert.equal(labelOfRef(s, FREE_REF), 'Free models')
    assert.equal(labelOfRef(s, 'oa:gpt-4o'), 'OpenAI: gpt-4o')
    assert.equal(labelOfRef(s, 'gone:x'), 'gone:x')
  })
})

describe('what costs nothing', () => {
  const s = settings({ profiles: [demo, router(), openai(), ollama()] })

  it('is the free models, a server on this machine, and an OpenRouter ":free" model the listing does not deny', () => {
    assert.equal(isFreeRef(s, FREE_REF), true)
    assert.equal(isFreeRef(s, 'ol:llama3.2'), true)
    assert.equal(isFreeRef(s, 'or:qwen/qwen3-coder:free'), true)
    assert.equal(isFreeRef(s, 'or:qwen/qwen3-coder:free', () => false), false, 'a listing with a price is believed')
  })

  it('is not an OpenRouter model without ":free", a hosted API, the demo, or a name that is none of them', () => {
    assert.equal(isFreeRef(s, 'or:anthropic/claude-sonnet-4'), false)
    assert.equal(isFreeRef(s, 'oa:gpt-4o-mini'), false)
    assert.equal(isFreeRef(s, 'demo:eNCode-demo'), false)
    assert.equal(isFreeRef(s, 'gone:x'), false)
  })
})

describe('role lists', () => {
  const profiles = [{ id: 'or' }, { id: 'oa' }]

  it('keep known roles, references that name a profile or "@free", and each only once', () => {
    const roles = cleanRoles(
      { main: ['or:a:free', ' or:a:free ', FREE_REF, 'gone:x', 7, ''], reviewer: ['oa:o3'], summarizer: 'oa:o3', nonsense: ['oa:o3'], utility: [] },
      profiles,
    )
    assert.deepEqual(roles, { main: ['or:a:free', FREE_REF], reviewer: ['oa:o3'] })
  })

  it('cap a list, and cope with anything that is not a list of roles', () => {
    const many = Array.from({ length: 20 }, (_, i) => `or:m${i}`)
    assert.equal(cleanRoles({ main: many }, profiles).main?.length, MAX_ROLE_MODELS)
    for (const junk of [null, undefined, 'main', 4, [], [['or:a']]]) assert.deepEqual(cleanRoles(junk, profiles), {})
    assert.deepEqual(cleanRoles(JSON.parse('{"__proto__": ["or:a"], "main": ["or:a"]}'), profiles), { main: ['or:a'] })
  })
})

describe('efforts', () => {
  it('keep known roles at known levels, and nothing else', () => {
    assert.deepEqual(cleanEfforts({ main: 'max', explore: 'low', reviewer: 'HIGH', planner: 'extreme', utility: 3, nonsense: 'low' }), { main: 'max', explore: 'low' })
    for (const junk of [null, undefined, 'max', 4, [], ['max']]) assert.deepEqual(cleanEfforts(junk), {})
    assert.deepEqual(cleanEfforts(JSON.parse('{"__proto__": "max", "constructor": "low", "summarizer": "xhigh"}')), { summarizer: 'xhigh' })
  })

  it('know the five levels, least first, each with a name and a hint', () => {
    assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
    for (const effort of EFFORTS) {
      assert.ok(isEffort(effort))
      assert.ok(EFFORT_INFO[effort].label && EFFORT_INFO[effort].hint)
    }
    for (const other of ['', 'Max', 'minimal', 'none', null, 2]) assert.equal(isEffort(other), false)
  })

  it('set one role and keep the others; none hands the role back to its model', () => {
    const efforts = { main: 'high', reviewer: 'low' } as const
    assert.deepEqual(withEffort(efforts, 'main', 'max'), { main: 'max', reviewer: 'low' })
    assert.deepEqual(withEffort(efforts, 'explore', 'low'), { main: 'high', reviewer: 'low', explore: 'low' })
    assert.deepEqual(withEffort(efforts, 'main', null), { reviewer: 'low' })
    assert.deepEqual(withEffort({}, 'planner', null), {})
    assert.deepEqual(efforts, { main: 'high', reviewer: 'low' }, 'the list it was given is left as it was')
  })
})

describe('choosing the main model', () => {
  const s = settings({ profiles: [demo, router(), openai()], activeProfileId: 'demo', roles: { reviewer: ['oa:o3'] } })

  it('makes the first one\'s connection the active profile, and keeps the other roles', () => {
    assert.deepEqual(mainPatch(s, ['oa:gpt-4o', FREE_REF]), { roles: { reviewer: ['oa:o3'], main: ['oa:gpt-4o', FREE_REF] }, activeProfileId: 'oa' })
  })

  it('makes the free models\' connection active when they come first', () => {
    assert.equal(mainPatch(s, [FREE_REF]).activeProfileId, 'or')
  })

  it('hands the main role back to the demo, or to nothing', () => {
    const chosen = settings({ ...s, activeProfileId: 'oa', roles: { main: ['oa:gpt-4o'], reviewer: ['oa:o3'] } })
    assert.deepEqual(demoPatch(chosen), { roles: { reviewer: ['oa:o3'] }, activeProfileId: 'demo' })
    assert.deepEqual(mainPatch(chosen, []), { roles: { reviewer: ['oa:o3'] }, activeProfileId: 'oa' })
  })
})
