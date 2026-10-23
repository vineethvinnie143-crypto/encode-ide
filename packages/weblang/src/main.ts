/** The server's entry, as eNCode's desktop build bundles it (`weblang-server.cjs`). */
import { startServer } from './server'

startServer(process.stdin, process.stdout, (code) => process.exit(code))
