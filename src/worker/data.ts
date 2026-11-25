// Rounds, pools, the pair_counts cache, and ratings for a pool.
import { POOLED_ROLES, RATING } from "../rating/config";
import { fitBTCounts, ranksOf, type BTFit, type PairCount } from "../rating/rating";
import type { RoundRow } from "./env";
import { firstGroup, HELD, nextGroup, STAGE, type StageItem } from "./staging";
import { nowIso } from "./util";

export { isAdultRole, MIN_ROLE_BOARD_VOTERS, POOLS, poolsForRole, ROLE_NAMES, visiblePools, type Pool } from "./pools";
import { poolsForRole } from "./pools";

/** Every open round, oldest first. Several can be open at once (migration 0005). */
export async function openRounds(db: D1Database): Promise<RoundRow[]> {
  return (await db.prepare("SELECT * FROM rounds WHERE state = 'open' ORDER BY opened_at, id").all<RoundRow>()).results;
}

/** Rounds whose leaderboard a voter may open: open or frozen, by name. */
export async function boardRounds(db: D1Database): Promise<RoundRow[]> {
  return (await db.prepare("SELECT * FROM rounds WHERE state IN ('open', 'frozen') ORDER BY name, id").all<RoundRow>()).results;
}

/**
 * Open rounds in the order new batches should go to them: fewest batches issued first, so votes spread evenly
 * (owner decision, 25 Nov 2026). Ties go to the round opened first.
 */
export async function roundsByNeed(db: D1Database): Promise<RoundRow[]> {
  return (
    await db
      .prepare(
        `SELECT r.* FROM rounds r WHERE r.state = 'open'
          ORDER BY (SELECT count(*) FROM batches b WHERE b.round_id = r.id), r.opened_at, r.id`,
      )
      .all<RoundRow>()
  ).results;
}

/** True once this voter has opened this round's leaderboard. */
export async function boardSeen(db: D1Database, voterId: string, roundId: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 FROM round_board_seen WHERE voter_id = ? AND round_id = ?").bind(voterId, roundId).first());
}

export async function roundItems(db: D1Database, itemSetId: string): Promise<string[]> {
  const r = await db
    .prepare("SELECT question_id FROM item_set_items WHERE item_set_id = ? ORDER BY question_id")
    .bind(itemSetId)
    .all<{ question_id: string }>();
  return r.results.map((x) => x.question_id);
}

/**
 * The questions voters can be shown in this round, and that its leaderboard lists: every question of the item set,
 * or, in a staged round (migration 0008), the questions that have come into play so far.
 */
export async function playItems(db: D1Database, round: RoundRow): Promise<string[]> {
  // A question held back for a defect in its loaded text (HELD in staging.ts) is in play in no round.
  if (!round.staged) return (await roundItems(db, round.item_set_id)).filter((id) => !HELD.has(id));
  const r = await db.prepare("SELECT question_id FROM round_in_play WHERE round_id = ? ORDER BY question_id").bind(round.id).all<{ question_id: string }>();
  return r.results.map((x) => x.question_id);
}

async function stageItems(db: D1Database, itemSetId: string): Promise<StageItem[]> {
  const r = await db
    .prepare("SELECT q.id, q.level, q.unit FROM item_set_items i JOIN questions q ON q.id = i.question_id WHERE i.item_set_id = ? ORDER BY q.id")
    .bind(itemSetId)
    .all<StageItem>();
  return r.results;
}

/**
 * The statement that puts `ids` in play. It inserts only while the round still holds `expected` questions in play,
 * so two requests that add the same group at once add it once.
 */
