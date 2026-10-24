# 0111. A folder on another machine opens over SSH: the agent works there, and the keys stay on the PC

- Status: Accepted, builds on 0040, 0064, 0106 and 0108
- Date: 2026-10-24

## Context

A tester kept their project on a Linux VM and reached it over SSH. eNCode could only open folders on the PC, so they
ran the agent's commands through `ssh` in the shell. The Review tab then saw nothing: the changes were on the VM, and
the Review tab reads the git of a folder on the PC. Vineeth chose to build remote folders next, the way an editor with
remote workspaces does it, in eNCode's own code and on the `ssh` that Windows ships.

The constraints:

- **eNCode's own code.** No VS Code server, no library that runs a remote agent. The `ssh` program does the
  connection, its keys and its known hosts, as it does for the person in a terminal.
- **The keys stay on the PC.** The model keys and search keys are in the PC's keychain (0011). A machine reached over
  SSH is the person's, but it may be shared, backed up or less well kept, and nothing on it needs the keys themselves.
- **Same agent, same features.** The agent there should do what it does here: its tools, the sandbox where the
  machine has one, its sessions, rewinds, Review, the terminal, language servers.

## Decision

### eNCode's program runs on the machine

- The build has one more bundle, `dist/electron/encode-server.cjs`. It runs the same agent host as the utility process
  on the PC (`runHostRuntime`), and the main process's folder services: files, git status, the terminal and the
  Review tab. It runs on the machine's Node.js 22 or newer.
- It is sent over the connection the first time. The machine keeps it in `~/.encode-server/<version>/`, where the
  version is the first 16 hex digits of the bundle's SHA-256. The upload is checked against that checksum before it
  is used, so a changed build is a new folder and a half-written file is never run.
- One connection carries three channels of JSON lines, each message tagged with its channel (`stream.ts` in
  `@encode/protocol`):
  - `host`: the agent host's session API, as the utility process serves it on the PC;
  - `net`: the agent's model and search requests, which this PC makes;
  - `folder`: the folder services. A call names a service and one method from a fixed list (`remote/protocol.ts`).
- Standard output carries only those messages. Anything else the program would print goes to standard error, which
  the PC keeps in its log (and so in a diagnostics report).

### Starting it

- The PC runs `ssh -T -e none -a -x -o ClearAllForwardings=yes -o BatchMode=yes -o ConnectTimeout=20 -o
  ServerAliveInterval=15 -o ServerAliveCountMax=4 [-l user] [-p port] -- host '<one line>'`:
  - no terminal, no agent or X11 forwarding, no port forwarding;
  - the machine after `--`, so nothing typed is read as an option;
  - signing in with a key or ssh-agent only. BatchMode means a password prompt fails at once instead of hanging.
- The line (`remote/bootstrap.ts`) is a single-quoted POSIX shell script with no quote, `!` or newline inside, so it
  reads the same in bash, dash and zsh as the login shell. It finds the newest Node.js of 22 or later: eNCode's own
  copy, then PATH, nvm, Volta, Homebrew and `/usr/bin`. If the program is missing, it asks for it and reads exactly
  that many bytes. Then it starts the program.
- Each line it prints for eNCode carries a random nonce, so text a login script prints is passed over. The lines are
  START, UPLOAD, NODE-MISSING, NODE-OLD and FAILED.
- What `ssh` says when it fails is turned into a reason the person can act on (`sshFailure`):
  - the key was refused (and how to add one);
  - the machine's key is not known yet (connect once from a terminal);
  - the machine's key changed (eNCode does not connect, and says what that can mean);
  - the name is unknown, the connection was refused, or the machine could not be reached.

### Node.js, when the machine has none

- When the machine has no Node.js 22 or newer, the Open dialog says so. If the machine is Linux or macOS on x64 or
  arm64, the dialog offers to install Node.js there. Vineeth chose this on 2026-10-24: ask once, then install.
- With a yes, eNCode runs a second command:
  - it downloads the official Node.js 24.22.1 build from nodejs.org with curl or wget;
  - it checks the archive against the SHA-256 pinned in the source for that platform;
  - it unpacks it into `~/.encode-server/node-v24.22.1-<platform>` and points `~/.encode-server/node` at it.
- Nothing outside that folder changes, and nothing needs root. Each way it can fail has its own words.

### The keys stay on the PC

- The agent there asks the PC for a key as it does here, with the server it is about to call. The PC gives it a
  stand-in: `encode-remote-key-` and 48 random hex digits, one per profile or search provider, for that connection
  only. The PC gives one only where it would give the key: the server must be the one the key was entered for.
- The agent's requests to models and search providers go through the `net` channel. The PC makes each request
  (`serveTunnel`):
  - only to the origin of a model profile or a search provider. Any other address is refused.
  - A stand-in in a header is swapped for its key only for the server that key was entered for. Otherwise the request
    is refused.
  - A stand-in in the URL or the body is refused. One the PC did not give is refused.
  - Redirects are not followed.
  - The body of an error answer (400 and above) has the key taken out before the agent sees it.
- So the machine never holds a key. It holds stand-ins that work only through this PC, only to those servers, and
  only while the connection lasts. The end-to-end run checks this: the provider receives the real key, and no file
  on the machine holds it.
