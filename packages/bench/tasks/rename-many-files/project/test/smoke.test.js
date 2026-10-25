import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXAMPLE_INVOICES, renderInvoices, totalInvoices } from '../src/index.js'

test('an invoice ends with its total', () => {
  const lines = renderInvoices(EXAMPLE_INVOICES).split('\n')
  assert.equal(lines.length, EXAMPLE_INVOICES.length + 2)
  assert.match(lines.at(-1), /^Total\s+\$[\d,]+\.\d\d$/)
  assert.equal(typeof totalInvoices(EXAMPLE_INVOICES), 'number')
})
