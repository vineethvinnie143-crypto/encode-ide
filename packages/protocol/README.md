# @encode/protocol

eNCode's wire protocol between the agent host and its clients, and the JSON Schema checks that
tool inputs and protocol messages share. It has no dependencies and no Electron, DOM or Node
imports beyond types, so it runs in the app's main process, a utility process, the command line
and the tests alike.

## RPC

`Peer<Local, Remote>` runs requests, events and cancellation over any `Port`:

```ts
type Port = {
  post(message: Envelope): void
  listen(handler: (message: unknown) => void): () => void
  onClose?(handler: () => void): () => void
  close?(): void
}
```

An Electron `MessagePortMain`, a utility process's `parentPort`, a DOM `MessagePort` or a pipe
each become a `Port` in a few lines (`apps/desktop/electron/agent-host/ports.ts` has the
Electron ones). `createPortPair()` gives two connected in-memory ports for tests and for a host
that lives in the same process.

```ts
type HostApi = { requests: { sum: { params: { a: number; b: number }; result: number } }; events: { tick: number } }

const [near, far] = createPortPair()
const server = new Peer<HostApi, NoApi>(far)
const client = new Peer<NoApi, HostApi>(near)

server.handle('sum', ({ a, b }) => a + b, { schema: { type: 'object', required: ['a', 'b'], additionalProperties: false, properties: { a: { type: 'number' }, b: { type: 'number' } } } })
client.on('tick', (n) => console.log(n))
server.notify('tick', 1)
await client.request('sum', { a: 1, b: 2 }, { timeoutMs: 5_000 }) // 3
```

- **Typed both ways.** An `Api` is a type alias of `requests` (params and result) and `events`.
  Requests, handlers, events and listeners are checked against it.
- **The receiver trusts nothing.** An envelope is shape-checked (version, type, ids, method
  names up to 128 characters). A method has to be registered to be called. A handler can declare
  a JSON Schema, and params that fail it are refused with `invalid-params` before the handler
  runs. A malformed message goes to `onProtocolError`, never to a handler.
- **Cancellation travels.** A request takes an `AbortSignal` and a timeout (`0` waits forever).
  Aborting or timing out sends a `cancel`, and the handler's `context.signal` aborts. If the
  connection closes, every pending request rejects with `closed` and every running handler is
  aborted.
- **Errors cross as a code and a message, never a stack.** `RpcError` carries
  `unknown-method`, `invalid-params`, `cancelled`, `timeout`, `closed`, `internal` or a code a
  handler chose, plus optional `data`.
- **Versioned.** Every envelope carries `v: 1` (`PROTOCOL_VERSION`). A peer on another version
  is refused with a protocol error.

## JSON Schema

`validate(value, schema)` and `validationMessage(value, schema)` check the subset that tool
inputs and protocol messages use: `type` (one or several), `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, string length and `pattern`, number bounds,
array size, `anyOf` and `oneOf`. Keywords outside the subset are ignored, never guessed at.

Errors read as sentences a model can act on, because the same checker validates what a model
sends a tool: `todos[0].status must be one of: pending, in_progress, completed`.
