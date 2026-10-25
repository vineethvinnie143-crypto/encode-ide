// The nightly import: reads the bank's export and books each record, printing one line per record.
import { readFileSync } from 'node:fs'
import { parseAmount } from '../src/amount.js'

const rows = readFileSync(new URL('../data/records.csv', import.meta.url), 'utf8').trim().split('\n').slice(1)
let imported = 0
let total = 0
for (const [index, row] of rows.entries()) {
  const [id, date, customer, amount, currency] = row.split(';')
  const cents = parseAmount(amount)
  if (cents === undefined) {
    console.log(`row ${index + 2}: skipped ${id}, could not read the amount "${amount}"`)
    continue
  }
  imported += 1
  total += cents
  console.log(`row ${index + 2}: booked ${id} ${date} ${customer.padEnd(14)} ${amount.padStart(9)} ${currency}`)
}
const skipped = rows.length - imported
console.log(`${imported} of ${rows.length} records booked, ${skipped} skipped. Total booked: ${(total / 100).toFixed(2)} USD`)
if (skipped) console.log('The books do not balance until every record is booked.')
process.exitCode = skipped ? 1 : 0
