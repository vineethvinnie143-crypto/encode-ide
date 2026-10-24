const { bus } = require('./lib/bus')
const { registerHandlers } = require('./events')

registerHandlers(bus)

module.exports = { bus }
