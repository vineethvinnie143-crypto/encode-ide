/**
 * Makes the children of `container` the elements of `next`, one HTML element per entry, redrawing only
 * those that differ from `previous` (what the container was last made to show). The elements that stay are
 * not touched, so a text selection inside them, a scrolled code block and the hover under the pointer
 * survive while an answer streams in after them.
 */
export function patchBlocks(container: HTMLElement, previous: readonly string[], next: readonly string[]): void {
  const template = document.createElement('template')
  for (let index = 0; index < next.length; index++) {
    const current = container.children[index]
    if (current && previous[index] === next[index]) continue
    template.innerHTML = next[index]
    const element = template.content.firstElementChild
    if (!element) continue
    if (current) current.replaceWith(element)
    else container.append(element)
  }
  while (container.children.length > next.length) container.lastElementChild?.remove()
}
