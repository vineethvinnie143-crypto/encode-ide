# 0135. Steps that read results think at low effort, where the cache keeps

- Status: Accepted, off by default: on DeepSeek V4.1 Flash it cost 23% more per task solved, with no gain in passes beyond chance (0139); builds on 0067, 0099, 0129 and 0130
- Date: 2026-10-25

## Context

A reasoning model is asked for one effort for the whole request: the role's effort in Settings, or the provider's
default. Each step's reasoning is paid at the output price, the highest a model has, and at a high effort a step can
think for thousands of tokens. Many steps need little of that. After a Read, a Grep or a test run that passed, the next
step mostly reads what came back and makes the next call it had already planned. Thinking pays at the first step of a
request, after something failed, and in the answer.

Not every model can change its effort between steps for free:

- Claude and Gemini check their reasoning against the request it was written under (0130). A changed thinking
  setting starts the cached conversation again.
- gpt-oss writes its effort into the system message, so a changed effort changes the start of every request.
- OpenAI's, DeepSeek's and Kimi's effort is a field of the request. Their caches match the prompt, not that field.

## Decision

- **A light step** (`packages/core/src/loop.ts`). A step is light when the step before it met all of these:
  - each of its calls was Read, Grep, Glob, CodeMap, LSP, Bash or BashOutput;
  - none of its calls failed, so a command exited 0 and no edit missed;
  - nothing it found sends the model back: no language-server errors after an edit, no check's bounce, no offer of a
    stronger model.

  A light step asks for low effort. These steps keep the effort set:
  - the first step of a request;
  - the step after a message of the person's;
  - the step after an edit or a failure;
  - a step after a summary;
  - a retry;
  - the closing reply at the step limit.
- **The answer keeps its effort.** A light step whose reply calls nothing would answer, ask or stop. Its reply is
  dropped and the step is asked again at the effort set. Its text is not shown as it streams, so the person sees the
  answer once. The dropped call's tokens still count in what the request cost.
- **Only where the cache keeps** (`effortPerStep` in `packages/providers/src/families.ts`). The router's budget says
  whether the model allows a light step (`ModelBudget.effortPerStep`): an OpenAI model other than gpt-oss, or a
  DeepSeek or Kimi model, that reasons. On any other model, every step keeps the effort set.
- **The person's effort gives way only there.** The desktop puts the role's effort on every request (0067). A light
  request is marked (`CompletionRequest.light`), and the desktop leaves its low effort as it is.
- **Off by default.** **Settings → Agent → Think less on steps that read results** turns it on (`lightSteps`). It is
  turned on by default only once a benchmark run shows that the cost per solved task falls and the pass rate holds
  (0129): `pnpm bench run --model <model> --effort high --repeat 5`, then the same run with `--light-steps`, then
  `bench compare`. The report records the effort and whether steps were light. Save diagnostics lists the setting.

## Consequences

- On a model that allows it, a request that reads its way around and runs passing tests pays for low reasoning on
  most of those steps, and for full reasoning where it decides something. How much this saves depends on how long the
  model thinks at its usual effort. The benchmark measures it per task, reasoning tokens included.
- Each answer after a light step costs one more call: the dropped light reply, and the conversation sent again, mostly
  from the cache. When the steps before it saved little, this can cost more than it saves. The benchmark shows which.
- **Accuracy risks.**
  - An edit decided on a light step is made with less thought. The step after a passing command is light, and it may
    be the one that writes the fix. The pass rate in the benchmark is the check.
  - A light step's narration (0126) shows once its calls are known, not as it streams.
- Old DeepSeek reasoning is still sent back on every step. Shortening it like old outputs is a separate change.
