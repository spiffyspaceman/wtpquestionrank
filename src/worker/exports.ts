// Round exports. The JSON export is the analysis script's input and must match RoundExport in analysis/analyze.ts.
import { board, POOLS } from "./data";
import type { RoundRow } from "./env";
import { toCsv } from "./util";

import {
  EXPORT_SKIP_KEYS,
  EXPORT_VOTE_KEYS,
  EXPORT_VOTER_KEYS,
  votesCsvFrom,
  type ExportSkip,
  type ExportVote,
  type ExportVoter,
  type ExportVoteRow,
  type RoundExport,
} from "./export-shape";

export { EXPORT_SKIP_KEYS, EXPORT_VOTE_KEYS, EXPORT_VOTER_KEYS };

/** The full round: voters who voted or skipped in it, every vote (repeats and revoked voters included), every skip. */
export async function roundExport(db: D1Database, round: RoundRow): Promise<RoundExport> {
  return roundExportParts(db, round, true);
}

async function roundExportParts(db: D1Database, round: RoundRow, withVotes: boolean): Promise<RoundExport> {
  const voters = await db
    .prepare(
      `SELECT ${EXPORT_VOTER_KEYS.join(", ")} FROM voters
        WHERE id IN (SELECT voter_id FROM votes WHERE round_id = ?1 UNION SELECT voter_id FROM skips WHERE round_id = ?1)
        ORDER BY label`,
    )
    .bind(round.id)
    .all<ExportVoter>();
  const votes = withVotes
    ? (await db.prepare(`SELECT ${EXPORT_VOTE_KEYS.join(", ")} FROM votes WHERE round_id = ? ORDER BY id`).bind(round.id).all<ExportVote>()).results
    : [];
  const skips = await db
    .prepare(`SELECT ${EXPORT_SKIP_KEYS.join(", ")} FROM skips WHERE round_id = ? ORDER BY id`)
    .bind(round.id)
    .all<ExportSkip>();
  return {
    round: { id: round.id, name: round.name, item_set_id: round.item_set_id, state: round.state },
    voters: voters.results,
    votes,
    skips: skips.results,
  };
}

const VOTE_ROW_SQL = `SELECT v.id, v.round_id, v.voter_id, v.role, v.left_q, v.right_q, v.winner_q, v.close_call, v.is_repeat,
        v.after_board, v.client_ms, v.server_ms, v.created_at, u.label, v.batch_pair_id, v.item_set_id
   FROM votes v JOIN voters u ON u.id = v.voter_id`;

export async function votesCsv(db: D1Database, round: RoundRow): Promise<string> {
  const r = await db.prepare(`${VOTE_ROW_SQL} WHERE v.round_id = ? ORDER BY v.id`).bind(round.id).all<ExportVoteRow>();
  return votesCsvFrom(r.results);
}

/** Up to `limit` vote rows with id > `after`, for the paged export. */
export async function votePage(db: D1Database, round: RoundRow, after: number, limit: number) {
  const r = await db
    .prepare(`${VOTE_ROW_SQL} WHERE v.round_id = ? AND v.id > ? ORDER BY v.id LIMIT ?`)
    .bind(round.id, after, limit)
    .all<ExportVoteRow>();
  const votes = r.results;
  return { votes, next: votes.length === limit ? (votes[votes.length - 1].id as number) : null };
}

/** Everything in the export but the votes. */
export async function exportMeta(db: D1Database, round: RoundRow) {
  const full = await roundExportParts(db, round, false);
  return { round: full.round, voters: full.voters, skips: full.skips ?? [] };
}

export async function skipsCsv(db: D1Database, round: RoundRow): Promise<string> {
  const r = await db
    .prepare(
      `SELECT s.id, s.created_at, u.label, s.voter_id, s.item_lo, s.item_hi, s.is_repeat, s.client_ms, s.batch_pair_id
         FROM skips s JOIN voters u ON u.id = s.voter_id WHERE s.round_id = ? ORDER BY s.id`,
    )
    .bind(round.id)
    .all<Record<string, unknown>>();
  const cols = ["id", "created_at", "label", "voter_id", "item_lo", "item_hi", "is_repeat", "client_ms", "batch_pair_id"];
  return toCsv(cols, r.results.map((x) => cols.map((k) => x[k])));
}

/** Live point ratings for every pool, with the latest snapshot's intervals where one exists. */
export async function ratingsCsv(db: D1Database, round: RoundRow): Promise<string> {
  const forPool = await board(db, round);
  const rows: unknown[][] = [];
  for (const pool of POOLS) {
    const b = await forPool(pool);
    for (const r of b.rows)
      rows.push([
        pool,
        r.id,
        r.rank ?? "",
        r.rating.toFixed(1),
        r.lo?.toFixed(1) ?? "",
        r.hi?.toFixed(1) ?? "",
        r.games,
        r.wins,
        b.snapshot?.computed_at ?? "",
      ]);
  }
  return toCsv(["pool", "question_id", "rank", "rating", "ci_lo", "ci_hi", "games", "wins", "intervals_as_of"], rows);
}

/** Voters: label, role and revoked date only. */
export async function votersCsv(db: D1Database): Promise<string> {
  const r = await db.prepare("SELECT label, role, revoked_at FROM voters ORDER BY label").all<Record<string, unknown>>();
  return toCsv(["label", "role", "revoked_at"], r.results.map((x) => [x.label, x.role, x.revoked_at]));
}

/** A note opens as text in a spreadsheet, never as a formula. */
function sheetSafe(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/**
 * One row per reason a voter gave, with the vote it belongs to. Listed reasons are fixed codes
 * (src/worker/reasons.ts); "other" rows carry the voter's own note.
 */
export async function reasonsCsv(db: D1Database, round: RoundRow): Promise<string> {
  const r = await db
    .prepare(
      `SELECT v.id AS vote_id, v.created_at, u.label, v.voter_id, v.role, v.is_repeat, v.left_q, v.right_q, v.winner_q,
              v.close_call, x.reason, x.note
         FROM (SELECT vote_id, reason, NULL AS note FROM vote_reasons
               UNION ALL SELECT vote_id, 'other' AS reason, note FROM vote_other) x
         JOIN votes v ON v.id = x.vote_id JOIN voters u ON u.id = v.voter_id
        WHERE v.round_id = ? ORDER BY v.id, x.reason`,
    )
    .bind(round.id)
    .all<Record<string, unknown>>();
  const cols = ["vote_id", "created_at", "label", "voter_id", "role", "is_repeat", "left_q", "right_q", "winner_q", "close_call", "reason", "note"];
  return toCsv(
    cols,
    r.results.map((x) => cols.map((k) => (k === "note" && typeof x.note === "string" ? sheetSafe(x.note) : x[k]))),
  );
}
