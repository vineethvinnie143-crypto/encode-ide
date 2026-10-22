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
  sidebar of sessions grouped by project (pin, archive, mark unread, an Activity view of what
  needs you). Beside them are a conversation with a tool timeline (Chat and Trajectory views),
  a composer with mode, approval-policy and model chips, and a Browse and Workspace panel with
  Files, Editor and Shell.
- **A coding agent with real tools.** The agent follows Claude Code's tool contracts:
  - files: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`;
  - commands: `Bash` in the operating system's shell, with background jobs (`BashOutput`,
    `KillShell`);
  - delegation: subagents through `Task`;
  - planning: `TodoWrite`, goals, `ExitPlanMode`;
  - knowledge: `Skill`, `WebSearch`, `WebFetch`;
  - questions: `AskUserQuestion`.

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
  after tool calls, when you send a message, and when the agent stops; a `PreToolUse` hook that exits with 2 refuses
  the call. A project's hooks wait until you trust the folder. Every file the agent's tools change is kept first, so
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
  switches, and a million-line file scrolls with a native scrollbar. Characters that make
  text read differently from how it is stored (bidi controls, zero-width and hidden
  characters) are drawn as labelled markers. The editor can also show a change against a
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
**Browser**, **Terminal** and **Trajectory**. `Ctrl+T` opens a New tab page to choose from, and a
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

## Shortcuts

`Ctrl+/` lists every shortcut and the menus show them next to each command. The main ones:

| Action | Shortcut |
| --- | --- |
| New session | `Ctrl+N` |
| Open a folder | `Ctrl+O` |
| Go to file | `Ctrl+P` |
| Save the active file | `Ctrl+S` |
| Settings | `Ctrl+,` |
| Show or hide the sidebar / the side panel / the bottom panel | `Ctrl+B` / `Ctrl+Alt+B` / `Ctrl+J` |
| New / close / reopen a side panel tab | `Ctrl+T` / `Ctrl+W` / `Ctrl+Shift+T` |
| Next / previous tab, tab 1 to 9 | `Ctrl+Shift+]` / `Ctrl+Shift+[`, `Ctrl+1` to `Ctrl+9` |
| Side panel full width / cycle split, full, hidden | `Ctrl+Alt+F` / `Ctrl+Shift+B` |
| Activity view | `Ctrl+Alt+U` |
| Search across files | `Ctrl+Shift+F` |
| Show files / chat / the terminal | `Ctrl+Shift+E` / `Ctrl+Shift+X` / `` Ctrl+` `` |
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
| Leave the editor with the keyboard | `Esc`, then `Tab` (a plain `Tab` indents) |

The editor takes its own keys while it has focus, so `Ctrl+/`, `Ctrl+[` and `Ctrl+]` comment
and indent there instead of listing the shortcuts and moving between sessions.

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
    editor/                   the open documents: text, history and what is on disk
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
packages/checkpoints/         what the file tools changed, saved before each change, and put back on request (the Rewind dialog's engine)
packages/config/              settings files, workspace trust and saved rules
packages/core/                the agent: loop, approvals, compaction, sessions, memory, subagents, host
packages/diff/                Myers diff, hunks that apply and unapply, word diffs (@encode/diff)
packages/editor/              the editor without a DOM: state, commands, search, highlighting, review (@encode/editor)
packages/editor-view/         the editor's DOM view, themed by CSS variables and tested in Chromium (@encode/editor-view)
packages/gateway-protocol/    the gateway's wire contract, shared by the app and the gateway
packages/hooks/               user hooks in Claude Code's format, run in the agent's shell and environment
packages/mcp/                 the MCP client: stdio, Streamable HTTP and SSE, with per-server approval; the app runs it through the workspace package's hub
packages/permissions/         shell grammar, command policy, egress and path rules
packages/protocol/            RPC over any message port, and the JSON Schema checks
packages/providers/           the model conversation, adapters (OpenAI-compatible, Anthropic), DirectClient
packages/router/              roles as ordered model lists, health and failover, the free model pool
packages/testkit/             seeded property testing
packages/text/                the text model: an immutable line tree and change sets (@encode/text)
packages/tools/               the agent's tools: files, search, the OS shell, jobs, the web (fetch, and search through DuckDuckGo, Brave Search, Tavily or Exa), and the Computer tool with its Windows helper
packages/workspace/           a folder's permissions as one snapshot (settings, trust, rules, hooks), what the Permissions screen may do, the record behind Rewind, and the folder's MCP servers with what the MCP screen may do
docs/adr/                     architecture decision records
docs/gateway-protocol.md      the gateway protocol, in prose
docs/security/                threat model
scripts/                      repository tooling: test runner, source checks
```

## Development

```bash
pnpm typecheck                # every package
pnpm test                     # unit tests (node:test); pnpm test shell compaction filters by path
pnpm test:browser             # the editor view in a real Chromium over the DevTools protocol
pnpm build                    # renderer with Vite, main and preload with esbuild
pnpm e2e                      # the full smoke against the built app, in a throwaway sandbox
pnpm perf                     # how smooth the interface is: frames while a long answer streams, scrolls and a panel is dragged
```

`pnpm e2e` copies `apps/desktop/test/fixtures/demo-project` to a temporary folder, gives
eNCode a temporary profile, and drives the real UI over the Chrome DevTools Protocol. The run
covers:

- the editor: what is drawn equals the file, typing, saving and undoing against the file on
  disk, find, quick open, go to line, the context menu, a change from disk that keeps the
  cursor, and the discard prompts;
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
