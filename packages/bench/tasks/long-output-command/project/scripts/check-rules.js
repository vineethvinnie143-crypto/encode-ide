// Checks the pricing rules on a few thousand cases and prints one line for each.
import { applyDiscount, priceWithTax } from '../src/pricing.js'

let failed = 0
let n = 0
for (let price = 100; price <= 2000; price += 100) {
  for (let percent = -10; percent <= 100; percent += 1) {
    n++
    const capped = Math.min(Math.max(percent, 0), 50)
    const want = Math.round(price * (1 - capped / 100))
    const got = applyDiscount(price, percent)
    if (got === want) console.log(`ok ${n} applyDiscount(${price}, ${percent}) = ${got}`)
    else {
      failed++
      console.log(`FAIL ${n} applyDiscount(${price}, ${percent}): expected ${want}, got ${got}`)
    }
  }
  for (const tax of [0, 5, 20]) {
    n++
    const want = Math.round(price * (1 + tax / 100))
    const got = priceWithTax(price, tax)
    console.log(`${got === want ? 'ok' : 'FAIL'} ${n} priceWithTax(${price}, ${tax}) = ${got}`)
    if (got !== want) failed++
  }
}
console.log(`${n - failed} of ${n} cases passed`)
process.exitCode = failed ? 1 : 0
