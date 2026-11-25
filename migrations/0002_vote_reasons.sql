-- WTP Question Rank: optional reasons attached to a vote (owner decision, 25 Nov 2026; see DEVIATIONS.md).
-- Rules:
--   * Fixed codes only, never free text. src/worker/reasons.ts lists the same codes and their labels.
--   * Append-only, like votes. A reason row is written in the same D1 batch as its vote, and only if the vote exists.
--   * At most two reasons per vote (enforced by the Worker).

CREATE TABLE vote_reasons (
  vote_id       INTEGER NOT NULL REFERENCES votes(id),
  reason        TEXT NOT NULL CHECK (reason IN
                  ('position','substance','source','followup','tradeoffs','readings','decider','connects','current')),
  PRIMARY KEY (vote_id, reason)
);
CREATE TRIGGER vote_reasons_no_update BEFORE UPDATE ON vote_reasons BEGIN SELECT RAISE(ABORT, 'vote reasons are append-only'); END;
CREATE TRIGGER vote_reasons_no_delete BEFORE DELETE ON vote_reasons BEGIN SELECT RAISE(ABORT, 'vote reasons are append-only'); END;