function joinStatements(db: D1Database, roundId: string, ids: string[], expected: number, at: string): D1PreparedStatement[] {
  if (!ids.length) return [];
  // One statement, so the count is read once: a JSON list keeps it to four bound values whatever the group's size.
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO round_in_play (round_id, question_id, joined_at)
         SELECT ?1, j.value, ?2 FROM json_each(?3) j
          WHERE (SELECT count(*) FROM round_in_play WHERE round_id = ?1) = ?4`,
      )
      .bind(roundId, at, JSON.stringify(ids), expected),
  ];
}

/** The statements that put a staged round's first group in play; none for a round that is not staged. */
export async function firstGroupStatements(db: D1Database, round: RoundRow, at: string): Promise<D1PreparedStatement[]> {
  if (!round.staged) return [];
  return joinStatements(db, round.id, firstGroup(await stageItems(db, round.item_set_id)), 0, at);
}

/** How a staged round stands: questions in play, questions in its set, and the fewest adult comparisons in play. */
export async function stageState(db: D1Database, round: RoundRow) {
  const inPlay = new Set(await playItems(db, round));
  // Held questions never join, so they do not count toward the total a round can reach.
  const all = (await stageItems(db, round.item_set_id)).filter((i) => !HELD.has(i.id) || inPlay.has(i.id));
  const games = new Map([...inPlay].map((id) => [id, 0]));
  for (const pc of await pairCounts(db, round.id, "adults")) {
    if (games.has(pc.left)) games.set(pc.left, games.get(pc.left)! + pc.n);
    if (games.has(pc.right)) games.set(pc.right, games.get(pc.right)! + pc.n);
  }
  const fewest = games.size ? Math.min(...games.values()) : 0;
  return { all, inPlay, total: all.length, fewest, settled: games.size > 0 && fewest >= STAGE.SETTLED_ADULT_GAMES };
}

/** Add the next group to a staged round now. Returns the ids that joined (none when every question is in play). */
export async function growRound(db: D1Database, round: RoundRow, state?: Awaited<ReturnType<typeof stageState>>): Promise<string[]> {
  if (!round.staged) return [];
  const st = state ?? (await stageState(db, round));
  const ids = nextGroup(st.all, st.inPlay, STAGE.STEP);
  if (!ids.length) return [];
  const res = await db.batch(joinStatements(db, round.id, ids, st.inPlay.size, nowIso()));
  return res[0].meta.changes ? ids : [];
}

/**
 * Called before a batch is issued: in a staged round that grows by itself, the next group joins once every question
 * in play has STAGE.SETTLED_ADULT_GAMES adult comparisons.
 */
export async function growIfSettled(db: D1Database, round: RoundRow): Promise<void> {
  if (!round.staged || !round.auto_grow || round.state !== "open") return;
  const st = await stageState(db, round);
  if (st.inPlay.size < st.total && st.settled) await growRound(db, round, st);
}

/**
 * A voter's first-presentation votes, over every round. The leaderboard opens at 20 of these; with one round this is
 * the count it always was.
 */
export async function firstVoteCount(db: D1Database, voterId: string): Promise<number> {
  const r = await db.prepare("SELECT count(*) AS n FROM votes WHERE voter_id = ? AND is_repeat = 0").bind(voterId).first<{ n: number }>();
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
  voterId: string,
): D1PreparedStatement[] {
  // Counted only if the vote row for this pair was written in the same transaction. The round and voter conditions
  // are the vote insert's own: when that insert is refused (round no longer open, code revoked) while another
  // request's vote for the pair already stands, this must be refused too, or that vote would be counted twice.
  return poolsForRole(role).map((pool) =>
    db
      .prepare(
        `INSERT INTO pair_counts (round_id, pool, left_q, right_q, left_wins, n)
         SELECT ?1, ?2, ?3, ?4, ?5, 1 WHERE EXISTS (SELECT 1 FROM votes WHERE batch_pair_id = ?6)
            AND EXISTS (SELECT 1 FROM rounds WHERE id = ?1 AND state = 'open')
            AND EXISTS (SELECT 1 FROM voters WHERE id = ?7 AND revoked_at IS NULL)
         ON CONFLICT (round_id, pool, left_q, right_q)
         DO UPDATE SET left_wins = left_wins + excluded.left_wins, n = n + 1`,
      )
      .bind(roundId, pool, left, right, leftWon ? 1 : 0, batchPairId, voterId),
  );
}

/**
 * Rebuild the round's pair_counts from the vote log, in one transaction: first presentations only,
 * revoked voters excluded, each vote counted under the role it was cast with, with its current (corrected) winner.
 */
/** Returns the rows written (D1 meta), so callers and tests can see the cost. */
export async function rebuildPairCounts(db: D1Database, roundId: string): Promise<number> {
  // The true counts, grouped per pool. Written only where a row changed, so a rebuild with few differences (the
  // usual case: one revoked voter) costs few row writes on the D1 free tier.
  const base = `FROM votes_effective v JOIN voters u ON u.id = v.voter_id
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
export function tieKey(id: string): number {
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
  // A staged round lists only the questions in play; the rest have not been shown to anyone yet.
  const items = await playItems(db, round);
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
