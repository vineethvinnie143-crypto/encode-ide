# 0051. Tester builds carry their commit, keep a scrubbed log and report in one file

- Status: Accepted
- Date: 2026-10-22

## Context

The owner and two or three friends will run builds that change daily, from files handed to them: there is no
certificate, no update server and no store. That asks for three things.

- "It does not work" is useless without the build, the system and what the app logged. A friend cannot be asked to
  open DevTools. The answer to "which build is this?" has to be one click, and it has to be true.
- A log is where keys and names leak: an HTTP error echoes a header or an address, an error message holds a path with
  the user's name in it, a profile may hold a password in a proxy address. A file a friend sends to someone else must
  not carry any of that.
- A package fails in ways `electron .` does not: a file left out of the asar, a page that does not load from the
  package, a process that cannot start from inside it, an installer that makes no shortcut. It has to fail in CI, not
  on a friend's computer.

## Decision

- **The build says what it is.** `scripts/main-build.mjs` writes the version, the commit (CI names the head of a pull
  request, not the merge commit GitHub builds), whether the tree had local changes, the build time and the channel
  into the main bundle. CI builds are `tester`, any other `dev`. About and the first line of a report read it.
- **The main process keeps a log.** Everything it prints is kept in `userData/logs/eNCode.log` (1 MiB, then one older
  file) and for the last 1,000 lines in memory. Every line is scrubbed before it is kept or written. Writing never
  throws: a full disk must not stop the app.
- **Scrubbing is by shape and by value.** `redact` removes the keys and tokens of the services eNCode talks to, GitHub,
  AWS, Google and Slack tokens, JWTs, `Authorization` and `Bearer` values, fields named like secrets, passwords in
  addresses, long mixed-case runs, e-mail addresses and user names in paths, and the user's home folder becomes `~`.
  It also removes the exact values of the keys eNCode holds, whatever they look like: the log reads that list at most
  every five seconds, and a report reads it fresh. Redacting a second time changes nothing.
- **One file says what went wrong.** *Help → Save diagnostics…* writes a text file where the user says: the build, the
  system (memory, displays and their scale), the settings (policy, models with only "key stored" or not, the number of
  remembered folders), the health of the agent process, the number of sessions, the names of the `ENCODE_*` variables
  set, and the last 400 log lines. It holds no file contents, no conversation text and no remembered folder. The text
  goes through `redact` once more. eNCode sends it nowhere.
- **A new install is safe.** The policy is Workspace Write, the model is the offline demo, no folder is remembered and
  the Computer tool is off. A test fixes the first three, and an unknown policy in a damaged file is not Full access.
- **Two unsigned programs.** An NSIS installer for the current user (no administrator prompt, Start menu and desktop
  shortcut, user data left on uninstall) and a portable program. CI makes both on every run and starts each the way a
  tester does: the unpacked program, the portable program, and the installed program after a silent install, which is
  then uninstalled. `scripts/packaged-smoke.mjs` checks that the window shows the bundled interface, that About names
  this build, that the agent process answers a message (with an approval), and that the page cannot see Node.
- **Only the builds that matter are kept.** The installer and the portable program are kept for 30 days when the run is
  on `main` or started by hand on a branch.
- **Test hooks do not exist in a package.** Every `ENCODE_*` variable that moves a profile or a home folder, or answers
  a dialog, is ignored when the app is packaged.

## Consequences

- Every report starts with the build, and every artifact traces to a commit.
- A packaging fault turns CI red. The cost is about three more minutes per run.
- The bundle changes with every build because of the build time, so builds are not byte-for-byte reproducible. The
  commit is the identity.
- Scrubbing by shape can miss a key of a kind nobody has seen, when eNCode does not hold it. A log line can also name a
  file or folder when something went wrong with it. The report says both and is plain text; the tester reads it (R15).
- No signing means SmartScreen warns on the first start, and the tester is told to expect it (T21 stays open until a
  public release).
