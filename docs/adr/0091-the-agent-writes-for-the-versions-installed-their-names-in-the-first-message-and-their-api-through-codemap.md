# 0091. The agent writes for the versions installed: their names in the first message, and their API through CodeMap

- Status: Accepted, builds on 0084 and 0090
- Date: 2026-10-24

## Context

A model writes code for the version of a library it remembers best, not the one the project has. It writes zod 3's
`z.string().email()` where zod 4 is installed, React 18's `ReactDOM.render` under React 19, an ox_lib export from two
releases ago, or a FiveM native by a name that was changed. The code looks right and fails at run time. A weaker
model does this more often, and makes up a function when it is not sure.

The answer is on disk. `node_modules`, a virtual environment, Cargo's and Go's caches and the server's resources hold
the exact code the project runs, with its declarations and documentation. Reading it with Glob and Read costs a dozen
calls: find where the package is (pnpm hides it behind a link), find its types (its own, or `@types`), follow its
re-exports, and read files of thousands of lines. A web search answers for the newest version, which may not be the
one installed.

FiveM's natives were already written to a library for the Lua language server (0084), as Lua that a person reads.
Nothing gave the agent one native by name.

## Decision

### Installed versions in the first message

`projectPackages` (`packages/tools/src/codemap/packages.ts`) lists the project's direct dependencies and the version
installed of each:

- **npm**: `package.json` files down to two folders deep, at most 40, each read up to 1 MB. A dependency's version is
  read from its `package.json` in `node_modules`, found as Node would, walking up from the folder but never above the
  project. `workspace:`, `file:` and `link:` dependencies are the project's own, and left out.
- **Python**: `pyproject.toml` (PEP 621 and Poetry), `requirements.txt` and `requirements-dev.txt`. Versions come from the `dist-info` of
  the folder's virtual environment (`.venv`, `venv` or `env`), which also maps a distribution to the name it is
  imported by (PyYAML is `yaml`).
- **Rust**: `Cargo.toml`, at the version `Cargo.lock` pins, the newest where it pins several.
- **Go**: the `require`s of `go.mod`.
- **FiveM**: the resources a resource names in `dependencies` or imports with `@name/...` in its `fxmanifest.lua`,
  found among the server's resources, with their `version`.

`renderPackages` writes them in at most 700 characters, one line per ecosystem: `npm: react 19.1.0, zod 4.0.5, beta
not installed`. `@types` packages are left out, development dependencies come last, and a dependency the project names
but has not installed says so. This goes in the same reminder as the code map (0090), in the first message and in the
preface that survives a summary, so it is part of the cached prefix:

> Installed versions of the project's dependencies (write code for these versions; CodeMap with package shows their
> API as installed):

A folder with no manifest gets nothing. Reading the manifests takes about 15 ms on eNCode's own code.

### CodeMap with `package`

`package` names a dependency, as its manifest spells it. `findPackage` finds where it is installed:

- npm: `node_modules`, as above. A package behind a link (pnpm's store) is read where it is, and shown as
  `node_modules/name/...`, the path the project uses.
- Python: the virtual environment's `site-packages`, by the import name or the distribution's name.
- Rust: `CARGO_HOME`, or `~/.cargo`, `registry/src/*/name-version`.
- Go: `GOMODCACHE`, `GOPATH/pkg/mod` or `~/go/pkg/mod`, with capitals escaped as Go escapes them, and the longest module
  path that holds the package asked for.
- FiveM: the resource's folder.

A name is checked against the shape of its ecosystem's names first, so `../x`, an absolute path or a drive is never
looked up. A dependency the project names but has not installed is answered as such, and anything else as "not a
dependency the project has installed", with where it looked.

What it answers (`package-docs.ts`), in at most 8,000 characters:

- **Package alone**: what it exports, by file and line. For npm this is read from its types: `types`, `typings` or
  the types of `exports['.']`, else `index.d.ts`, else `@types/name` found from the folder as TypeScript would, and
  then the files the entry re-exports (`export … from`, `/// <reference path>`), at most 24. Other ecosystems read the
  package's entry (`__init__.py`, `src/lib.rs`, the module's folder, `fxmanifest.lua`). Functions and classes come
  first, then constants, methods, interfaces and types; overloads of one name are one line, with their count. A
  package with no declarations gives the start of its README.
- **`symbol`**: each declaration of that name, with its documentation (JSDoc, `///`, `#`, `--` comments above, or a
  Python docstring below) and its declaration: the whole body of an interface, type, enum, struct or trait, the
  signature of a function, and a class's header with its members. A body of more than 40 lines is its header and
  the first line of each member, overloads of one name counted as one (Electron's `BrowserWindow` has 63 forms of
  `on`). Overloads that follow each other are shown together. `Foo.bar`, `Foo::bar` and `Foo:bar` name a member. At most 6 declarations are shown. When nothing has the
  name, it gives the names like it and says it may not exist in this version.
- **`query`**: the declarations whose names hold the query's words, the closest first, by file.

Declaration files (`.d.ts`, `.pyi`) are read before code where a package has them. Tests, examples, fixtures and
TypeScript's `tsX.Y/` copies are skipped. A lookup reads at most 600 files, 2 MB each and 24 MB in all, and uses the
same definition rules as the code index.

### FiveM's natives

When the FiveM natives are installed (Settings > Language servers, 0084), eNCode also writes `natives.json` beside
the Lua library: each native with its parameters, return types, description and side, client, server or both with
the server's form where it differs. `installedNatives` reads it once, and again only when its time changes. A file
over 64 MB, or an entry not of the expected shape, is not used.

- `package: "natives"` with `symbol` shows one native in full, matching case first. A name that is not a native
  gives the natives whose names hold its words.
- With `query`, it searches the words of the natives' names, then their descriptions.
- `symbol` alone, with no package, falls back to a native of that name when the project defines nothing by it.
- When they are not installed, CodeMap says where to install them, and that WebFetch can read docs.fivem.net until
  then.

### Permissions

- A package lookup asks for the read permission of the package's folder, like Grep of that folder. Inside the
  workspace that is allowed as any read is. A folder outside it (a virtual environment elsewhere, Cargo's or Go's
  cache) is judged by the person's rules and the mode, as a Read there would be.
- A lookup never reads a file that a link takes out of the folder it reads. It leaves out a file the person's rules
  forbid reading, as the code map does.
- The natives are eNCode's own data, so a natives lookup needs no permission.

### The tool budget

CodeMap's description gains one line and is 931 characters. The built-in tools come to 20,980 of ADR 0062's 21,000.

## Consequences

- The agent starts knowing which versions it writes for, at a cost of a line or two, and can check one export of
  the installed version in one call of a few hundred tokens instead of a web search or a dozen reads.
- A FiveM script gets natives by their current names and forms, on the side they exist on.
- Checked by hand on real packages, React's `useState` from `@types/react` through pnpm's store and Electron's
  `BrowserWindow`. The tests cover each ecosystem: a venv, Cargo's cache, Go's module cache and FiveM's resources.
- Open:
  - Composer, RubyGems, NuGet, Maven and Gradle dependencies are not read yet.
  - A Python package installed outside a virtual environment of the folder is not found.
  - A JavaScript package without declarations is read from its code, which says less about its types.
  - The benchmark of Accuracy 1d measures how often the agent writes for the wrong version, with and without this.
