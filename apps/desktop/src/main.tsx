import ReactDOM from 'react-dom/client'
import App from './App'
import { applyAppearance, initialAppearance } from './theme/appearance'
import './theme/fonts.css'
import './theme/tokens.css'
import './theme/editor-terminal.css'
import './styles/index.css'
import './ui/ui.css'

// Before the first render, so the first frame already has the user's theme.
applyAppearance(initialAppearance())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
