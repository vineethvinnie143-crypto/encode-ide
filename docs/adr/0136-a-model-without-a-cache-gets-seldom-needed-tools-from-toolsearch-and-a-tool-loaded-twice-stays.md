# 0136. A model without a cache gets seldom needed tools from ToolSearch, and a tool loaded twice stays

- Status: Accepted, builds on 0062 and 0130
- Date: 2026-10-25

## Context

Every request carries the instructions and the whole tool list: about 27,000 characters, or 7,700 tokens. A model with
a prompt cache pays a fraction of that after the first step. A model without one pays all of it on every step: about
385,000 tokens over 50 steps. 0130 calls these models uncached: their price list prices a cached token at 90% or more
of an uncached one, or has no cache price at all.

Some tools are in every request and seldom used:

- the Computer tool (4,900 characters) and the Browser (2,300) in the desktop app;
- the three goal tools;
- EnterPlanMode.

ToolSearch already holds back the tools that wait for it (0062): the model sees their names, and loads a definition
when it needs one. What a conversation has loaded is read from its messages, so a compaction that removes the
ToolSearch call removes the tool again. The model then has to search again, which costs a step.

## Decision

- **Seldom needed tools** (`Tool.seldom`): Computer, Browser, CreateGoal, UpdateGoal, GetGoal and EnterPlanMode.
  ExitPlanMode is not one of them, so plan mode can always be left.
- **Held back for an uncached model.** For a model without a cache (`paysEveryToken` in `shortening.ts`), the loop
  asks the registry for the lean list (`visibleDefinitions(…, lean)`). The seldom tools wait for ToolSearch like the
  deferred ones, and ToolSearch's description ends with `Also:` and their names. Once ToolSearch loads one, or the
  model calls one, it is in the list from the next step.
- **Unchanged for every other model.** A model with a cache, or one whose cache is not known, keeps the full list, and
  its cached prefix stays as it was.
- **ToolSearch finds a seldom tool by its name.** `select:Computer` loads it, and so does a query with a word of its
  name ("goal"). A seldom tool's description is not searched. A model with a cache already has these tools, so a query
  about something else must not bring them in.
- **A tool loaded twice stays.** The loop counts, for the session, each tool a ToolSearch call loaded. A tool loaded
  twice stays in the list from then on, also after a compaction removes the calls that loaded it. Its definition then
  stays in a cached prefix too, instead of leaving it and coming back.
- **Subagents and attempts** offer ToolSearch when any tool it can load is one of theirs, the seldom tools included.

## Measured

`budget.test.ts`, first request, Linux:

| Tool list | With a cache | Without |
| --- | --- | --- |
| A session without the desktop | 20,978 | 19,499 (−7%) |
| The desktop's tools, Computer and Browser included | 28,207 | 19,480 (−31%) |

With the 6,000 characters of instructions, a desktop session without a cache pays about 25% less for its fixed part on
every step.

## Consequences

- An uncached model that needs the Computer tool, the Browser or a goal takes one more step to load it. The step
  costs far less than the definitions over a session, and the model reads the names in ToolSearch's description.
- The model may plan less often without EnterPlanMode in its list. The instructions still tell it when to plan, and
  the tool is one ToolSearch call away.
- The set of tools that stay after two loads is kept by the session's loop. A new loop (after the tools change)
  starts the count again.
- Models with a cache are not affected, and neither are their tool lists or caches.
