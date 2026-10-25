import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)
const api = await load('src/index.js')
const money = await load('src/money.js')
const columns = await load('src/layout/columns.js')
const BEFORE = {"Invoices": {"render": "Design work   $1,504.61\nHosting          $51.90\nSupport plan  $1,099.19\n------------  ---------\nTotal         $2,655.70", "csv": "label,cents,amount\r\nDesign work,150461,\"$1,504.61\"\r\nHosting,5190,$51.90\r\nSupport plan,109919,\"$1,099.19\"\r\n"}, "Receipts": {"render": "Coffee     $1,504.61\nCroissant     $51.90\nGift card  $1,099.19\n---------  ---------\nTotal      $2,655.70", "csv": "label,cents,amount\r\nCoffee,150461,\"$1,504.61\"\r\nCroissant,5190,$51.90\r\nGift card,109919,\"$1,099.19\"\r\n"}, "Refunds": {"render": "Damaged item   $1,425.42\nLate delivery  $2,072.71\n-------------  ---------\nTotal          $3,498.13", "csv": "label,cents,amount\r\nDamaged item,142542,\"$1,425.42\"\r\nLate delivery,207271,\"$2,072.71\"\r\n"}, "Credits": {"render": "Referral  $1,425.42\nGoodwill  $2,072.71\nPromo     $1,020.00\n--------  ---------\nTotal     $4,518.13", "csv": "label,cents,amount\r\nReferral,142542,\"$1,425.42\"\r\nGoodwill,207271,\"$2,072.71\"\r\nPromo,102000,\"$1,020.00\"\r\n"}, "Fees": {"render": "Card fee    $1,187.85\nPayout fee  $1,835.14\nFX margin     $782.43\n----------  ---------\nTotal       $3,805.42", "csv": "label,cents,amount\r\nCard fee,118785,\"$1,187.85\"\r\nPayout fee,183514,\"$1,835.14\"\r\nFX margin,78243,$782.43\r\n"}, "Payouts": {"render": "Shop 14   $1,425.42\nShop 22   $2,072.71\nShop 31   $1,020.00\n--------  ---------\nTotal     $4,518.13", "csv": "label,cents,amount\r\nShop 14,142542,\"$1,425.42\"\r\nShop 22,207271,\"$2,072.71\"\r\nShop 31,102000,\"$1,020.00\"\r\n"}, "Tips": {"render": "Morning   $1,187.85\nEvening   $1,835.14\n--------  ---------\nTotal     $3,022.99", "csv": "label,cents,amount\r\nMorning,118785,\"$1,187.85\"\r\nEvening,183514,\"$1,835.14\"\r\n"}, "Payroll": {"render": "Ana       $1,425.42\nBo        $2,072.71\nChen      $1,020.00\nDee       $2,067.29\n--------  ---------\nTotal     $6,585.42", "csv": "label,cents,amount\r\nAna,142542,\"$1,425.42\"\r\nBo,207271,\"$2,072.71\"\r\nChen,102000,\"$1,020.00\"\r\nDee,206729,\"$2,067.29\"\r\n"}, "Statements": {"render": "Opening   $1,662.99\nSales      -$189.72\nFees      $1,257.57\n--------  ---------\nTotal     $2,730.84", "csv": "label,cents,amount\r\nOpening,166299,\"$1,662.99\"\r\nSales,'-18972,'-$189.72\r\nFees,125757,\"$1,257.57\"\r\n"}, "Taxes": {"render": "Standard  $1,267.04\nReduced   $2,314.33\nZero        $861.62\n--------  ---------\nTotal     $4,442.99", "csv": "label,cents,amount\r\nStandard,126704,\"$1,267.04\"\r\nReduced,231433,\"$2,314.33\"\r\nZero,86162,$861.62\r\n"}, "Ledger": {"render": "Cash         $1,346.23\nReceivables  $2,393.52\nPayables       $940.81\n-----------  ---------\nTotal        $4,680.56", "csv": "label,cents,amount\r\nCash,134623,\"$1,346.23\"\r\nReceivables,239352,\"$2,393.52\"\r\nPayables,94081,$940.81\r\n"}, "Budgets": {"render": "Design    $1,425.42\nPlatform  $2,072.71\nSales     $1,020.00\n--------  ---------\nTotal     $4,518.13", "csv": "label,cents,amount\r\nDesign,142542,\"$1,425.42\"\r\nPlatform,207271,\"$2,072.71\"\r\nSales,102000,\"$1,020.00\"\r\n"}, "Discounts": {"render": "Spring sale  $1,346.23\nBundle       $2,393.52\n-----------  ---------\nTotal        $3,739.75", "csv": "label,cents,amount\r\nSpring sale,134623,\"$1,346.23\"\r\nBundle,239352,\"$2,393.52\"\r\n"}, "Subscriptions": {"render": "Basic     $1,662.99\nPlus       -$189.72\nTeam      $1,257.57\n--------  ---------\nTotal     $2,730.84", "csv": "label,cents,amount\r\nBasic,166299,\"$1,662.99\"\r\nPlus,'-18972,'-$189.72\r\nTeam,125757,\"$1,257.57\"\r\n"}, "Shipping": {"render": "Post      $1,267.04\nCourier   $2,314.33\nFreight     $861.62\n--------  ---------\nTotal     $4,442.99", "csv": "label,cents,amount\r\nPost,126704,\"$1,267.04\"\r\nCourier,231433,\"$2,314.33\"\r\nFreight,86162,$861.62\r\n"}, "money": ["$1,234.56", "-$0.05", "€0.99", "$5.00 to $20.00"]}

test('the formatter goes by its new name, and the old one is gone', () => {
  assert.equal(typeof api.formatMoney, 'function')
  assert.equal(typeof money.formatMoney, 'function')
  assert.equal(api.formatCents, undefined)
  assert.equal(money.formatCents, undefined)
  assert.deepEqual([api.formatMoney(123456), api.formatMoney(-5), api.formatMoney(99, 'EUR'), api.formatRange(500, 2000)], BEFORE.money)
})

test('the look-alike that measures columns is still there', () => {
  assert.equal(typeof columns.formatCentsWidth, 'function')
  assert.equal(columns.formatCentsWidth(['a', 'a long label']), 12)
})

for (const name of Object.keys(BEFORE).filter((key) => key !== 'money')) {
  test(`${name} shows the same as before`, () => {
    const example = api[`EXAMPLE_${name.toUpperCase()}`]
    assert.equal(api[`render${name}`](example), BEFORE[name].render)
    assert.equal(api[`csv${name}`](example), BEFORE[name].csv)
  })
}
