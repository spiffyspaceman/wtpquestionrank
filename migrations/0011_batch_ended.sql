-- WTP Question Rank: a judge who narrows their set mid-batch gets a fresh batch at once (owner decision, 26 Nov 2026;
-- see DEVIATIONS.md). The rest of the old batch is ended, not skipped.
-- Rules:
--   * batches.ended_at is when the voter changed their set while the batch still had unanswered pairs. Those pairs
--     are neither votes nor skips: they are no longer offered from that batch, and the pairing may offer them again
--     later. Answers already given in the batch stay.
--   * It is set once, by the Worker, and never cleared. NULL for every batch that ran its course.
--   * A batch can end only this way: a judge cannot discard pairs without changing their set.

ALTER TABLE batches ADD COLUMN ended_at TEXT;
