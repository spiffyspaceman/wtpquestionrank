-- WTP Question Rank: several rounds open at once, and the leaderboard flag kept per round
-- (owner decisions, 25 Nov 2026; see DEVIATIONS.md and docs/AUDIT_2026-11-25.md, finding 6).
-- Rules:
--   * More than one round may be open. The Worker gives each new batch to the open round with the fewest batches.
--   * A voter "has seen the leaderboard" round by round. round_board_seen holds the first time a voter opened a
--     round's board; a vote's after_board flag and the lock on changing earlier answers read it, not voters.board_seen_at.
--     voters.board_seen_at stays as the first time the voter opened any board.
--   * Append-only, like the vote log.

DROP INDEX rounds_one_open;

CREATE TABLE round_board_seen (
  voter_id      TEXT NOT NULL REFERENCES voters(id),
  round_id      TEXT NOT NULL REFERENCES rounds(id),
  seen_at       TEXT NOT NULL,
  PRIMARY KEY (voter_id, round_id)
);
CREATE TRIGGER round_board_seen_no_update BEFORE UPDATE ON round_board_seen BEGIN SELECT RAISE(ABORT, 'board views are append-only'); END;
CREATE TRIGGER round_board_seen_no_delete BEFORE DELETE ON round_board_seen BEGIN SELECT RAISE(ABORT, 'board views are append-only'); END;

-- Views recorded so far belong to the round that was current when they happened: the latest one opened by then.
INSERT INTO round_board_seen (voter_id, round_id, seen_at)
SELECT u.id, r.id, u.board_seen_at
  FROM voters u JOIN rounds r
    ON r.id = (SELECT x.id FROM rounds x WHERE x.opened_at IS NOT NULL AND x.opened_at <= u.board_seen_at
                ORDER BY x.opened_at DESC, x.id LIMIT 1)
 WHERE u.board_seen_at IS NOT NULL;

-- Lookups by voter alone (votes across rounds; a voter's newest batch).
CREATE INDEX votes_by_voter ON votes(voter_id, is_repeat);
CREATE INDEX batches_by_voter ON batches(voter_id, created_at);
