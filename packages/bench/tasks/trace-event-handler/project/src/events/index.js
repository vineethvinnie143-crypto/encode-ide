const { markPaid } = require('../orders/paid')
const { markShipped } = require('../orders/shipped')
const { sendReceipt } = require('../orders/receipts')

function registerHandlers(bus) {
  bus.on('order:paid', markPaid)
  bus.on('order:shipped', markShipped)
  bus.on('order:receipt', sendReceipt)
}

module.exports = { registerHandlers }
