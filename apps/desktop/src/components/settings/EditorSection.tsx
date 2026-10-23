import { commandRegistry } from '../../commands/app'
import {
  WRAP_COLUMN_MAX,
  WRAP_COLUMN_MIN,
  clampWrapColumn,
  useEditorLayout,
  type EditorPart,
  type WhitespaceShown,
  type WrapAt,
} from '../../stores/editor-layout'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { Toggle } from '../../ui/Toggle'
import { CommitInput, SettingRow, SettingsGroup } from './Section'

const WRAP_AT = [
  { value: 'edge', label: 'Window edge' },
  { value: 'column', label: 'Column' },
  { value: 'bounded', label: 'Whichever is first' },
] as const satisfies readonly { value: WrapAt; label: string }[]

const WHITESPACE = [
  { value: 'none', label: 'None' },
  { value: 'boundary', label: 'In runs and at line edges' },
  { value: 'selection', label: 'In the selection' },
  { value: 'trailing', label: 'At line ends' },
  { value: 'all', label: 'All' },
] as const satisfies readonly { value: WhitespaceShown; label: string }[]

const WRAP_HELP: Record<WrapAt, string> = {
  edge: 'Rows end at the right edge of the editor, so nothing scrolls sideways.',
  column: 'Rows end at the column below, however wide the editor is.',
  bounded: 'Rows end at the column below, or sooner when the editor is narrower.',
}

const WHITESPACE_HELP: Record<WhitespaceShown, string> = {
  none: 'Spaces and tabs are never marked.',
  boundary: 'Marks the spaces at the start and end of a line, two or more in a row, and every tab.',
  selection: 'Marks the spaces and tabs in what you select.',
  trailing: 'Marks the spaces and tabs left at the end of a line.',
  all: 'Marks every space with a dot and every tab with a line.',
}

/** The parts of the editor turned on and off here as in the View menu, in the order they show there. */
const PARTS: readonly { part: EditorPart; label: string; help: string }[] = [
  { part: 'breadcrumbs', label: 'Breadcrumbs', help: 'The path to the file and the symbols the cursor is in, above the text.' },
  { part: 'folding', label: 'Folding', help: 'Blocks fold away from chevrons in the gutter.' },
  { part: 'stickyScroll', label: 'Sticky scroll', help: 'The first lines of the blocks you are in stay at the top as you scroll.' },
  { part: 'bracketColors', label: 'Bracket colours', help: 'Brackets are coloured by how deep they nest.' },
  { part: 'minimap', label: 'Minimap', help: 'A small picture of the file beside the text.' },
  { part: 'inlayHints', label: 'Inlay hints', help: 'Types and parameter names from the language server, among the text.' },
  { part: 'semanticHighlighting', label: 'Semantic colours', help: 'Names coloured as the language server knows them.' },
]

/** Settings > Editor: wrapping, spaces and tabs, and the parts around the text. Kept on this computer as they change. */
export function EditorSection() {
  const layout = useEditorLayout()
  const toggleKeys = commandRegistry.shortcut('view.wordWrap')
  return (
    <>
      <SettingsGroup title="Long lines">
        <SettingRow
          id="editor.wordWrap"
          htmlFor="word-wrap"
          label="Word wrap"
          help={`Long lines wrap onto rows below instead of running off to the right.${toggleKeys ? ` ${toggleKeys} turns it on and off.` : ''}`}
        >
          <Toggle id="word-wrap" checked={layout.wordWrap} onChange={(wordWrap) => layout.set({ wordWrap })} />
        </SettingRow>
        <SettingRow id="editor.wrapAt" label="Wrap at" help={WRAP_HELP[layout.wrapAt]}>
          <Segmented label="Wrap at" value={layout.wrapAt} options={WRAP_AT} onChange={(wrapAt) => layout.set({ wrapAt })} />
        </SettingRow>
        <SettingRow id="editor.wrapColumn" htmlFor="wrap-column" label="Wrap column" help={`Characters in a row, ${WRAP_COLUMN_MIN} to ${WRAP_COLUMN_MAX}; a tab counts as its width.`}>
          <CommitInput
            id="wrap-column"
            className="narrow"
            type="number"
            min={WRAP_COLUMN_MIN}
            max={WRAP_COLUMN_MAX}
            disabled={layout.wrapAt === 'edge'}
            value={String(layout.wrapColumn)}
            onCommit={(text) => {
              const column = Number(text)
              if (text.trim() && Number.isFinite(column)) layout.set({ wrapColumn: clampWrapColumn(column) })
            }}
          />
        </SettingRow>
        <SettingRow id="editor.wrapIndent" htmlFor="wrap-indent" label="Indent wrapped rows" help="Rows after a line's first start as far in as the line does.">
          <Toggle id="wrap-indent" checked={layout.wrapIndent} onChange={(wrapIndent) => layout.set({ wrapIndent })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Spaces and tabs">
        <SettingRow
          id="editor.whitespace"
          htmlFor="whitespace-shown"
          label="Show spaces and tabs"
          help={layout.showWhitespace ? 'Show whitespace in the View menu is on, so every space and tab is marked until you turn it off.' : WHITESPACE_HELP[layout.whitespace]}
        >
          <Select id="whitespace-shown" value={layout.whitespace} options={WHITESPACE} onChange={(whitespace) => layout.set({ whitespace })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Around the text">
        {PARTS.map(({ part, label, help }) => (
          <SettingRow key={part} id={`editor.${part}`} htmlFor={`editor-${part}`} label={label} help={help}>
            <Toggle id={`editor-${part}`} checked={layout[part]} onChange={(on) => layout.set({ [part]: on })} />
          </SettingRow>
        ))}
      </SettingsGroup>
    </>
  )
}