- The agent's own web tools need no key. Fetch goes out from the machine, with its own checks (no private addresses).
- The Browser tool is still this PC's browser, and its tab is the one place a request leaves from this PC on the
  agent's word. While the folder is on a machine, that tab loads nothing on this PC or its network: loopback, private,
  link-local and other special addresses, local names (`localhost`, `.local`, a name without a dot), and names that
  resolve to such an address. The check runs on this PC for every request of the tab (`browser/rules.ts`,
  `heldOnRemote`), because the approval the agent host asks for runs on the machine. The agent hears why a page was
  held. So a dev server the agent starts there is not reachable in the tab yet; forwarding the machine's ports is for
  a later version.

### One place at a time

- The open folder is on this PC or on one machine (`remote/places.ts`). The main process reaches the open folder's
  files, git, terminals and Review tab through objects that follow the place, so the window's requests are unchanged.
- When the folder moves to a machine or back, the agent host moves with it (`AgentHostService.restart`):
  - the sessions there are closed as when eNCode quits;
  - the host starts on the other side;
  - the window loads that side's sessions.
- The agent there keeps its sessions, checkpoints, router state, language servers and sandbox folder in
  `~/.encode-server/data`. That folder is its profile folder, off limits to the agent (0106).
- It reads instructions, skills and agents from the machine's `~/.encode`. The Computer tool is off there: the agent
  there has no screen of this PC.
- The Review tab works there: its git runs on the machine. A commit message or a review is drafted by the agent
  there, through the PC's models. The Turn view reads the agent's own record there.
- What the program there asks of this PC (a commit message, a review, the Turn view's record) goes to the agent host,
  so it is answered only while the agent host runs on that machine: not before the folder has moved there, and not
  from a machine the folder has left. Its file-change notices reach the window on the same terms. The window keeps
  each machine's connection apart, so a machine that failed to open does not mark the open one as lost.
- A folder on a machine is named `ssh://[user@]host[:port]/path`. The recent folders keep that name, and choosing one
  connects again. The window knows the open folder by its path there, as that machine's sessions name it, and
  `OpenWorkspace.remote` says which machine. While a machine's folder is open:
  - a path the window sends is the machine's, unless it is a path of this PC: a Windows path, the chats folder or a
    recent folder of this PC;
  - the system's folder dialog always opens a folder of this PC.

### What the person sees

- **File > Open folder on another machine (SSH)…** and the project switcher open a dialog:
  - the machine, with suggestions from `~/.ssh/config`;
  - the folder there, absolute or under `~`;
  - what the connection is doing (connecting, sending eNCode the first time, starting);
  - why it failed, with ssh's own words folded under Details.
- The project switcher shows the machine beside the folder's name, with a dot for the connection: up, connecting, or
  lost with the reason on hover. The sessions list groups only the open place's folders; the switcher lists them all.
- A dropped connection is made again when the folder or the agent is next used, and the agent host starts again over
  it.
- Help > Save diagnostics says that a folder is open on another machine, how its connection stands, and the Node.js
  and system there. It never names the machine.

## Consequences

- The tester's VM works: the agent edits and runs commands there, and the Review tab shows the changes.
- Limits of this version (TESTING.md lists them):
  - Signing in is by key or ssh-agent only: no password or one-time code prompts yet.
  - The machine must be Linux or macOS, with Node.js 22 or newer or with the install allowed. Windows machines over
    SSH are not supported yet.
  - A dropped connection ends what was running there. The conversation stays, and the request can be tried again.
  - A folder on a machine is not reconnected by itself when eNCode starts. It waits in the recent folders.
  - While a machine's folder is open, the sessions of this PC's folders are not listed, and the other way round.
    Schedules and background work of the side that is not open stop when the folder moves.
  - Language servers there must be installed there (or by eNCode's Install button there, which uses the machine's
    tools).
  - The Browser tool cannot open the machine's own servers (`localhost` there) yet, and opens nothing on this PC's
    network while the folder is there.
- The `remote` part of the end-to-end run needs a POSIX shell to play the machine, so it runs on Linux and macOS
  checkouts. Windows CI skips it and says so. The unit and integration tests of `electron/remote` run everywhere
  that has a POSIX shell, and the pure ones run on Windows too.

## Verification

- `stream.test.ts`: channels over a byte stream, bytes inside messages, broken lines and over-long lines.
- `tunnel.test.ts`: the key swap, origins, stand-ins in the URL and body, redirects, scrubbed error bodies, aborts.
- `bootstrap.test.ts`: the start line in bash, dash and sh; the Node.js search; the upload; the install script against
  a local server, with a wrong checksum refused.
- `target.test.ts`: what is typed for the machine and the folder, names in full, ssh's arguments, `~/.ssh/config`.
- `remote.test.ts`: the real bundle started over a stand-in ssh, the upload once per version, the folder services,
  the method list enforced, the agent host there, plain reasons for ssh failures, and the Node.js install outcome.
- `places.test.ts`: which side a path is on, a single move per machine, one machine closed only after the agent
  moved, staying put when a machine cannot be reached.
- `service.test.ts`: the agent host restarts on request, with nothing counted as a failure.
- `browser/rules.test.ts`: the addresses the agent's tab holds while the folder is on a machine (loopback in its
  spellings, private and link-local ranges, IPv4 inside IPv6, local names, names that resolve to a private address),
  and the public ones it loads.
- The end-to-end run (`ENCODE_SMOKE_ONLY=remote`) plays the machine with a stand-in ssh. It:
  - opens a folder there through the dialog, after a folder that does not exist was refused in words;
  - shows its files;
  - lets the agent write a file and run a command there;
  - checks that the provider got the real key and that the machine's files hold none;
  - has the agent there open a page of this PC in the Browser tool, which is held;
  - goes back to the PC's folder and its sessions.
