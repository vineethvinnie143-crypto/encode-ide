import { useEffect, useState } from 'react'
import { useUi } from '../stores/ui'
import { Toast } from '../ui/Toast'

/** The current notice, bottom right. It closes after 5 s, and waits while the pointer is on it. */
export default function Toasts() {
  const toast = useUi((state) => state.toast)
  const dismiss = useUi((state) => state.dismissToast)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (!toast || hovered) return
    const timer = window.setTimeout(dismiss, 5000)
    return () => window.clearTimeout(timer)
  }, [toast, hovered, dismiss])

  useEffect(() => setHovered(false), [toast?.id])

  if (!toast) return null
  return (
    <Toast
      key={toast.id}
      kind={toast.kind}
      onDismiss={dismiss}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {toast.text}
    </Toast>
  )
}
