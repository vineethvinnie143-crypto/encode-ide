/**
 * The parts of the editor the app draws (ADR 0088): the pane that shows the file of the active tab, the bars and lists
 * around it, the editor's dialogs and settings, a symbol's icon, and the stylesheet whose token classes the Review
 * tab's lines are drawn with too. With surface.ts, this is all the app takes from the editor; a module that only
 * needs the editor's logic imports surface.ts, which loads in plain Node for tests.
 */
import '@encode/editor-view/style.css'

/** The editor pane, showing the active tab's file (`tab` null: nothing open). */
export { default as CodeEditor } from '../components/CodeEditor'
/** The path of symbols at the cursor above the pane, and the file's outline beside it. */
export { Breadcrumbs } from '../components/code/Breadcrumbs'
export { OutlinePane } from '../components/code/OutlinePane'
/** The problems the language servers found in the folder, as a list. */
export { ProblemsPane } from '../components/code/ProblemsPane'
/** Settings > Language servers. */
export { default as LanguageServersSection } from '../components/code/LanguageServersSection'
export { EditorIssueDialog } from '../components/code/EditorIssueDialog'
export { InstallServerDialog } from '../components/code/InstallServerDialog'
export { SymbolIcon } from '../components/code/SymbolIcon'
