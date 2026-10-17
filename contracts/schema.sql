-- Darwin run history (Neon Postgres). Owner: Part A. Applied with `npm run db:apply`.
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS runs (
  id               text PRIMARY KEY,
  status           text NOT NULL DEFAULT 'pending',   -- pending | running | done | error
  winner_branch_id text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id              text PRIMARY KEY,
  run_id          text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_id       text,
  sandbox_id      text,
  sandbox_name    text,
  sandbox_ip      text,
  status          text NOT NULL,                      -- see BranchStatus in contracts/types.ts
  patch_rationale text,
  score           integer,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS branches_run_idx ON branches(run_id);

CREATE TABLE IF NOT EXISTS attacks (
  id        bigserial PRIMARY KEY,
  branch_id text NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name      text NOT NULL,
  passed    boolean NOT NULL,
  detail    text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS attacks_branch_idx ON attacks(branch_id);

CREATE TABLE IF NOT EXISTS events (
  id      bigserial PRIMARY KEY,
  run_id  text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  kind    text NOT NULL,                              -- see EventKind in contracts/types.ts
  message text NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, id);
