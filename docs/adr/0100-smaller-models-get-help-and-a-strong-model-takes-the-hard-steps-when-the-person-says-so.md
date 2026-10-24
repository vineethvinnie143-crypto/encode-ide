# 0100. Smaller models get help, and a strong model takes the hard steps when the person says so

- Status: Accepted, builds on 0052, 0094, 0095, 0096 and 0099
- Date: 2026-10-24

## Context

Most testers run eNCode on a cheap model: DeepSeek, GLM, Kimi, Qwen, MiniMax, or the free ones. Such a model writes
most code well enough at a fraction of the price, and fails in ways a frontier model rarely does: it edits before it
knows what it will change, sends the call that just failed again, and goes round the same failing check. 0094 already
sorts models into the strong ones (`needsNoGuide`), which get the short guide, and the rest, which get the full one and
the Reviewer before they finish (0096). What was missing:

- help the smaller model gets on every step, cheaply, beyond the general guide;
- a sampling temperature fit for code where the family's maker names one;
- a way out when the smaller model is stuck: a stronger model for the rest of the request, never used unasked, since
  it costs more;
- a nudge in Settings > Roles towards one strong model for the two steps where it matters most, the plan and the
  review, while the cheap one keeps writing the code.

## Decision

### Which models are smaller

`isStrongModel` (moved from core's `guide.ts` into `@encode/providers/strong`, so the agent and the desktop's settings
read the same rule) names the strong ones: Claude Opus, Sonnet and Fable from 4, GPT-5 and o3 (not their small sizes),
Gemini Pro from 2.5, Grok 4. Every other model is a smaller one. `needsNoGuide` is that same function.

### Help for smaller models

With `smallerHelp: 'auto'` (the default; Settings > Roles > Help smaller models), a smaller model gets:

- a fixed part after the instructions, cached with them (`SMALLER_MODEL_PART`, about 470 characters): say which files
  will change, what changes in each and how it will be checked before the first change; start work across several
  files with its steps in TodoWrite; check each change before the next; change a call that failed before sending it
  again;
- think before edit: in Code mode, the first step of a request with a file change (Edit, MultiEdit, Write,
  NotebookEdit, LSPEdit), when the agent has written fewer than 80 characters of reply and of reasoning since the
  request began (encrypted reasoning counts as enough), does not run its changes. Each gets the result "Not run yet.
  Before the first change of a request, say in two to four lines which files you will change, what changes in each,
  and how you will check it. Then make this call again."; the step's other calls run. The person sees one notice,
  "eNCode asked the agent to say what it will change before its first edit.", and no row for the held calls. It
  happens once a request at most, whatever the agent does next. A strong model, and every model with the setting off,
  is never held. The model deciding is the one that wrote the last reply.

### Temperatures for code

When the person set no temperature, the chat-completions adapter sends the one a family's maker recommends for code
(`codeTemperature`): 0.0 for DeepSeek (its API defaults to 1.0; its documentation recommends 0.0 for coding) and 0.7
for Qwen's Coder models (their model card). The rules of 0099 still hold: no temperature to reasoning models, to Kimi,
MiniMax and Gemini 3. Every other family keeps its provider's default.

### A stronger model after two setbacks

The loop counts setbacks in each request of the main agent (`Setbacks`): a send-back of the language servers' gate,
the checks, the claim check, or the Reviewer when it found a P0 or P1 problem (not the scan, and not the cases no test
covers); a call that failed the same way a second time (counted once); a second failed change to one file. A call the
person, a rule or a hook refused is not a setback.

After the second, with `offerStronger: 'ask'` (the default; Settings > Roles > Offer a stronger model when one fails
twice), when the model that wrote the last reply is a smaller one and the Plan role, or else the Review role, resolves
to a strong model of its own, the person is asked once a request, before the next model call, through the approval
card (`StrongerModel`):

> **Let claude-sonnet-4.5 take over this request?** deepseek-chat ran into trouble twice in this request: the
> project's checks failed after its changes, twice. claude-sonnet-4.5, the model of your Plan role, would do the rest
> of it. The next request goes back to deepseek-chat. It costs $3.00 per million tokens read and $15.00 written,
> against $0.28 and $0.42 for deepseek-chat.

The prices come from the router (`ModelBudget.price`, a new field, told only where a catalog gave one). The buttons are
"Use it for this request", "Use it whenever one fails twice" (a session grant, like any other) and "Keep going", with
a note when the person explains. Whatever the approval policy, the person decides: Full access does not answer it.

On yes, the main agent's calls for the rest of the request go to that role (`callRole`): its model list, through the
router as any other call; the model is told first that it takes over and to read what was tried. The checks, the
claim check, the Reviewer and the language servers' gate hold its work afresh. The next request starts on the main
role again. On no, the agent goes on, with the person's note if they wrote one, and is not asked again in that
request.

### The suggestion in Settings > Roles

While billed models may run, Main is a smaller model on a connection that is not local, and Plan or Review still
follows Main, Settings > Roles offers the strong model of that connection's list that calls tools and is not free, the
newest of the first family found in this order: Claude Sonnet, GPT-5 (not Pro), Gemini Pro, Grok 4, Claude Opus
(`strongRoleSuggestion` in `shared/strong-roles.ts`). **Use** puts it on Plan and Review alone; Main and the rest keep
what they had. No other connection, no key and no free model is ever suggested; on a connection that lists no strong
model (DeepSeek's own) nothing is.

With it set, 0096's `auto` already has the Reviewer read the smaller model's work (the Review role has a model of its
own), Plan mode drafts with the strong model, and the offer above has a model to name.

## Consequences

- A smaller model plans its first change in words, which the person and the Reviewer can read, at the cost of one
  round trip at most per request when it would not have; and gets out of a loop of the same failure with a model the
  person chose and approved.
- Nothing costs more without the person's yes; free-only mode leaves no billed model to offer, since the router would
  not call one.
- The harness of core's tests, the benchmark's reference runs and replays (`AS_WRITTEN`, `REFERENCE_SETTINGS`) and the
  desktop's end-to-end run turn both settings off except where they test them: the scripted and fake models are
  smaller ones, and a script plays its steps as written.
- A report of a request (0092) keeps a held change as a call that failed with the held result. The task a replay makes
  of it leaves that call out, as it never ran, and plays the one the model sent after saying what it would change; a
  report with every word replaced keeps it, since its result no longer reads as held.
- `smaller.test.ts` holds the rule, the plan said, the setbacks, the prompt and its prices, a held change and the
  calls beside it, a strong model and the setting off, and the offer: asked once, the Plan role for the rest of the
  request and the main role for the next, no and its note, the Review role when Plan has none, none when turned off,
  for a strong model or without a strong role, and the checks held afresh after two failed rounds.
  `strong-roles.test.ts` holds the suggestion. `openai.test.ts` holds the temperatures. The desktop's end-to-end run
  holds a change, sees the part and the held result sent to the model and one row for the write; then sets a strong
  model on Plan, fails an edit twice and another once, gets the offer with its reasons, approves it and finds the next
  call sent to the strong model.
- Open:
  - Which models count as strong is a list by name; a smaller model that does as well (a new Kimi or GLM) waits for the
    list to grow. "Test this model" (the next step) scores a model on the benchmark from Settings, which is what the
    list should follow.
  - A setback is what eNCode can see; a model that goes round in circles with calls that each succeed is not caught.
  - The designer role for the UI taste tool comes with that tool, where its one use is.
