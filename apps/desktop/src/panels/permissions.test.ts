import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PermissionRuleView, PermissionsReport } from '@shared/types'
import { DEFAULT_ALWAYS_SCOPE, SCOPE_CHOICES, alwaysRulesText, bannerOf, groupRules, removable, ruleTiming, scopeNote, shortPath, trustOffer, trustState } from './permissions'

const report = (patch: Partial<PermissionsReport> = {}): PermissionsReport => ({
  root: '/code/app',
  trusted: true,
  trustWarning: null,
  configApproved: true,
  heldBack: [],
  waiting: [],
  problems: [],
  broken: null,
  rules: [],
  additionalDirectories: [],
  envNames: [],
  files: { user: '/home/u/.encode/settings.json', project: '/code/app/.encode/settings.json', local: '/code/app/.encode/settings.local.json' },
  ...patch,
})

const rule = (behavior: PermissionRuleView['behavior'], text: string, scope: PermissionRuleView['scope'] = 'user'): PermissionRuleView => ({ behavior, text, scope, active: true })

describe('the rules on the Permissions screen', () => {
  it('are grouped with what protects first, and a kind with no rules is left out', () => {
    const groups = groupRules([rule('allow', 'Bash(ls:*)'), rule('deny', 'Read(./.env)'), rule('allow', 'Bash(git status:*)'), rule('ask', 'Bash(git push:*)')])
    assert.deepEqual(groups.map((group) => [group.behavior, group.rules.map((item) => item.text)]), [
      ['deny', ['Read(./.env)']],
      ['ask', ['Bash(git push:*)']],
      ['allow', ['Bash(ls:*)', 'Bash(git status:*)']],
    ])
    assert.deepEqual(groupRules([rule('allow', 'Bash(ls:*)')]).map((group) => group.behavior), ['allow'])
    assert.deepEqual(groupRules([]), [])
  })

  it('can be removed unless they come from the command line', () => {
    assert.equal(removable(rule('deny', 'Read(./a)', 'local')), true)
    assert.equal(removable(rule('deny', 'Read(./a)', 'cli')), false)
  })
})

describe('where a rule is saved', () => {
  it('starts with the narrowest choice, the one only the person sees', () => {
    assert.equal(SCOPE_CHOICES[0].value, DEFAULT_ALWAYS_SCOPE)
    assert.equal(DEFAULT_ALWAYS_SCOPE, 'local')
    assert.deepEqual(SCOPE_CHOICES.map((choice) => choice.value), ['local', 'project', 'user'])
  })

  it('says what each choice means for who sees it and when it applies', () => {
    assert.match(scopeNote('local'), /ignore that file.*applies at once/)
    assert.match(scopeNote('project'), /shared with everyone.*applies at once/)
    assert.match(scopeNote('user'), /every project, at once/)
    assert.match(scopeNote('local', 'after-trust'), /not trusted yet.*once it is/)
    assert.match(scopeNote('project', 'after-review'), /changed since you approved.*review them/)
    assert.doesNotMatch(scopeNote('user', 'after-trust'), /trusted/)
  })

  it('applies at once in the user\'s settings, and in a folder only once it is trusted and its settings approved', () => {
    assert.equal(ruleTiming(report(), 'local'), 'now')
    assert.equal(ruleTiming(report({ trusted: false }), 'user'), 'now')
    assert.equal(ruleTiming(report({ trusted: false }), 'local'), 'after-trust')
    assert.equal(ruleTiming(report({ trusted: false }), 'project'), 'after-trust')
    assert.equal(ruleTiming(report({ configApproved: false }), 'local'), 'after-review')
    assert.equal(ruleTiming(null, 'local'), 'now')
  })

  it('offers to trust the folder with the rule, unless its own settings are unread or it is the home folder', () => {
    assert.equal(trustOffer(report(), 'local'), null)
    assert.equal(trustOffer(report({ trusted: false }), 'user'), null)
    assert.deepEqual(trustOffer(report({ trusted: false }), 'local'), { kind: 'offer', checked: true, note: 'The folder has no settings of its own that grant anything.' })
    const waiting = trustOffer(report({ trusted: false, heldBack: ['p: env'] }), 'project')
    assert.equal(waiting?.kind, 'offer')
    assert.equal(waiting?.kind === 'offer' && waiting.checked, false)
    const home = trustOffer(report({ trusted: false, trustWarning: 'This is your home folder: trusting it trusts every file in it.' }), 'local')
    assert.equal(home?.kind, 'warn')
    assert.match(home?.note ?? '', /home folder.*Settings, Permissions/)
  })

  it('shows the rules as they will be written', () => {
    assert.equal(alwaysRulesText(['Bash(npm run build:*)', 'Bash(npm run test:*)']), 'Bash(npm run build:*)\nBash(npm run test:*)')
  })
})

describe('where the open folder stands', () => {
  it('is broken first: nothing else matters while nothing runs', () => {
    assert.equal(trustState(report({ broken: 'cannot tell', trusted: false })), 'broken')
    assert.equal(bannerOf(report({ broken: 'cannot tell' }))?.tone, 'danger')
  })

  it('tells a folder that waits to be trusted from one that asks for nothing', () => {
    assert.equal(trustState(report({ trusted: false })), 'untrusted')
    assert.equal(trustState(report({ trusted: false, heldBack: ['p: env'] })), 'untrusted-waiting')
    assert.equal(bannerOf(report({ trusted: false })), null)
    assert.match(bannerOf(report({ trusted: false, heldBack: ['p: env'] }))?.text ?? '', /waiting for your review/)
  })

  it('notices settings that changed since they were approved', () => {
    assert.equal(trustState(report({ configApproved: false })), 'changed')
    assert.match(bannerOf(report({ configApproved: false }))?.text ?? '', /changed since you approved/)
    assert.equal(bannerOf(report()), null)
    assert.equal(bannerOf(null), null)
  })
})

describe('a path in a line of text', () => {
  it('is cut at the front, so the file name stays', () => {
    assert.equal(shortPath('/a/b.json'), '/a/b.json')
    const long = `/very/${'long/'.repeat(30)}settings.json`
    const short = shortPath(long, 40)
    assert.equal(short.length, 40)
    assert.ok(short.startsWith('…') && short.endsWith('settings.json'))
  })
})
