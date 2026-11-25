-- WTP Question Rank: item sets that can take more questions after their round has opened
-- (owner decision, 25 Nov 2026; see DEVIATIONS.md). The ratings are refit from the whole vote log, so a question
-- that joins late simply enters the next fit; the pairing's warm-up rule then favours it until it has caught up.
-- Rules:
--   * A set is open-ended only if it was created that way. A set that has frozen can never be made open-ended, so the
--     pre-registered launch set stays fixed for good.
--   * An open-ended set only grows: questions can be added, never removed, and question text still never changes.
--   * added_at is NULL for questions in the set from the start, and the time of the addition for the rest.

ALTER TABLE item_sets ADD COLUMN open_ended INTEGER NOT NULL DEFAULT 0 CHECK (open_ended IN (0,1));
ALTER TABLE item_set_items ADD COLUMN added_at TEXT;

DROP TRIGGER item_set_items_frozen_ins;
CREATE TRIGGER item_set_items_frozen_ins BEFORE INSERT ON item_set_items
WHEN (SELECT frozen_at IS NOT NULL AND open_ended = 0 FROM item_sets WHERE id = NEW.item_set_id)
BEGIN SELECT RAISE(ABORT, 'item set is frozen'); END;

CREATE TRIGGER item_sets_open_ended_fixed BEFORE UPDATE OF open_ended ON item_sets
WHEN OLD.frozen_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a frozen item set cannot change whether it is open-ended'); END;
