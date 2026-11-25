-- WTP Question Rank: corrections. A voter may go back within their current batch and change an answer
-- (owner decision, 25 Nov 2026; see DEVIATIONS.md).
-- Rules:
--   * The vote log stays append-only. A correction is a new row; the original vote is never changed.
--   * The newest correction of a vote is its answer for the leaderboard, the exports and the analysis. The views
--     below give that answer; every reader of winners, close calls or reasons uses them.
--   * A correction's reasons and Other note belong to the correction and replace the vote's own.
--   * token is a random id from the Worker, so the reason rows can find their correction in the same D1 batch.

CREATE TABLE vote_corrections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,
  vote_id       INTEGER NOT NULL REFERENCES votes(id),
  winner_q      TEXT NOT NULL,
  close_call    INTEGER NOT NULL CHECK (close_call IN (0,1)),
  client_ms     INTEGER,                      -- time on the pair while correcting, measured in the browser
  created_at    TEXT NOT NULL
);
CREATE INDEX vote_corrections_vote ON vote_corrections(vote_id, id);
CREATE TRIGGER vote_corrections_winner BEFORE INSERT ON vote_corrections
WHEN NEW.winner_q NOT IN (SELECT left_q FROM votes WHERE id = NEW.vote_id UNION ALL SELECT right_q FROM votes WHERE id = NEW.vote_id)
BEGIN SELECT RAISE(ABORT, 'the winner must be one of the pair'); END;
CREATE TRIGGER vote_corrections_no_update BEFORE UPDATE ON vote_corrections BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;
CREATE TRIGGER vote_corrections_no_delete BEFORE DELETE ON vote_corrections BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;

CREATE TABLE correction_reasons (
  correction_id INTEGER NOT NULL REFERENCES vote_corrections(id),
  reason        TEXT NOT NULL CHECK (reason IN
                  ('position','substance','source','followup','tradeoffs','readings','decider','connects','current')),
  PRIMARY KEY (correction_id, reason)
);
CREATE TRIGGER correction_reasons_no_update BEFORE UPDATE ON correction_reasons BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;
CREATE TRIGGER correction_reasons_no_delete BEFORE DELETE ON correction_reasons BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;

CREATE TABLE correction_other (
  correction_id INTEGER PRIMARY KEY REFERENCES vote_corrections(id),
  note          TEXT NOT NULL CHECK (length(note) <= 200)
);
CREATE TRIGGER correction_other_no_update BEFORE UPDATE ON correction_other BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;
CREATE TRIGGER correction_other_no_delete BEFORE DELETE ON correction_other BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;

-- Each vote with its current answer. correction_id is NULL when the vote was never corrected.
CREATE VIEW votes_effective AS
SELECT v.id, v.batch_pair_id, v.round_id, v.item_set_id, v.voter_id, v.role, v.left_q, v.right_q, v.item_lo, v.item_hi,
       COALESCE(c.winner_q, v.winner_q) AS winner_q, COALESCE(c.close_call, v.close_call) AS close_call,
       v.is_repeat, v.after_board, v.client_ms, v.server_ms, v.created_at, c.id AS correction_id,
       v.winner_q AS original_winner_q, v.close_call AS original_close_call
  FROM votes v
  LEFT JOIN vote_corrections c ON c.id = (SELECT MAX(id) FROM vote_corrections WHERE vote_id = v.id);

-- Current reasons: the newest correction's if the vote was corrected, else the vote's own. 'other' rows carry the note.
CREATE VIEW vote_reasons_effective AS
SELECT e.id AS vote_id, r.reason, NULL AS note
  FROM votes_effective e JOIN vote_reasons r ON r.vote_id = e.id WHERE e.correction_id IS NULL
UNION ALL
SELECT e.id, 'other', o.note
  FROM votes_effective e JOIN vote_other o ON o.vote_id = e.id WHERE e.correction_id IS NULL
UNION ALL
SELECT e.id, r.reason, NULL
  FROM votes_effective e JOIN correction_reasons r ON r.correction_id = e.correction_id
UNION ALL
SELECT e.id, 'other', o.note
  FROM votes_effective e JOIN correction_other o ON o.correction_id = e.correction_id;
