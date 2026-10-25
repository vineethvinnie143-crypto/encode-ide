# 0130. Old results are shortened by what the model's cache charges

- Status: Accepted, builds on 0094 and 0128
- Date: 2026-10-25

## Context

0094 shortens the outputs of old steps once the prompt passes 32,000 tokens (or a fifth of the window), and below the
summary's limit only when that saves a tenth of the window. It does this the same way for every model. But a rewrite
costs very different amounts:

- A provider caches the prompt only up to the first message that changed. A rewrite sends everything after that point
  again, at the full price or at the price of writing the cache.
- That price varies a lot by provider. A cached token costs about 2% of an uncached one on DeepSeek V4.1 Flash
  directly, a tenth through OpenRouter and on Claude, a quarter on OpenAI and Gemini, and all of it where nothing is
  cached. Writing Claude's cache costs a quarter more than an uncached token. Most others charge nothing extra.
- A rewrite also drops the reasoning after the change. Claude and Gemini check reasoning against the prompt it was
  written under, so theirs has to go. DeepSeek, Kimi and GLM read theirs back as plain text, and lost it for nothing.

The owner set a target of 25% lower cost at the same accuracy (the review of 2026-10-25), and this is its first change.

## Decision

- **The cache's terms come with a model's budget** (`packages/providers/src/cache-terms.ts`):
  - `read` and `write` are shares of an uncached token, plus whether the provider binds the model's reasoning and how
    long the cache lasts.
  - OpenRouter's catalog gives them from `input_cache_read` and `input_cache_write`. A listed model with an input price
    and no cache price discounts nothing.
  - Without a price list (a direct provider, a free model, a preset), the family's usual terms are used. Unknown hosts
    get half.
  - Thinking is bound for a reasoning model of Claude's or Gemini's family. Claude's cache lasts five minutes, or the
    hour once the session asks for it (0128).
- **Three profiles** (`packages/core/src/shortening.ts`):
  - **Bound** (Claude, Gemini with reasoning):
    - Old outputs are cut to 800 characters, and the last two steps stay whole.
    - Within a request, shortening happens only by 0094's rule, a saving of a tenth of the window. A rewrite of signed
      reasoning stays as rare as before.
    - When a request starts, a rewrite is also made whenever it pays (see below), since no reasoning of a tool-call
      loop is lost then. It always pays when the cache has expired since the last request: the whole prompt is
      written again anyway.
  - **Rolling** (a cache where a rewrite costs only the tail sent again: DeepSeek, OpenAI, Grok, Kimi, Qwen, GLM, and
    any model the client cannot tell about):
    - Shortening starts at 16,000 tokens, or a tenth of the window.
    - A command's or a page's output stays whole for one step. What the model finds code by and edits from (Read,
      Grep, Glob, LSP) stays whole for three.
    - Each rewrite sits near the end, so little is sent again.
  - **Uncached** (a price list that discounts a cached token by less than a tenth): the rolling rule from 16,000
    tokens in any window, since every token is paid in full on every step.
- **A rewrite pays** when the tokens it saves, read from the cache on the requests ahead, cost more than the tail it
  sends again now: saved × read × ahead ≥ tail × (write − read).
  - The requests ahead are estimated as the number of steps the conversation has had so far, between 4 and 40. A
    conversation that has gone on long tends to go on.
  - A rewrite saving under 1,000 tokens is never made.
  - 0094's rule (a tenth of the window) still applies on top, so no prompt grows longer than before. Past the limit
    everything works as before.
- **What is never shortened**, in every profile:
  - the plan, the task list and a goal (the inputs of ExitPlanMode, TodoWrite, CreateGoal and UpdateGoal);
  - the person's answers (AskUserQuestion's result);
  - the latest Read of each file in the request being worked on, until the file is changed. The model edits from it.
    Only when a prompt does not fit at all does that read give way too.
- **A model keeps its own reasoning** through a rewrite where no provider binds it, within the request it is working
  on. Reasoning that is signed, encrypted, redacted or of unknown origin is still dropped, as is reasoning from earlier
  requests.
- **Tests.**
  - `context-cost.test.ts` prices the scripted 50-step session at six providers' cache prices, and CI fails when a
    profile costs more than recorded.
  - Input bill vs. 0094, in uncached tokens: DeepSeek V4.1 Flash direct 155k to 132k (−15%), DeepSeek through
    OpenRouter 254k to 195k (−23%), OpenAI 441k to 316k (−28%), Claude 287k to 247k (−14%), Gemini 441k to 378k (−14%),
    no cache 1,372k to 920k (−33%).
  - The same holds in 64k and 200k windows, and with the steps split across five requests.
  - Unit tests cover the terms, the profiles, the payoff, which outputs stay whole, which reasoning survives, and a
    Claude cache that expired between requests.

## Consequences

- These savings count input only, on scripted output that is all command output. Real sessions read files, and Read
  results stay whole longer, so real savings will be smaller. Output and reasoning are untouched. R2 and R4 take those.
- Rolling shortens a command's output after one step. A model that wants an older test run again reads it from the
  session's folder (0093) or runs it again. The benchmark at `--repeat 5`, with `--window 16000` and `--gate` (0129),
  is how a live run checks that accuracy holds. The plan's Q5 adds field signals and backs off where it does not.
- A preset or a direct provider uses its family's usual terms: a DeepSeek preset counts as a tenth, while DeepSeek
  V4.1 Flash directly charges about 2%. At that price rewriting pays less often, so 0094's rule does most of the work.
