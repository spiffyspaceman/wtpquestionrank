// Cut a staged round's export down to its first group: the votes on pairs among the launch questions, cast before
// the second group of questions joined. That slice is the nearest thing the round "All questions" holds to the
// pre-registered Round 1 (which closed without a verdict), so it can be run through analyze.ts beside method A and A2.
// The result is exploratory, never the registered analysis (DEVIATIONS.md, 25 Nov 2026). Not a frozen file.
//
//   npx tsx analysis/first_group.ts --export round.json --backup wtpqr-backup.json \
//       [--items items/launch_items_v1.json] [--out first-group.json]
//   npx tsx analysis/analyze.ts --export first-group.json --items items/launch_items_v1.json \
//       --llm-design llm-arm/design.json --llm-out llm-arm/out --out analysis-out/first-group
//
// --export is the round's JSON export from /admin; --backup is "Download full backup" (it holds round_in_play, which
// says when each question joined). Without --backup every vote among the launch questions is kept, whenever cast.
import fs from "node:fs";
import type { RoundExport } from "./analyze";

export interface InPlayRow {
  round_id: string;
  question_id: string;
  joined_at: string;
}

export interface FirstGroupResult {
  export: RoundExport;
  /** When the first question outside the group joined; null if none has, or no backup was given. */
  cutoff: string | null;
  kept: { votes: number; skips: number; voters: number };
  dropped: { otherQuestions: number; afterCutoff: number };
}

/** The slice of `full` on pairs within `group`, cast before the first question outside `group` came into play. */
export function firstGroup(full: RoundExport, group: ReadonlySet<string>, inPlay: InPlayRow[] | null): FirstGroupResult {
  const later = (inPlay ?? []).filter((r) => r.round_id === full.round.id && !group.has(r.question_id)).map((r) => r.joined_at);
  const cutoff = later.length ? later.reduce((a, b) => (a < b ? a : b)) : null;
  let otherQuestions = 0, afterCutoff = 0;
  const votes = full.votes.filter((v) => {
    if (!group.has(v.left_q) || !group.has(v.right_q)) return otherQuestions++, false;
    if (cutoff !== null && v.created_at >= cutoff) return afterCutoff++, false;
    return true;
  });
  // The export gives a skip no time, so skips are cut by question only. analyze.ts counts skips per rater and does
  // not use them in any rating.
  const skips = (full.skips ?? []).filter((s) => group.has(s.item_lo) && group.has(s.item_hi));
  const active = new Set([...votes.map((v) => v.voter_id), ...skips.map((s) => s.voter_id)]);
  const voters = full.voters.filter((u) => active.has(u.id));
  return {
    export: { round: full.round, voters, votes, skips },
    cutoff,
    kept: { votes: votes.length, skips: skips.length, voters: voters.length },
    dropped: { otherQuestions, afterCutoff },
  };
}

if (process.argv[1] && process.argv[1].endsWith("first_group.ts")) {
  const get = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const exportPath = get("export");
  if (!exportPath) throw new Error("missing --export");
  const items = JSON.parse(fs.readFileSync(get("items") ?? "items/launch_items_v1.json", "utf8")) as { items: { id: string }[] };
  const backupPath = get("backup");
  const backup = backupPath ? (JSON.parse(fs.readFileSync(backupPath, "utf8")) as { tables: Record<string, unknown[]> }) : null;
  const inPlay = backup ? ((backup.tables.round_in_play ?? []) as InPlayRow[]) : null;
  const r = firstGroup(JSON.parse(fs.readFileSync(exportPath, "utf8")) as RoundExport, new Set(items.items.map((i) => i.id)), inPlay);
  const out = get("out") ?? "first-group.json";
  fs.writeFileSync(out, JSON.stringify(r.export));
  console.log(
    `${out}: ${r.kept.votes} votes, ${r.kept.skips} skips, ${r.kept.voters} voters. ` +
      `Left out: ${r.dropped.otherQuestions} on other questions, ${r.dropped.afterCutoff} cast after ${r.cutoff ?? "(no cutoff)"}.` +
      (backup ? "" : " No backup given: no cutoff was applied."),
  );
}
