# 0062. Every step pays for the whole request, so its parts have a budget and the large ones wait until asked for

- Status: Accepted, builds on 0009 and 0057
- Date: 2026-10-22

## Context

A turn is a loop, and every step of it sends the instructions, the tool definitions and the whole conversation again.
Thirty steps cost thirty prompts. A provider with a prompt cache charges a tenth for the part it has seen, and charges
in full for everything after the first change; the free pool has no cache and counts the tokens against an allowance
(0020, 0024). Either way a character that is in every request is paid for in every step, which makes the fixed parts
of the request the first thing to measure.

Measured on 2026-10-22 (a scripted model, real tools; 3.5 characters to a token):

| Part of a request | Characters | Tokens |
| --- | --- | --- |
| Instructions | 5,372 | 1,500 |
| The 18 built-in tools of a session without skills or desktop | 17,882 | 5,100 |
| All built-in tools, with Skill (20 skills) and Computer | 24,708 | 7,100 |
| First message: environment and project memory | 359 to 700 | 100 to 200 |
| What a later turn adds to the history | the person's words and the answer | |
| One MCP server with 40 tools | 70,740 | 20,200 |

Two things stand out. The built-in set is small and was never looked at again after it was written; nothing stops it
growing. And a single MCP server (0057) costs three times everything else together, on every step, whether or not the
model uses it: on a free model with a 32,000-token window the app would not fit a conversation at all.

Measuring also found a defect. `repairPairing` rebuilt the user message holding the results of every tool step, so the
loop could not tell a repaired history from an unchanged one and wrote the whole conversation to the session log after
every step (a `compaction` record that removed nothing), reset the context meter so that it fell back to a rough
estimate, and would have cleared anything keyed to the history. A session of thirty steps wrote the conversation
thirty times.

## Decision

- **The fixed parts have ceilings, tested.** `budget.test.ts` builds a real first request and fails when the
  instructions pass 6,500 characters, the built-in tools 20,500 (30,000 with skills and the desktop), or one tool 3,000
  (6,000). A change that needs more says so there, where the price is read. `ENCODE_TOKEN_REPORT=1 node scripts/test.mjs
  budget` prints the table above. The test also checks that the environment and the memory are sent once, and that a
  later turn adds only the words, and that a session of six tool steps writes thirteen message records and no
  compaction record.
- **Tools of outside servers wait until asked for.** A tool can ask to be deferred (`Tool.defer`; the MCP adapter sets
  it). When the definitions of such tools together pass 10,000 characters, the request carries only a tool called
  `ToolSearch`, whose description lists their names by server, and a definition is sent from the step after the model
  asked for it. `ToolSearch` takes words ("github issue") or `select:name1,name2` and loads up to ten tools, at most
  24,000 characters of definitions. Below the threshold nothing changes: a search would cost more than it saves.
  - **What a conversation has loaded is read from the conversation.** A `ToolSearch` call loads what its query finds,
    which is computed again from the call's input, and a call to a deferred tool loads that tool. Nothing is kept
    beside the messages, so a reopened session, a rewind and a compaction leave the tool list in step with what the model
    has seen, and a call to a tool that was not loaded is checked against its schema like any call and, being in the
    history, makes the tool visible from the next step.
  - **An agent that cannot search is sent what it may use in full.** A subagent whose definition names an MCP tool and
    not `ToolSearch` could never ask for it.
  - The tool list changes when a tool is loaded, which costs the provider's cache for that request and drops the
    reasoning blocks written under the old list (the loop does that whenever the tools change). Loads happen early and
    in one call; the alternative, a single
    `UseTool` that takes a name and arguments, keeps the list fixed but asks the model to produce nested calls, which
    smaller models do worse, so it was not chosen.
- **A Read of the same lines again points back.** Read remembers which lines of a file it last put in the conversation.
  The same lines of a file whose bytes are the same are answered with one sentence ("Unchanged: lines 1-120 of a.ts are
  exactly as they were when you read them earlier in this conversation") instead of the lines. The memory is dropped
  whenever the earlier output may be gone or out of date: the file changed (by hash, so a touch does not count), the
  agent wrote it, the history was shortened or summarized, the conversation was rewound or reset, and a subagent starts
  without it. Output under 600 characters is sent again, being about as long as the note, and output over 55,000 is
  never pointed to, because the loop cuts results at 60,000 before the model sees them.
- **A window counts as at most 200,000 tokens.** Past that the prompt is shortened as if the window ended there, unless
  the person sets `contextCap`. A model with a window of a million tokens does not read 800,000 tokens better than 150,000
  and every step would pay for all of them; the verbatim tail kept after a summary is a share of the capped window.
  Windows up to 235,000 tokens behave as before.
- **Repeated lines in command output collapse.** Four or more identical lines of eight characters or more become the
  line and "(the line above is repeated N more times)", in Bash and BashOutput. Short lines and blank lines are left
  alone.
- **A step that changes nothing rewrites nothing.** `repairPairing` returns the very messages of a history that needs no
  repair, so the loop's check by identity means what it says: no record is written, the meter keeps the provider's exact
  count, and anything keyed to the history is not cleared by accident.

## Consequences

- An MCP server with 40 tools costs about 1,400 characters of names in the tool list instead of 70,000 characters of
  definitions, and a model with a small window can use one.
- A model that does not look at the tool list's description may call a deferred tool blind. It gets the schema error, and
  the tool is visible on the next step, so the cost is one wasted call.
- A long session's log grows with its messages. Logs written before this change keep their redundant records and are
  read as before.
- The number that decides most of a long session's cost, how much old output stays verbatim, is unchanged: outputs older
  than four steps are shortened only when the prompt nears the limit (0009). A lower threshold would make a summary
  appear sooner and the provider's cache miss more often; the usage numbers in the app are what would justify it.
- The cap and the deferral threshold are constants (`DEFAULT_CONTEXT_CAP`, `DEFER_ABOVE_CHARS`); the cap is also a setting
  that the settings page will expose.
- Tests: `budget.test.ts`; `tool-search.test.ts` (threshold, ranking, `select:`, limits, what a conversation has loaded);
  the loop tests (a search then a call, a call before loading, few tools, a rewritten history, the window cap, a Read after
  a compaction); `files.test.ts` (the note, and every case that must show the lines again); `text.test.ts`; and
  `compaction.test.ts` (a paired history comes back as the same objects).
