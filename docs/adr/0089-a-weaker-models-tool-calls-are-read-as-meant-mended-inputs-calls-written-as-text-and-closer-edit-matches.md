# 0089. A weaker model's tool calls are read as meant: mended inputs, calls written as text, and closer Edit matches

- Status: Accepted, builds on 0032, 0062 and 0073
- Date: 2026-10-24

## Context

eNCode is meant to get good work out of cheap and free models (DeepSeek, GLM, Kimi, Qwen, MiniMax and OpenRouter's
free pool), not only the strongest ones. Where those models lose turns is rarely the reasoning. It is the mechanics of
a tool call:

- **The wrong shape.** They send `"50"` for a number, one path where a list is asked for, `path` where the tool says
  `file_path`, `oldString` for `old_string`, or `null` for a parameter they mean to leave out. The schema check
  refuses the call, and the next try is often wrong the same way.
- **Calls written as text.** They write their tool calls in the reply's text, in the markup they were trained on
  (`<tool_call>`, `<function=…>`, DeepSeek's and Kimi's tokens). This happens when a provider's parser misses them, or
  when the model falls back to its own format. The turn then ends on a reply that only looks like work.
- **Indentation.** Their Edit's `old_string` has the right words but not the file's indentation: two spaces for a tab,
  or a method copied without its class's indent. Edit says "not found", and the model guesses again.
- **The same failing call.** They send it three, four, five times until the turn runs out of steps.

Some of this was handled already: the providers' repair of arguments that are not quite JSON, the router asking once
more after arguments it cannot read, Edit's passes for line endings, quotes and Read's line numbers (0032), and the
errors after every edit (0073).

## Decision

### Inputs read as meant

`repairInput` (`packages/protocol/src/repair.ts`) mends a call's input against the tool's schema. The rules:

- **Only a refused call is mended.** An input that passes its schema is never changed.
- **One reading only.** Each change has a single possible reading:
  - a whole number or decimal written as text, for an integer or number;
  - `true` or `false` written as text, for a boolean;
  - JSON text of a list or an object, where one is asked for;
  - one string, where a list of strings is asked for;
  - a number, where text is asked for;
  - a list of one value, where one value is asked for;
  - `null` for a parameter that may be left out, which is left out;
  - a parameter's own name in another case or style (`filePath`, `Limit`);
  - a short list of other names models use (`path`, `file` and `filename` for `file_path`; `cmd` for `command`;
    `regex` for `pattern`; and a few more). These are used only when the schema does not have that name itself, the
    call did not also send the right one, and it did not send two names for the same one.
- **Never inside a choice.** Nothing inside `anyOf` or `oneOf` is mended.
- **All or nothing.** The mended input must pass the whole schema. Otherwise nothing is changed, and the error names
  what was sent.
- **Shown and told.** The call runs as mended, and its card shows it that way, also on an approval. The result ends
  with what was read, for example `eNCode read this call as: "path" as "file_path"; "offset": "2" as 2.`, so the
  model sends it right next time.
- **Both checks.** The router's schema check (which decides whether to ask the model again) and the loop's own check
  both see the mended input.

### Calls written as text

`recoverTextCalls` (`packages/core/src/text-calls.ts`) reads a reply that has no tool call of its own for the formats
models use:

- `<tool_call>` with JSON (Hermes, Qwen);
- `<tool_call>` with `<arg_key>` and `<arg_value>` (GLM);
- `<function=…><parameter=…>` (Qwen3 Coder);
- `<invoke name="…"><parameter name="…">`;
- DeepSeek's and Kimi's tool-call tokens;
- a reply that is nothing but one JSON object, or a list of them, naming a tool of the agent, in a json fence or not.

Each call it finds becomes a tool call of that reply, and the markup is taken out of the words shown.

- **The same checks.** The calls go through every check and approval a call does. Values written in markup are text,
  and the mending above reads `"50"` as a number.
- **Left as it is:**
  - a reply that has tool calls of its own;
  - markup inside a code fence (a model showing what a call looks like);
  - JSON that names no tool of the agent;
  - markup that does not read as a call;
  - any reply whose markup is in something the model was given to read: a tool's result or a message, with Read's
    line numbers and spacing left aside. A call copied from a README or a web page is that page's words, not the
    model's.

### Edit, closer

- **Indentation.** When the exact match and the earlier passes fail, Edit looks for whole lines that differ from
  `old_string` only in their indentation, or only in trailing spaces, at exactly one place.
  - The indentation must be shifted alike on every line: more or less of the same prefix, or tabs for a fixed number
    of spaces, or the reverse.
  - `new_string` is indented the same way, line ends follow the file, and the result says what was matched and how.
  - Old text under 8 characters, a second matching place, an uneven shift, or a `new_string` line the shift cannot
    apply to leaves the call refused. The error says where the same text is with other spacing.
- **Closest lines.** When nothing matches, the error shows the closest lines of the file: the run of lines most like
  `old_string` by letter pairs, at least 75% alike. Each line that differs is shown as `old_string` has it and as the
  file has it, quoted, so a tab or a trailing space is visible. The search is skipped when it would need more than 400,000 line comparisons.

### The same failing call

`FailedCalls` (`packages/core/src/repeats.ts`) counts, per turn, the calls that fail: refused, rejected or failed when
run. From the third time the same call (same tool, same input) fails with the same error, its result ends with: "This
exact call has now failed 3 times with the same error … change what you send, try another way, or ask the user."

## Consequences

- A weaker model loses fewer turns to the shape of a call, and a model that writes calls as text works at all.
- The model is told each time eNCode read a call differently from how it was sent, so it does not come to rely on it.
- Each rule is a test (`repair.test.ts`, `text-calls.test.ts`, `files.test.ts`, `loop.test.ts`). A format a model
  family adds is one more case there.
- Open:
  - A model may write a call in a format not listed here. The Model families step tunes each family and measures it.
  - A call written as text that a model meant only as an example, outside a code fence and not copied from anything
    it read, runs like any call. It still needs the approvals its tool needs.
