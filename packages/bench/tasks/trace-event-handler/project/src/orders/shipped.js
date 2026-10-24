const { orders } = require('./paid')

function markShipped(event) {
  const order = orders.get(event.orderId)
  if (!order || order.status !== 'paid') return null
  order.status = 'shipped'
  return order
}

module.exports = { markShipped }
