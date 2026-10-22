# 0035. A preset whose server tool chat-completions refuses is asked on the Messages API

- Status: Accepted
- Date: 2026-10-22

## Context

The owner's model is an OpenRouter preset (`@preset/...`). A preset can carry OpenRouter's server tools
(Web Search, Web Fetch, Datetime, Shell and others), and OpenRouter adds them to every request made
through the preset. Some of them exist only on the Responses and Messages APIs: with its Shell tool on,
chat-completions answers HTTP 400 `Tool 'openrouter:shell' is not available for the 'chat-completions'
API. It is only supported for: responses, anthropic-messages.` The same preset worked in another IDE, which
speaks one of those two APIs. eNCode speaks chat-completions to OpenRouter, so it could not use the model
the owner chose without switching the tool off on openrouter.ai.

## Decision

- The refusal is classified once, in `errors.ts`: `invalid-request` with the code `server_tool_unsupported`
  and the APIs the provider says take the tool (`apis`). Its text is ours: it names the tool and the preset,
  and does not read as a model without tool support, which would be learned and stay learned.
- The OpenRouter adapter answers that refusal, which comes before a byte of the reply, by sending the same
  request to OpenRouter's Anthropic-compatible Messages endpoint (`/api/v1/messages`) with the key as a bearer
  token, the form its documentation gives. It does so only when the refusal lists `anthropic-messages` or
  lists no API at all, and only before anything was streamed.
- The model is then asked on the Messages API first for 30 minutes, so the refusal costs one round trip per
  model and not one per request. Each model is remembered on its own, and not at all until the Messages API has
  answered.
- On that endpoint the body carries no thinking, effort or sampling parameters, because OpenRouter documents
  none for it and one it refuses fails the whole call. Prompt-cache marks stay for Claude models.
- When the Messages API cannot take the request either, the refusal is what is thrown, with what the Messages
  API answered added to its text. A failure of the fallback is never read as a bad key (the key works on
  chat-completions), so it does not set the key aside.
- The Responses API is not spoken. A refusal that lists only `responses` stays a refusal, and the router sets
  that model aside for 15 minutes without touching the key or other models.

## Consequences

- A preset that keeps Shell on works in eNCode as it does elsewhere. The server tool then runs in OpenRouter's
  sandbox, not on the user's machine, is billed by OpenRouter, and is outside eNCode's approvals. A preset
  that should not do that is changed on openrouter.ai, which the refusal's text says.
- Blocks the Messages API streams for a server tool are not part of the conversation eNCode keeps, so a later
  turn does not send them back.
- The fallback is verified against OpenRouter's documentation and a local server, not against OpenRouter:
  whether it takes `@preset/...` as a model on that endpoint, and what a server tool's blocks look like in its
  stream, need a live check with the owner's key.
