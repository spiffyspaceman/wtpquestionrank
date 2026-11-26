-- WTP Question Rank: a judge may choose to judge only some units, and State, Nationals or both (owner decision,
-- 26 Nov 2026; see DEVIATIONS.md). The general pool stays the default.
-- Rules:
--   * voters.slice_json is the voter's own choice, {"units":[4,5],"levels":["NF"]}, or NULL for all questions. The
--     voter changes it on the home page; it applies from their next batch.
--   * batches.slice_json is the choice a batch was drawn under, so the analysis can tell slice votes from the rest.
--     NULL means the general pool. It is written when the batch is made and never changed.
--   * In a staged round, a slice with too few questions in play brings the next questions of that slice into play,
--     for everyone (round_in_play, as before).

ALTER TABLE voters ADD COLUMN slice_json TEXT;
ALTER TABLE batches ADD COLUMN slice_json TEXT;
