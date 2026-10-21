/**
 * Message ports for the two ends of an Electron utility process, as the
 * protocol's Port. Both are written against the few members they use, so
 * they run (and are tested) without Electron.
 */
import type { Envelope, Port } from '@encode/protocol'

/** `process.parentPort` inside a utility process. */
export interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  off?(event: 'message', listener: (event: { data: unknown }) => void): unknown
  removeListener?(event: 'message', listener: (event: { data: unknown }) => void): unknown
}

/** The utility process as the main process holds it. */
export interface ChildLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  off?(event: string, listener: (...args: never[]) => void): unknown
  removeListener?(event: string, listener: (...args: never[]) => void): unknown
}

function remove(target: { off?: (event: never, listener: never) => unknown; removeListener?: (event: never, listener: never) => unknown }, event: string, listener: unknown): void {
  const detach = target.off ?? target.removeListener
  detach?.call(target, event as never, listener as never)
}

/** The host's end: messages from the main process arrive as `{ data }`. */
export function parentPortAsPort(parent: ParentPortLike): Port {
  return {
    post: (message: Envelope) => parent.postMessage(message),
    listen(handler) {
      const listener = (event: { data: unknown }) => handler(event.data)
      parent.on('message', listener)
      return () => remove(parent, 'message', listener)
    },
  }
}

/** The main process's end: the child's messages arrive as they were sent, and its exit is the port closing. */
export function childAsPort(child: ChildLike): Port {
  return {
    post: (message: Envelope) => child.postMessage(message),
    listen(handler) {
      const listener = (message: unknown) => handler(message)
      child.on('message', listener)
      return () => remove(child, 'message', listener)
    },
    onClose(handler) {
      const listener = () => handler()
      child.on('exit', listener)
      return () => remove(child, 'exit', listener)
    },
  }
}
