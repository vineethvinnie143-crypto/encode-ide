# 0003. Own code above the platform

- Status: Accepted
- Date: 2026-10-21

## Context

The owner wants eNCode to carry its own branding and its own code: no VS Code source in any
form (no fork, no Monaco, no VS Code extension), and a desktop GUI as the main product.
Forge already followed a "no app-level libraries" goal with a hand-written editor, shell,
terminal buffer, diff and markdown renderer.

## Decision

- The platform boundary is Electron, Chromium, Node.js and TypeScript, plus build tools
  (Vite, esbuild, the TypeScript compiler, electron-builder for now). Everything above it is
  written in this repository.
- Not used, now or later: VS Code or its forks, Monaco, xterm.js, node-pty, CodeMirror,
  diff libraries, markdown libraries, state libraries, test frameworks.
- Each name in the product, in package metadata and in user-visible text is eNCode. Data
  stays in the existing `eNCode` user-data folder, so Forge installs carry over.
- Kept for now: React, react-dom and lucide-react. Replacing them in-house is an open
  decision for after launch.
- Spawning programs the user already has (git, the OS shell, language servers) is not
  outside code and fits the rule.

## Consequences

- Fewer supply-chain dependencies and no license entanglement with editor projects.
- More code to own: the editor engine, a PTY bridge, an LSP client, an MCP client and the
  updater are planned work (M3, M4, M6) rather than imports.
- Reviews reject a dependency that crosses the boundary even when it would save time.
