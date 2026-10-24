# eNCode

An AI-first desktop IDE with an autonomous coding agent. eNCode is built in this repository,
from the editor to the shell: it is not a VS Code fork and embeds no Monaco, xterm.js or
node-pty.

![eNCode](docs/images/overview.png)

**Status:** private development, for the owner and a few testers. M0 (foundation and security),
the agent engine (M1) and the editor (M4) are in, and the app runs the agent in its own process.
Every model call goes through the router (M2). Not released. Windows is the
primary platform; the code stays cross-platform.

## What it does

- **Agent-first workspace.** A title bar with menus and Back and Forward, an icon rail, and a
  sidebar of sessions grouped by project, and chats (pin, archive, mark unread, an Activity view of what
  needs you). Beside them are a conversation with a tool timeline (Chat and Trajectory views),
  a composer with mode, approval-policy and model chips, and a Browse and Workspace panel with
  Files, Editor and Shell.
- **Everything from the keyboard.** `Ctrl+K` finds any session, action or settings page by its words. In the
  message box, `/` lists the commands (`/status`, `/model`, `/undo`, `/rewind`, `/init` and more), `@` picks a file
  and `$` a skill. A file you mention comes with your message, as the Read tool would show it, and counts as read,
  so the agent can edit it at once; only files it may read without asking come this way (inside the folder, or
  allowed by a rule), and the rest are named for the agent to read through its tools. A skill you call with `$`
  brings its instructions. `Ctrl+F` finds words anywhere in the session, folded steps and long outputs included.
  `Esc` twice stops the agent. Any shortcut can be changed: open the list with `Ctrl+/`, click one and press the new
  keys.
- **Steer it while it works.** A message sent while the agent works reaches it before its next step, with the results
  of the step it came in during (`Ctrl+Enter`, or **Steer now** on a waiting message); `Enter` queues it for after the
  turn. **Settings → General** swaps the two. A steering message goes through your hooks and brings what it mentions,
  like any request.
- **Report a request that went wrong.** The flag on any of your messages saves that request to a file you send: its
  steps, what the tools answered and the files as they were, with keys taken out and, by default, every word replaced.
  The person who gets it replays it call by call and keeps it as a test.
- **Problems in plain words.** A request that fails ends on one sentence that says what happened, with what can be
  done about it: **Retry** (the same request runs on from where it stopped), **Switch model**, **Open Settings** or
  **Save diagnostics**. What the provider or the system said is folded under **Details**, without keys. Toasts and
  Settings checks speak the same way, and a test keeps raw error text out of the window.
- **Chats.** `Ctrl+Alt+O` (**File → New chat**) starts a session that belongs to no project. It works in a folder of
  its own, `Documents\eNCode` unless you choose another under **Settings → General**, so the files it makes are kept,
  and its tools follow the same rules as in a project. Chats are listed under **Chats** in the sidebar.
- **Settings as a page.** `Ctrl+,` opens Settings over the app, which stays as it was under it while the agent keeps
  working. Search any setting from the page or from `Ctrl+K`, and a change is kept as you make it: no Save. Choose
  whether `Enter` or `Ctrl+Enter` sends, Windows notices when a request finishes or the agent needs you (they say which
  session, never what the agent wrote), the taskbar button flashing while it waits for you, and keeping the computer
  awake while an agent works. **Archived sessions** restores or deletes what you put away.
