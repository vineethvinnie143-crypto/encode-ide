# 0002. A pnpm monorepo with in-house test tooling

- Status: Accepted
- Date: 2026-10-21

## Context

Forge was a single Electron package with no unit tests. The plan splits the product into a
headless core, a CLI, a router, a gateway and the desktop app, which need shared packages
with their own tests. The owner's rule (see [0003](0003-own-code-above-the-platform.md))
excludes third-party application libraries, and that includes test frameworks shipped as
app code.

## Decision

- The repository is a pnpm workspace: `apps/*` and `packages/*`. The desktop app is
  `apps/desktop` (`@encode/desktop`). M0 adds `@encode/permissions` (shell grammar, command
  policy, egress rules) and `@encode/testkit`.
- pnpm is pinned in `packageManager` with its sha512, and installs are frozen in CI.
  `pnpm-workspace.yaml` sets a one-day `minimumReleaseAge`, lists the exact versions
  reviewed early, and names the dependency install scripts we skip.
- No Turborepo or similar orchestrator: root scripts delegate with `pnpm --filter`.
- `pnpm test` (`scripts/test.mjs`) finds every `*.test.ts`, bundles each with esbuild so
  imports resolve as in the app build, and runs the bundles with `node:test`. A test whose
  module graph reaches Electron fails to build, so logic under test takes Electron APIs by
  injection.
- `@encode/testkit` provides seeded property testing (`check`, generators, shrinking by
  size). `ENCODE_PROPERTY_SEED` replays a failure and `ENCODE_PROPERTY_RUNS` scales runs.
- Security fixes are mutation-checked: each fix's test must fail with the fix reverted.

## Consequences

- New packages get tests from day one without adding a framework.
- Electron-dependent behavior is covered by the end-to-end smoke
  ([0012](0012-windows-first-ci.md)), not by unit tests.
- Bundling each test file costs about a second for the whole suite; acceptable at this size.
