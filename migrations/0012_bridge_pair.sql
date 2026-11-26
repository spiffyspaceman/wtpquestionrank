-- Bridge pairs (owner decision, 26 Nov 2026). A judge who narrows the set may keep one pair per batch that sets a
-- question from the chosen units beside one from outside them; the box is ticked by default. Such a pair is marked
-- here, so the analysis can tell it from the pairs drawn from the set. The pairing code is unchanged: it draws nine
-- pairs from the set, and src/worker/bridge.ts adds the tenth.
ALTER TABLE batch_pairs ADD COLUMN bridge INTEGER NOT NULL DEFAULT 0;
