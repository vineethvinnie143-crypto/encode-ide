/** A shopping cart: lines with a price in cents and a quantity, an optional discount, then tax. */

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0)
}

/**
 * The amount to charge, in cents. The discount comes off before tax; both are percentages.
 */
export function total(lines, { discountPercent = 0, taxPercent = 0 } = {}) {
  const discounted = subtotal(lines) * (1 - discountPercent)
  return Math.round(discounted * (1 + taxPercent / 100))
}
