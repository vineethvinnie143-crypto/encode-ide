/** Wires the command palette into the composer and adds its styles. */
import fs from 'node:fs'

const composer = 'src/components/Chat/Composer.tsx'
const styles = 'src/styles.css'

const edits = [
  [composer, "import { useChat } from '../../stores/chat'",
    "import { useChat } from '../../stores/chat'\nimport CommandPalette from '../CommandPalette'\nimport type { CommandPaletteAction } from '../CommandPalette'"],
  [composer, "  const [policyOpen, setPolicyOpen] = useState(false)",
    "  const [policyOpen, setPolicyOpen] = useState(false)\n  const [paletteOpen, setPaletteOpen] = useState(false)"],
  [composer, "  const notify = useUi((state) => state.notify)",
    "  const notify = useUi((state) => state.notify)\n  const askText = useUi((state) => state.askText)"],
  [composer, `          <button className="composer-plus" onClick={() => void attachActiveFile()} title="Attach active file">
            <Plus size={15} />
          </button>`,
    `          <button className="composer-plus" onClick={() => setPaletteOpen(true)} title="Commands (/)">
            <Plus size={15} />
          </button>`],
  [composer, "          onChange={(event) => setDraft(event.target.value)}",
    `          onChange={(event) => {
            const value = event.target.value
            if (value === '/') {
              setPaletteOpen(true)
              setDraft('')
              return
            }
            setDraft(value)
          }}`],
  [composer, "  const placeholder = !workspace",
    `  const runPaletteAction = async (action: CommandPaletteAction) => {
    setPaletteOpen(false)
    const sessionId = useSessions.getState().activeId
    switch (action) {
      case 'file':
        await attachActiveFile()
        break
      case 'goal': {
        const current = useChat.getState().goal
        const text = await askText(current ? 'Goal' : 'Set a goal', 'Goal', current?.text ?? '')
        if (text && sessionId) {
          void api.agent.setGoal(sessionId, {
            text,
            status: 'active',
            rounds: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        }
        break
      }
      case 'plan':
        void save({ agentMode: (settings?.agentMode ?? 'code') === 'plan' ? 'code' : 'plan' })
        break
      case 'feedback': {
        const text = await askText('Feedback', 'What went well or badly?')
        if (text) {
          await api.app.feedback(text)
          notify('success', 'Feedback recorded')
        }
        break
      }
      case 'compact': {
        const result = await api.agent.compact(sessionId)
        notify('success', result.removed ? \`Compacted \${result.removed} messages\` : 'Nothing to compact')
        break
      }
      case 'permission':
        setPolicyOpen(true)
        break
      case 'model':
        setSettingsOpen(true)
        break
      case 'export': {
        const file = await api.agent.export(sessionId)
        if (file) notify('success', \`Exported to \${file}\`)
        break
      }
    }
  }

  const placeholder = !workspace`],
  [composer, "      <div className=\"composer-stats\">",
    `      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onAction={(action) => void runPaletteAction(action)} />
      )}

      <div className="composer-stats">`],
  [styles, '/* Policy menu',
    `/* Command palette */
.command-palette { width: min(680px, 92vw); background: #17171b; border: 1px solid var(--border-strong); border-radius: 12px; overflow: hidden; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55); }
.command-input { width: 100%; height: 44px; padding: 0 14px; background: #101014; border: 0; border-bottom: 1px solid var(--border); color: var(--text); font-size: 14px; outline: none; }
.command-list { max-height: 60vh; overflow: auto; padding: 6px; }
.command-group-title { padding: 8px 10px 4px; font-size: 11px; color: var(--text-muted); }
.command-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 8px; text-align: left; color: var(--text-dim); }
.command-item:hover { background: #1d1d22; color: var(--text); }
.command-label { font-size: 13px; font-weight: 500; color: var(--text); }
.command-detail { margin-left: auto; font-size: 11.5px; color: var(--text-muted); }

/* Policy menu`],
]

let changed = 0
for (const [file, from, to] of edits) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) {
    console.log(`MISS ${file}: ${from.slice(0, 60).replace(/\n/g, '\\n')}`)
    continue
  }
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  changed += 1
}
console.log(`applied ${changed}/${edits.length}`)
