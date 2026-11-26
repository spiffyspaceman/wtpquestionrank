// When the leaderboard opens to a voter, and when a question on it shows a rank (owner decision, 26 Nov 2026).
// The pre-registered values stay in the frozen src/rating/config.ts (QUALITY.LEADERBOARD_UNLOCK_VOTES = 20,
// RATING.MIN_GAMES_RANKED = 10), and the analysis still uses them; these lower numbers govern only what the site
// shows (DEVIATIONS.md). No Workers types here, so the pages can import it too.

export const DISPLAY = {
  /** First votes, over all rounds, before a voter may open the leaderboard. */
  BOARD_UNLOCK_VOTES: 10,
  /** Comparisons before a question on the leaderboard shows a rank, rating, range and win count. */
  RANK_SHOWN_AT: 5,
} as const;
