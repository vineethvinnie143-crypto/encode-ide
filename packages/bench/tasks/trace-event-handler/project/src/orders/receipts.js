function sendReceipt(event) {
  return { to: event.email, subject: `Receipt for order ${event.orderId}` }
}

module.exports = { sendReceipt }