- **A coding agent with real tools.** The agent follows Claude Code's tool contracts:
  - files: `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, and `CodeMap`, which shows where
    things are defined without reading files (a map of the project or a folder, a file's outline, or where one name
    is defined and which files use it; FiveM's events, commands, callbacks and exports included). With `package` it
    reads an installed dependency's API at the version installed (npm, Python, Rust, Go, FiveM resources), or one of
    FiveM's natives, and the first message names the versions installed. Read shows images,
    Jupyter notebooks cell by cell, and PDFs page by page with their outline, through eNCode's own PDF reader; a
    model that reads PDFs also gets the pages that have figures or scans, as the pages themselves;
  - commands: `Bash` in the operating system's shell, with background jobs (`BashOutput`,
    `KillShell`), and `Monitor`, which turns the lines of a command into events the agent hears;
  - delegation: subagents through `Task`, in the foreground or the background, continued with `SendMessage`;
  - time: `ScheduleWakeup` brings the agent back to a session when it asked to be, also after eNCode restarts;
  - planning: `TodoWrite`, goals, `EnterPlanMode` (it asks you first), `ExitPlanMode`;
  - knowledge: `Skill`, `WebSearch`, `WebFetch`;
  - questions: `AskUserQuestion`;
  - code intelligence: `LSP` (definitions, references, hover, symbols, calls, diagnostics, code actions) and
    `LSPEdit` (renames across files, code actions), through the language servers on your computer or installed by eNCode;
  - worktrees: `EnterWorktree` and `ExitWorktree` keep the agent's work on a branch of its own, apart from your checkout.

  After every edit the agent is told what the language servers say it broke, and a turn that would end with errors it
  made goes back to it to fix them (once by default; **Settings → Language servers**).

  When a request changed code, the project's typecheck and tests run before the agent finishes, unless it ran them
  after its last change: a new failure goes back to it to fix (twice by default; **Settings → Agent → Checks**), and
  one that was there before the request is left alone and said so. Its last reply is checked too: "all tests pass"
  with no passing run, a file that does not exist, or a function a file does not hold sends it back once to check.

  Then the lines the request added are scanned for what is often a security bug (a key in the code, SQL or a shell line
  joined from a value, `eval` of input, TLS checks off, a FiveM server event that pays out what the client sends), and
  for smaller models the Reviewer reads the change against the request before you see the answer: a serious finding,
  or a case no test covers, goes back to the agent once. It reads a plan before you do, too
  (**Settings → Agent → Reviewer**: smaller models, always or never).

  A command that cannot easily be undone (a recursive delete, `git reset --hard`, a push, a publish, a deploy, a
  dropped table) that would run without you seeing it, under Full access or a rule that allows it, is put to the
  agent's model once more with only your requests; if it does not confirm, you decide. Bigger work in a project with
  tests starts from the tests. When you set a rule ("always use pnpm") or a command failed and another worked, eNCode
  offers lines for the project's instructions file below the answer, written only when you click Add.

  For a hard change, `/best 3 <request>` has the agent make up to four attempts side by side, each in a git worktree
  of its own that starts from the project as it is, uncommitted work included. The Reviewer compares what each changed,
  with its checks and scan, and picks one; nothing in the project changes until you click Keep on the attempt you
  want, which Undo and Rewind can take back like any of the agent's changes. Discard all removes them.

  A long result (a build log, a test run) is kept whole in a file: the agent reads its start and end, and reads on by
  range when it needs the middle. A long file read whole shows its start and a list of what the rest defines, by line.
  The head of each request's work log shows what it cost: tokens, how much came from the prompt cache, and dollars
  when the provider says.

  In a long session the outputs of old steps are shortened early and seldom, so the prompt cache keeps working, and
  each says where the whole of it is; after a summary the files the agent worked on are read again for it. Strong
  models (Claude Opus and Sonnet, GPT-5, Gemini Pro, Grok 4) get short instructions with the same rules, and
  **Settings → Roles** suggests the smaller model of Main's family for the small jobs. Roles nobody set follow Main, so
  they never go to the free models unless you choose them.

  It works in Code, Ask and Plan modes. It runs in its own process, so a hung tool cannot freeze
  the window, and every session is an append-only log that survives a crash and can be forked.
- **Computer use (Windows).** Off until you turn it on under **Settings → Agent**. The agent can then look at an
  application, read its controls and use the mouse and keyboard in it, one application at a time, only after you allow
  that application. A banner shows while it works, and its **Stop** button or **Ctrl+Alt+Esc** ends it from any
  window, as does using the mouse or keyboard yourself. Terminals, password managers, eNCode itself and programs
  running as administrator are never used, and screenshots are never saved.
- **Review before it acts.** Four approval policies decide what runs unasked:
  - Read Only: edits and commands are refused.
  - Workspace Write: every command asks.
  - Auto review: provably read-only commands run unasked, and a second model, the Reviewer, approves other low-risk
    commands that fit your request. Everything else asks you, and some commands are never put to the Reviewer.
  - Full access: nothing asks.

  Approval cards say why they ask, and edits show their diff first.
- **Rules you set, and folders you trust.** **Always allow** on an approval saves a rule for exactly what you
  approved, in your private settings for the project unless you choose another place, and the same command runs
  unasked from then on. **Settings → Permissions** lists the rules, takes new ones (allow, always ask, never allow)
  and shows whether the folder is trusted. A folder you open is not trusted: its own settings can take
  permissions away but cannot give any until you trust the folder and approve what they say, and a banner tells
  you when a pull changed them. If a settings file cannot be read, nothing runs in that folder until it is fixed.
- **Hooks, and a way back.** Commands you set under `hooks` in a settings file (Claude Code's format) run before and
  after tool calls, when you send a message, when the agent stops, waits for you, starts a subagent, and when a
  session ends; a `PreToolUse` hook that exits with 2 refuses the call. A project's hooks wait until you trust the folder. Every file the agent's tools change is kept first, so
  the **Rewind** button on any of your requests can put the files back to before it, and the conversation with them if
  you like; a file you edited since is left alone unless you say otherwise, and **Undo** brings the changes back.
  Changes made by commands (installs, builds, git) are not recorded.
- **Its own look.** Dark or light (or follow Windows), four accents, high contrast,
  compact density and reduced motion, under **Settings → Appearance**. Text is in Windows' own
  fonts at Codex's sizes (Segoe UI 14 px, Consolas 12 px); choose eNCode's Inter and
  JetBrains Mono, any installed font, or other sizes there. The icons and the Trace N logo are
  drawn for eNCode.
- **Any model.** It works with any OpenAI-compatible endpoint and OpenRouter's catalog
  (including free models), with presets for DeepSeek, OpenAI, Ollama and LM Studio. Long
  sessions are compacted into a summary instead of failing at the context limit.
- **Its own editor.** Not Monaco or CodeMirror. Files open into a virtualized editor with
  tokenizers for 35 languages, multiple cursors, find and replace, undo that survives tab
  switches. Files up to 256 MB open and stay quick (a 100 MB file opens in under a second and is coloured on another
  thread), and a minified file's one long line can be typed in and scrolled to its end. Long lines wrap onto rows
  with Alt+Z (at the window's edge or a column), and spaces and tabs can be shown as faint marks. Input methods
  compose in place at every cursor, a screen reader reads the lines around the cursor, and the editor keeps to
  Windows' scaling and contrast themes. Characters that make text read differently from how it is stored (bidi
  controls, zero-width and hidden characters) are drawn as labelled markers, and right-to-left text reads in its own
  order only inside strings, comments and prose, when you ask for it. eNCode sees which languages a folder uses and
  installs their servers with one click when you ask: from pinned sources, checked and unpacked by eNCode itself, with
  no npm or Node.js needed. FiveM resources read as FiveM runs them: CfxLua's syntax, the runtime, the manifest's
  directives and, once installed, every native with its parameters and notes, written from Cfx.re's own typings. JSON (with its schema), CSS, SCSS, Less and
  HTML are read by eNCode's own language server, with nothing to install; in a Tailwind project (a FiveM resource's web
  page included) Tailwind's own server runs beside it for class names, and Svelte files get Svelte's server, each
  installed with one click. Once typing pauses, a model of your choosing suggests the rest of the line or a short
  block as faded text, taken with Tab, a word at a time with Ctrl+Right, never sent with files that hold secrets. In a
  folder you trust, the language servers (typescript-language-server, pyright,
  rust-analyzer, gopls, clangd, lua-language-server, Eclipse JDT LS and more) mark
  errors and warnings as you type, suggest as you type (with snippets and the imports they need), show a call's
  parameters and what a name is on hover, and take you to a definition or list its uses in a peek, with Back and
  Forward. F2 renames across the project with a preview and one Undo for the whole change; Ctrl+. and a lightbulb
  offer the servers' fixes and refactorings; imports are organized and files formatted (on save and as you type, if
  you want); a Problems panel and F8 go through every problem. Breadcrumbs and an outline show where the cursor is
  among the file's symbols; Go to symbol finds one in the file or the whole folder, and a call hierarchy follows
  callers and calls a level at a time. Blocks fold as the server says (imports, comments, regions) or by indentation
  without one, the blocks you are in stay pinned above the text as you scroll, brackets are coloured by depth, and a
  minimap shows the whole file. Inlay hints show the types a server worked out and the names of parameters among the
  text, and names are coloured by what the server knows them to be, deprecated ones struck through. eNCode talks to
  them through its own client and
  carries none of them. The editor can also show a change against a
  baseline hunk by hunk with Keep and Undo; that review is wired to the agent's edits as the
  agent core lands.
- **Hand-written internals.**
  - the editor: a text model, an editing engine, a DOM view and tokenizers;
  - the eNCode Shell (an interpreter, not cmd.exe or PowerShell);
  - an ANSI terminal buffer;
  - a Myers diff;
  - a markdown renderer and a state store.

## Quick start

Requires Node.js 22.12 or newer (24 recommended) and pnpm 10. `corepack enable` installs the
pnpm version pinned in `package.json`.

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm dev` runs the renderer with hot reload and restarts Electron when the main process
changes.

