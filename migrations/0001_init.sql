-- WTP Question Rank: initial D1 schema.
-- Rules:
--   * votes, skips and admin_audit are append-only. Triggers below reject UPDATE and DELETE.
--   * pair_counts and rating_snapshots are caches. Both can be rebuilt from votes at any time.
--   * No names, emails or free text about voters. A voter is a hashed code, a role and a neutral label.
--   * Never edit this file after it ships. Add 0002_*.sql instead.
-- Times are ISO 8601 UTC strings. Ids are random text ids made by the Worker unless noted.

PRAGMA foreign_keys = ON;

-- ---------- questions and item sets ----------

CREATE TABLE questions (
  id            TEXT PRIMARY KEY,             -- e.g. 'st-2021-22-u3-q1'
  level         TEXT NOT NULL CHECK (level IN ('State','NF','NI','Regional')),
  cycle         TEXT NOT NULL,                -- e.g. '2021-22'
  unit          INTEGER NOT NULL CHECK (unit BETWEEN 1 AND 6),
  qnum          INTEGER NOT NULL CHECK (qnum BETWEEN 1 AND 9),
  published     INTEGER NOT NULL CHECK (published = 1),   -- drafts can never be loaded
  stem          TEXT NOT NULL,
  bullets_json  TEXT NOT NULL,                -- JSON array of strings, in published order
  source        TEXT NOT NULL,                -- citation shown to admins, never to voters
  source_url    TEXT,                         -- used only in 'link' display mode
  text_sha256   TEXT NOT NULL,                -- hash of stem + bullets as loaded
  val_id        TEXT,                         -- i00..i11 for the 12 A/B validation items
  created_at    TEXT NOT NULL
);

CREATE TABLE item_sets (
  id            TEXT PRIMARY KEY,             -- e.g. 'state-launch-v1'
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  display_mode  TEXT NOT NULL DEFAULT 'full_text' CHECK (display_mode IN ('full_text','link')),
  file_sha256   TEXT NOT NULL,                -- hash of the item file it was loaded from
  created_at    TEXT NOT NULL,
  frozen_at     TEXT                          -- set when the first round using it opens; then immutable
);

CREATE TABLE item_set_items (
  item_set_id   TEXT NOT NULL REFERENCES item_sets(id),
  question_id   TEXT NOT NULL REFERENCES questions(id),
  PRIMARY KEY (item_set_id, question_id)
);

-- Once an item set is frozen, its membership cannot change.
CREATE TRIGGER item_set_items_frozen_ins BEFORE INSERT ON item_set_items
WHEN (SELECT frozen_at FROM item_sets WHERE id = NEW.item_set_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item set is frozen'); END;
CREATE TRIGGER item_set_items_frozen_del BEFORE DELETE ON item_set_items
WHEN (SELECT frozen_at FROM item_sets WHERE id = OLD.item_set_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'item set is frozen'); END;
-- Question text cannot change once loaded. A corrected text is a new question row.
CREATE TRIGGER questions_no_text_update BEFORE UPDATE OF stem, bullets_json, text_sha256 ON questions
BEGIN SELECT RAISE(ABORT, 'question text is immutable'); END;

-- ---------- rounds ----------

CREATE TABLE rounds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  item_set_id   TEXT NOT NULL REFERENCES item_sets(id),
  state         TEXT NOT NULL CHECK (state IN ('draft','open','frozen','closed')),
  created_at    TEXT NOT NULL,
  opened_at     TEXT,
  frozen_at     TEXT,
  closed_at     TEXT
);
-- Only one open round at a time.
CREATE UNIQUE INDEX rounds_one_open ON rounds(state) WHERE state = 'open';

-- ---------- voters and sessions ----------

