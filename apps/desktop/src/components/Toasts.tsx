import { AlertTriangle, CheckCircle2, Info, X } from '../ui/icons'
import { useUi } from '../stores/ui'

export default function Toasts() {
  const toast = useUi((state) => state.toast)
  const dismiss = useUi((state) => state.dismissToast)
  if (!toast) return null

  const Icon = toast.kind === 'error' ? AlertTriangle : toast.kind === 'success' ? CheckCircle2 : Info

  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={16} />
      <span>{toast.text}</span>
      <button className="toast-close" onClick={dismiss} title="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}