Open a folder and start a session. On a first start a **Connect a model** window asks how eNCode
should reach a model: free models on a free OpenRouter key, a key or a local server of your own, or the
**Demo (offline)** agent, which needs no key: its plan is scripted, but its tools act on the real
workspace, so you can try approvals, diffs and the shell straight away.

## Models

The model button in the message box lists what is in use, the free models and each connection's
models, and opens the Connect window again. Every model call goes through the router
(`@encode/router`), which ranks models, fails over, learns what a provider refuses and keeps
a billed model from ever being tried after a free one or on another key
([ADR 0052](docs/adr/0052-every-model-call-goes-through-the-router-keys-are-asked-for-by-origin.md)):

- **Settings → Roles** sets *Only use free models*, which model does which job (writing,
  exploring, planning, reviewing, summarizing, small tasks) with a fallback order, and shows how
  each connection is doing.
- **Effort** sets how hard a role's models think, from Low to Max: the chip under the message box, `Ctrl+Shift+M` and
  `/effort` set it for the main role, and **Settings → Roles** for each role. A model without a reasoning setting
  ignores it, and a role left alone is left to its model.
- **Reasoning models** get their own reasoning back as their providers ask
  ([ADR 0099](docs/adr/0099-each-model-family-gets-its-own-reasoning-back-and-is-asked-in-its-own-terms.md)):
  DeepSeek, Kimi and GLM in `reasoning_content`, MiniMax in its `<think>` block, Gemini's thought signatures on its
  calls, and Claude's and Gemini's through OpenRouter as `reasoning_details`, so a task with tools goes on where
  DeepSeek or Gemini 3 stopped at the second step. Only the model that wrote the reasoning is sent it. The temperature
  is not sent to Kimi, MiniMax or Gemini 3, which choose their own, and an effort goes to DeepSeek and Kimi in their
  own words.
