-- WTP Question Rank: a round that opens its questions in stages (owner decision, 25 Nov 2026; see DEVIATIONS.md).
-- With few voters, a large round spreads votes so thin that no question reaches a rank. A staged round keeps one
-- round and one rating scale but puts its questions in play in groups: the first group when the round opens, the
-- next when the questions in play have settled.
-- Rules:
--   * round_in_play lists the questions of a staged round that voters can be shown, each with the time it joined.
--     Pairs are drawn only from these, and the round's leaderboard lists only these.
--   * A round that is not staged has no rows here: all the questions of its item set are in play, as before.
--   * Questions only join; none leaves. Append-only, like the vote log.
--   * Whether a round is staged is fixed once it opens. auto_grow (the site adds the next group by itself) can be
--     switched at any time; the owner can also add a group by hand.

ALTER TABLE rounds ADD COLUMN staged INTEGER NOT NULL DEFAULT 0 CHECK (staged IN (0,1));
ALTER TABLE rounds ADD COLUMN auto_grow INTEGER NOT NULL DEFAULT 0 CHECK (auto_grow IN (0,1));

CREATE TABLE round_in_play (
  round_id      TEXT NOT NULL REFERENCES rounds(id),
  question_id   TEXT NOT NULL REFERENCES questions(id),
  joined_at     TEXT NOT NULL,
  PRIMARY KEY (round_id, question_id)
);
CREATE TRIGGER round_in_play_no_update BEFORE UPDATE ON round_in_play BEGIN SELECT RAISE(ABORT, 'questions in play are append-only'); END;
CREATE TRIGGER round_in_play_no_delete BEFORE DELETE ON round_in_play BEGIN SELECT RAISE(ABORT, 'questions in play are append-only'); END;

CREATE TRIGGER rounds_staged_fixed BEFORE UPDATE OF staged ON rounds
WHEN OLD.state <> 'draft' AND NEW.staged <> OLD.staged
BEGIN SELECT RAISE(ABORT, 'staging is fixed once a round has opened'); END;

-- A draft round on an open-ended set (the full question set) opens staged, growing by itself.
UPDATE rounds SET staged = 1, auto_grow = 1
 WHERE state = 'draft' AND item_set_id IN (SELECT id FROM item_sets WHERE open_ended = 1);
