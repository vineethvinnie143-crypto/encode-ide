/**
 * True when motion should be cut: Settings > Appearance says Reduce, or says System and Windows is set to
 * show no animations. The stylesheet follows the same rule (theme/tokens.css); this is for the motion that
 * script starts, such as a smooth scroll.
 */
export function reducedMotion(): boolean {
  const motion = document.documentElement.dataset.motion
  if (motion === 'reduce') return true
  if (motion === 'full') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The scroll behaviour for a move you asked for: smooth, unless motion is cut. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? 'auto' : 'smooth'
}