- **Settings → Models** edits the connections. Presets for the Connect window:

| Preset | Base URL | Example model |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | pick from the catalog (`:free` models cost nothing) |
| Anthropic | `https://api.anthropic.com` | pick from the list |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Ollama | `http://localhost:11434/v1` | `llama3.2` |
| LM Studio | `http://localhost:1234/v1` | your loaded model |

An address is `https://`, or `http://` for a server on this computer. An endpoint implements
`POST {baseUrl}/chat/completions` with OpenAI tool calling, or Anthropic's Messages API. Streaming is
preferred, and servers that answer with a single JSON body work too.

API keys are sealed by the operating system's keychain (DPAPI on Windows) and never written in
any other form. Where no keychain is usable, Settings says so and keeps the key for the
current session only. A key is bound to its server: pointing a profile at another server
drops it.

The agent runs in a separate process. It asks the main process for the key when a model request
starts, gets it only for the server it was entered for, and does not keep it. That process uses
Node's networking, which does not read Windows' proxy settings, so a network that requires a
proxy does not work yet ([ADR 0030](docs/adr/0030-the-agent-runs-in-a-host-that-clients-drive.md)).

## The eNCode Shell and the agent's shell

The terminal panel runs a hand-written shell. It supports pipelines, `>` and `>>`, `;`, `&&`,
`||`, quoting and its own built-ins (`ls`, `cat`, `echo`, `cd`, `mkdir`, `cp`, `mv`, `rm`,
`head`, `tail`, `wc`, `which`, `env`, `set`, …). Other programs are found only in absolute
`PATH` entries and started by absolute path. npm-style `.cmd` shims run through cmd.exe only
when their arguments are plain.

It is line-oriented, not a PTY, so full-screen programs such as vim and less are not
supported.

The agent's `Bash` tool does not use it. It runs the operating system's own shell, so commands
mean what models and project scripts expect: bash on macOS and Linux; on Windows PowerShell 7
(or Windows PowerShell), which the sandbox can confine, and Git Bash when the sandbox or its
"Run commands in PowerShell" switch is off; or the shell that `ENCODE_SHELL` names
([ADR 0011](docs/adr/0011-agent-commands-run-in-the-os-shell.md)). Approvals read the command
before it runs, and the operating system's sandbox limits what it can change
([ADR 0063](docs/adr/0063-the-agents-commands-run-in-the-operating-systems-sandbox-and-the-person-is-told-what-it-does-not-hold-back.md)).

## The side panel and the bottom panel

The side panel holds tabs: **Files** (the explorer, search and source control), **Editor**,
**Review**, **Browser**, **Terminal** and **Trajectory**. `Ctrl+T` opens a New tab page to choose from, and a
Browser tab remembers its page, so `Ctrl+Shift+T` brings a closed one back where it was. The tab
shows a page in a frame and lifts the framing rules (`X-Frame-Options`, `frame-ancestors`) from
what that frame loads, so sites that forbid framing do not leave it blank. That is a stopgap until
the browser gets a view of its own.
`Ctrl+Alt+F` makes the panel full width, `Ctrl+Shift+B` cycles split, full and hidden, and
`Ctrl+Alt+B` hides it. A hidden panel stays alive: a browser keeps its page and a terminal its
shell.

`Ctrl+J` shows the bottom panel, which holds the terminal and the background jobs the agent
started. Tabs, layout and widths are remembered between runs
([ADR 0015](docs/adr/0015-one-tab-model-for-the-side-and-bottom-panels.md)).

