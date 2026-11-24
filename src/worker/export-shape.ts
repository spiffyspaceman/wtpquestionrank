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

