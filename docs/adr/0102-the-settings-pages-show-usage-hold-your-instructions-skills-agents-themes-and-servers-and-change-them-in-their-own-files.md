# 0102. The Settings pages show usage, hold your instructions, skills, agents, themes and servers, and change them in their own files

- Status: Accepted, builds on 0057, 0063, 0068 and 0093
- Date: 2026-10-24

## Context

UI-6a (0068) made Settings a page of its own. Several things a person sets up were still only reachable by editing a
file by hand, or sat in the old Plugins window: what requests cost, the instructions the agent reads every time, skills
and agents of one's own, MCP servers, the marks the Windows sandbox leaves on folders, and colours. Codex shows these on
its settings pages; eNCode had the data for all of them but no page.

The rule for every page: the file stays the truth. A page writes the same file a person would edit, in the same format,
and reads it back, so the command line, a text editor and the page never disagree.

## Decision

### Usage

The session index already kept each request's tokens and cost (0093's cost per request). It now keeps them by local
day and by model (`RequestUsage.models`), and `host.usage()` returns every session's days. A day is the sum of its
models, so a model that reported a cost counts even when another model in the same request did not; calls that
reported no cost are counted as unpriced, never priced at zero. Requests stored before models were kept show under
"Before models were kept". Settings > Usage sums 7, 30 or 90 days into totals, a chart by day (cost or tokens), and
tables by model and by project, with chats together under Chats. Nothing leaves the computer.

### Personalization

Your instructions are `~/.encode/ENCODE.md`, the file the agent already reads first. The page edits it with a save that
names the text it started from: when the file changed meanwhile (the command line, another window) the save is refused
and the page shows what the file holds now. Windows line ends are kept, a link is written through and stays a link, and
a file over 256 KB is refused. The page says how much of the file is sent (the first 40,000 characters). The project's
own file is shown by the name the agent reads first (ENCODE.md, .encode/ENCODE.md, AGENTS.md, CLAUDE.md); where there is
none, one button makes ENCODE.md.

### Skills and agents

The Plugins window is gone; Settings > Skills and agents replaces it (the rail button, the command and `/skills` open
it). It lists the built-in, your own and the project's skills and agents. You can make a skill (`~/.encode/skills/<name>/SKILL.md`)
or an agent (`~/.encode/agents/<name>.md`, read-only or with every tool, on the main model or a role's), read one, show
it in its folder, and remove one of your own, which goes to the Recycle Bin. A built-in or project item cannot be
removed from here.

### Computer use and the context size

Computer use moves from Agent to its own page, with what it can and cannot do as the code has it: your mouse or keyboard
makes the agent stop and wait, password fields, terminals and password managers are refused, other apps' windows are
painted over, one session at a time. Settings > Agent > Limits gains the context size (64k to 1M, default 200k), which
caps the window the agent plans for when the model allows more.

### Colour themes of your own

A theme is 17 colours over a base (`dark` or `light`): title bar, sidebar, background, cards, text, lines, accent, your
messages, success, warning, danger and six code colours. Every other token (text steps, borders, fills, surfaces,
selection, the window background and caption buttons) is worked out from them at the built-in themes' distances, with
High contrast still applied. The editor in Appearance shows a change at once and keeps it once the colours stop
changing; it warns when text, secondary text, the accent or a code colour reads below 4.5:1. Up to 12 themes are kept in
the settings; a theme goes to a file and comes back as `{ "eNCodeTheme": 1, "name", "base", "colors" }`, with no id, so
an import is always a new theme. While a theme of yours is on, Mode and Accent are its own.

### MCP servers from a form

Settings > MCP > Add a server (0057's screen) writes the entry in Claude Code's format into `~/.encode/mcp.json` (all your projects) or
the project's `.mcp.json` (shared with the project). A program is typed as one command line, split at spaces with quotes
keeping a word whole and shown word by word before it is added; an address is HTTP or SSE with headers. The host checks
the entry with the same parser that reads the files and refuses a name that is taken. A project server the person adds
in a trusted folder is approved with it, since writing it is approving it; elsewhere it waits for trust. Values written
out (not `${NAME}`) in a project's file are named in a warning, since everyone who has the project sees them. Remove
takes a server out of every file of its scope and, for a project's, its approval.

### Remove marks

The Windows sandbox marks folders so confined commands can change them (0063). The Sandbox page now lists those folders,
from the engine's own record, and Remove marks takes the marks off one or all, putting their permissions back. A folder
the agent works in again is marked again; the page says so.

## Consequences

- Every page edits a person's own files, in their own format; a page and a hand edit do not overwrite each other.
- Usage is local and approximate: it is what providers reported, and nothing is priced that was not.
- Themes add one more way to make text unreadable; the contrast warning says so but does not stop it.
- The MCP form can write a secret into a shared file if the person types one there; it warns, it does not refuse.
