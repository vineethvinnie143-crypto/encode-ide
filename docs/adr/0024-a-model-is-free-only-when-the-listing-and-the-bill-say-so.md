# 0024. A model is free only when the listing and the bill say so

- Status: Accepted
- Date: 2026-10-21

## Context

The owner wants to use only free models and never be charged. OpenRouter's catalog can change
without notice: a price field can appear, a zero price can lapse. The first live check (a real key,
charged $0) also showed that a free model in the list is not a model the account can use: the
account's privacy settings excluded the endpoints of three of them (HTTP 404), and two were limited
to apps OpenRouter lists (HTTP 403, which `@encode/providers` reads as a refused key). Its daily
counter of free requests ran late.

## Decision

- On OpenRouter a model is free when its id ends in `:free` and every price it lists is zero: prompt
  and completion, and also request, image, web search, reasoning and cache. A price that is missing,
  unreadable or not one this code knows counts against the model. A zero price without `:free` is
  left out. On a provider marked `free` (the gateway, a server on this machine) every model is free.
- `"freeOnly": true` makes the router send a request only to a free model, in four layers:
  selection, a look right before sending (the catalog can change while a key is read),
  `checkModel()`, and a snapshot read from disk, which cannot vouch for a model that has a price.
  OpenRouter's server-side fallbacks only ever name free models. An unreadable setting turns the
  switch on, not off. Personal mode sets it.
- Billing is a tripwire, not trust: OpenRouter reports what each request cost. A model listed as free
  that is billed is learned as paid (kept across restarts), is never used again in free-only mode, and
  raises a `billed` alert.
- A listing is only a candidate. A refusal of one model by the account (privacy settings, app-only,
  other 403) sets that model aside for a day (an hour for an unexplained 403) without blocking the key
  or the provider, and raises one `model-refused` alert per reason. A model that has answered, or has an
  eval score, ranks above one that is only listed. OpenRouter's daily counter can raise the router's own
  tally but never lower it.
- `scripts/free-models.mjs` shows the picks with every price as OpenRouter wrote it, and with `--test`
  makes real calls and compares the key's credit usage before and after. The key comes from the
  environment only and is never printed.

## Consequences

- The free pool can be much smaller than the listing. The user is told which models were set aside and
  why, and "Check again" (`retryRefused()`) brings them back after a settings change.
- Using the models that train on prompts means loosening OpenRouter's privacy settings, which is the
  user's decision and not something eNCode does for them.
- For the strongest guarantee the key itself should have a $0 credit limit; software alone cannot make
  a charge impossible.
