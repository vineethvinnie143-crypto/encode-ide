// The site's menu: pages nested under their parents.

export function buildMenu(pages) {
  const byId = new Map()
  const roots = []
  for (const page of pages) {
    const node = { id: page.id, title: page.title, children: [] }
    byId.set(page.id, node)
    if (page.parent === null) roots.push(node)
    else byId.get(page.parent).children.push(node)
  }
  return roots
}

export function renderMenu(nodes, depth = 0) {
  return nodes.flatMap((node) => [`${'  '.repeat(depth)}- ${node.title}`, ...renderMenu(node.children, depth + 1)])
}
