# 0023. Failover is silent, and only a clean reply is committed

- Status: Accepted
- Date: 2026-10-21

## Context

The free tier and bring-your-own-key models fail in every way a network service can: a 5xx before
the first byte, a stream that dies halfway, a model that hangs, rate limits, a quota that runs
out at midnight, a key that stops working. A session that stops, or shows half an answer and
then another model's, is not Claude Code-level. The agent loop must see one model that mostly
works.

## Decision

- `@encode/router` implements `ModelClient`. Each attempt is one streamed call to one model under a
  watchdog (first token, idle gap, and keepalives that buy time only up to a cap). An adapter that
  ignores its abort signal is abandoned, not awaited.
- Content streams to the UI as it arrives, but nothing reaches the agent's history until an
  attempt finishes cleanly. A failed attempt sends `discard`, then `switch`, and the next model
  takes over, before or during the stream.
- Every failure is classified once, by `@encode/providers`, and answered by one policy: cooldowns
  that double, circuit breakers that let one probe through, rate limits that are not ill health,
  account-wide limits that close the free tier or block a provider, a refused key that blocks its
  provider until the host calls `keysChanged()`, learned context windows and tool support.
- A request has a failover budget: 3 costly failures, 90 seconds from the first problem, 12
  attempts. When it is spent, or nothing can run, the request ends as `paused` (with the time a
  retry may work) or `compact` (only the window stands in the way). Waits that fit the budget are
  sat out and announced.
- A content filter is never routed around to another model.
- `complete()` rejects only when the caller aborts, with exactly the abort reason.
- Router sources use only `fetch`, timers and `AbortController` (no `node:` imports, `process` or
  `Buffer`; a test enforces it), so the gateway can run the same code.

## Consequences

- The UI must handle `discard`: text it showed may be taken back.
- Time is injected, so the router is tested on a fake clock against scripted providers, including a
  seeded chaos suite that checks invariants (only a clean finish commits, no model is called while
  it cools down, at most 20 free requests reach OpenRouter in any minute).
- A reply that finished but is flawed (unreadable tool JSON, empty) is retried once on the same
  model, then on another, and is committed for the agent to correct only when the budget is spent.
- A user who wants an immediate failure instead of failover uses `DirectClient`, which has the same
  interface and no failover.
