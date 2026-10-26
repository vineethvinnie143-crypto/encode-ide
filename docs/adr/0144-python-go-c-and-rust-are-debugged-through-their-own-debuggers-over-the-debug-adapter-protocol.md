# 0144. Python, Go, C and Rust are debugged through their own debuggers, over the Debug Adapter Protocol

- Status: Accepted, builds on 0062, 0083, 0114 and 0143
- Date: 2026-10-26

## Context

0143 gave eNCode a debugger for Node.js and TypeScript: its own client of Node.js's inspector, the gutter, and the
Debug panel. Its plan named the next part: Python, Go and C/C++, each through its language's own debugger.

Those debuggers speak the Debug Adapter Protocol (DAP): debugpy for Python, Delve for Go, lldb-dap (LLVM's) for C,
C++ and Rust. The constraints stay 0143's:

- Its own code only. The client is eNCode's; each debugger runs as a separate program, as a language server does
  (0062). Nothing of VS Code's is used.
- One kind of run. The panel, the editor and the agent see a Python run as they see a Node.js one.
- A run starts the folder's code, so only in a trusted folder, and only when the person starts it.

## Decision

### The engine (`packages/debug`)

- **A DAP client of our own** (`dap.ts`): `Content-Length` framing, requests answered by sequence number, events, and
  the requests a debugger sends back (answered "not supported"). What a debugger sends is bounded: a header of 8 KB,
  a message of 64 MB, an answer within its time. A header that never ends, a body that is not JSON, or too large a
  message ends the connection instead of growing a buffer.
- **`DapSession`** (`dap-session.ts`) is a run through one debugger, in the shape of 0143's runs (`RunSession` in
  `types.ts`, which both kinds of run implement).
  - Start: `initialize`, then `launch` (or `attach`) sent without waiting, then the breakpoints once the debugger says
    `initialized`, then `configurationDone`. debugpy answers the launch only after that; Delve before.
  - The protocol's ids (threads, frames, values) live only while the program is paused. The run gives out small ids of
    its own and forgets them when the program goes on, so an id of an earlier pause never reaches the debugger. A
    count of pauses drops an answer that comes after the program moved on.
  - Bounds: 200 threads, frames of 32 of them read at a stop, 200 frames, 2,000 values a level, a value of 10,000
    characters. Long lists come in groups of 100 (`[0 … 99]`), as in Node.js runs.
  - A hover reads a name with the names before it (`item.qty`) and nothing else, as 0143's does; it goes as `hover`
    where the debugger offers it, else as `watch`.
  - Output: the program's lines, batched (`output.ts`, shared with Node.js runs). What a debugger prints about itself
    (Delve's "Type 'dlv help'", lldb's command echo) is left out.
  - Stop: `terminate`, then `disconnect`, then the debugger's whole process tree.
- **Each debugger's ways** (`adapters.ts`):

  | | debugpy | Delve | lldb-dap |
  | --- | --- | --- | --- |
  | Reached over | standard input and output | a socket it dials (a Unix socket in the run's owner-only folder; 127.0.0.1 on Windows) | standard input and output |
  | Hit count `5` (from the 5th on) | `>= 5` | `>= 5` | `5`; only "from N on" (`== 5`, `% 5` are refused with why) |
  | Uncaught exceptions | `uncaught` | an unrecovered panic, a fatal error | C++: lldb stops at `std::terminate`; Rust: a breakpoint on `rust_panic` |
  | Every exception | `raised` | a breakpoint on `runtime.gopanic` | `cpp_throw` |
  | The console's expressions | `repl` | `repl` | `watch` (its `repl` answers as lldb's command line) |

### What runs (`packages/workspace`)

- **The editor's file** is run by its language: `.py` with Python; `.go` as its package in a module (a `_test.go`
  file runs its package's tests), or alone outside one; `.rs` with cargo in a Cargo project, else alone with rustc;
  `.c` and `.cpp` built alone with clang (or gcc). JavaScript and TypeScript stay 0143's.
