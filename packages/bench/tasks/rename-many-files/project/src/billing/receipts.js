// Receipts: what a customer paid at the till. Amounts are whole cents throughout; they are formatted only where a person reads them.
import { formatCents } from '../money.js'

/** The receipts as they come from the database: a label and an amount in cents, which may be negative. */
export const EXAMPLE_RECEIPTS = Object.freeze([{"label": "Coffee", "cents": 150461}, {"label": "Croissant", "cents": 5190}, {"label": "Gift card", "cents": 109919}])

/** Sums the amounts, in cents. Fractions of a cent, which old imports have, are rounded first. */
export function totalReceipts(items) {
  return items.reduce((sum, item) => sum + Math.round(item.cents), 0)
}

/** One line per item, the amounts lined up on the right, then the total. */
export function renderReceipts(items) {
  const width = Math.max(8, ...items.map((item) => item.label.length))
  const amounts = items.map((item) => formatCents(item.cents))
  const total = formatCents(totalReceipts(items))
  const right = Math.max(total.length, ...amounts.map((amount) => amount.length))
  const lines = items.map((item, i) => `${item.label.padEnd(width)}  ${amounts[i].padStart(right)}`)
  lines.push(`${'-'.repeat(width)}  ${'-'.repeat(right)}`)
  lines.push(`${'Total'.padEnd(width)}  ${total.padStart(right)}`)
  return lines.join('\n')
}

/** The largest item, for the heading of the e-mail that sends receipts out. */
export function headlineReceipts(items) {
  if (!items.length) return 'Nothing to show'
  const largest = items.reduce((best, item) => (Math.abs(item.cents) > Math.abs(best.cents) ? item : best))
  return `${items.length} item${items.length === 1 ? '' : 's'}, largest ${largest.label} at ${formatCents(largest.cents)}`
}

/**
 * The receipts as CSV for the accountants' spreadsheet: label, cents, and the formatted amount. Labels are quoted when they
 * hold a comma or a quote, as RFC 4180 says, and a label that starts with = + - or @ gets a leading quote so a
 * spreadsheet does not run it as a formula.
 */
export function csvReceipts(items) {
  const cell = (text) => {
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const rows = [['label', 'cents', 'amount'], ...items.map((item) => [item.label, String(Math.round(item.cents)), formatCents(item.cents)])]
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** Splits the receipts into what came in and what went out, each with its total, for the two-column view. */
export function splitReceipts(items) {
  const incoming = items.filter((item) => item.cents >= 0)
  const outgoing = items.filter((item) => item.cents < 0)
  return {
    incoming: { items: incoming, total: formatCents(totalReceipts(incoming)) },
    outgoing: { items: outgoing, total: formatCents(totalReceipts(outgoing)) },
  }
}

/**
 * Checks the receipts before they are shown: every item needs a label of 1 to 60 characters and a finite amount, and no
 * two items may share a label. Returns the problems as text, in order; none means the list can be shown.
 */
export function checkReceipts(items) {
  const problems = []
  const seen = new Set()
  for (const [index, item] of items.entries()) {
    if (typeof item.label !== 'string' || !item.label.trim()) problems.push(`item ${index + 1} has no label`)
    else if (item.label.length > 60) problems.push(`item ${index + 1}'s label is longer than 60 characters`)
    else if (seen.has(item.label)) problems.push(`"${item.label}" appears twice`)
    else seen.add(item.label)
    if (!Number.isFinite(item.cents)) problems.push(`item ${index + 1} has no amount`)
  }
  return problems
}

/** Groups the receipts by the first word of their label, with a total for each group, largest group first. */
export function groupReceipts(items) {
  const groups = new Map()
  for (const item of items) {
    const key = item.label.split(/\s+/)[0] || item.label
    const group = groups.get(key) ?? { key, items: [], cents: 0 }
    group.items.push(item)
    group.cents += Math.round(item.cents)
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.key.localeCompare(b.key))
    .map((group) => ({ key: group.key, count: group.items.length, total: formatCents(group.cents) }))
}
