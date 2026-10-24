import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subtotal, total } from '../src/cart.js'

test('adds up the lines', () => {
  assert.equal(subtotal([{ price: 250, quantity: 2 }, { price: 100, quantity: 1 }]), 600)
})

test('takes the discount off before tax', () => {
  assert.equal(total([{ price: 1000, quantity: 2 }], { discountPercent: 10, taxPercent: 20 }), 2160)
})

test('without a discount or tax the total is the subtotal', () => {
  assert.equal(total([{ price: 999, quantity: 3 }]), 2997)
})
