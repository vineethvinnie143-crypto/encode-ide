import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EditorAction } from '@shared/types'
import { actionSections } from './actions'

describe('the action menu', () => {
  it('puts the actions in their sections, the preferred ones first, the rest in the order the server gave', () => {
    const actions: EditorAction[] = [
      { id: 0, title: 'Extract to function', kind: 'refactor.extract' },
      { id: 1, title: 'Add missing import', kind: 'quickfix' },
      { id: 2, title: "Change spelling to 'count'", kind: 'quickfix', preferred: true },
      { id: 3, title: 'Organize imports', kind: 'source.organizeImports' },
      { id: 4, title: 'Something of its own' },
      { id: 5, title: 'Ignore this rule', kind: 'quickfix.ignore' },
      { id: 6, title: 'Refactoring', kind: 'refactoring' },
    ]
    assert.deepEqual(
      actionSections(actions).map((section) => [section.label, section.actions.map((action) => action.id)]),
      [
        ['Quick fixes', [2, 1, 5]],
        ['Refactor', [0]],
        ['Source', [3]],
        ['More', [4, 6]],
      ],
    )
    assert.deepEqual(actionSections([]), [])
  })
})
