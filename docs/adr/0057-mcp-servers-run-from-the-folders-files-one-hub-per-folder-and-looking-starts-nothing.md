# 0057. MCP servers run from the folder's files, one hub per folder, and looking starts nothing

- Status: Accepted
- Date: 2026-10-22

## Context

0044 built the MCP client as a library: it can start a server, keep it, and decide whether a given entry may run.
Putting it to work in the app has its own ways to go wrong:

- **Looking starts programs.** The MCP screen and the banner above the composer read a folder's servers all the time.
  If reading started them, opening a cloned repository would run whatever its `.mcp.json` names before anyone read it.
- **One copy per chat.** Servers started per session mean three chats in a folder run three copies of a program that
  may have side effects (a database client, a browser), and each carries its own tools into the prompt.
- **Files that change under a running server.** A pull or the agent can change `.mcp.json` at any time. A server that
  keeps running from the entry that was approved is running something nobody approved.
- **A tool list that never settles.** The tools are part of the start of every request, which providers cache. A
  server that reconnects, or one that is slow to start, must not change that start each time.
- **Turning a server off must not cost an approval.** The person's choice is saved in a settings file. If that write
  changed the digest the folder's grants were approved under (0041), turning a server off would switch off the
  rest of the folder's grants.
- **The page must not be able to start code.** The Settings screen is a web page; the agent has no tool that reaches
  these actions.

## Decision

- **One hub per folder, shared by its chats.** `McpHub` (`@encode/workspace`) owns one `McpManager` for a folder. A
  chat takes the hub when its scope is opened and gives it back when the chat ends. A hub nobody has used for five
  minutes (no chat, no look at the screen) is closed and its servers stop, and so is every hub when the program closes,
  within 2.5 seconds.
- **The hub follows the folder's snapshot (0055).** The three files (`~/.encode/mcp.json`, `.mcp.json`,
  `.encode/mcp.json`) are watched files of the snapshot, next to the settings. Before every turn and every tool call
  the snapshot is read again; when its text differs, the hub brings the servers in line, one update at a time and
  without waiting for any server. While the snapshot is `broken` no server runs. A changed entry stops its server at
  once and it waits for approval again (0044).
- **Servers start with a chat, and looking starts nothing.** Opening a folder starts no server; opening a chat in it
  does, because the chat's scope takes the hub and brings the servers the settings allow in line. The first turn of a
  chat waits at most five seconds for servers that are starting, once per wave of starting, so the next turn does not
  wait again for a slow one: its tools join from the turn after it is ready. The MCP screen asks for the servers to
  be started, as a chat does, so that it can show what they offer. The banner above the composer asks with
  `start: false`: nothing is started, no server is brought in line with the files, and each server is reported from
  what the settings and the person's approvals say of it ("It starts with your next chat in this folder.").
- **Approval is of the exact entry, and the card says what it runs.** The card shows the command line or the address,
  the names of the variables and headers the entry sets, and the variables it reads from the person's environment
  (RP2), never their values. Approving sends the digest of the setup the card showed; the manager refuses it when the
  entry changed since, when the folder is not trusted, or when there is nothing to approve. "Take back approval" revokes
  a project server's approval. The banner counts only a project's servers that wait, and a dismissal is remembered for
  the folder and exactly what waits in it, so a server that changes or a new one brings it back.
- **Turning a server off is a restriction.** The name goes into `disabledMcpjsonServers` in the person's settings (a
  server they set up) or in `.encode/settings.local.json` (a project's server, so the shared file is not touched; git
  is asked to ignore it). The list only takes permission away, so it applies at once and is left out of what the
  folder's approval covers. If the server is still turned off in another file when the person turns it on, the notice
  names that file. A settings file that cannot be read as JSON is never overwritten.
- **The page only asks.** Report and act are IPC handlers for the app's top frame and for the open folder only. The
  host checks an action before it does anything: the type is from the list, the name is one the configuration allows,
  the digest is 64 hexadecimal characters. The answer to an action is the report afterwards. Adding and removing a
  server is done in the files for now; the settings page edits them later.
- **The tools come between turns.** The core reads the hub through `ExternalToolSource`: `list()` is in name order and
  `key()` is a hash of every tool's name, description and schema, so a server that reconnects with the same tools does
  not change the start of the request; a tool whose name clashes with a built-in or another tool is dropped with a
  warning rather than failing the session. The list is fixed for the whole turn once it begins.
- **What a server says about itself is outside text.** Its instructions reach the model in the turn's reminders as
  `<mcp_server_notes>`, each marked with whose words they are and that they are data, cut to a size, with the block's
  own tags and `system-reminder` defanged, and told again only when they change. They are never part of the system prompt.
- **`.mcp.json` is a protected file.** A write to the top-level `.mcp.json` asks whatever a rule says, as the files
  under `.git` and `.encode` do, because what it holds starts a program with the person's rights at the next chat.
  "Always allow" offers no Edit rule for it. A rewind may still put the file back, because the person asks for that.

## Consequences

- The first turn in a folder with approved servers can wait up to five seconds. A server that needs longer is not
  there for that turn and the model is not told it is coming; it is there from the next turn.
- Chats in one folder share a server, so a server that keeps state keeps one state for all of them.
- A folder's servers run for up to five minutes after its last chat is closed; the screen counts as use.
- A project's entry that is turned off keeps its approval, so turning it on again starts it without a card.
- Tools of servers that offer many tools cost tokens in every request. Loading them only when the model asks (a tool
  search) is left for later.
- Adding and removing servers still means editing a file; the Settings page of the interface work adds forms for it.