- **`.encode/debug.json`** takes `"type"`: `node` (the default), `python` (or `debugpy`), `go`, `lldb` (or
  `lldb-dap`) for a built C or C++ program, and `rust`.
  - Python: `program` or `module`, `python` (the interpreter), `justMyCode`; or `"request": "attach"` to a program
    that runs debugpy's server, on this machine only (port 5678 by default).
  - Go: `program` (a package's folder or a file; the folder by default), `mode` (`debug` or `test`), `buildFlags`.
  - lldb: `program`, the executable the person's build makes.
  - Rust: `bin`, `example`, `package`, `manifest`; without them, the one program of the package.
  - All of them: `args`, `cwd`, `env`, with 0143's variables.
- **Builds run as the run starts** (`debug-builds.ts`), in its console, and Stop stops them. cargo is asked which
  programs the project has (`cargo metadata`) and then builds the one whose main file is open; it says where the
  program is. A single file is built with debug information and no optimization into the run's own folder, which goes
  when the run ends. Delve builds its program there too (`output`), not as `__debug_bin` in the person's folder.
- **The debugger inherits the run's environment** (the person's, with the configuration's `env`), and starts the
  program with it, as a terminal would.

### Finding and installing the debuggers (`debuggers.ts`)

- **Python**: the configuration's, else the folder's virtual environment (`.venv`, `venv`, `env`), the active one
  (`VIRTUAL_ENV`, `CONDA_PREFIX`), then the PATH's (`python3`, `python`, and on Windows `py -3`). Each is asked its
  version isolated (`-I`); one that does not answer (the Microsoft Store's stand-in) is passed by.
- **debugpy**: eNCode's own copy first, else the debugpy installed in that Python (1.6 or newer). Without either,
  eNCode offers its copy: debugpy 1.8.22, the one wheel PyPI publishes for every computer, from
  `files.pythonhosted.org` (a new host on the list, for `/packages/` only), checked against a sha256 pinned here. It
  needs Python 3.10 or newer; for an older Python the message says how to install debugpy into it.
- **Delve**: the person's own first (PATH, `GOBIN`, `GOPATH/bin`, `~/go/bin`), which matches their Go, else eNCode's.
  eNCode installs Delve 1.27.2 with `go install` (0083's toolchain kind). Delve builds and reads programs of Go 1.25
  and newer, so the install asks that of the computer's Go (`runtimeAtLeast`), and fetches its own copy of Go (0114)
  when the computer's is older or missing. A Delve built with eNCode's Go runs with it.
- **Go** for a run: the PATH's when it is 1.25 or newer, or when the folder's go.mod asks for such a Go (the go
  command fetches it); else eNCode's copy; else the message offers Delve with eNCode's Go.
- **lldb-dap** comes with LLVM, which is too large to fetch for a debugger: it is found on the PATH (`lldb-dap`,
  `lldb-vscode`) and where LLVM's installers put it (`Program Files\LLVM\bin`, `/usr/lib/llvm-N/bin`,
  `/usr/bin/lldb-dap-N`, Homebrew, Xcode). Missing, the message says how to get LLVM on that system. For Rust, Rust's
  own formatters are loaded first, from `rustc --print sysroot`, so a `String` or a `Vec` shows its contents.
- **The install dialog**: a start that needs debugpy or Delve answers with `install`. The window shows why, the steps
  of the install as for a language server (what is downloaded, from where, checked against what, kept where), and
  "Install and debug". When it is in place, the run starts. The installs go through `ServerInstalls`, which now knows
  the debuggers: eNCode's copy of Go is removed only when neither gopls nor Delve uses it.

## Consequences

- Python, Go, C, C++ and Rust programs are debugged from the gutter and the Debug panel, with the same breakpoints,
  conditions, hit counts, log points, stepping, values and console as Node.js.
- A Python or Go run can need a download, which the person reads and accepts first. Nothing is installed for the
  whole computer, and the PATH is not changed.
- A C or C++ run needs LLVM installed by the person. On Windows, LLVM's lldb-dap needs the Python its release was
  built with; when Windows cannot load it, the run says so.
- Delve 1.27 refuses programs built by a Go much newer than it; the pin moves with Go's releases.
- Still to come under 0143's plan: the agent's own debug tool, through approvals.

## Verification

- `packages/debug/src/dap.test.ts`: framing, split and joined messages, error answers with their format, reverse
  requests, bounds on the header, the size and the JSON, timeouts.
- `packages/debug/src/dap-session.test.ts`, against the real debuggers where installed: Python, Go, C and Rust,
  each with breakpoints, a log point, a condition and hit counts, evaluation, stepping, grouped long lists, and their
  exceptions (Python's `ZeroDivisionError`, a Go panic, a Rust panic through its formatters).
- `packages/workspace/src/debug-languages.test.ts`: the configurations and what is wrong with one; which Python,
  debugpy, Go, Delve, lldb-dap, compiler and cargo each run finds, with stand-in programs, and what it says (and
  offers to install) when one is missing; whole runs through the folder's debugger with the real debuggers: a Python
  file with eNCode's debugpy, a Go module built into the run's folder, a C file built with clang, a Rust program of a
  Cargo project built with cargo.
- Windows CI fetches debugpy's pinned wheel (checked against its sha256) and builds Delve, so these run there too.
