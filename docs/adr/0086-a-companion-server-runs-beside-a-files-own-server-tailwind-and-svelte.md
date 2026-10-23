# 0086. A companion server runs beside a file's own server; Tailwind and Svelte

- Status: Accepted, builds on 0072, 0083 and 0085
- Date: 2026-10-23

## Context

A FiveM resource's interface is often a web page built with Tailwind, under the resource's own `web` folder. Its CSS
and HTML get eNCode's own server (0085), and its `.tsx` files get TypeScript's. What neither knows is Tailwind's class
names: completing them, showing the CSS a class makes, and marking a class that conflicts with another. Tailwind's own
server knows them, but only as a second opinion. It is no replacement for the CSS, HTML or TypeScript server.

Until now the hub has given each file to exactly one server, found by `serverFor`. About 48 of the hub's methods
assume that.

Svelte files have no server in eNCode. Svelte's own server runs Microsoft's CSS and HTML language services inside it.
ADR 0072 keeps VS Code's code out of eNCode, and allows a separate program as a language server. Vineeth chose to allow
Svelte's server on that footing (2026-10-23).

## Decision

### A companion

- **What it is.** A catalog entry may be a `companion`: a server with no extensions of its own, a list of languages
  (`css`, `scss`, `less`, `html`, `javascriptreact`, `typescriptreact`, `svelte`) and a `uses(dir)` test. A file
  keeps the server `serverFor` gives it. The companion is given the file too, beside that server, when the file is in
  one of its languages and in a project of its kind.
- **What counts as a project of its kind.** `uses` says so for one of the folders from the file's own up to the open
  folder. For Tailwind, that is a folder with a Tailwind config, or a `package.json` that depends on `tailwindcss`,
  `@tailwindcss/vite` or `@tailwindcss/postcss` (version 4 needs no config). So in a FiveM server folder, only the
  files under the resource that uses Tailwind go to it.
- **How often the folders are checked.** Each folder is looked at once every 30 seconds at most. The walk never goes
  above the open folder, and reads only a `package.json` of up to 1 MB.
- **When it starts.** Only when such a file is open in the editor, in a folder the person trusts, and only if the
  companion is installed. A companion that is missing changes nothing.
- **What reaches it.** It is given the editor's documents: open, change and close. A file closed in the editor is
  closed in every companion that has it, whether or not its project still uses it.

### What it adds

- **Marks.** A file's marks are its own server's and its companions' together. Each server's marks replace only that
  server's.
- **Suggestions.** The companion is asked at the same time as the main server, with 1.5 seconds to answer. Its items
  follow the main server's, numbered after them, and are not resolved.
- **Hovers.** In the editor and for the agent, the companion's hover follows the main server's, after a rule. The
  range is the main server's, or the companion's when the main server said nothing.
- **What it does not add.** The rest stays the main server's alone: definitions, rename, actions, symbols, folding,
  hints and the agent's error gate.

### Tailwind and Svelte

- **Tailwind's server** is `@tailwindcss/language-server` 0.16.0, pinned by sha512 in the npm locks (0083). Only its
  `tailwindcss-language-server` script runs. The package also holds a `css-language-server`, built on VS Code's CSS
  service, and eNCode never runs it; a test checks both the command and the installed script.
- **Tailwind's checks**: its class conflicts, a wrong `@apply`, screen or variant, and variant order. Colour
  decorators and Emmet are off.
- **Svelte's server** is `svelte-language-server` 0.18.4, pinned the same way. It is a normal server for `.svelte`,
  found by `svelte.config.*` and offered with one click.

### On screen

- **The editor's install offer**, once a file's own server is there, also offers a companion the folder uses and that
  is missing: "This folder uses Tailwind CSS. Install its language server…". The file's own server is offered first.
- **Settings > Language servers** lists a companion "alongside" the files it takes. The folder's count of those files
  is shown when a project of its kind is anywhere in the folder.

## Consequences

- **Tailwind in a FiveM web page.** Its class names complete, hover and are checked in CSS, HTML, JSX, TSX and Svelte,
  with no change for files outside a Tailwind project.
- **Svelte files** get errors, completion, hovers and the rest from Svelte's own server.
- **Running the project's code.** Both servers run the project's code: Tailwind loads the project's config and its own
  copy of `tailwindcss`, and Svelte loads `svelte.config.js` and its preprocessors. That is why they start only in a
  trusted folder, as every server does (0073).
- **Answers grow.** A companion's suggestions can be long; Tailwind gives thousands of classes, which the client caps
  at 5,000 per answer.
- **Not covered.** Vue files have no main server in eNCode, so Tailwind is not given them. Classes in `.ts` and `.js`
  files without JSX are not given to Tailwind either.
