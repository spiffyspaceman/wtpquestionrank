// A short topic label for each question, shown on the leaderboard and in admin (owner decision, 26 Nov 2026), never
// on the voting page. Drafted with AI from each question's stem and bullets; a label may be corrected at any time,
// since it is not the question's text. Bundled into the Worker and sent only with the leaderboard and admin data:
// the file maps question ids, which encode cycle and unit, so it is never served as a static file.
import file from "../../items/summaries.json";

const LABELS = (file as { summaries: Record<string, string> }).summaries;

/** The question's topic label, or null for a question that has none yet. */
export const summaryOf = (id: string): string | null => LABELS[id] ?? null;

/** Every label, for the tests. */
export const ALL_SUMMARIES: Readonly<Record<string, string>> = LABELS;
