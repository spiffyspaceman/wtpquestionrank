// Summarize the method A run: validity checks, ratings, split-half reliability, position effect.
import fs from "node:fs";
import { loadMethodA } from "../analysis/analyze";
import { bootstrapBT, fitBT, makeRng } from "../src/rating/rating";
import { median, spearman } from "../analysis/stats";
const items = JSON.parse(fs.readFileSync("items/launch_items_v1.json", "utf8")).items as { id: string; val_id: string | null }[];
const ids = items.map((i) => i.id);
const A = loadMethodA("llm-arm/design.json", "llm-arm/out", new Set(ids));
const f = fitBT(ids, A.votes);
const boot = bootstrapBT(ids, A.votes, { reps: 1000, seed: 20261124 });
const firstWins = A.votes.filter((v) => v.winner === v.left).length;
// split-half within block: 3 of 6 judges per block vs the rest
const rng = makeRng(7);
const rs: number[] = [];
for (let h = 0; h < 200; h++) {
  const half = new Set<string>();
  for (let b = 0; b < 5; b++) {
    const js = [0, 1, 2, 3, 4, 5].sort(() => rng() - 0.5).slice(0, 3);
    js.forEach((j) => half.add(`b${b}j${j}`));
  }
  const fa = fitBT(ids, A.votes.filter((v) => half.has(v.rater!)), { noCov: true });
  const fb = fitBT(ids, A.votes.filter((v) => !half.has(v.rater!)), { noCov: true });
  rs.push(spearman(fa.beta, fb.beta));
}
// pair-level unanimity
const byPair = new Map<string, number[]>();
for (const v of A.votes) { const k = [v.left, v.right].sort().join("|"); const w = v.winner === [v.left, v.right].sort()[0] ? 1 : 0; byPair.set(k, [...(byPair.get(k) ?? []), w]); }
const split = [...byPair.values()].map((xs) => xs.reduce((s, x) => s + x, 0));
const dist = [0, 1, 2, 3, 4, 5, 6].map((k) => split.filter((s) => s === k).length);
const r = median(rs);
const rows = ids.map((id, i) => ({ id, val: items[i].val_id, rating: f.rating[i], lo: boot.ratingLo[i], hi: boot.ratingHi[i], rankLo: boot.rankLo[i], rankHi: boot.rankHi[i], wins: f.wins[i], games: f.games[i] })).sort((a, b) => b.rating - a.rating);
const out = { judgesRead: A.judgesRead, judgments: A.votes.length, problems: A.problems, firstListedWon: firstWins / A.votes.length, leftAdvantageElo: (400 * f.left) / Math.LN10, leftSe: f.leftSe, splitHalfMedian: r, spearmanBrown: (2 * r) / (1 + r), pairVoteSplits_0to6: dist, rows };
fs.writeFileSync("llm-arm/methodA_summary.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, rows: undefined }, null, 0));
rows.forEach((x, k) => console.log(k + 1, x.id, x.val ?? "", Math.round(x.rating), `${Math.round(x.lo)}-${Math.round(x.hi)}`, `${x.rankLo}-${x.rankHi}`, `${x.wins}/${x.games}`));