CREATE TABLE voters (
  id            TEXT PRIMARY KEY,
  code_hash     TEXT NOT NULL UNIQUE,         -- SHA-256 of (pepper || code); pepper is a Worker secret
  role          TEXT NOT NULL CHECK (role IN ('judge','coach','alumni','teacher','other','student')),
  label         TEXT NOT NULL UNIQUE,         -- neutral, e.g. 'Judge 07'; real names stay off the site
  is_owner      INTEGER NOT NULL DEFAULT 0,   -- marks the owner's own code, for with/without analyses
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  board_seen_at TEXT                          -- first time this voter opened the leaderboard
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,             -- SHA-256 of the cookie token
  voter_id      TEXT NOT NULL REFERENCES voters(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX sessions_voter ON sessions(voter_id);

-- ---------- batches: what the server handed out ----------

CREATE TABLE batches (
  id            TEXT PRIMARY KEY,
  round_id      TEXT NOT NULL REFERENCES rounds(id),
  voter_id      TEXT NOT NULL REFERENCES voters(id),
  seed          INTEGER NOT NULL,             -- RNG seed used by selectBatch, for audit
  created_at    TEXT NOT NULL
);
CREATE INDEX batches_voter ON batches(round_id, voter_id);

CREATE TABLE batch_pairs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  position      INTEGER NOT NULL,
  left_q        TEXT NOT NULL REFERENCES questions(id),
  right_q       TEXT NOT NULL REFERENCES questions(id),
  is_repeat     INTEGER NOT NULL CHECK (is_repeat IN (0,1)),
  reason        TEXT NOT NULL CHECK (reason IN ('warmup','explore','info','repeat')),
  issued_at     TEXT NOT NULL,                -- server time the batch was sent
  UNIQUE (batch_id, position),
  CHECK (left_q <> right_q)
);

-- ---------- votes: the append-only log, the source of truth ----------

CREATE TABLE votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_pair_id TEXT NOT NULL UNIQUE REFERENCES batch_pairs(id),
  round_id      TEXT NOT NULL REFERENCES rounds(id),
  item_set_id   TEXT NOT NULL REFERENCES item_sets(id),
  voter_id      TEXT NOT NULL REFERENCES voters(id),
  role          TEXT NOT NULL,                -- voter's role at vote time (copied, so the log stands alone)
  left_q        TEXT NOT NULL,
  right_q       TEXT NOT NULL,
  item_lo       TEXT NOT NULL,                -- min(left_q, right_q)
  item_hi       TEXT NOT NULL,                -- max(left_q, right_q)
  winner_q      TEXT NOT NULL,
  close_call    INTEGER NOT NULL CHECK (close_call IN (0,1)),
  is_repeat     INTEGER NOT NULL CHECK (is_repeat IN (0,1)),
  after_board   INTEGER NOT NULL CHECK (after_board IN (0,1)),  -- voter had seen the leaderboard
  client_ms     INTEGER,                      -- time on pair measured in the browser
  server_ms     INTEGER,                      -- vote time minus issued_at, measured by the server
  created_at    TEXT NOT NULL,
  CHECK (left_q <> right_q),
  CHECK (item_lo < item_hi),
  CHECK (item_lo IN (left_q, right_q) AND item_hi IN (left_q, right_q)),
  CHECK (winner_q IN (left_q, right_q))
);
-- One first-presentation vote and at most one repeat vote per pair per voter per round.
CREATE UNIQUE INDEX votes_one_per_pair ON votes(round_id, voter_id, item_lo, item_hi, is_repeat);
CREATE INDEX votes_round_time ON votes(round_id, created_at);
CREATE TRIGGER votes_no_update BEFORE UPDATE ON votes BEGIN SELECT RAISE(ABORT, 'votes are append-only'); END;
CREATE TRIGGER votes_no_delete BEFORE DELETE ON votes BEGIN SELECT RAISE(ABORT, 'votes are append-only'); END;

CREATE TABLE skips (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_pair_id TEXT NOT NULL UNIQUE REFERENCES batch_pairs(id),
  round_id      TEXT NOT NULL REFERENCES rounds(id),
  voter_id      TEXT NOT NULL REFERENCES voters(id),
  item_lo       TEXT NOT NULL,
  item_hi       TEXT NOT NULL,
  is_repeat     INTEGER NOT NULL CHECK (is_repeat IN (0,1)),
  client_ms     INTEGER,
  created_at    TEXT NOT NULL,
  CHECK (item_lo < item_hi)
);
CREATE UNIQUE INDEX skips_one_per_pair ON skips(round_id, voter_id, item_lo, item_hi, is_repeat);
CREATE TRIGGER skips_no_update BEFORE UPDATE ON skips BEGIN SELECT RAISE(ABORT, 'skips are append-only'); END;
CREATE TRIGGER skips_no_delete BEFORE DELETE ON skips BEGIN SELECT RAISE(ABORT, 'skips are append-only'); END;

-- ---------- caches (rebuildable from votes) ----------

-- Ordered-pair counts per pool, first presentations only, revoked voters excluded.
-- pool is 'adults' (judge, coach, alumni, teacher, other) or a single role.
-- Updated in the same D1 batch as each vote insert; rebuilt by the admin "Rebuild" action.
CREATE TABLE pair_counts (
  round_id      TEXT NOT NULL,
  pool          TEXT NOT NULL,
  left_q        TEXT NOT NULL,
  right_q       TEXT NOT NULL,
  left_wins     INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  PRIMARY KEY (round_id, pool, left_q, right_q)
);

-- Full fits with bootstrap intervals, computed in the admin's browser (too heavy for a Worker request).
CREATE TABLE rating_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id      TEXT NOT NULL,
  pool          TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  n_votes       INTEGER NOT NULL,
  n_raters      INTEGER NOT NULL,
  last_vote_id  INTEGER NOT NULL,             -- the fit covers votes with id <= this
  config_json   TEXT NOT NULL,                -- RATING constants and bootstrap settings used
  payload_json  TEXT NOT NULL                 -- ids, ratings, SEs, intervals, ranks, games
);
CREATE INDEX rating_snapshots_latest ON rating_snapshots(round_id, pool, computed_at);

-- ---------- abuse control and audit ----------

-- Wrong-code attempts per hashed client key per UTC day. Not append-only; rows older than 2 days are deleted.
-- key_hash = SHA-256(daily salt || CF-Connecting-IP). The raw IP is never stored.
CREATE TABLE attempts (
  key_hash      TEXT NOT NULL,
  day           TEXT NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key_hash, day)
);

CREATE TABLE admin_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,                -- Access JWT 'sub' (opaque id, not the email) or 'admin-secret'
  action        TEXT NOT NULL,
  detail_json   TEXT NOT NULL
);
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
