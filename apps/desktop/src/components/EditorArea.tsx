import CodeEditor from './CodeEditor'
import EditorTabs from './EditorTabs'
import Welcome from './Welcome'
import { useEditor } from '../stores/editor'

export default function EditorArea() {
  const tabs = useEditor((state) => state.tabs)
  const activePath = useEditor((state) => state.activePath)
  const active = tabs.find((tab) => tab.path === activePath) ?? null

  return (
    <section className="editor-area">
      <EditorTabs />
      <div className="editor-host">
        <CodeEditor tab={active} />
        {!active && <Welcome />}
      </div>
    </section>
  )
}
