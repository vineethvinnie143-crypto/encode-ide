import { readFileSync } from 'node:fs'
import { orderTotal } from './src/discount.js'

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'))
const orders = JSON.parse(readFileSync(new URL('./orders.json', import.meta.url), 'utf8'))

for (const order of orders) {
  const { subtotal, rule, total } = orderTotal(order, rules)
  console.log(`${order.id}  subtotal ${subtotal.toFixed(2)}  ${rule ?? 'no discount'}  total ${total.toFixed(2)}`)
}
