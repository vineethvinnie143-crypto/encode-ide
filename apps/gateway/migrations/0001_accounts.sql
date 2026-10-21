-- Accounts, sessions and the sign-up allowlist for the eNCode free tier.
-- Times are epoch milliseconds. Refresh tokens and device ids are stored only
-- as SHA-256 hashes; no GitHub token, prompt or completion is ever stored.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  login_lower TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  last_sign_in_at INTEGER NOT NULL
);

CREATE INDEX accounts_login ON accounts (login_lower, last_sign_in_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_hash TEXT UNIQUE,
  rotated_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  client TEXT
);

CREATE INDEX sessions_account ON sessions (account_id, revoked_at);

-- An entry binds to the GitHub user id of its first sign-in, so a login that
-- changes hands after a rename does not carry the invitation with it.
CREATE TABLE allowlist (
  login_lower TEXT PRIMARY KEY,
  github_id INTEGER,
  added_at INTEGER NOT NULL
);
