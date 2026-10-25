// Column layout for the text reports. Nothing here formats money: it only measures the cells it is given.

/** How wide the label column of a money table must be: its longest label, and never under 8 characters. */
export function formatCentsWidth(labels) {
  return Math.max(8, ...labels.map((label) => String(label).length))
}

/** Pads every cell of a row to the widths given, the first column on the left and the rest on the right. */
export function padRow(cells, widths) {
  return cells.map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join('  ')
}
