// The optional reasons a voter can tap before picking the better question. Fixed codes only: never free text.
// Owner decision, 25 Nov 2026 (DEVIATIONS.md). The CHECK in migrations/0002_vote_reasons.sql lists the same codes.

export const REASONS = [
  { code: "position", label: "Forces a real position" },
  { code: "substance", label: "Real constitutional substance" },
  { code: "source", label: "Strong quote or source" },
  { code: "followup", label: "More room for follow-up" },
  { code: "tradeoffs", label: "Hard trade-offs on every side" },
  { code: "readings", label: "Competing ways to read the Constitution" },
  { code: "decider", label: "Who should decide" },
  { code: "connects", label: "Rewards connecting ideas" },
  { code: "current", label: "Ties to current issues" },
] as const;

export type ReasonCode = (typeof REASONS)[number]["code"];

export const MAX_REASONS = 2;

const CODES = new Set<string>(REASONS.map((r) => r.code));

/** Valid, distinct reason codes, or null when the input is not a list of at most MAX_REASONS known codes. */
export function parseReasons(v: unknown): ReasonCode[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 2 * MAX_REASONS) return null;
  const out = new Set<ReasonCode>();
  for (const x of v) {
    if (typeof x !== "string" || !CODES.has(x)) return null;
    out.add(x as ReasonCode);
  }
  return out.size > MAX_REASONS ? null : [...out];
}
