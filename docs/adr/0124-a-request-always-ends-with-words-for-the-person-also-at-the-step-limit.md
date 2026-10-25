# 0124. A request always ends with words for the person, also at the step limit

- Status: Accepted, builds on 0095 and 0109
- Date: 2026-10-25

## Context

The owner, on tester build 7: a request said "Worked for 12m 9s", showed the files it edited, and nothing else. The
answer was missing, so he had to ask again.

The chat shows a request as a work log that folds when the request ends, and the reply after its last step. A request
could end right after a step, with nothing written for the person, in three ways:

- **The step limit.** The loop stopped after its last allowed step. The session said why only in its done event. The
  chat dropped that, and the command line never printed it. The owner's settings held a limit of 12, so a long request
  hit it often. A message he sent while the agent worked did not help: the steps after it counted against the same 12.
- **A tool that ends the request.** UpdateGoal with `complete` or `blocked` ended the turn at once. Words the model wrote
  with that call sat in the work log, before the step, and folded away with it. With no words, there was nothing at all.
- **An answer the agent was sent back from.** The checks before it finishes (0095), or a beforeStop hook, send the agent
  back after it answered. Once it took more steps, that answer folded away too, and the reply after its last step was
  often only "Fixed the type error".

## Decision

- **At the step limit the agent writes its answer, with tools held back.**
  - The results of the last allowed step carry a note: that was the last step, tools are off for the next reply, and
    the reply should say what was found, what changed and how far it got, and what is left.
  - The next call keeps the tools listed (so the cached prefix holds) and sends `toolChoice: 'none'`. Text calls are not
    recovered from it.
  - A call the model makes anyway is not run. It is answered with the usual "not run" result, so the conversation stays
    valid for the next request.
  - An empty reply is not asked for again, is not kept, and does not fail the request: the session's line says why it
    stopped.
  - A pause or a failure on that call ends the request as it would on any call.
  - The loop's end carries the reply: `{ kind: 'max-steps', steps, reply? }`. A subagent reports it to its parent, and a
    best-of attempt keeps it.
  - When the limit is reached right after the agent was sent back from an answer, no closing reply is asked for: that
    answer came after its last step and stands.
- **A message the person sends while the agent works gives the request the whole limit again.** Steps count from their
  latest message. A message the agent takes after its last allowed step is taken too, instead of being left for the
  next request.
- **The chat says when the step limit stopped a request.**
  - The session adds a notice under the answer: "Stopped after 12 steps, the most one request may take." When the limit
    is under the default, it adds "The limit is set to 12; unless set, it is 200." Unless a goal goes on by itself, it
    ends with "Send a message to let it go on."
  - The entry carries `stepLimit`, and is kept with the conversation. The command line prints it like any notice.
  - In the app, while it ends the conversation and nothing runs, the line offers **Continue** (sends "Continue.") and
    **Change the limit** (Settings, Agent, Max agent steps). An older one keeps only its words.
  - The done event still carries "Stopped after 12 steps. Send a follow-up to continue." for the notification.
- **A tool that ends the request is followed by an answer.**
  - attempt_completion shows its result as the answer already, and a plan has its card, so those two are left as they
    are.
  - For any other (UpdateGoal `complete` or `blocked`): words that came with the call are shown again after the step, as
    the answer. With no words, a closing reply is asked for with tools held back. The note says what the tool reported
    and asks for what was done and how it was checked, or why it cannot go on.
- **An answer the agent is sent back from is written again at the end.** The reminder from the checks, from a finished
  attempt_completion the checks refused, and from a beforeStop hook ends with: if you take more steps, end with your
  whole answer again, since the person sees only your last reply.

## Consequences

- No request ends on a step with nothing for the person to read, unless the person stopped it or a problem says why.
- A request that reaches the limit costs one call more, and a goal round that ends on UpdateGoal without words does too.
  An answer written again after the checks costs its output tokens.
- A message sent while the agent works can make a request run longer than the limit counted from the first message.
  Only the person can do that.
- Tests:
  - `loop.test.ts`: the closing reply and its note; tools kept but not callable; a stray call answered unrun; an empty
    closing reply; the limit reached right after a send-back; UpdateGoal with and without words; the beforeStop
    reminder.
  - `session.test.ts`: the notice and its words, kept across a reopen; no "send a message" while a goal goes on; the
    whole limit again after a steer.
  - `subagents.test.ts` and `host.test.ts`: a subagent's report at its limit, and a goal round's closing reply.
  - The smoke's `limit` part: a request at a limit of two ends with its closing answer under the folded steps, the line
    and its two buttons. Change the limit opens the setting. Continue goes on with two more steps, and the earlier line
    loses its buttons. The test provider answers `tool_choice: 'none'` in words, as OpenAI does.
