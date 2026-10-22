# eNCode

An AI-first desktop IDE with an autonomous coding agent. eNCode is built in this repository,
from the editor to the shell: it is not a VS Code fork and embeds no Monaco, xterm.js or
node-pty.

![eNCode](docs/images/overview.png)

**Status:** private development. M0 (foundation and security) is in, and the agent engine (M1)
is landing as packages: the app still runs M0's agent until it is switched over. Not released yet.
Windows is the primary platform; the code stays cross-platform.

## What it does

- **Agent-first workspace.** A title bar with menus and Back and Forward, an icon rail, and a
  sidebar of sessions grouped by project (pin, archive, mark unread, an Activity view of what
  needs you). Beside them are a conversation with a tool timeline (Chat and Trajectory views),
  a composer with mode, approval-policy and model chips, and a Browse and Workspace panel with
  Files, Editor and Shell.
- **A coding agent with real tools.** The agent has these tools:
  - files: `glob`, `grep`, `read`, `edit`, `write`;
  - commands: `pwsh` (with background jobs: `job_list`, `job_output`, `job_kill`);
  - delegation: subagents through `task`;
  - planning: `todo_write`, goals, `exit_plan_mode`;
  - knowledge: `skill`, `web_search`, `web_fetch`;
  - questions: `ask_user_question`.

  It works in Code, Ask and Plan modes, and every session is persisted and can be forked.
- **Review before it acts.** Four approval policies decide what runs unasked:
  - Read Only: edits and commands are refused.
  - Workspace Write: every command asks.
  - Auto review: only provably read-only commands run unasked.
  - Full access: nothing asks.

  Approval cards say why they ask, and edits show their diff first.
- **Its own look.** Dark or light (or follow Windows), four accents, high contrast,
  compact density and reduced motion, under **Settings → Appearance**. The icons and the
  Trace N logo are drawn for eNCode, and Inter and JetBrains Mono are bundled.
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

Open a folder and start a session. The **Demo (offline)** profile needs no key: its plan is
scripted, but its tools act on the real workspace, so you can try approvals, diffs and the
shell straight away.

## Models

Open the profile menu at the bottom of the left rail and choose **Settings… → Models → Add
provider**, then pick a preset or *Custom*:

| Preset | Base URL | Example model |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | pick from the catalog (`:free` models cost nothing) |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Ollama | `http://localhost:11434/v1` | `llama3.2` |
| LM Studio | `http://localhost:1234/v1` | your loaded model |

An endpoint must implement `POST {baseUrl}/chat/completions` with OpenAI tool calling.
Streaming is preferred, and servers that answer with a single JSON body work too.

API keys are sealed by the operating system's keychain (DPAPI on Windows) and never written in
any other form. Where no keychain is usable, Settings says so and keeps the key for the
current session only. A key is bound to its server: pointing a profile at another server
drops it.

## The eNCode Shell

The terminal and the agent's `pwsh` tool share one hand-written shell. It supports
pipelines, `>` and `>>`, `;`, `&&`, `||`, quoting and its own built-ins (`ls`, `cat`, `echo`,
`cd`, `mkdir`, `cp`, `mv`, `rm`, `head`, `tail`, `wc`, `which`, `env`, `set`, …). Other
programs are found only in absolute `PATH` entries and started by absolute path. npm-style
`.cmd` shims run through cmd.exe only when their arguments are plain.

It is line-oriented, not a PTY, so full-screen programs such as vim and less are not
supported. The agent moves to the OS shell in M1
([ADR 0011](docs/adr/0011-agent-commands-run-in-the-os-shell.md)). The eNCode Shell stays
the terminal's shell.

## The side panel and the bottom panel

The side panel holds tabs: **Files** (the explorer, search and source control), **Editor**,
**Browser**, **Terminal** and **Trajectory**. `Ctrl+T` opens a New tab page to choose from, and a
Browser tab remembers its page, so `Ctrl+Shift+T` brings a closed one back where it was.
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
  electron/                   main process: window, IPC, services, agent
    agent/                    M0's loop, tools, approval, compaction, provider, prompt (replaced by packages/core)
    agent-host/               the main process side of the agent host in a utility process (not wired in yet)
    services/                 shell, workspace, settings and key vault, web, git, programs
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
packages/core/                the agent: loop, approvals, compaction, sessions, memory, subagents, host
packages/diff/                Myers diff, hunks that apply and unapply, word diffs (@encode/diff)
packages/editor/              the editor without a DOM: state, commands, search, highlighting, review (@encode/editor)
packages/editor-view/         the editor's DOM view, themed by CSS variables and tested in Chromium (@encode/editor-view)
packages/gateway-protocol/    the gateway's wire contract, shared by the app and the gateway
packages/permissions/         shell grammar, command policy, egress and path rules
packages/protocol/            RPC over any message port, and the JSON Schema checks
packages/providers/           the model conversation, adapters (OpenAI-compatible, Anthropic), DirectClient
packages/testkit/             seeded property testing
packages/text/                the text model: an immutable line tree and change sets (@encode/text)
packages/tools/               the agent's tools: files, search, the OS shell, jobs, the web
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
```

`pnpm e2e` copies `apps/desktop/test/fixtures/demo-project` to a temporary folder, gives
eNCode a temporary profile, and drives the real UI over the Chrome DevTools Protocol. The run
covers:

- the editor: what is drawn equals the file, typing, saving and undoing against the file on
  disk, find, quick open, go to line, the context menu, a change from disk that keeps the
  cursor, and the discard prompts;
- the demo agent;
- the shell, running `node` and `npm`;
- a streaming provider (`scripts/fake-provider.mjs`) with approvals and diffs;
- the key path;
- sessions, subagents and Stop;
- web_fetch approvals;
- compaction.

Screenshots and the Electron log land in `apps/desktop/screenshots`. Set
`ENCODE_SMOKE_OFFLINE=1` to skip the one check that needs the internet.

`pnpm test:browser` needs a Chromium-based browser (it finds Chrome or Edge, or takes
`ENCODE_BROWSER`) and writes screenshots to the folder named by `ENCODE_SHOTS`.

CI runs all of the above on Windows for every pull request
([ADR 0012](docs/adr/0012-windows-first-ci.md)). Unit tests run in plain Node and may not
import Electron, so logic under test takes Electron APIs by injection.

## Security

The agent is treated as a confused deputy: whatever it decides to do passes an approval
policy, and content it reads is data, never instructions.

The [threat model](docs/security/threat-model.md) lists what is protected, how, and what
remains open. The decisions behind each control are in [docs/adr](docs/adr/README.md).

## Packaging

```bash
pnpm dist                     # -> apps/desktop/release/eNCode-<version>-portable.exe
```

Builds are unsigned until the release milestone (M6), which also adds installers,
auto-update and Electron fuses.

## License

MIT, see [LICENSE](LICENSE). The license for a public release is still to be confirmed.

The bundled fonts, Inter and JetBrains Mono, are under the SIL Open Font License 1.1; their
licences are in [apps/desktop/src/theme/fonts](apps/desktop/src/theme/fonts).
