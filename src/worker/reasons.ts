// The optional reasons a voter can tap before picking the better question: nine fixed codes, plus "Other" with an
// optional explanation of at most OTHER_MAX_WORDS words. Owner decisions, 25 Nov 2026 (DEVIATIONS.md).
// The CHECK in migrations/0002_vote_reasons.sql lists the same nine codes; "Other" lives in vote_other (0003).

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

/** Reasons per vote, "Other" included. */
export const MAX_REASONS = 2;

/** The same limit the LLM judges had on their reasons (PREREG §5). */
export const OTHER_MAX_WORDS = 20;
export const OTHER_MAX_CHARS = 200;
export const OTHER_LABEL = "Other";

export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** The voter's explanation, cleaned: control characters removed, runs of white space made single spaces. */
export function cleanNote(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The "Other" field of a vote: undefined/null/false means not chosen; a string (empty allowed) means chosen, with that
 * explanation. Returns null when it is malformed or too long.
 */
export function parseOther(v: unknown): { chosen: boolean; note: string } | null {
  if (v === undefined || v === null || v === false) return { chosen: false, note: "" };
  if (typeof v !== "string" || v.length > 4 * OTHER_MAX_CHARS) return null;
  const note = cleanNote(v);
  if (note.length > OTHER_MAX_CHARS || wordCount(note) > OTHER_MAX_WORDS) return null;
  return { chosen: true, note };
}

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
