// Rounds, pools, the pair_counts cache, and ratings for a pool.
import { POOLED_ROLES, RATING, ROLES } from "../rating/config";
import { fitBTCounts, ranksOf, type BTFit, type PairCount } from "../rating/rating";
import type { RoundRow } from "./env";

export const POOLS = ["all", "adults", ...ROLES] as const;
export type Pool = (typeof POOLS)[number];

export const ROLE_NAMES: Record<string, string> = {
  judge: "Judge",
  coach: "Coach",
  alumni: "Alumni",
  teacher: "Teacher",
  other: "Other",
  student: "Student",
};

export const isAdultRole = (role: string): boolean => (POOLED_ROLES as readonly string[]).includes(role);

/** Pools a first-presentation vote by this role counts toward. */
export function poolsForRole(role: string): Pool[] {
  return isAdultRole(role) ? ["all", role as Pool, "adults"] : ["all", role as Pool];
}

/** Pools a voter may see on the leaderboard: the pooled adults board and their own role's board. */
export function visiblePools(role: string): Pool[] {
  return ["adults", role as Pool];
}

export async function openRound(db: D1Database): Promise<RoundRow | null> {
  return db.prepare("SELECT * FROM rounds WHERE state = 'open' LIMIT 1").first<RoundRow>();
}

/** The round voters see: the open one, or else the most recently frozen one. */
export async function currentRound(db: D1Database): Promise<RoundRow | null> {
  return (
    (await openRound(db)) ??
    (await db.prepare("SELECT * FROM rounds WHERE state = 'frozen' ORDER BY frozen_at DESC LIMIT 1").first<RoundRow>())
  );
}

export async function roundItems(db: D1Database, itemSetId: string): Promise<string[]> {
  const r = await db
    .prepare("SELECT question_id FROM item_set_items WHERE item_set_id = ? ORDER BY question_id")
    .bind(itemSetId)
    .all<{ question_id: string }>();
  return r.results.map((x) => x.question_id);
}

