// One place for every tunable number in the rating and pairing code.
// Change a value here, never inline. A change after votes exist is a methods change:
// log it and re-run the analysis under both values.

export const RATING = {
  /** Displayed rating = ELO_BASE + ELO_SCALE * log10-odds. Mean item = 1000. */
  ELO_BASE: 1000,
  ELO_SCALE: 400,
  /** Prior SD on each item's log-odds strength. 2.0 logits is about 350 Elo points.
   *  It keeps an undefeated item's rating finite; with 20+ games per item it barely moves estimates. */
  ITEM_PRIOR_SD: 2.0,
  /** Prior SD on the left-side advantage (log-odds). */
  LEFT_PRIOR_SD: 1.0,
  /** Prior SD on a role's departure from the pooled strength of an item (extended model). */
  ROLE_DEVIATION_PRIOR_SD: 0.75,
  /** An item is "ranked" only after this many first-presentation comparisons in the pool shown. */
  MIN_GAMES_RANKED: 10,
  BOOTSTRAP_REPS: 1000,
  CI_LEVEL: 0.95,
} as const;

export const PAIRING = {
  /** Pairs handed out per batch, including the one repeat. */
  BATCH_SIZE: 10,
  /** Until every item has this many comparisons, pick pairs to balance counts. */
  WARMUP_GAMES: 6,
  /** After warm-up, this share of new pairs is uniformly random among pairs the voter has not judged. */
  EXPLORE_FRACTION: 0.3,
  /** No item appears more than this many times in one batch. */
  MAX_PER_ITEM_PER_BATCH: 2,
  /** One swapped repeat per batch, of a pair first shown at least this many of the voter's trials ago. */
  REPEATS_PER_BATCH: 1,
  REPEAT_MIN_GAP: 20,
} as const;

export const QUALITY = {
  /** Flag a rater whose median time on a first-presentation pair is below this (ms), over >= MIN_VOTES_FOR_FLAGS. */
  TOO_FAST_MEDIAN_MS: 20_000,
  /** Flag a rater who picks the same side this share of the time or more, over >= MIN_VOTES_FOR_FLAGS. */
  SIDE_SHARE_FLAG: 0.85,
  MIN_VOTES_FOR_FLAGS: 20,
  /** Leaderboard unlock for a voter, in first-presentation votes. */
  LEADERBOARD_UNLOCK_VOTES: 20,
} as const;

export const ROLES = ["judge", "coach", "alumni", "teacher", "other", "student"] as const;
export type Role = (typeof ROLES)[number];
/** The pooled board. Students vote and get their own board but are not pooled (owner decision, 2026-11-24). */
export const POOLED_ROLES: readonly Role[] = ["judge", "coach", "alumni", "teacher", "other"];
