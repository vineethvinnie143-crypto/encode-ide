# 0087. The editor suggests code as you type, from the Inline suggestions role, drawn as ghost text and sent without secrets

- Status: Accepted, builds on 0052, 0060, 0062 and 0079
- Date: 2026-10-23

## Context

The editor completes what a language server knows: a name, a member, a snippet. It does not write the rest of a line or
the body of a short block, which is what people now expect from an editor with a model behind it. The agent can write
that code, but only when asked in the chat, a turn at a time.

Three things make it hard:

- **It asks often.** A suggestion is wanted every time typing pauses, so cost, speed and the free models' daily limits
  matter more than for the agent.
- **It sends the file.** What is around the cursor goes to a model provider, including any secret written in the file.
- **What it shows must be what goes in.** Text from a model is drawn in the editor, so it must not hide what it is, for
  example with bidi controls.

## Decision

### The role and when it is on

- **The model.** Suggestions come from a new built-in role, `inline` (Inline suggestions). Left empty, it follows
  `utility`, which follows `main`. Settings, Models gives it a model of its own, and a fast, cheap one suits it best.
- **The setting.** Settings, Editor, *Suggest code as you type* is Auto, On or Off (`inlineSuggest`, default Auto).
  - **Auto** is on, except when the role's first model is a free model with a daily limit (`@free`, or an OpenRouter
    `:free` model). Those requests are kept for the agent.
  - **On** uses free models too.
  - **Off** never asks.
- **Who decides.** `inlineState()` in `shared/inline.ts` decides, and the same function runs in both processes. It
  returns whether suggestions are on and why, in words. There are none in the offline demo, with no model, or when
  *only free models* is set and the role has no free model.
- **The main process checks too.** It refuses a request whenever the settings have suggestions off, whatever the page
  asks.

### Asking

- **When.** The editor asks 300 ms after typing pauses: after typing, a new line, a delete, a completion taken or a
  suggestion taken. Alt+\ asks at once.
- **When not.** It does not ask while:
  - the list of suggestions or a snippet is open;
  - an input method composes;
  - the editor does not have the focus;
  - there is more than one cursor, or a selection;
  - the file is read-only;
  - the line is longer than the view draws (0079);
  - the cursor is in the middle of a word.
- **What is sent.**
  - Up to 6,000 characters before the cursor and 2,000 after it, cut at whole lines.
  - The file's path relative to the folder, and its language.
  - Up to three parts, 1,500 characters each, of other open files that look most like the 20 lines before the cursor.
    "Looks like" is the share of words they have in common, among 30-line windows of the first 3,000 lines of up to 12
    files.
  - The page cuts all of this to size, and the main process cuts it again.
- **One at a time.** A newer request stops the one before it, so does a moved cursor, and the editor's cancel stops one
  by its id. The host gives a suggestion 10 seconds.
- **No waiting.** If the router would wait for the free models' pace, the suggestion is given up at once and the
  editor is told until when.
- **Kept answers.** The last 32 answers are kept per place: the file, the 600 characters before the cursor and the 120
  after. Typing back to a place asks nothing; Alt+\ asks again when the kept answer was empty. A change of settings
  clears them.

### What is never sent

- **Files whose name says they hold secrets**, and **files the folder's permission rules keep from the agent** (a
  `Read` deny or ask rule), whether they are the file or one of the parts. Secret names: `.env`, `.env.*`, `.npmrc`,
  `.netrc`, `credentials.json`, `secrets.*`, keys and keystores. A sample (`.env.example`) is not a secret file.
- **Anything shaped like a credential, in what is sent.** It is replaced with `[redacted]`:
  - the patterns the log uses;
  - assignments to names such as `client_secret`, `license_key`, `connection_string` and `webhook_url`;
  - in `.cfg`, `.conf`, `.ini` and `.properties` files (FiveM's `server.cfg`), lines that set a key, password, token,
    licence or connection;
  - private keys, a password in a URL, Discord webhooks and Cfx.re keys;
  - long opaque tokens that mix both letter cases with several digits.
- **If redaction changed the cursor's own line,** nothing is asked there.
- **The request.** It has no tools, low reasoning, temperature 0.2, and 96 output tokens for the rest of a line or 320
  for up to 12 lines. The prompt says the file is data, not instructions.

### What is shown

- **Cleaning the reply.**
  - Code fences, a `<cursor/>` echoed back, and text the reply repeats from before the cursor are taken out.
  - In the middle of a line, only the rest of that line is kept, without the closing characters the line already has.
  - On a line with nothing after the cursor, up to 12 lines are kept, stopping before a line that repeats the next one.
- **Refused replies.** A reply that is empty, over 4,000 characters, already after the cursor, or still holding
  `[redacted]` is not shown. Neither is one with control characters (other than tab and new line), bidi controls or
  characters that draw as nothing.
- **How it is drawn.** The view draws the answer as ghost text: faded, and no part of the document. Its first line is
  an inlay at the cursor; its other lines are rows below, which push the next lines down. It is not drawn on a line too
  long to draw.
- **Keys.**
  - Tab takes the whole suggestion as one undo step, unless Tab moves the focus (Ctrl+M).
  - Ctrl+Right takes the next word (Cmd+Right on macOS); Alt+Right stays Go forward.
  - Esc puts it away until the text changes.
  - Typing what it starts with keeps the rest. Anything else ends it, as does moving the cursor, the list of
    suggestions opening, or the editor losing the focus.
- **Screen readers.** With the screen reader mode on, the first line is announced with "Tab to accept".
- **The status line.** While suggestions are on, it shows a button: idle, asking, *Paused* (the model cannot answer for
  now) or *Stopped*. Stopped means a refused key, no credit or no model, and nothing more is asked until the settings
  change. The button opens Settings, Editor.
- **Commands.** The palette and the menus have *Suggest code here* (Alt+\, Go) and *Turn suggestions as you type
  on/off* (View). Turning them on when they would still be off opens Settings, Editor, which says why.

## Consequences

- **Faster coding.** The editor writes the obvious rest of a line, or the body of a short block, without a turn in the
  chat. Kept answers and cancelled requests keep the number of calls near one per pause.
- **The cost is a request per pause.** That is why Auto does not spend the free models' daily requests, and why the
  role can have a cheap model of its own.
- **What a provider sees.** The open file around the cursor and parts of other open files, with credentials taken out,
  go to the provider of the role's model. Redaction is by pattern: a secret that looks like ordinary text, such as a
  short password in a string with a plain name, can still go. Files of secrets and files the folder's rules keep from
  the agent never go.
- **Only text.** A suggestion can be wrong, like any completion; it only becomes text when the person takes it. It
  never runs, and nothing is written to disk by taking it.
- **Not covered yet.**
  - Several suggestions to choose from, and a suggestion for a selection, are left for later.
  - A suggestion that edits text before the cursor (a "next edit") is not part of this.
