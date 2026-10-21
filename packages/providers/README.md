# @encode/providers

The layer between eNCode's agent and the model APIs: the canonical conversation, the transport
contract, the error classifier, the stream assembler and (as M1 lands them) the provider
adapters.

```
core ──complete()──▶ ModelClient ──stream()──▶ ProviderAdapter ──▶ HTTP
                     (router, or DirectClient)  (openai-compatible, openrouter, anthropic)
```

Dependencies run one way: `providers ← router ← apps`, and `core` depends only on `providers`.
The router (M2) implements `ModelClient`; until it lands, `DirectClient` does, with one model
per role and no failover.

## Files

| File | What it holds |
| --- | --- |
| `messages.ts` | The canonical conversation: content blocks, messages, `ModelRequest`. |
| `contract.ts` | `TransportTarget`, `TransportEvent`, `ProviderAdapter`, `ModelClient` and its outcomes. |
| `errors.ts` | `TransportError` and the classifiers for HTTP failures, stream errors and socket errors. |
| `assembler.ts` | Incremental events → `AssistantMessage`, with tool-call parsing and validation. |

The classifier is kept in its own file so the router's quota and gateway rules can grow it
without touching the rest.

## The canonical conversation

Blocks follow Anthropic's model: `text`, `image`, `thinking` (with its signature),
`redacted-thinking`, `tool-use` and `tool-result`, paired by id. Every assistant message
records its `origin` (provider, the model that actually answered, and its family).

**History is append-only.** Core never edits an earlier message, the system prompt or the tool
list within a conversation:

- prompt caches stay warm;
- Anthropic's newest models bind each thinking block to the conversation before it, and reject
  it with a 400 once that prefix changes.

Reminders go into new messages. The system prompt and tool text are rendered once per session
and replayed as stored. Compaction is the only sanctioned rewrite, and it starts a new prefix.

Adapters send the same history to every model and drop only what the target cannot read:

- thinking from another family;
- Anthropic thinking anywhere but Anthropic;
- ids in a shape a provider rejects, which are rewritten.

They never edit the stored history.

## Calling a model

```ts
const outcome = await client.complete({
  role: 'main',
  payload: { system, messages, tools, maxOutputTokens: 32_000 },
  requirements: { promptTokens, maxOutputTokens: 32_000, tools: true, images: false },
  sticky: sessionId,
  signal,
  onEvent: (event) => ui.update(event),
  validateToolCall: (name, input) => registry.check(name, input),
})
```

`complete()` rejects only when `signal` aborts, with `signal.reason`. Everything else ends as an
outcome:

- `done`: the message, with content in stream order, plus usage and the finish reason. A tool
  call whose JSON could not be repaired, or that failed `validateToolCall`, carries
  `invalid: {raw, error}`. Core answers it with an error result, so every `tool-use` still gets
  exactly one `tool-result`.
- `compact`: the prompt does not fit `window`. Compact and call again.
- `paused`: nothing can run now (a spent quota, a bad key, the network). `retryAt` says when a
  wait would help.

`budget(role, {sticky, tool, agent})` returns the context window and output limit of the model a
call would run on now. Core compacts at 85% of that window before sending.

UI events are `attempt`, `text`, `thinking`, `tool-call`, `discard` (forget the current attempt),
`switch` and `wait`. Nothing an attempt streams is final until it finishes cleanly.

## Writing an adapter

An adapter is stateless. It translates a `ModelRequest`, streams `TransportEvent`s, and fails
with a `TransportError` from `classifyHttpFailure`, `classifyStreamError` or
`classifyNetworkFailure`. Once aborted, it fails with `signal.reason`. It does not retry, fail
over or repair JSON.

Event order is content order:

- consecutive `text` events extend one block;
- consecutive `thinking` events extend one block until a signature closes it;
- `tool-call` events with the same `index` extend one call.

`usage` events are cumulative, and later fields overwrite earlier ones. `inputTokens` counts
every prompt token, cached or not. `keepalive` reports an SSE comment (OpenRouter's processing
note). It may stretch a first-token deadline, but it is not content.
