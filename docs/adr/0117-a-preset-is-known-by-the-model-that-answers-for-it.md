# 0117. A preset is known by the model that answers for it

- Status: Accepted, builds on 0035 and 0113
- Date: 2026-10-24

## Context

The owner's main model is an OpenRouter preset, `@preset/deepseek-v4-1-1017`. A preset is settings kept on openrouter.ai
(a model, its parameters, perhaps tools) and called by that id. The model behind this one, DeepSeek V4.1 Flash 1017,
reads pictures, has a 1M-token window and is priced per token. eNCode knew none of that: OpenRouter's model list has no
presets, so the registry described the id with the defaults for a model nobody lists, a modest window, no price, and
no pictures. A screenshot sent to it was replaced by a note, and the chat said the model cannot see pictures.

OpenRouter says which model a preset uses only in its replies, in the `model` field of the stream, which the router
already reads to credit a server-side fallback to the model that answered (0024). Its API for reading a preset takes a
management key, which people do not give eNCode.

## Decision

- **A model the provider's list does not have, answered on OpenRouter by one it does, is described as that one**
  (`learnServedBy` in `router.ts`, `servedBy` in `registry.ts`): its window, what it reads (pictures, PDFs), whether it
  reasons, its price, under its own id. The latest answer wins, and it is kept with what the router has learned, so it
  survives a restart. A listed model, or one on another kind of provider, learns nothing from the name in a reply.
- **When another model answers for the preset**, what failures taught about the one before (a smaller window, pictures
  or tools refused) is forgotten. The preset is never counted free because a free model answered for it, since the next
  request may go elsewhere, and the date the model behind it retires does not retire the preset, which can be moved on.
- **A preset not yet known is sent pictures.** Until its first answer, an `@preset/` id on OpenRouter is taken to read
  them. If its model cannot, OpenRouter refuses ("No endpoints found that support image input"), the router learns that
  the model does not read pictures, and as before the request goes to a model of the role that does, if one is ready.
- **If none is, the call goes again at once with a note in each picture's place** (`complete` in core's `loop.ts`),
  once, and the chat says the model cannot see pictures, as for any such model (0113). Before, the turn stopped.

## Consequences

- A preset of a model that sees reads the first picture sent to it, and after its first answer it is budgeted with its
  real window: compaction no longer starts at a fraction of what the model holds, and the cost shown is its own.
- A preset of a model that does not read pictures costs one refused request the first time a picture goes to it.
- A preset that sends some requests to one model and some to another (its own fallbacks) is described as whichever
  answered last.
- Not yet seen against openrouter.ai with a preset: if a reply ever named the preset rather than its model, nothing is
  learned, and the preset keeps the defaults with pictures sent.

## Verification

- `registry.test.ts`: a preset is told apart by its id, is sent pictures until known, is described by the model that
  answered under its own id and never free by it, keeps what failures taught while the same model answers and forgets
  it when another does, and keeps the model across a restart (a malformed one is skipped).
- `router.test.ts`: the first reply teaches the window, pictures and price; a listed model or a non-OpenRouter
  provider learns nothing; a preset that refuses pictures is known not to read them.
- `session.test.ts`: the model refusing pictures sends the message again at once with notes, and the person is told.
  Without the change in `loop.ts` the turn ended after the refusal.
