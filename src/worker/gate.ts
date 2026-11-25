/**
 * The data gate in PREREG_Human_vs_LLM.md §9, for the admin study health panel. analysis/analyze.ts holds the same
 * numbers (PREREG); it reads files with Node, so the Worker cannot import it. test/node/health-gate.test.ts checks that
 * the two agree.
 */
export const GATE = {
  MIN_ADULT_RATERS: 15,
  MIN_VOTES_PER_COUNTED_RATER: 20,
  MIN_ADULT_GAMES_PER_ITEM: 30,
} as const;
