# 0085. JSON, CSS and HTML are read by eNCode's own language server

- Status: Accepted, builds on 0072 and 0083
- Date: 2026-10-23

## Context

eNCode's first users write FiveM resources whose interfaces are web pages (NUI), so they open HTML, CSS, SCSS and
JSON every day. The usual language servers for these come from VS Code's source (`vscode-langservers-extracted` and its
forks). ADR 0072 rules them out and says JSON (with JSON Schema), HTML and CSS intelligence is written in this
repository. Servers that are not VS Code's, such as Tailwind's own, may sit beside it later (Editor 8c-2).

## Decision

### One server, part of eNCode

- `packages/weblang` is eNCode's own LSP server for `json`, `jsonc`, `css`, `scss`, `less` and `html`. The desktop
  build bundles it as `weblang-server.cjs` beside the agent host, and it runs with eNCode's own Node.js, as the npm
  servers do (0083). There is nothing to install and no download.
- The catalog entry `web` marks it `builtin`. Discovery never looks for it on the PATH or in the project, so a
  program there with the same name is never taken for eNCode's.
- Like every server, it starts only in a folder the person trusts.
- Documents over 5 MB are not read, and each answer is capped: 2,000 completion items and 5,000 symbols.

### JSON

- **The reader** keeps going after each problem: a missing comma, a stray token, an unquoted key or an unclosed string
  is reported, and the rest of the document is still read.
- **Comments and trailing commas** are allowed in `.jsonc` files and in files that allow them whatever their extension
  (`tsconfig.json`, `.eslintrc`, `settings.json` and similar). In plain JSON they are errors that say how to keep them.
- **JSON Schema**: the parts editors use, from draft 4 to 2020-12. That covers types, enum and const, properties and
  pattern properties, items and prefix items, bounds and lengths, patterns, the combinators, if/then/else, and `$ref`
  within a schema.
- **Built-in schemas** for `package.json` and `tsconfig.json`/`jsconfig.json` are written by eNCode. A document's own
  `$schema` that names one of them by its usual address gets it.
- **Any other `$schema`** is used only when it is a `.json` file inside the open folder, read once it is under 1 MB and
  read again when it changes. An address on the web is never fetched.
- **The service gives**:
  - repeated keys, marked
  - completion of keys (with a value to fill) and of values from the schema
  - hovers with the schema's words
  - symbols
  - folding, including `#region`
  - formatting that keeps comments and one blank line where there was one, and leaves a document it cannot read
    unchanged

### CSS, SCSS and Less

- **The reader** turns the text into rules, at-rules and declarations, and keeps going past an unclosed block, a missing
  colon or a missing semicolon at the end of a line.
- **Checks**, each with the likely name when one is close:
  - unknown properties
  - descriptors in `@font-face` and its kind
  - at-rules (in plain CSS)
  - pseudo-classes and pseudo-elements
  - a keyword that a keyword-only property does not take
- **Not marked**: custom properties, vendor prefixes, interpolations, Tailwind's directives (`@tailwind`, `@apply`,
  `@theme`...), the selectors CSS modules and Vue use (`:global`, `::v-deep`), and SCSS's and Less's own forms.
- **Completion** covers properties, values (with global keywords and functions), the custom properties used in the
  file inside `var(`, SCSS and Less variables, at-rules, pseudo-classes and element names.
- **Hovers** show a property's syntax. Symbols and folding are given too.
- **Where the names come from**: `mdn-data` (CC0), written into `data/css-data.ts` by `scripts/web-data.mjs`. The script
  pins the package by version and sha512, checks it, and reads only its JSON.

### HTML

- **The reader** closes elements the way browsers do where the standard lets an end tag be left out (`<li>`, `<p>`,
  `<td>`...). It keeps `<svg>` and `<math>` content as written.
- **Checks**:
  - elements left open
  - end tags that close nothing
  - void elements given an end tag or `/>`
  - unknown elements (custom elements with a dash are fine)
  - obsolete elements
  - repeated attributes and ids
  - images with no alt text (as information)
- **Completion** covers elements, the open element's end tag, attributes (the element's own, global, ARIA and event
  handlers), the values of enumerated attributes, and character references.
- **The CSS in `<style>`** is checked and completed by the CSS service. It works on a copy of the page with everything
  else blanked, so offsets need no mapping.
- **Where the names come from**: `html-tag-names`, `html-void-elements` and `html-element-attributes` (MIT), pinned the
  same way. The attribute values are written by eNCode from the HTML standard.

## Consequences

- JSON, CSS and HTML files get marks, completion, hovers, symbols and folding with no install. The agent's language
  tools see the same.
- **This is not a browser engine.** Values beyond keyword-only properties are not checked, and HTML content models
  (what may go inside what) are not checked.
- **What is not covered**: `style="..."` attributes, scripts in `<script>`, CSS formatting, colour pickers, links,
  rename, and `$schema` addresses on the web.
- Tailwind's own server, beside this one, and Svelte's server came next ([0086](0086-a-companion-server-runs-beside-a-files-own-server-tailwind-and-svelte.md)).
- The packaged app runs the server from inside its archive with Electron as Node, as it runs the agent host's other
  scripts. The packaged smoke covers starting the app, not this server.
