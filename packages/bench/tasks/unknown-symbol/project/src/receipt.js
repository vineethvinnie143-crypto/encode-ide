/** The receipt for an order, a line per item and the total. Prices are in cents. */
export function renderReceipt(order) {
  const lines = order.items.map((item) => `${item.name} x${item.quantity}  ${item.price * item.quantity}`)
  const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  return [...lines, `Total  ${total}`].join('\n')
}
