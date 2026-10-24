# 0099. Each model family gets its own reasoning back, and is asked in its own terms

- Status: Accepted, builds on 0009, 0035 and 0052
- Date: 2026-10-24

## Context

Most of the models testers bring (DeepSeek, Kimi, GLM, Qwen, MiniMax, Gemini, and Claude through OpenRouter) reason
before they answer, and most of them are spoken to in OpenAI's chat-completions dialect. The adapter read their
reasoning (`reasoning_content`, `reasoning`) and showed it, but never sent it back. Their providers' documentation
(October 2026) says what that costs:

- DeepSeek in thinking mode, on by default for its current models: in a request with tools, "the `reasoning_content`
  of all previous turns should be passed back", "even for turns where the model did not perform a tool call";
  otherwise the API answers 400 ("The reasoning_content in the thinking mode must be passed back to the API"). An
  agent loop on DeepSeek stopped at its second step.
- Kimi: send back the reasoning of the current tool-call loop (K2.6, K2.7); pass the assistant message back as it came
  (K3). Do not set the temperature.
- GLM: interleaved thinking is on by default, and "thinking blocks should be explicitly preserved and returned
  together with the tool results"; with Preserved Thinking (the default on the Coding Plan endpoint) the complete,
  unmodified `reasoning_content` of earlier turns too.
- MiniMax M2: its reasoning comes in the reply's text between `<think>` tags, "which must be preserved completely",
  and the whole assistant message goes back. eNCode showed those tags as the answer.
- Gemini 3: a missing thought signature on the first call of a step of the current turn is a 400 ("Function call is
  missing a thought_signature"). Google's OpenAI endpoint puts it in the call's `extra_content`; OpenRouter in
  `reasoning_details`. A call Gemini did not make may carry `skip_thought_signature_validator`. Gemini 3 is to keep
  its own temperature.
- OpenRouter: reasoning goes back as `reasoning_details`, unchanged and in order, which carries Claude's signed
  thinking and Gemini's signatures; `reasoning` for plain text.

## Decision

### Reading

The chat-completions adapter (`openai.ts`, `reasoning.ts`) reads, besides `reasoning_content` and `reasoning`:

- OpenRouter's `reasoning_details`: each streamed piece is a `reasoning-detail` event; the assembler merges pieces of
  the same index and type (text, summary and data join, the signature comes whole) onto the thinking block they stream
  beside, or a block of their own for reasoning that is only encrypted (`ThinkingBlock.details`). Reasoning that came
  only as details is shown from their text or summary.
- A call's `extra_content` (Gemini's signature), kept on the call (`ToolUseBlock.extra`).
- A `<think>` block at the very start of a reply's text, as thinking, whatever pieces the tags are cut into; the blank
  lines after it are dropped. `<think>` anywhere else is text. Pieces that could be the start of a tag are held until
  the next piece, and let out before a tool call or at the end.

All of it is the provider's own output, stored with the message it came with (opaque to eNCode), and never shown to
another model.

### Sending back

For each assistant message, `replayFor` decides what goes back with it. Only a message written by the target's model
on the target's provider (`sameModel`: the provider, and the model id without `:free`-style variants or `models/`) has
its reasoning sent; another model's never is. What goes back, by where the request goes:

| Target | Field | Which messages |
| --- | --- | --- |
| OpenRouter | `reasoning_details` as they came, else `reasoning` | the current request; every turn for the four families below |
| DeepSeek | `reasoning_content`; a short placeholder for a message whose reasoning it never saw (another model's, or one compaction took out) | every turn |
| Kimi, GLM | `reasoning_content` | every turn (their servers ignore what they do not keep) |
| MiniMax | `<think>…</think>` before the content | every turn |
| Gemini (Google's endpoint) | the call's `extra_content` as it came; `skip_thought_signature_validator` on the first call of a step that has none | signatures on every turn, the skip value in the current request |
| everyone else (OpenAI, Mistral, local servers) | nothing new | |

The current request starts after the last message that is not tool results. A call's `extra_content` goes back to
the model that wrote it whatever its family. A server that names one of these fields as unknown is sent the request
again without them (the same negotiation as an unknown parameter), except on DeepSeek's demand for them.

Compaction's rule for thinking (0009: what was minted under a prefix that changed is dropped) now also drops a call's
`extra_content`; the placeholder and the skip value keep DeepSeek and Gemini going after it.

### Asking in each family's terms

`families.ts` holds what each family expects beyond the dialect:

- a temperature the person set is not sent to Kimi, MiniMax or Gemini 3 and later (`takesSampling`);
- an effort the person set goes to DeepSeek and Kimi as their own `reasoning_effort` words (low, high, max), and to
  OpenAI's as before (`effortWord`); a server that refuses it is asked again without it;
- a model of DeepSeek, Kimi, GLM, MiniMax or Qwen that no catalog knows is assumed to have a window of 128,000 to
  256,000 tokens and 32,000 tokens of output, not 64,000 and 8,192: their reasoning counts against the output, and
  8,192 cut replies short. A server that allows less names its limit and is asked again with it; a smaller window is
  learned from the first overflow, as before.
- `minimax` is a family of its own.

## Consequences

- A tool-call loop goes on with DeepSeek in thinking mode, with Gemini 3 on Google's endpoint, and with Claude and
  Gemini through OpenRouter, where it stopped or lost the model's reasoning at each step; Kimi, GLM and MiniMax keep
  their reasoning across steps as their providers ask; MiniMax's reasoning no longer shows as its answer.
- Sending reasoning back costs input tokens on the families that ask for it; for the rest nothing changes.
- `reasoning.test.ts` holds the `<think>` reader, the merging of details, the request boundary and the rules by
  family; `openai.test.ts` reads details, signatures and a `<think>` block from a stream, sends each family its
  field, goes on with a loop on a server that refuses a step without its reasoning (as DeepSeek does), and asks again
  without the fields when a server names them as unknown; `compaction.test.ts` drops a signature with the thinking.
- Open:
  - What a family wants changes with its models; the rules follow the providers' documentation as of October 2026,
    and a new model that wants something else needs a new rule. `pnpm bench run --model ...` (or `--base-url` for a
    provider's own endpoint) and `bench compare` score a model before and after a rule; they need the person's key,
    so the scores come from testers, not from eNCode's CI.
  - Kimi's tool-call ids (`functions.Read:0`) are replaced with eNCode's own, as every id with other characters is;
    its official API takes that, a server running Kimi's own parser may not.
  - Qwen's own API (DashScope) is sent nothing new: its documentation does not say it wants reasoning back.
