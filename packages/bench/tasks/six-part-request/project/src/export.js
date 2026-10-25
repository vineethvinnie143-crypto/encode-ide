// The stock as CSV, for the warehouse's spreadsheet.

/** One row per item: SKU, name, units on hand, price in cents. */
export function exportCsv(items) {
  return items.map((item) => [item.sku, item.name, item.onHand, item.price].join(',')).join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------------------------------
// The rest of this module is what the export service keeps for operators: a short history, sanity checks run at
// start, and the lines the operators' console prints. Nothing below changes what the functions above return.
// ---------------------------------------------------------------------------------------------------------------------

/** How many export events the console keeps before the oldest goes. */
export const EXPORT_HISTORY = 200

/** One export event as the console keeps it. */
export class ExportEvent {
  constructor(at, sku, detail) {
    this.at = at
    this.sku = String(sku)
    this.detail = String(detail ?? '').slice(0, 160)
  }

  toLine() {
    return `${new Date(this.at).toISOString().slice(0, 19).replace('T', ' ')} export ${this.sku} ${this.detail}`.trimEnd()
  }

  toJSON() {
    return { at: this.at, sku: this.sku, detail: this.detail }
  }
}

/** The last EXPORT_HISTORY export events, oldest first. Pushing past the size drops the oldest. */
export class ExportHistory {
  constructor(size = EXPORT_HISTORY) {
    this.size = Math.max(1, Math.floor(size))
    this.events = []
  }

  push(event) {
    this.events.push(event)
    if (this.events.length > this.size) this.events.splice(0, this.events.length - this.size)
    return this
  }

  /** The newest `limit` events, newest last. */
  recent(limit = 20) {
    return this.events.slice(-Math.max(0, limit))
  }

  /** Every event for one SKU, oldest first. */
  forSku(sku) {
    return this.events.filter((event) => event.sku === sku)
  }

  /** How many events each SKU has, most first; ties by SKU. */
  busiest(limit = 5) {
    const counts = new Map()
    for (const event of this.events) counts.set(event.sku, (counts.get(event.sku) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([sku, count]) => ({ sku, count }))
  }

  clear() {
    this.events = []
  }
}

/**
 * Checks a list of items before the export service starts on it: every item needs a SKU of 2 to 16 letters, digits
 * or dashes, a name, a whole number on hand that is not negative, a price in whole cents and a daily use that is not
 * negative. Returns the problems as text, in order; none means the list is usable.
 */
export function checkExportItems(items) {
  const problems = []
  const seen = new Set()
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    const at = `item ${index + 1}`
    if (typeof item?.sku !== 'string' || !/^[A-Za-z0-9-]{2,16}$/.test(item.sku)) problems.push(`${at} has no usable SKU`)
    else if (seen.has(item.sku)) problems.push(`${at} repeats SKU ${item.sku}`)
    else seen.add(item.sku)
    if (typeof item?.name !== 'string' || !item.name.trim()) problems.push(`${at} has no name`)
    if (!Number.isInteger(item?.onHand) || item.onHand < 0) problems.push(`${at} has no usable count on hand`)
    if (!Number.isInteger(item?.price) || item.price < 0) problems.push(`${at} has no price in whole cents`)
    if (item?.dailyUse !== undefined && !(Number(item.dailyUse) >= 0)) problems.push(`${at} has a negative daily use`)
  }
  return problems
}

/** The console's heading for the export service: how many items, how many with nothing on hand, the busiest SKUs. */
export function exportHeading(items, history) {
  const list = Array.isArray(items) ? items : []
  const empty = list.filter((item) => item.onHand === 0).length
  const parts = [`${list.length} item${list.length === 1 ? '' : 's'}`]
  if (empty) parts.push(`${empty} with none on hand`)
  const busy = history ? history.busiest(3) : []
  if (busy.length) parts.push(`busiest: ${busy.map((entry) => `${entry.sku} (${entry.count})`).join(', ')}`)
  return parts.join(', ')
}

/**
 * Groups items by the letters their SKU starts with ("BLT-01" and "BLT-07" are both BLT), with a count and the units
 * on hand for each group, largest group first. Operators use it to see which product line runs low.
 */
export function groupExportByLine(items) {
  const groups = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const line = (/^[A-Za-z]+/.exec(item.sku) ?? [item.sku])[0].toUpperCase()
    const group = groups.get(line) ?? { line, count: 0, onHand: 0 }
    group.count += 1
    group.onHand += item.onHand
    groups.set(line, group)
  }
  return [...groups.values()].sort((a, b) => b.onHand - a.onHand || a.line.localeCompare(b.line))
}

/** Parses a SKU list typed into the console ("BLT-01, nut-3  WSH-9") into SKUs, upper case, each once. */
export function parseExportSkus(text) {
  const out = []
  for (const word of String(text ?? '').split(/[\s,;]+/)) {
    const sku = word.trim().toUpperCase()
    if (sku && /^[A-Z0-9-]{2,16}$/.test(sku) && !out.includes(sku)) out.push(sku)
  }
  return out
}