## The Review tab

**Review** (`Ctrl+Shift+G` or the rail's Review button) shows the open repository's changes as diffs: **Unstaged**,
**Staged**, the **Branch** against its base, or one **Commit**. Lines are
coloured as in the editor, the words that changed are marked, and the layout is unified or side by side.

- Stage, unstage or revert a whole file, or one hunk at a time. A hunk is put into git's index exactly as it is shown,
  line endings included, and an action on a file that changed since it was shown is refused and the review is read
  again. A revert can be undone with **Undo** on its notice or `Ctrl+Z` in the tab; a new file that is reverted goes
  to the Recycle Bin.
- Comment on any line with the `+` beside its number, then **Send** the comments to the agent as one message (they
  wait for the end of a turn that is running).
- **Commit…** drafts a message from the staged changes with the Small tasks model; edit it, then **Commit** or
  **Commit and push**. Nothing is committed until you press one.
- `F7` and `Shift+F7` move between changes. Lockfiles and other generated files start folded.
- **Ask the Reviewer** (the tab's button, `/review` or the palette) sends the change to the model of the Review role,
  in one request with no tools, and its findings land on their lines as comments with a priority (P0 to P3), beside
  yours, to send to the agent or delete. The change is read as data, never as instructions; lock and minified files are
  left out.

The tab runs git itself, with the settings that stop a repository's config from starting programs when it is read
([ADR 0064](docs/adr/0064-the-review-tab-reads-git-itself-and-stages-a-hunk-the-way-git-add-p-does.md)). Committing
runs the repository's hooks, as git does.

**Last turn** (in the scope menu, and what **Review changes** under a reply opens) shows what one request of the
conversation changed with the agent's file tools, from the agent's own record, so it works in a folder without git
too. A chip beside it picks an earlier request. Revert a hunk, a file or everything the request did; each revert can be
undone. A file a later request changed again, or whose earlier version eNCode could not keep, is marked **Read only**
with the reason. **Undo** on the latest change card opens the Rewind dialog on putting that request's files back. A
card's view lasts until you close the tab; the tab opens again on the scope you picked from the menu
([ADR 0065](docs/adr/0065-the-turn-view-reads-the-agents-record-and-writes-back-only-over-what-the-person-saw.md)).

## Shortcuts

`Ctrl+/` lists every shortcut and the menus show them next to each command. Click a shortcut in that list and press
the new keys to change it; **+** adds another, **Reset** puts one back and **Reset all** every one (with Undo). A key
another command has asks before it moves, and keys that typing, every text field or Windows need (a plain letter,
`Ctrl+C`, `Alt+F4`, the computer tool's `Ctrl+Alt+Esc`) cannot be used. Your shortcuts are kept with your settings
([ADR 0067](docs/adr/0067-steering-goes-through-what-a-request-goes-through-the-reviewer-reads-the-change-as-data-and-a-shortcut-leaves-typing-alone.md)).
The main ones as shipped:

| Action | Shortcut |
| --- | --- |
| Command palette: sessions, actions and settings pages | `Ctrl+K` or `Ctrl+Shift+P` |
| New session, new chat | `Ctrl+N`, `Ctrl+Alt+O` |
| Open a folder | `Ctrl+O` |
| Go to file (`@` a symbol, `#` a symbol of the folder, `:` a line, `name.ts:12`) | `Ctrl+P` |
| Go to symbol in the file / in the folder | `Ctrl+Shift+O` / `Ctrl+Alt+T` |
| Choose the model, the effort | `Alt+M`, `Ctrl+Shift+M` |
| Send a message | `Enter`, or `Ctrl+Enter` if you choose it in Settings → General |
| Steer the agent now, queue a message (while it works) | `Ctrl+Enter`, `Enter` (swapped in Settings → General) |
| Find in the session, next and previous match | `Ctrl+F`, then `Enter` / `Shift+Enter` (or `F3` / `Shift+F3`) |
| Plan mode on or off | `Shift+Tab` (in the message box) |
| Stop the agent | `Esc` twice (in the message box or on the conversation) |
| Save the active file | `Ctrl+S` |
| Settings | `Ctrl+,` |
| Show or hide the sidebar / the side panel / the bottom panel | `Ctrl+B` / `Ctrl+Alt+B` / `Ctrl+J` |
| New / close / reopen a side panel tab | `Ctrl+T` / `Ctrl+W` / `Ctrl+Shift+T` |
| Next / previous tab, tab 1 to 9 | `Ctrl+Shift+]` / `Ctrl+Shift+[`, `Ctrl+1` to `Ctrl+9` |
| Side panel full width / cycle split, full, hidden | `Ctrl+Alt+F` / `Ctrl+Shift+B` |
| Activity view | `Ctrl+Alt+U` |
| Search across files | `Ctrl+Shift+F` |
| Show files / chat / the terminal | `Ctrl+Shift+E` / `Ctrl+Shift+X` / `` Ctrl+` `` |
| Show the Review tab | `Ctrl+Shift+G` |
| Back / forward over the sessions you opened | `Ctrl+[` / `Ctrl+]` (or the mouse buttons) |
| Next / previous recent session | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Go to session 1 to 9 | `Alt+1` to `Alt+9` |
| Next session that needs you | `Ctrl+Alt+A` |
| Rename, pin, archive, mark unread | `Ctrl+Alt+R`, `Ctrl+Alt+P`, `Ctrl+Shift+A`, `Ctrl+Shift+U` |
| Zoom in, out, reset | `Ctrl+=`, `Ctrl+-`, `Ctrl+0` |
| Full screen | `F11` |
| Find, replace in the file | `Ctrl+F`, `Ctrl+H` (in the editor) |
| Go to a line, `line` or `line:column` | `Ctrl+G` (in the editor) |
| Comment the line, indent, outdent | `Ctrl+/`, `Ctrl+]`, `Ctrl+[` (in the editor) |
| Move a line, copy a line | `Alt+Up`/`Down`, `Shift+Alt+Up`/`Down` (in the editor) |
| Select the next occurrence, all occurrences | `Ctrl+D`, `Ctrl+Shift+L` (in the editor) |
| Add a cursor above or below | `Ctrl+Alt+Up`/`Down`, or `Alt`+click (in the editor) |
| Delete the line | `Ctrl+Shift+K` (in the editor) |
| Callers of a function, what it calls | `Shift+Alt+H` (in the editor) |
| Fold / unfold the block, fold / unfold everything | `Ctrl+Shift+[` / `Ctrl+Shift+]`, `Ctrl+Alt+[` / `Ctrl+Alt+]` (in the editor) |
| Move through the breadcrumbs | `Ctrl+Shift+.` |
| Leave the editor with the keyboard | `Esc`, then `Tab` (a plain `Tab` indents) |

The editor takes its own keys while it has focus, so `Ctrl+/`, `Ctrl+[` and `Ctrl+]` comment
and indent there instead of listing the shortcuts and moving between sessions, and `Ctrl+Shift+[`
and `Ctrl+Shift+]` fold instead of moving between the side panel's tabs.

Opening a folder, or a session from another project, is refused while any session runs or
waits for you: the agent works in the open folder, so switching would point its edits at the
wrong project. Stop it or let it finish first.

## Repository layout

```
apps/desktop/                 the Electron app (@encode/desktop)
  electron/                   main process: window, IPC, services, the supervisor of the agent host
    agent-host/               the agent host's program (a utility process) and the main process side that runs it
    services/                 shell, workspace, settings and key vault, models, git, programs, skills, schedules
  src/                        renderer: components, stores, editor, terminal, markdown
    commands/                 the command registry: one list behind the menus, shortcuts and dialogs
    components/shell/         title bar and menus, icon rail, session sidebar, shell dialogs
    components/panels/        the side and bottom panels: tab strip, pages, New tab
    editor/                   the open documents: text, history and what is on disk; the language servers' marks, and
                              (assist/) suggestions, parameter hints, the symbol's places and the history of jumps,
                              rename, code actions and formatting, the outline; the Problems list and F8, the
                              symbols' ranking and the call hierarchy's rows; the record of each file's edits for
                              Report editor issue. The rest of the app reaches all of it through surface.ts and
                              surface-view.ts only (ADR 0088)
    palette/                  the command palette's and Go to file's ranking and modes, as pure functions
    panels/                   which tabs are open and how the panel is laid out, as pure functions
    theme/                    design tokens, appearance, bundled fonts and their licences
    styles/                   one stylesheet per area, in cascade order (index.css)
    ui/                       eNCode's icons, logo and shared controls
  shared/                     types and appearance rules shared by main, preload and renderer
  build/                      the app icon: icon.svg and the script that renders it
  scripts/                    build, dev, e2e harness, smoke, fake provider
  test/fixtures/              the workspace the smoke opens (copied, never edited)
apps/gateway/                 the free-tier gateway on Cloudflare Workers (@encode/gateway)
packages/accounts/            GitHub sign-in, sessions and Connect OpenRouter for the app
packages/bench/               the agent's benchmark: tasks with hidden checks, runs on the app's agent host, reports and their comparison, and the replay of a reported request (@encode/bench)
packages/checkpoints/         what the file tools changed, saved before each change, and put back on request (the Rewind dialog's engine)
packages/config/              settings files, workspace trust and saved rules
packages/core/                the agent: loop, approvals, compaction, sessions, memory, subagents, host
packages/diff/                Myers diff, hunks that apply and unapply, word diffs (@encode/diff)
packages/editor/              the editor without a DOM: state, commands, search, highlighting, review (@encode/editor)
packages/editor-view/         the editor's DOM view, themed by CSS variables and tested in Chromium (@encode/editor-view)
packages/gateway-protocol/    the gateway's wire contract, shared by the app and the gateway
packages/git/                 the Review tab's git: a scope's changes read and diffed, hunks staged and reverted, commits and pushes; the agent's worktrees, made with hooks off (@encode/git)
packages/hooks/               user hooks in Claude Code's format, run in the agent's shell and environment
packages/lsp/                 eNCode's language server client: the wire format, document sync, lookups, rename and code action plans, and a hub per folder that finds, starts and stops the servers (@encode/lsp)
packages/mcp/                 the MCP client: stdio, Streamable HTTP and SSE, with per-server approval; the app runs it through the workspace package's hub
packages/permissions/         shell grammar, command policy, egress and path rules
packages/protocol/            RPC over any message port, and the JSON Schema checks
packages/providers/           the model conversation, adapters (OpenAI-compatible, Anthropic), DirectClient
packages/router/              roles as ordered model lists, health and failover, the free model pool
packages/testkit/             seeded property testing that shrinks failures, and fuzzing
packages/text/                the text model: an immutable line tree and change sets (@encode/text)
packages/tools/               the agent's tools: files, search, the OS shell, jobs, the web (fetch, and search through DuckDuckGo, Brave Search, Tavily or Exa), and the Computer tool with its Windows helper
packages/workspace/           a folder's permissions as one snapshot (settings, trust, rules, hooks), what the Permissions screen may do, the record behind Rewind, and the folder's MCP servers with what the MCP screen may do, and its language servers with the changes they make for the editor
docs/adr/                     architecture decision records
docs/gateway-protocol.md      the gateway protocol, in prose
docs/security/                threat model
scripts/                      repository tooling: test runner, fuzzing, edit traces, source checks
```

## Development

```bash
pnpm typecheck                # every package
pnpm test                     # unit tests (node:test); pnpm test shell compaction filters by path
pnpm test:browser             # the editor view in a real Chromium over the DevTools protocol
pnpm fuzz --seconds 300 editor  # every property check on fresh seeds for that long (all of them without a path)
pnpm traces                   # the editor's regression traces, made again from git history
pnpm build                    # renderer with Vite, main and preload with esbuild
pnpm e2e                      # the full smoke against the built app, in a throwaway sandbox
pnpm perf                     # how smooth the interface is: frames while a long answer streams, scrolls and a panel is dragged
```

`pnpm e2e` copies `apps/desktop/test/fixtures/demo-project` to a temporary folder, gives
eNCode a temporary profile, and drives the real UI over the Chrome DevTools Protocol. The run
covers:

- the editor: what is drawn equals the file, typing, saving and undoing against the file on
  disk, find, quick open, go to line, the context menu, a change from disk that keeps the
  cursor, and the discard prompts; random editing of a file with Windows line endings, saved and
  then undone back to the same bytes;
- the demo agent;
- the shell, running `node` and `npm`;
- a streaming provider (`scripts/fake-provider.mjs`) with approvals and diffs, and what the
  model is sent: Claude Code's tool names, and the project's instructions as a reminder;
- the key path, and the first start: the Connect window, a model of one's own checked with a real
  tool call, the model menu and the Roles tab;
- the session logs on disk (readable only by the user, no key in them) and the import of an
  earlier build's sessions;
- sessions, subagents and Stop;
- `WebFetch` approvals;
- permissions: "Always allow" saving a rule and trusting the folder, the same command then running unasked while a
  different one asks, settings that arrive from a pull waiting behind a banner, the Permissions screen, a rule added
  and removed by hand, and trust taken back;
- hooks and rewind: a folder's hooks staying quiet until it is trusted, then logging each prompt and change of a file
  while a guard refuses a command before it asks; the Rewind dialog putting the agent's changes back (files only), Undo,
  a file edited since being left alone, and going back in the conversation too;
- compaction, with a model whose window is only a little larger than eNCode's own instructions and tools;
- the About box (version and commit) and the diagnostics report, which must hold no key.

Screenshots and the Electron log land in `apps/desktop/screenshots`. Set
`ENCODE_SMOKE_OFFLINE=1` to skip the one check that needs the internet.

`pnpm perf` runs the same harness with `apps/desktop/scripts/perf.mjs`: it streams a long markdown
answer (the fake provider's `long-reply`, about 2,000 pieces at 300 a second) into a thread that
grows with each run, then scrolls the thread and drags the side panel's edge, and prints the
frames drawn and the slowest ones (a frame is 16.7 ms at 60 Hz), with the script, layout and
style time per second. It also checks that the streamed answer came out whole and in order.
Compare runs on one machine: a machine without a GPU is slower than a PC.

`pnpm test:browser` needs a Chromium-based browser (it finds Chrome or Edge, or takes
`ENCODE_BROWSER`) and writes screenshots to the folder named by `ENCODE_SHOTS`.

Property checks (`@encode/testkit`, [ADR 0082](docs/adr/0082-the-editor-is-held-to-its-invariants-by-shrinking-properties-timed-fuzzing-real-edits-replayed-and-random-use-of-the-browser-and-the-app.md))
run 200 cases each on a fresh seed (`ENCODE_PROPERTY_RUNS`, `ENCODE_PROPERTY_SEED`). A failure is made smaller
before it is reported, with the seed that replays it. `pnpm fuzz` runs them for longer and lists each one's case count
and failures. The editor's regression suite replays real edits (`packages/editor/test/traces`), and the browser tests'
random use takes `ENCODE_MONKEY_STEPS` and `ENCODE_MONKEY_SEED`; the end-to-end run's random editing takes
`ENCODE_SMOKE_SEED`, and it also opens and edits eNCode's own files.

A tester's **Help → Report editor issue…** file replays with `pnpm editor-issue report.json`, every invariant checked
after every step ([ADR 0088](docs/adr/0088-report-editor-issue-replays-what-was-recorded-and-the-app-reaches-the-editor-through-a-fixed-interface.md)).
Once the bug is fixed, `pnpm editor-issue report.json --keep <name>` adds its trace to the regression suite.

The agent has a benchmark of its own (`packages/bench`,
[ADR 0092](docs/adr/0092-the-agent-is-measured-by-a-benchmark-of-its-own-and-a-reported-request-replays-into-it.md)):
small projects with a request and hidden checks, run on the app's own agent host. `pnpm bench run --reference` proves
the tasks without a model; `pnpm bench run --model openrouter:<id>` (or `@free`, `anthropic:<id>`, `openai:<id>`,
`--base-url <url>`) runs them on one, with the key from `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
or `ENCODE_BENCH_API_KEY`, and writes a report to `bench-results/`: pass rate, calls, tokens, cost, tool failures.
`pnpm bench compare before.json after.json` sets two side by side. A tester's **Report a problem with this request**
file replays with `pnpm turn-report report.json`, call by call against what the tools did for the tester, without
running its commands; `--save <name>` keeps it as a task whose replay the tests then hold to.

CI runs all of the above on Windows for every pull request
([ADR 0012](docs/adr/0012-windows-first-ci.md)). Unit tests run in plain Node and may not
import Electron, so logic under test takes Electron APIs by injection.

The Computer tool's Windows helper (`packages/tools/src/computer/windows`,
[ADR 0053](docs/adr/0053-the-windows-desktop-helper-is-our-own-program-built-on-the-machine-from-source-in-the-repository.md))
is C# that is compiled on first use with the compiler Windows ships. Its arithmetic, key table
and outline rules are checked against the TypeScript from node:test on any machine with the .NET
SDK or the Framework compiler; the rest runs on Windows only, against a window of our own
(`fixture/Fixture.cs`) that records every event it receives, and `.github/workflows/desktop.yml`
runs just that part in a few minutes when the tool's code changes.

## Security

The agent is treated as a confused deputy: whatever it decides to do passes an approval
policy, and content it reads is data, never instructions.

The [threat model](docs/security/threat-model.md) lists what is protected, how, and what
remains open. The decisions behind each control are in [docs/adr](docs/adr/README.md).

## Packaging

```bash
pnpm build
pnpm --filter @encode/desktop package   # -> apps/desktop/release/: eNCode-<version>-setup.exe and -portable.exe
```

CI makes both for every run, starts each the way a tester does (`apps/desktop/scripts/packaged-smoke.mjs`,
`installer-smoke.mjs`), and keeps them for 30 days when the run is on `main`. Every build carries its version
and commit: **Help → About eNCode**, and the first line of **Help → Save diagnostics…**.
[TESTING.md](TESTING.md) is what testers are given.

Builds are unsigned, and there is no auto-update; both come with a public release, which also adds Electron
fuses.

## License

MIT, see [LICENSE](LICENSE). The license for a public release is still to be confirmed.

The bundled fonts, Inter and JetBrains Mono, are under the SIL Open Font License 1.1; their
licences are in [apps/desktop/src/theme/fonts](apps/desktop/src/theme/fonts). They are used
when chosen in Settings; the default is Windows' own fonts, which eNCode does not ship.
