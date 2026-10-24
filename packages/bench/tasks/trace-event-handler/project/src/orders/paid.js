const orders = new Map()

function markPaid(event) {
  const order = orders.get(event.orderId) ?? { id: event.orderId }
  order.status = 'paid'
  order.paidAt = event.at
  orders.set(order.id, order)
  return order
}

module.exports = { markPaid, orders }
