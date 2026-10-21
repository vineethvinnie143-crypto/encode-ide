# 0009. Compaction keeps every tool call answered

- Status: Accepted
- Date: 2026-10-21

## Context

Forge compacted a conversation by keeping its last 12 messages. That cut assistant tool
calls away from their results. OpenAI-compatible providers reject such a transcript with
HTTP 400, so long sessions broke for good. Other paths broke pairing as well:

- A stopped run left tool calls unanswered.
- A follow-up message after `attempt_completion` was refused with HTTP 400.
- An older session file could be damaged in the same ways.

## Decision

- **The pairing invariant.** After the system prompt the first message is the user's.
  Every assistant tool call is answered exactly once, by the tool messages that immediately
  follow it. There are no orphan results and no empty `tool_calls`.
  - `repairPairing` restores the invariant on load. It keeps results in their original
    order and answers open calls with a fixed "Not run" stub.
  - The agent loop answers every call it receives. `attempt_completion` is answered
    "Reported to the user.", and Stop leaves stubs.
- **Units.** Compaction cuts only between units: a user message, a step (an assistant
  message with its tool results), or a reply. It never cuts inside a step.
- **When.** Before each model request, when the estimate exceeds 70 % of the model's
  context window.
  - The estimate is characters divided by 3.5, calibrated from the provider's reported
    prompt tokens.
  - The window comes from the OpenRouter catalog, a window learned from an overflow error,
    or 64 k by default.
- **How much.** The cheapest step that fits wins:
  1. Tool outputs and arguments older than the last 4 steps are shortened.
  2. If that is not enough, the oldest units are summarized and recent units worth 35 % of
     the window are kept.
  3. If it is still too long, recent outputs are shortened too.
- **Summary.** The dropped part is summarized by the model, which is told the transcript is
  data and not instructions. A deterministic digest (requests, files changed, commands,
  failures) is the fallback.
  - The summary goes into a `<conversation_summary>` block in the first user message.
  - A cut inside a turn carries the request in progress word for word, in
    `<current_request>`.
- **Overflow recovery.** When a provider refuses a prompt as too long, eNCode reads the
  window and the used size from the error, compacts, and resends exactly once. The
  provider's non-streaming retry is skipped for this error, so a too-long prompt is never
  sent twice.
- Manual compaction from the composer uses the same path and keeps 10 % of the window.

## Consequences

- Long sessions continue instead of failing.
- Property tests cover repair (valid, idempotent, nothing lost or invented), elision and
  planning, and each property was mutation-checked. The smoke drives a provider that
  refuses one prompt as too long and checks the summary, the notice, and a follow-up turn.
- Summaries are generated from content that may include prompt injections, and they sit in
  a user message. Approvals remain the control. The threat model lists this residual risk.
