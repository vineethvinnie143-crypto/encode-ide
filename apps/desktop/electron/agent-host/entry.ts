/**
 * The utility process: the agent host behind the main process's message port.
 * Bundled on its own (dist/electron/agent-host.cjs).
 */
import { parentPortAsPort, type ParentPortLike } from './ports'
import { runHostRuntime } from './runtime'

const parent = (process as unknown as { parentPort?: ParentPortLike }).parentPort
if (!parent) throw new Error('The agent host must run as an Electron utility process.')

process.on('unhandledRejection', (reason) => {
  console.error('[agent-host] unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
})
process.on('uncaughtException', (error) => {
  console.error('[agent-host] uncaught exception:', error.stack ?? error.message)
  // The main process restarts the host; state that can be saved already is, in the session logs.
  process.exit(1)
})

runHostRuntime(parentPortAsPort(parent), { onShutdown: () => process.exit(0) })
