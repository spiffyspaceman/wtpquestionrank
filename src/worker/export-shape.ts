// The JSON export's shape. No Workers types here, so Node-side tests can import it.

// Exactly the fields of the analysis script's input types, in that order.
export const EXPORT_VOTER_KEYS = ["id", "label", "role", "is_owner", "revoked_at", "board_seen_at"] as const;
export const EXPORT_VOTE_KEYS = [
  "id",
  "round_id",
  "voter_id",
  "role",
  "left_q",
  "right_q",
  "winner_q",
  "close_call",
  "is_repeat",
  "after_board",
  "client_ms",
  "server_ms",
  "created_at",
] as const;
export const EXPORT_SKIP_KEYS = ["voter_id", "item_lo", "item_hi", "is_repeat"] as const;

// Local copies of the analysis input types (analysis/analyze.ts imports node:fs, so the Worker cannot import it).
// test/node/export-shape.test.ts checks at compile time and at run time that these match the analysis types exactly.
type Row<K extends readonly string[]> = { [P in K[number]]: unknown };
export type ExportVoter = Row<typeof EXPORT_VOTER_KEYS>;
export type ExportVote = Row<typeof EXPORT_VOTE_KEYS>;
export type ExportSkip = Row<typeof EXPORT_SKIP_KEYS>;
export interface RoundExport {
  round: { id: string; name?: string; item_set_id?: string; state?: string };
  voters: ExportVoter[];
  votes: ExportVote[];
  skips?: ExportSkip[];
}


// ---------- builders shared by the Worker and the admin page (paged exports) ----------

/** Columns of votes.csv, in order. */
export const VOTES_CSV_COLUMNS = [
  "id",
  "created_at",
  "label",
  "voter_id",
  "role",
  "left_q",
  "right_q",
  "winner_q",
  "close_call",
  "is_repeat",
  "after_board",
  "client_ms",
  "server_ms",
  "batch_pair_id",
  "item_set_id",
  // The units and level the voter had chosen when the batch was made (migration 0010); empty for all questions.
  "batch_slice",
  // 1 for a bridge pair: one question from the chosen units, one from outside them (migration 0012).
  "bridge_pair",
] as const;

/** One vote row as the paged export sends it: the RoundExport fields plus the CSV-only ones. */
export type ExportVoteRow = Record<(typeof EXPORT_VOTE_KEYS)[number] | (typeof VOTES_CSV_COLUMNS)[number], unknown>;

export function pick<K extends string>(row: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  for (const k of keys) out[k] = row[k];
  return out;
}

/** The RoundExport the analysis script reads, from the export meta and every vote row in id order. */
export function buildRoundExport(
  meta: { round: RoundExport["round"]; voters: ExportVoter[]; skips: ExportSkip[] },
  votes: ExportVoteRow[],
): RoundExport {
  return {
    round: meta.round,
    voters: meta.voters.map((v) => pick(v as Record<string, unknown>, EXPORT_VOTER_KEYS)),
    votes: votes.map((v) => pick(v, EXPORT_VOTE_KEYS)),
    skips: meta.skips.map((s) => pick(s as Record<string, unknown>, EXPORT_SKIP_KEYS)),
  };
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function votesCsvFrom(rows: ExportVoteRow[]): string {
  return toCsv(VOTES_CSV_COLUMNS, rows.map((x) => VOTES_CSV_COLUMNS.map((k) => x[k])));
}
