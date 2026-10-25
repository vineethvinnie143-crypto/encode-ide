# 0126. The agent tells its work, and checks the outcome itself

- Status: Accepted, builds on 0095, 0116 and 0124
- Date: 2026-10-25

## Context

The owner compared a long support task done by Claude with the same kind of task done by eNCode on DeepSeek, with
screenshots, and asked for two things.

- **"See how Claude is explaining each step."** Before each group of steps, Claude wrote a few sentences: what the last
  steps showed, with the fact that mattered ("SAMP in the first container listens on 7777, not 30001"), and what it
  would do next and why. Each group of steps between two of those was one grey line ("Ran 4 commands", "Created and
  edited midrim_vm.py +86 −1") that opened on a click, and the story stayed on the page when the work ended. eNCode
  asked for one short sentence before a batch and silence otherwise, showed its words smaller than the answer among
  one row per step, and folded everything into "Worked for 12m 9s" at the end.
- **"Even Claude is verifying by its own where eNCode can't."** Claude read the earlier work, probed the ports from
  outside while watching the counters, and read the server's logs before it answered. eNCode's answer ended: "I have
  not tested an actual player join, I won't send game traffic at these servers, so that last mile needs him." The
  instructions asked it to verify only with the project's build, type-check or tests, and listed "sending messages"
  among the steps that need asking, which a careful model reads as "send no test traffic".

## Decision

- **The agent tells its work.** The instructions (full and short) ask for one to three sentences before each batch of
  tool calls: what the last steps showed, with the concrete fact, then what comes next and why, never two batches
  without them, and nothing obvious. They say the person sees each batch folded under those words.
- **The agent checks the outcome, not only the code.** After the project's own checks, it checks the result the way
  the user will meet it: run the program, call the endpoint, query the service, read its logs, reproduce the failure
  and show it is gone. Harmless probes of the user's own systems (a status query, a test request, a connection check)
  need no asking. A check is left to the user only when it truly needs them (their device, their account, a real
  customer), with why. The answer says how the agent knows, measured rather than inferred.
- **"Sending messages" becomes "messaging people".** What needs asking is what cannot be undone or reaches other
  people. Test traffic to the user's own systems is neither.
- **An answer that leaves a check to the person goes back once.** Before the request ends, the claim check's reading
  (0095) finds a sentence where the agent says it did not test, verify or confirm something, or that the person has
  to, or "the last mile". Suggestions ("you can try it with npm start") do not count. The agent is sent back once with
  that sentence, to make the check itself if any harmless way exists, or keep it and say in one line why only the
  person can. A notice tells the person. It applies in Code mode, to a request that ran tools, when the checks before
  finishing are on, and like 0124's send-backs it asks for the whole answer again.
- **The chat shows the work as the agent told it.**
  - The work log is split into what the agent said, the notices, and batches: the steps between two of those
    (`logBlocks`). A call with no words before it keeps its batch going.
  - What the agent said reads like its answer: same size and colour.
  - Each batch is one quiet line that opens on a click. A batch of one step shows that step: a command by the
    description the agent gave it, a file by its name, anything else by its name and input. A batch of more says what
    they did, in the order each kind began, naming one or two files ("Read loop.ts, ran 2 commands", "Edited
    prompt.ts and ui.ts", `batchSummary`). The lines the batch changed sit beside it, and a mark says when a step in
    it failed or was declined.
  - While a step of a batch is at work, the batch's line says that step, with the clock of 0125 and a spinner. The
    live line with the dice stays under it.
  - A batch of one step opens with its step open. Find opens the batch that holds the words, as it opened the log.
  - Nothing folds when the request ends. "Worked for 12m 9s" and what the request used move under the answer, where
    the live line was. Side chats show their work the same way.

## Consequences

- A thread reads like Claude's: the agent's reasoning between its steps is in view, and the steps take one line each.
  A long request is longer on the page than one folded line, as it is in Claude.
- The words between batches cost output tokens on every batch: one to three sentences, some 30 to 60 tokens. The
  instructions grow by about 650 characters (full) and 340 (short), inside both ceilings.
- An answer that leaves a check to the person costs one more model call, once a request. An English sentence is
  needed for it to be found; an answer in another language is not sent back.
- A model may now probe what it reaches without asking, within the sandbox and the permission policy, which still
  decide what runs: a probe is a command or a fetch like any other.
- An earlier answer the agent was sent back from now shows as words in the log, so the answer can be read twice. The
  reply after the last step is still the answer that Copy takes.
- Tests:
  - `claims.test.ts`: what leaves a check to the person, and what does not.
  - `check-gate.test.ts`: the send-back once, with the sentence; quiet without steps, outside Code mode and when the
    checks are off.
  - `prompt.test.ts` and `budget.test.ts`: the new instructions in both texts, inside the ceilings.
  - `turns.test.ts`: the blocks of a log and what a batch did.
  - The smoke's `story` part: what was said and each batch's line, in order, after the request; the send-back and the
    check the agent made; the words at the answer's size; a batch of two commands opening to both, a batch of one
    opening with its step open; "Worked for" under the answer. The session view and find parts follow the batches.
