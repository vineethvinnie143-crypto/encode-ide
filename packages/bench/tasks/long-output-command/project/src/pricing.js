/** Prices are in cents. A discount is a percentage, never more than half the price. */
export const MAX_DISCOUNT_PERCENT = 50

export function applyDiscount(price, percent) {
  const capped = Math.min(Math.max(percent, 0), 75)
  return Math.round(price * (1 - capped / 100))
}

export function priceWithTax(price, taxPercent) {
  return Math.round(price * (1 + taxPercent / 100))
}
