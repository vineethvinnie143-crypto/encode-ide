// Sales by region: node summary.js <file.csv>
import { readFileSync } from 'node:fs'
import { readCsv } from './src/csv.js'

const REGIONS = ['north', 'south', 'east', 'west']
const file = process.argv[2] ?? 'sales.csv'
const records = readCsv(readFileSync(file, 'utf8'))
const cents = Object.fromEntries(REGIONS.map((region) => [region, 0]))
for (const record of records) {
  if (record.region in cents) cents[record.region] += Math.round(Number(record.amount) * 100)
}
console.log(`${records.length} records`)
for (const region of REGIONS) console.log(`${region} ${(cents[region] / 100).toFixed(2)}`)