export async function firstVoteCount(db: D1Database, roundId: string, voterId: string): Promise<number> {
  const r = await db
    .prepare("SELECT count(*) AS n FROM votes WHERE round_id = ? AND voter_id = ? AND is_repeat = 0")
    .bind(roundId, voterId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function pairCounts(db: D1Database, roundId: string, pool: string): Promise<PairCount[]> {
  const r = await db
    .prepare("SELECT left_q, right_q, left_wins, n FROM pair_counts WHERE round_id = ? AND pool = ?")
    .bind(roundId, pool)
    .all<{ left_q: string; right_q: string; left_wins: number; n: number }>();
  return r.results.map((x) => ({ left: x.left_q, right: x.right_q, leftWins: x.left_wins, n: x.n }));
}

/** Statements that add one first-presentation vote to the cache, for every pool it belongs to. */
export function pairCountUpserts(
  db: D1Database,
  roundId: string,
  role: string,
  left: string,
  right: string,
  leftWon: boolean,
  batchPairId: string,
): D1PreparedStatement[] {
  // Counted only if the vote row for this pair was written in the same transaction.
  return poolsForRole(role).map((pool) =>
    db
      .prepare(
        `INSERT INTO pair_counts (round_id, pool, left_q, right_q, left_wins, n)
         SELECT ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM votes WHERE batch_pair_id = ?)
         ON CONFLICT (round_id, pool, left_q, right_q)
         DO UPDATE SET left_wins = left_wins + excluded.left_wins, n = n + 1`,
      )
      .bind(roundId, pool, left, right, leftWon ? 1 : 0, batchPairId),
  );
}

/**
 * Rebuild the round's pair_counts from the vote log, in one transaction: first presentations only,
 * revoked voters excluded, each vote counted under the role it was cast with.
 */
/** Returns the rows written (D1 meta), so callers and tests can see the cost. */
export async function rebuildPairCounts(db: D1Database, roundId: string): Promise<number> {
  // The true counts, grouped per pool. Written only where a row changed, so a rebuild with few differences (the
  // usual case: one revoked voter) costs few row writes on the D1 free tier.
  const base = `FROM votes v JOIN voters u ON u.id = v.voter_id
                WHERE v.round_id = ?1 AND v.is_repeat = 0 AND u.revoked_at IS NULL`;
  const sums = "SUM(CASE WHEN v.winner_q = v.left_q THEN 1 ELSE 0 END) AS lw, COUNT(*) AS n";
  const adults = POOLED_ROLES.map((r) => `'${r}'`).join(",");
  const truth = [
    `SELECT 'all' AS pool, v.left_q AS l, v.right_q AS r, ${sums} ${base} GROUP BY v.left_q, v.right_q`,
    `SELECT v.role AS pool, v.left_q AS l, v.right_q AS r, ${sums} ${base} GROUP BY v.role, v.left_q, v.right_q`,
    `SELECT 'adults' AS pool, v.left_q AS l, v.right_q AS r, ${sums} ${base} AND v.role IN (${adults}) GROUP BY v.left_q, v.right_q`,
  ];
  const res = await db.batch([
    // Rows that no longer have any counted vote (for example, all from a revoked voter).
    db
      .prepare(
        `DELETE FROM pair_counts WHERE round_id = ?1
           AND (pool, left_q, right_q) NOT IN (SELECT pool, l, r FROM (${truth.join(" UNION ALL ")}))`,
      )
      .bind(roundId),
    // New or changed rows. ON CONFLICT ... WHERE skips rows that already hold the right counts.
    ...truth.map((sel) =>
      db
        .prepare(
          `INSERT INTO pair_counts (round_id, pool, left_q, right_q, left_wins, n)
           SELECT ?1, pool, l, r, lw, n FROM (${sel}) WHERE 1
           ON CONFLICT (round_id, pool, left_q, right_q) DO UPDATE SET left_wins = excluded.left_wins, n = excluded.n
           WHERE pair_counts.left_wins <> excluded.left_wins OR pair_counts.n <> excluded.n`,
        )
        .bind(roundId),
    ),
  ]);
  return res.reduce((sum, r) => sum + (r.meta.rows_written ?? r.meta.changes ?? 0), 0);
}

export interface SnapshotPayload {
  ids: string[];
  rating: number[];
  ratingLo: number[];
  ratingHi: number[];
  rankLo?: number[];
  rankHi?: number[];
  games?: number[];
}

export interface SnapshotRow {
  id: number;
  computed_at: string;
  n_votes: number;
  n_raters: number;
  payload_json: string;
}

export async function latestSnapshot(db: D1Database, roundId: string, pool: string): Promise<SnapshotRow | null> {
  return db
    .prepare(
      `SELECT id, computed_at, n_votes, n_raters, payload_json FROM rating_snapshots
        WHERE round_id = ? AND pool = ? ORDER BY computed_at DESC, id DESC LIMIT 1`,
    )
    .bind(roundId, pool)
    .first<SnapshotRow>();
}

/** FNV-1a of a salted id: a stable order with no relation to the id's own sort order. */
function tieKey(id: string): number {
  let h = 0x811c9dc5;
  for (const ch of "wtpqr-tie:" + id) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export interface BoardRow {
  id: string;
  rating: number;
  games: number;
  wins: number;
  rank: number | null;
  lo: number | null;
  hi: number | null;
}

/** Live point ratings for a pool plus the latest snapshot's intervals. Ranks only at MIN_GAMES_RANKED games. */
export async function board(
  db: D1Database,
  round: RoundRow,
): Promise<(pool: string) => Promise<{ fit: BTFit; rows: BoardRow[]; snapshot: SnapshotRow | null }>> {
  const items = await roundItems(db, round.item_set_id);
  return async (pool: string) => {
    const fit = fitBTCounts(items, await pairCounts(db, round.id, pool), { noCov: true });
    const snapshot = await latestSnapshot(db, round.id, pool);
    const snap = snapshot ? (JSON.parse(snapshot.payload_json) as SnapshotPayload) : null;
    const snapIx = new Map((snap?.ids ?? []).map((id, i) => [id, i]));
    const ranked = fit.ids.map((_, i) => fit.games[i] >= RATING.MIN_GAMES_RANKED);
    const rankable = fit.ids.map((_, i) => (ranked[i] ? fit.beta[i] : -Infinity));
    const ranks = ranksOf(rankable);
    const rows: BoardRow[] = fit.ids.map((id, i) => {
      const k = snapIx.get(id);
      return {
        id,
        rating: fit.rating[i],
        games: fit.games[i],
        wins: fit.wins[i],
        rank: ranked[i] ? ranks[i] : null,
        lo: snap && k !== undefined ? snap.ratingLo[k] : null,
        hi: snap && k !== undefined ? snap.ratingHi[k] : null,
      };
    });
    // Ties (unplayed items all sit at 1000) must not fall back to question-id order, which encodes cycle and unit.
    rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.rating - a.rating || tieKey(a.id) - tieKey(b.id));
    return { fit, rows, snapshot };
  };
}
