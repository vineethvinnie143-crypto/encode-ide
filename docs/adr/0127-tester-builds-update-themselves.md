# 0127. Tester builds update themselves

- Status: Accepted, builds on 0051
- Date: 2026-10-25

## Context

A tester build reached a tester as a zip in a chat: CI's artifact, downloaded by the owner, passed on, unpacked, and
installed over the last one by hand. Eight builds went out that way in two days, and every fix waited on someone doing
it again. The owner asked for an auto-update system. Asked how a download would be checked, they chose a fingerprint
check: the release names each file's SHA-256 and the app refuses a download that does not match, without a signing key
of its own.

What there was to build on: CI already makes the installer and the portable program on Windows and starts each one
(0051), the repository is public, so a GitHub release can be downloaded without an account, and eNCode takes no
outside libraries, so electron-updater is out.

## Decision

- **Each tester build is a release.** A run started by hand on `main` publishes `build-<run number>` on GitHub with
  the installer, the portable program and `encode-update.json`: the schema, the channel, the version, the build number,
  the commit, the date, what is new (the titles of the merged pull requests since the last release), and each
  program's name, size and SHA-256 (`scripts/release-manifest.mjs`). It is made as a draft, filled, then published as
  the newest, so the newest release never names a file that is not there yet. Only the release job may write to the
  repository, only from `main`, and it never runs the programs it publishes.
- **A build knows its number.** CI's run number is stamped into the build beside its commit (`ENCODE_BUILD`), so a
  newer release is a larger number. About says "Tester build 291", a diagnostics report has it on its first line, and
  a build made anywhere else is build 0.
- **The app looks by itself, and installs only when asked** (`electron/services/updates.ts`, `electron/updater.ts`).
  - Only an installed tester build updates itself: one with a number, from the tester channel, with the installer's
    uninstaller beside it. The portable program is told about a newer build and sent to its release page. A copy run
    from the sources or an unpacked folder does not look.
  - It reads `releases/latest/download/encode-update.json` 30 seconds after the start and every four hours (half an
    hour after a failed look), with Chromium's network and the system's proxy. **Settings → General → Updates** turns
    the looking off and has **Check now**, which always works.
  - A newer build of the same channel is downloaded in the background into `%LOCALAPPDATA%\eNCode-updates`, one at a
    time, with a bar. The file is refused, and deleted, when it is larger or smaller than the release says, when its
    SHA-256 does not match, when it stalls for a minute, or when an answer comes from anywhere but GitHub over HTTPS
    (`github.com` and its `*.githubusercontent.com` storage). The release names files, not addresses: a file's
    address is made from the build number and a plain file name, so a release cannot point the app elsewhere.
  - A download that is ready waits across restarts, and is checked again before it runs.
  - **Restart to update** is in the title bar, in a notice, in Settings and in About. It never interrupts a request:
    while an agent works or waits for the person, the button says it restarts after the agents and a click stops
    waiting. Then eNCode closes as it always does (the agents and their commands first) and, as its last act, starts
    the installer silently as an update into the running copy's folder (`--updated /S --force-run /D=<folder>`), which
    replaces the program and starts it again.
  - eNCode writes down the restart before it closes. The next start says once whether it took ("Updated to build
    292") or not; a build that did not take is not offered again by itself, only its release page.
- **Tests.** `updates.test.ts` covers what is read from a release, what is refused, the timing, the wait for the
  agents, the record and the portable program. The smoke's `updates` part has the app go by build 41 against the fake
  provider's release: up to date, then a newer build downloaded with its bar and checked, offered in Settings, About, a
  notice and the title bar, and the restart written down instead of closing the app. On Windows, CI's installer smoke
  has the installed program go by the build before its own, update to its own from a release on the same computer
  through the real installer, and start again saying it updated.

## Consequences

- Testers install once by hand (the eight builds before this one cannot look), then get each build by a restart.
- The fingerprint proves the download is the file the release describes, not who made the release: anyone who can
  publish a release in this repository (its owner, or CI's release job) can ship a build that the app will install.
  Signing the release description with a key kept out of GitHub would close that, and is not done, by the owner's
  choice. The builds are still unsigned for Windows, as before.
- The releases are public, as the repository is: anyone can download a tester build. They carry no key.
- The app now talks to GitHub as well as to the services the person set up; About and TESTING.md say so, and the
  setting turns it off.
- Closing for an update also ends `encode` commands run from the installed program, and the installer's
  check for a running eNCode closes any other eNCode of this user.
- CI's concurrency still cancels a run on `main` when another starts there, so a build started by hand is lost if a
  merge lands during it, as before.
