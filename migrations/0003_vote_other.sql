-- WTP Question Rank: the "Other" reason, with an optional short explanation (owner decision, 25 Nov 2026; see
-- DEVIATIONS.md). The owner lifted the no-free-text rule for this one field, for every voter, students included.
-- Rules:
--   * One row per vote at most. note is the voter's own words, at most 20 words (enforced by the Worker) and 200
--     characters (enforced here). An empty note means "Other" with no explanation.
--   * Append-only, like votes. Written in the same D1 batch as its vote, and only if the vote exists.
--   * Shown only to the owner (admin page and reasons.csv), never on the voter pages.

CREATE TABLE vote_other (
  vote_id       INTEGER PRIMARY KEY REFERENCES votes(id),
  note          TEXT NOT NULL CHECK (length(note) <= 200)
);
CREATE TRIGGER vote_other_no_update BEFORE UPDATE ON vote_other BEGIN SELECT RAISE(ABORT, 'vote reasons are append-only'); END;
CREATE TRIGGER vote_other_no_delete BEFORE DELETE ON vote_other BEGIN SELECT RAISE(ABORT, 'vote reasons are append-only'); END;
