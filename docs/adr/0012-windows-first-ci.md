# 0012. Windows-first CI with a sandboxed end-to-end smoke

- Status: Accepted
- Date: 2026-10-21

## Context

The owner develops and uses eNCode on Windows and asked to test only on Windows for now. Much
of M0's security work is Windows-specific: `Path` casing, PATHEXT, batch files, 8.3 short
names, junctions and DPAPI. Unit tests cannot cover Electron itself, and the existing smoke
needed a hand-started app, a fixed port and a workspace inside the repository that it edited
in place.

## Decision

- `.github/workflows/ci.yml` runs on `windows-latest` for pull requests, pushes to `main`
  and manual dispatch. The steps:
  1. a frozen pnpm install;
  2. a check for bidi-control and zero-width characters in tracked text files
     (`scripts/check-sources.mjs`, the Trojan Source class of attack);
  3. typecheck, unit tests and build;
  4. the end-to-end smoke.

  Screenshots and the Electron log are uploaded when a step fails.
- **Locked-down workflow.**
  - The workflow token is read-only and checkout keeps no credentials.
  - Actions are pinned to full commit hashes, with the release named in a comment.
  - Runs on the same ref cancel each other.
- **The e2e harness** (`pnpm e2e`, `apps/desktop/scripts/e2e.mjs`) runs the smoke against
  the built app with nothing shared:
  - the fixture in `apps/desktop/test/fixtures/demo-project`, copied to a temporary
    workspace;
  - a temporary profile through `ENCODE_USER_DATA_DIR`;
  - free ports for DevTools and the local fake provider;
  - the Electron process tree stopped afterwards.
- **No internet dependency.** `ENCODE_SMOKE_OFFLINE=1` skips the only check that needs the
  internet, the live OpenRouter catalog. CI sets it, so a third-party outage cannot fail a
  build.
- Code stays cross-platform. The harness also runs on Linux (xvfb when there is no display,
  and `--no-sandbox` only as root). macOS and Linux runners are added when the owner asks.

## Consequences

- Every pull request proves the Windows build end to end:
  - the editor;
  - the demo agent;
  - the eNCode Shell running `node` and `npm`;
  - a streaming provider with approvals and diffs;
  - the key path through the real `safeStorage`;
  - sessions, subagents and Stop;
  - the web_fetch approval;
  - compaction after a context-overflow refusal.
- Linux- and macOS-only regressions are caught locally, not in CI, until those runners are
  added.
- A Windows run takes several minutes, so the job has a 45-minute ceiling.
