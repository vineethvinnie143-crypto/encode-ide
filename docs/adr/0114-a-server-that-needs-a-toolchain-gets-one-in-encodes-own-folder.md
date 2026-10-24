# 0114. A server that needs a toolchain gets one in eNCode's own folder

- Status: Accepted, builds on 0083
- Date: 2026-10-24

## Context

A tester clicked Install on several languages in Settings > Language servers and got a dialog with only Cancel:
"Installing C#'s language server needs the .NET SDK (dotnet was not found on the PATH). To get one: dotnet tool install
--global csharp-ls." The hint was wrong, since that command needs the .NET SDK too, and the same dead end met Go (gopls
is built by `go install`) and Rust (`rustup component add`). Java installed, but its server could not start without
Java 21 or newer. A computer with an older toolchain fared no better: csharp-ls 0.28 is built for .NET 10, so a .NET 8
SDK failed the install, and Java 8 or 17 on the PATH failed the start.

Other editors bundle or fetch these: Java editors carry a Java runtime, rust-analyzer's editor plugins carry its
program, and IDEs download a JDK, Go or .NET SDK into the person's folder on request, without an administrator.

## Decision

- **eNCode fetches the toolchain into its own folder** (`packages/lsp/src/runtimes.ts`), at
  `<tools>/runtimes/<toolchain>/<version>`, when the computer has none new enough, and only after the person reads the
  install dialog and says yes. Nothing is installed for the whole computer, no administrator is asked for, and the PATH
  is not changed: the copy is for the language server alone, and the dialog says where to get the whole toolchain to
  build programs.
  - **The .NET SDK** for C#: the newest SDK of the 10.0 line, as a zip from `builds.dotnet.microsoft.com`, checked
    against the SHA-512 Microsoft publishes in its release list for that file. Microsoft ships a zip for Windows only;
    elsewhere the dialog says where to get the SDK.
  - **Go** for gopls: the toolchain the go command itself fetches, from the Go module proxy, at a version (1.27.3, which
    gopls 0.24 asks for) and sha256 pinned in eNCode for each system.
  - **Java** for Eclipse's Java server: Temurin's Java runtime of the newest long-term line (25), from Eclipse
    Adoptium's list, checked against the sha256 Adoptium publishes, downloaded from Adoptium's GitHub releases.
- **The computer's own toolchain comes first** when it is new enough: `dotnet --list-sdks` lists a 10 or newer, `go env
  GOVERSION` says 1.21 or newer (the go command fetches what gopls asks for from then on), `java -version` says 21 or
  newer. These run in eNCode's tools folder, never the project, with a time limit. Otherwise eNCode's copy, when it
  fetched one before; otherwise one to fetch. The Java server runs on eNCode's Java whenever it is there.
- **A server built with eNCode's copy runs with it.** The install's marker names the toolchain and its version. The
  server starts with the toolchain's home set (`DOTNET_ROOT`, `GOROOT`) and its folder first on the PATH, under the key
  Windows already uses (`Path`), so `gopls` finds `go` and `csharp-ls` finds the SDK's MSBuild. When that copy is gone,
  the server says to install again rather than failing to start. csharp-ls starts with `DOTNET_ROLL_FORWARD=Major`, so
  it runs on a newer .NET too.
- **No caches in the person's home folder.** An installer run with eNCode's copy keeps its caches (`GOPATH`,
  `GOMODCACHE`, `GOCACHE`, `DOTNET_CLI_HOME`, `NUGET_PACKAGES`) in a folder beside the install, removed when it ends;
  Go runs with `GOTOOLCHAIN=local` so the pinned Go is the one that builds.
- **Rust without rustup takes rust-analyzer's own build** from its GitHub releases (a zip on Windows, the program
  gzipped elsewhere), trusted through the digest GitHub publishes, as for Lua and clangd. With rustup, the component is
  added as before. The dialog says a whole Cargo project still needs Rust's cargo.
- **Large downloads stream.** A toolchain is written to a file while it is hashed, and a zip is unpacked from disk one
  entry at a time, asynchronously (`unpackZip`), with every entry checked before the first is written. The .NET SDK is
  hundreds of megabytes and is never all in memory. Limits per toolchain: 600 MB downloaded, 2 GB and 60,000 files
  unpacked for the .NET SDK; 200 MB, 1 GB and 40,000 for Go; 200 MB, 600 MB and 40,000 for Java.
- **Allowed hosts gain paths.** Each host may be asked only under the path it is used for: `builds.dotnet.microsoft.com`
  under `/dotnet/`, `api.adoptium.net` under `/v3/`, `proxy.golang.org` under `/golang.org/toolchain/`, and
  `storage.googleapis.com`, where the Go proxy sends its files, under `/proxy-golang-org-prod/` alone.
- **The dialog and Settings say it.** The plan names the toolchain, its version, size, source and check, and that both go
  in eNCode's folder; a pinned server download asks its host for its size. A server already in place is not downloaded
  again (Java installed before, now fetching only its Java). Settings reads "Installed by eNCode, 0.28.0, with its own
  .NET SDK 10.0.402". Remove takes the toolchain copy too once no other server eNCode installed runs on it.

## Consequences

- C#, Go and Java install with one click on a computer without their toolchain, and on one with too old a toolchain.
  Rust installs without rustup.
- The .NET SDK costs about 300 MB of download and more once unpacked, said before the person agrees. eNCode's
  tools folder is in the roaming profile (`%APPDATA%\eNCode\tools`), so a roaming profile carries the toolchains too.
- The copy serves the language server only: `dotnet build` in the terminal or from the agent still needs the toolchain
  installed on the computer. Putting eNCode's copies on the agent's PATH is left open; it would need the sandbox's
  marks on the tools folder.
- The .NET SDK and Java follow their makers' newest release of a line, trusted through the hash their makers publish
  beside it, like GitHub's digest for Lua and clangd; Go is pinned and moves with eNCode.

## Verification

- `runtimes.test.ts`: C# fetches the SDK, installs csharp-ls with it (program, `DOTNET_ROOT`, the one `Path` key, caches
  removed), starts with it, plans again from the copy in place, and says how to recover once it is gone; a computer's
  SDK 10 is used and an SDK 8 is not; Linux and an unreachable Microsoft say where to get it; a hash mismatch or a URL
  elsewhere is refused and leaves nothing. Java fetches Temurin when only Java 8 is there, starts on it, and later
  fetches only Java; a Java 21 is used. Rust without rustup installs the gzipped program and starts it; with rustup it
  adds the component. Go plans the pinned toolchain, refuses one that does not match or a redirect elsewhere on its
  storage host, and uses a Go 1.21 or newer.
- `archive.test.ts`: `unpackZip` writes what `readZip` reads, over random trees too, and refuses a bad archive before
  writing anything; `readGzip`.
- `installs.test.ts`: a server built with eNCode's Go runs with it, and Remove takes both.
- Checked once against the real services from the build machine: Go 1.27.3 came from the Go module proxy (through its
  storage redirect), matched its pinned sha256, unpacked 12,071 files, built gopls 0.24.0 in 37 seconds, and gopls
  started with that Go on its PATH; nothing was written to the home folder. Microsoft's, Adoptium's and GitHub's
  release lists cannot be reached from the build machine, so their formats were read from the live services by hand
  and the tests carry them.
