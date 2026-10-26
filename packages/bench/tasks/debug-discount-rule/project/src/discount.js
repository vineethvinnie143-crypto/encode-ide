// Discounts: an order gets the single best rule it qualifies for.

export function bestDiscount(rules, subtotal) {
  let best = null
  for (const rule of rules) {
    if (subtotal < rule.minTotal) continue
    if (!best || rule.percent > best.percent) best = rule
  }
  return best
}

export function orderTotal(order, rules) {
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const rule = bestDiscount(rules, subtotal)
  const total = rule ? subtotal * (1 - rule.percent / 100) : subtotal
  return { subtotal, rule: rule ? rule.name : null, total: Math.round(total * 100) / 100 }
}
