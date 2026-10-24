# 0094. Old results are shortened early and seldom, strong models get a short guide, and small jobs a small model

- Status: Accepted, builds on 0062 and 0093
- Date: 2026-10-24

## Context

0093 made a long result cheap where it enters the conversation. What a long session pays comes after that: every
step sends the whole conversation again, cached or not.

- Old tool results were shortened only once the prompt passed 85% of the window. A 50-step session in a
  128,000-token window never got there: each of its 51 requests carried every result of every step before it, 2,679,000
  input tokens in all.
- Near that limit, shortening happened step after step. Each time it rewrote the prompt from the first result it
  changed, and a provider's cache serves only the start that stayed the same.
- A shortened result said "run the tool again if you need them", even when the whole of it was kept in a file.
- After a summary, the model knew the files it had worked on only from the summary's words, and read them again one
  step at a time.
- The instructions and tool descriptions took 26,347 characters (about 6,600 tokens) on every step, for every model. A
  frontier model follows the same rules from a third of the words.
- Explore, Small tasks, Compaction and Inline suggestions used Main's model unless the person set another, so a
  session on an expensive model paid its price to name a session or search a folder.

## Decision

### Old results are shortened early, and only for a saving worth the cache

Once the prompt passes 20% of the window (and at least 32,000 tokens), the outputs and long arguments of every step
but the last four are shortened to 1,500 characters, as before only near the limit. Below the summary's limit this
happens only when it saves at least a tenth of the window (and at least 4,000 tokens): the cache is then given up seldom
and for much, and a shortened result is short for good, so the passes after it change nothing. Past the limit it
happens whatever it saves, and a summary follows if that is not enough, as before.

Each shortened result says how to have it again:

- a result that is not a Read is kept whole in the session's folder of 0093 first, and the note names the file
  (`All of it is in <path>: Read it with offset and limit, or Grep it.`); an excerpt that already named its file
  keeps naming it, and only a file in the session's own folder counts: a note an output quotes (a web page, a file)
  is its text, and the output is kept like any other;
- a Read's lines are in their file: `Read the file again for them; it may have changed since.`;
- only where nothing could be kept: `Run the tool again if you need them.`

### After a summary, the files are read again

A summary now names the files the summarized part read or changed, not their contents. Up to five of them are read
again as Read shows them now (changed ones first, then those only read, latest first), within 8% of the window and
20,000 characters each, and put after the summary in a `<files_read_again>` block. They count as read, so the model
edits them straight away, and a Read of one of them answers that it is unchanged. A file the kept part read or wrote
whole is not read again. Only what the agent may read without asking comes this way: a file the person's rules ask
about or refuse, or one outside the workspace and its folders, is left for the model to Read.

### A model that needs no guide gets the short one

Claude Opus, Sonnet and Fable from 4, GPT-5 and o3 (not their small sizes), Gemini Pro from 2.5 and Grok 4 are sent
short instructions (2,165 characters instead of 5,372) and each tool's brief, a description that keeps the tool's
rules and leaves out the advice (`Tool.brief`). The two together are 16,680 characters instead of 26,347 (-37%, about
4,200 tokens instead of 6,600). The tools and their schemas are the same; only the words change. Every other model gets
the full guide, and Settings > Roles > Instructions gives it to every model when the person wants. The model the router
expects to call decides, so the start of the prompt changes only when the model does, which already restarts the cache.

### Small jobs can take a small model, never a free one by accident

While Explore and Small tasks follow a billed Main, Settings > Roles suggests the smaller model of Main's own family on
the same connection (Claude Haiku for Opus or Sonnet, GPT-5 mini for GPT-5, Gemini Flash for Gemini Pro, and the
like), only one that calls tools, is not free, and costs less where the list gives prices, with what it saves. One
click gives it to both; Compaction and Inline suggestions follow Small tasks.

A role nobody configured follows Main, so it never reaches the free models while Main lists billed ones, whatever the
connections: a test holds the router to it for every role, tool and subagent. A role that follows one listing the free
models says so in Roles, since their providers may keep what they are sent.

## Consequences

- The scripted 50-step session (`context-cost.test.ts`) sends 1,363,700 input tokens in a 128,000-token window instead
  of 2,679,000 (-49%), 1,525,700 in a 200,000-token window (-43%), and 1,306,800 in a 64,000-token window instead of
  1,714,900 (-24%; that window was already shortened near its limit). The uncached tokens grow a little (98,000 to
  130,100 in the 128,000-token window), from four rewrites where there were none; at a cache's usual price of a tenth,
  what the session costs still falls by about a fifth there, and by the full share where nothing is cached.
- A model that needs an old output reads it from its file or the file it came from, a step it did not need before.
- Each rewrite writes the conversation to the session log once, as a compaction did.
- Open:
  - The list of models that need no guide is by name; the model families step (next) measures each family on the
    benchmark and may move models across.
  - A replay of a reported request (0092) cannot read a kept file, as in 0093.
  - The suggestion knows a family's small model by name; a connection that lists none gets none.
