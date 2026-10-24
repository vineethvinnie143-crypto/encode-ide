import { createServer } from 'node:http'
import { isActive, touch } from './sessions.js'

createServer((request, response) => {
  const id = request.headers.cookie?.match(/sid=(\w+)/)?.[1]
  if (!id || !isActive(id)) {
    response.writeHead(401).end()
    return
  }
  touch(id)
  response.end('ok')
}).listen(3000)
