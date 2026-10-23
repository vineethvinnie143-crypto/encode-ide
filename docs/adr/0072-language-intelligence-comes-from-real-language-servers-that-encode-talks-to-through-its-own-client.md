# 0072. Language intelligence comes from real language servers that eNCode talks to through its own client

- Status: Accepted, refines 0003
- Date: 2026-10-23

## Context

The owner wants the editor's language intelligence at the level of the best IDEs: completion, hover, signature help,
go to definition, references, rename across files, code actions, live diagnostics, formatting, outlines, inlay hints and
semantic colours, for TypeScript and JavaScript, Python, Rust, Go, C and C++, C#, Java, Lua (with FiveM's natives),
JSON and YAML, HTML, CSS and Tailwind, and Svelte. eNCode's editor is its own engine (0003): it has no Monaco and no
VS Code code, so none of this comes with it.

That level rests on type checkers and analysers: the TypeScript compiler, Pyright, rust-analyzer, gopls, clangd and
their like. Writing one per language is years of work and would still trail them. 0003 already counts spawning a
language server the person has, like git or the shell, as outside the rule against outside code. What it did not
settle is whether eNCode may install one for the person, and which servers it may use. Some widely used servers (the
JSON, HTML and CSS servers in vscode-langservers-extracted, and their forks) are taken from VS Code's source.

The owner was asked and answered on 2026-10-23: "Yes allow it".

## Decision

- **eNCode talks to language servers as separate programs**, over the Language Server Protocol on their standard input
  and output, through a client written in this repository: the JSON-RPC framing, the lifecycle, document sync, every
  feature request and the Windows path and URI handling are ours. No code of a server, and no LSP client library, goes
  into eNCode.
- **A server is found first and installed only with the person's yes.** eNCode looks for a server in the project (for
  example the project's own TypeScript), then on the PATH. When none is found, it offers to install one into its own
  tools folder in the profile, saying what will be fetched and from where, and runs nothing until the person agrees.
  The person can point any language at a server of their own in Settings.
- **No server taken from VS Code's source.** The servers in vscode-langservers-extracted and their forks are not used,
  found or offered. JSON (with JSON Schema), HTML and CSS intelligence is written in this repository, with servers
  that are not VS Code's (such as Tailwind's own and Biome) beside it where they fit.
- **Servers run under the same rules as the agent's commands.** They start in the project's folder with the sandbox
  settings the folder has, never with eNCode's own profile folder in reach, and a server that crashes is restarted a
  few times and then reported plainly, without stopping the editor.

## Consequences

- The editor can reach the accuracy of the tools the languages' own teams build, and the agent can use the same servers
  (diagnostics after its edits, definitions and references) to make fewer mistakes.
- Each language depends on a program the person installs or lets eNCode install; Diagnostics reports which server and
  version each language uses, so a tester's report says what was running.
- More code of our own: the LSP client, a server manager, the editor surfaces for every feature, and JSON, HTML and
  CSS intelligence. That work is scheduled after Parity 3.
