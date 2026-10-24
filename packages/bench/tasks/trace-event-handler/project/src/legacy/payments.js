// Kept for the old checkout, which nothing loads any more.
function onOrderPaid(event) {
  return { id: event.orderId, status: 'paid', legacy: true }
}

module.exports = { onOrderPaid, events: { 'order:paid': onOrderPaid } }
