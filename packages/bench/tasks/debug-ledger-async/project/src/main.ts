import { readFileSync } from 'node:fs'
import { Ledger, type Entry } from './ledger.ts'

const entries: Entry[] = JSON.parse(readFileSync(new URL('../entries.json', import.meta.url), 'utf8'))
const ledger = new Ledger()
await ledger.applyAll(entries)
for (const account of new Set(entries.map((entry) => entry.account))) console.log(`${account} ${ledger.balance(account)}`)
