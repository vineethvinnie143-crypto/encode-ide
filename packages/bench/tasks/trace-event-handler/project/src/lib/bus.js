const { EventEmitter } = require('node:events')

const bus = new EventEmitter()

module.exports = { bus }
