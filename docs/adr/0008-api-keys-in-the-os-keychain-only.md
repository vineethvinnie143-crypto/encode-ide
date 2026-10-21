# 0008. API keys in the OS keychain only

- Status: Accepted
- Date: 2026-10-21

## Context

Forge wrote keys as base64 (`plain:`) whenever Electron's `safeStorage` was unavailable,
which is the default on a Linux desktop without a keyring. On Linux, `safeStorage` can also
report success through the `basic_text` backend, which encrypts with a password compiled
into Chromium and so protects nothing. The settings, sessions and schedules files were
created readable by other users. A crash between write and rename left a `.tmp` copy that
could hold keys.

## Decision

- **Sealed or not stored.** `KeyVault` (`electron/services/secrets.ts`) seals keys with
  `safeStorage` (`enc:` + base64) and never writes a key in any other form.
- **Session-only fallback.** Where no keychain is usable, a key is held in memory until
  eNCode quits, and Settings says so and why. "Not usable" means one of:
  - `safeStorage` is unavailable;
  - on Linux, the backend is `basic_text` or `unknown`;
  - the keychain refuses to encrypt at runtime.
- **Migration.** At startup, legacy `plain:` keys are sealed, or moved into memory and
  removed from disk. Stale temp files are deleted.
  - A sealed key this keychain cannot open (another machine's, or a reset keychain) shows
    as missing instead of failing every request.
  - Values in an unknown format are kept untouched for a newer build.
- **Keys are bound to their server.** Pointing a profile's base URL at another origin drops
  its key, so an edited URL cannot send the key elsewhere.
- **Header-safe keys only.** A key must be one line of printable ASCII, at most 4,096
  characters, since it travels in an HTTP header.
- **The renderer never sees a key.** It learns only whether one exists and where keys are
  kept (`keyStorage`).
- **Private files.** Settings, sessions and schedules are written by `writePrivateFile`:
  - an exclusive 0600 temp file, fsync, then rename;
  - the rename is retried briefly on Windows sharing violations;
  - existing files and leftovers are tightened to 0600 or removed at startup.
- `SettingsService` takes its folder and cipher by injection and is unit tested under plain
  Node. `ENCODE_USER_DATA_DIR` gives unpackaged test runs a throwaway profile.

## Consequences

- On Windows the key is protected by DPAPI for the user account. Malware running as the same
  user can still decrypt it, a residual risk in the threat model.
- On a Linux desktop without a keyring, the user re-enters keys each session. That is the
  intended trade.
- The free tier's shared key never reaches the client at all. It stays in the gateway (M5).
