// WTP Question Rank: analysis of an exported round, and the pre-registered comparison with the LLM rankings.
//
// Usage (from the repo root):
//   npx tsx analysis/analyze.ts --export round.json --items items/launch_items_v1.json \
//       --llm-design llm-arm/design.json --llm-out llm-arm/out \
//       [--method-b Validation_Machine_Records_2026-11-24.jsonl] [--ab sean_ab_picks.json] \
//       [--out analysis-out] [--reps 1000] [--seed 20261124]
//
// Reads only files. Writes report.md, results.json and one leaderboard CSV per pool to --out.
// The decision rules applied at the end are the ones in PREREG_Human_vs_LLM.md; change neither without the other.

import fs from "node:fs";
import path from "node:path";
import { POOLED_ROLES, QUALITY, RATING, ROLES } from "../src/rating/config";
import {
  bootstrapBT,
  fitBT,
  fitRoleDeviation,
  makeRng,
  type BTFit,
  type Vote,
} from "../src/rating/rating";
import { binomTwoSided, kendallTauB, mean, median, quantile, spearman } from "./stats";

// ---------- input types ----------

export interface ExportVoter { id: string; label: string; role: string; is_owner?: number | boolean; revoked_at?: string | null; board_seen_at?: string | null }
export interface ExportVote {
  id: number; round_id: string; voter_id: string; role: string; left_q: string; right_q: string; winner_q: string;
  close_call: number | boolean; is_repeat: number | boolean; after_board: number | boolean;
  client_ms?: number | null; server_ms?: number | null; created_at: string;
}
export interface ExportSkip { voter_id: string; item_lo: string; item_hi: string; is_repeat: number | boolean }
export interface RoundExport {
  round: { id: string; name?: string; item_set_id?: string; state?: string };
  voters: ExportVoter[];
  votes: ExportVote[];
  skips?: ExportSkip[];
}
export interface ItemFile { items: { id: string; val_id: string | null; cycle: string; unit: number; q: number }[] }
interface DesignJudge { token: string; block: number; judge: number; labels: Record<string, string>; pairs: { n: number; first: string; second: string }[] }
interface Design { judges: DesignJudge[] }

export interface AnalyzeArgs {
  exportPath: string;
  itemsPath: string;
  llmDesignPath?: string;
  llmOutDir?: string;
  methodBPath?: string;
  abPath?: string;
  outDir: string;
  reps: number;
  seed: number;
}

// ---------- constants fixed by the pre-registration ----------

export const PREREG = {
  /** Data gate for the primary analysis. */
  MIN_ADULT_RATERS: 15,
  MIN_VOTES_PER_COUNTED_RATER: 20,
  MIN_ADULT_GAMES_PER_ITEM: 30,
  /** Verdict thresholds. */
  RHO_VALIDATED: 0.7,
  RHO_LOWER_BOUND: 0.5,
  CEILING_MARGIN: 0.05,
  RHO_PARTLY: 0.5,
  SPLIT_HALVES: 200,
} as const;

/** State norms from wtp_score.py NORM (struct and qual), used only to rebuild method B's item score. */
const STATE_NORM = { struct: [49.93, 10.48], qual: [23.64, 5.36] } as const;
const tScore = (raw: number, [m, sd]: readonly [number, number]) => Math.round((50 + (10 * (raw - m)) / sd) * 10) / 10;

const truthy = (x: unknown) => x === true || x === 1 || x === "1";

// ---------- helpers ----------

function fitPool(ids: string[], votes: Vote[]): BTFit {
  return fitBT(ids, votes);
}

function leaderboard(ids: string[], votes: Vote[], meta: Map<string, { val_id: string | null; cycle: string; unit: number; q: number }>, reps: number, seed: number) {
  const fit = fitPool(ids, votes);
  const boot = bootstrapBT(ids, votes, { reps, seed });
  const rows = ids.map((id, i) => ({
    id,
    val_id: meta.get(id)?.val_id ?? null,
    cycle: meta.get(id)?.cycle,
    unit: meta.get(id)?.unit,
    q: meta.get(id)?.q,
    rating: fit.rating[i],
    lo: boot.ratingLo[i],
    hi: boot.ratingHi[i],
    rankLo: boot.rankLo[i],
    rankHi: boot.rankHi[i],
    games: fit.games[i],
    wins: fit.wins[i],
    ranked: fit.games[i] >= RATING.MIN_GAMES_RANKED,
  }));
  rows.sort((a, b) => b.rating - a.rating);
  return { fit, rows, raters: new Set(votes.map((v) => v.rater)).size, votes: votes.length, leftAdvantageElo: (400 * fit.left) / Math.LN10 };
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

function splitHalf(ids: string[], votes: Vote[], halves: number, seed: number) {
  const raters = [...new Set(votes.map((v) => v.rater!))].sort();
  if (raters.length < 4) return { median: NaN, spearmanBrown: NaN, splits: 0 };
  const rng = makeRng(seed);
  const rs: number[] = [];
  for (let h = 0; h < halves; h++) {
    const shuffled = [...raters];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = new Set(shuffled.slice(0, shuffled.length >> 1));
    const fa = fitBT(ids, votes.filter((v) => a.has(v.rater!)), { noCov: true });
    const fb = fitBT(ids, votes.filter((v) => !a.has(v.rater!)), { noCov: true });
    rs.push(spearman(fa.beta, fb.beta));
  }
  const r = median(rs);
  return { median: r, spearmanBrown: (2 * r) / (1 + r), splits: halves };
}

/** Leave-one-rater-out predictions: for each vote, did the winner have the higher strength in a fit without that rater? */
function looAgreement(ids: string[], votes: Vote[]): Map<string, { agree: number; n: number }> {
  const out = new Map<string, { agree: number; n: number }>();
  const raters = [...new Set(votes.map((v) => v.rater!))];
  const ix = new Map(ids.map((id, i) => [id, i]));
  for (const r of raters) {
    const f = fitBT(ids, votes.filter((v) => v.rater !== r), { noCov: true });
    let agree = 0, n = 0;
    for (const v of votes) {
      if (v.rater !== r) continue;
      const loser = v.winner === v.left ? v.right : v.left;
      const d = f.beta[ix.get(v.winner)!] - f.beta[ix.get(loser)!];
      agree += d > 0 ? 1 : d === 0 ? 0.5 : 0;
      n++;
    }
    out.set(r, { agree, n });
  }
  return out;
}

function agreementWith(beta: Map<string, number>, votes: Vote[]): Map<string, { agree: number; n: number }> {
  const out = new Map<string, { agree: number; n: number }>();
  for (const v of votes) {
    const loser = v.winner === v.left ? v.right : v.left;
    const d = (beta.get(v.winner) ?? 0) - (beta.get(loser) ?? 0);
    const o = out.get(v.rater!) ?? { agree: 0, n: 0 };
    o.agree += d > 0 ? 1 : d === 0 ? 0.5 : 0;
    o.n++;
    out.set(v.rater!, o);
  }
  return out;
}

// ---------- LLM inputs ----------

export function loadMethodA(designPath: string, outDir: string, ids: Set<string>) {
  const design: Design = JSON.parse(fs.readFileSync(designPath, "utf8"));
  const votes: Vote[] = [];
  const problems: string[] = [];
  let judgesRead = 0;
  for (const jd of design.judges) {
    const f = path.join(outDir, `${jd.token}.json`);
    if (!fs.existsSync(f)) {
      problems.push(`${jd.token}: no output file`);
      continue;
    }
    let rec: { token: string; pairs: { n: number; first: string; second: string; winner: string }[] };
    try {
      rec = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      problems.push(`${jd.token}: output is not valid JSON`);
      continue;
    }
    judgesRead++;
    const want = new Map(jd.pairs.map((p) => [p.n, p]));
    let ok = 0;
    for (const p of rec.pairs ?? []) {
      const w = want.get(p.n);
      if (!w || w.first !== p.first || w.second !== p.second || (p.winner !== p.first && p.winner !== p.second)) {
        problems.push(`${jd.token} pair ${p.n}: does not match the design or has an invalid winner`);
        continue;
      }
      const L = jd.labels[p.first], R = jd.labels[p.second], W = jd.labels[p.winner];
      if (!ids.has(L) || !ids.has(R)) continue;
      votes.push({ left: L, right: R, winner: W, rater: jd.token, role: "llm" });
      want.delete(p.n);
      ok++;
    }
    if (want.size) problems.push(`${jd.token}: ${want.size} pairs missing`);
  }
  return { votes, problems, judgesRead, judgesExpected: design.judges.length };
}

/** Method B item scores for the 12 validation items: mean over scorers of (S_T + Q_T) / 2, State norms. */
export function loadMethodB(p: string): Map<string, { score: number; scorers: number }> {
  const acc = new Map<string, number[]>();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.arm !== "B") continue;
    for (const it of rec.items) {
      const vid = String(it.id).slice(0, 3);
      const sRaw = ["S1", "S2", "S3", "S4", "S5"].reduce((s, k) => s + Number(it.S[k].score), 0);
      const qRaw = ["Q1", "Q2", "Q3", "Q4", "Q5"].reduce((s, k) => s + Number(it.Q[k].score), 0);
      const score = (tScore(sRaw, STATE_NORM.struct) + tScore(qRaw, STATE_NORM.qual)) / 2;
      acc.set(vid, [...(acc.get(vid) ?? []), score]);
    }
  }
  return new Map([...acc].map(([k, v]) => [k, { score: mean(v), scorers: v.length }]));
}

/** Sean's A/B picks as saved by the Hearing Question A/B page: {picks: {n: {n,left,right,pick,side,close,ms}}} or an array. */
export function loadAB(p: string) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const picks: { n: number; left: string; right: string; pick: string; close: boolean }[] = Array.isArray(raw.picks) ? raw.picks : Object.values(raw.picks ?? {});
  picks.sort((a, b) => a.n - b.n);
  const seen = new Set<string>();
  const first: typeof picks = [];
  const repeats: typeof picks = [];
  for (const k of picks) {
    const key = [k.left, k.right].sort().join("|");
    (seen.has(key) ? repeats : first).push(k);
    seen.add(key);
  }
  return { first, repeats };
}

// ---------- main analysis ----------

export function analyze(a: AnalyzeArgs) {
  const items: ItemFile = JSON.parse(fs.readFileSync(a.itemsPath, "utf8"));
  const ids = items.items.map((i) => i.id);
  const idSet = new Set(ids);
  const meta = new Map(items.items.map((i) => [i.id, i]));
  const byVal = new Map(items.items.filter((i) => i.val_id).map((i) => [i.val_id!, i.id]));
  const ex: RoundExport = JSON.parse(fs.readFileSync(a.exportPath, "utf8"));
  const voters = new Map(ex.voters.map((v) => [v.id, v]));
  const notes: string[] = [];

  const allVotes = ex.votes.filter((v) => v.round_id === ex.round.id && idSet.has(v.left_q) && idSet.has(v.right_q));
  const revoked = new Set(ex.voters.filter((v) => v.revoked_at).map((v) => v.id));
  const live = allVotes.filter((v) => !revoked.has(v.voter_id));
  const toVote = (v: ExportVote): Vote => ({ left: v.left_q, right: v.right_q, winner: v.winner_q, rater: v.voter_id, role: v.role });
  const first = live.filter((v) => !truthy(v.is_repeat));
  const repeats = live.filter((v) => truthy(v.is_repeat));
  const adultRoles = new Set<string>(POOLED_ROLES);
  const adultFirst = first.filter((v) => adultRoles.has(v.role));

  // ---- rater quality ----
  const raterRows = ex.voters.map((vt) => {
    const mine = first.filter((v) => v.voter_id === vt.id);
    const reps = repeats.filter((v) => v.voter_id === vt.id);
    let repAgree = 0, repN = 0;
    for (const r of reps) {
      const orig = mine.find((v) => [v.left_q, v.right_q].sort().join() === [r.left_q, r.right_q].sort().join());
      if (!orig) continue;
      repN++;
      if (orig.winner_q === r.winner_q) repAgree++;
    }
    const leftPicks = mine.filter((v) => v.winner_q === v.left_q).length;
    const cms = mine.map((v) => v.client_ms).filter((x): x is number => typeof x === "number");
    const sms = mine.map((v) => v.server_ms).filter((x): x is number => typeof x === "number");
    const enough = mine.length >= QUALITY.MIN_VOTES_FOR_FLAGS;
    const leftShare = mine.length ? leftPicks / mine.length : NaN;
    const medMs = median(sms.length ? sms : cms);
    const flags: string[] = [];
    if (enough && medMs < QUALITY.TOO_FAST_MEDIAN_MS) flags.push("too_fast");
    if (enough && Math.max(leftShare, 1 - leftShare) >= QUALITY.SIDE_SHARE_FLAG) flags.push("one_side");
    if (vt.revoked_at) flags.push("revoked");
    return {
      voter: vt.id, label: vt.label, role: vt.role, owner: truthy(vt.is_owner),
      votes: mine.length, repeats: repN, repeatAgree: repAgree,
      leftShare, leftP: binomTwoSided(leftPicks, mine.length),
      medianClientMs: median(cms), medianServerMs: median(sms),
      closeCallRate: mine.length ? mine.filter((v) => truthy(v.close_call)).length / mine.length : NaN,
      skips: (ex.skips ?? []).filter((s) => s.voter_id === vt.id).length,
      afterBoardVotes: mine.filter((v) => truthy(v.after_board)).length,
      looAgreement: NaN as number,
      flags: flags.join(" "),
    };
  });
  const loo = looAgreement(ids, adultFirst.map(toVote));
  for (const r of raterRows) {
    const l = loo.get(r.voter);
    if (l && l.n) r.looAgreement = l.agree / l.n;
  }
  const flagged = new Set(raterRows.filter((r) => r.flags && r.flags !== "revoked").map((r) => r.voter));

  // ---- leaderboards ----
  const pools: Record<string, Vote[]> = {
    adults: adultFirst.map(toVote),
    everyone: first.map(toVote),
  };
  for (const role of ROLES) pools[role] = first.filter((v) => v.role === role).map(toVote);
  const boards: Record<string, ReturnType<typeof leaderboard>> = {};
  for (const [pool, vs] of Object.entries(pools)) {
    if (!vs.length) continue;
    boards[pool] = leaderboard(ids, vs, meta, a.reps, a.seed);
  }

  // ---- reliability ----
  const adultVotes = pools.adults;
  const humanSplit = splitHalf(ids, adultVotes, PREREG.SPLIT_HALVES, a.seed);
  const adultFit = boards.adults?.fit;
  const ssr = adultFit
    ? (() => {
        const v = adultFit.beta.reduce((s, b) => s + b * b, 0) / adultFit.beta.length;
        const e = mean(adultFit.se.map((s) => s * s));
        return (v - e) / v;
      })()
    : NaN;
  const totalPairRepeats = raterRows.reduce((s, r) => s + r.repeats, 0);
  const repeatConsistency = totalPairRepeats ? raterRows.reduce((s, r) => s + r.repeatAgree, 0) / totalPairRepeats : NaN;

  // ---- roles ----
  const roleFits: Record<string, BTFit> = {};
  for (const role of ROLES) if (pools[role]?.length) roleFits[role] = boards[role].fit;
  const roleAgreement: { a: string; b: string; items: number; spearman: number }[] = [];
  const roleNames = Object.keys(roleFits);
  for (let i = 0; i < roleNames.length; i++)
    for (let j = i + 1; j < roleNames.length; j++) {
      const fa = roleFits[roleNames[i]], fb = roleFits[roleNames[j]];
      const keep = ids.map((_, k) => k).filter((k) => fa.games[k] >= RATING.MIN_GAMES_RANKED && fb.games[k] >= RATING.MIN_GAMES_RANKED);
      if (keep.length >= 5)
        roleAgreement.push({ a: roleNames[i], b: roleNames[j], items: keep.length, spearman: spearman(keep.map((k) => fa.beta[k]), keep.map((k) => fb.beta[k])) });
    }
  const dev = first.length ? fitRoleDeviation(ids, first.map(toVote)) : null;
  const roleOutliers: { role: string; id: string; devElo: number; z: number }[] = [];
  if (dev)
    dev.roles.forEach((role, r) =>
      ids.forEach((id, i) => {
        const z = dev.dev[r][i] / dev.devSe[r][i];
        if (Math.abs(z) >= 2) roleOutliers.push({ role, id, devElo: (400 * dev.dev[r][i]) / Math.LN10, z });
      }),
    );

  // ---- method A (LLM pairwise, 36 items) ----
  let methodA: Record<string, unknown> | null = null;
  let llmBeta: Map<string, number> | null = null;
  if (a.llmDesignPath && a.llmOutDir && fs.existsSync(a.llmDesignPath)) {
    const A = loadMethodA(a.llmDesignPath, a.llmOutDir, idSet);
    if (A.problems.length) notes.push(`Method A input problems (${A.problems.length}): ${A.problems.slice(0, 10).join("; ")}`);
    if (A.votes.length) {
      const fA = fitBT(ids, A.votes);
      llmBeta = new Map(ids.map((id, i) => [id, fA.beta[i]]));
      // LLM split-half: within each block, 3 of 6 judges vs the other 3.
      const llmSplit = splitHalf(ids, A.votes, PREREG.SPLIT_HALVES, a.seed + 1);
      methodA = {
        judgesRead: A.judgesRead, judgesExpected: A.judgesExpected, judgments: A.votes.length,
        leftAdvantageElo: (400 * fA.left) / Math.LN10,
        splitHalf: llmSplit,
        ratings: Object.fromEntries(ids.map((id, i) => [id, fA.rating[i]])),
      };
    }
  }

  // ---- primary comparison ----
  const adultRaterCounts = new Map<string, number>();
  for (const v of adultFirst) adultRaterCounts.set(v.voter_id, (adultRaterCounts.get(v.voter_id) ?? 0) + 1);
  const countedRaters = [...adultRaterCounts.values()].filter((n) => n >= PREREG.MIN_VOTES_PER_COUNTED_RATER).length;
  const minItemGames = adultFit ? Math.min(...adultFit.games) : 0;
  const gate = {
    countedAdultRaters: countedRaters,
    minAdultGamesPerItem: minItemGames,
    passed: countedRaters >= PREREG.MIN_ADULT_RATERS && minItemGames >= PREREG.MIN_ADULT_GAMES_PER_ITEM,
  };

  let primary: Record<string, unknown> | null = null;
  let verdict = "No verdict: method A records or adult votes are missing.";
  if (llmBeta && adultFit) {
    const llm = ids.map((id) => llmBeta!.get(id)!);
    const rho = spearman(adultFit.beta, llm);
    const tau = kendallTauB(adultFit.beta, llm);
    const draws: number[] = [];
    bootstrapBT(ids, adultVotes, { reps: a.reps, seed: a.seed + 2, onDraw: (b) => draws.push(spearman(b, llm)) });
    const rhoLo = quantile(draws, 0.025), rhoHi = quantile(draws, 0.975);
    // Vote-level agreement vs the human ceiling, on the same adult votes.
    const agA = agreementWith(llmBeta, adultVotes);
    const per = [...loo.keys()].map((r) => ({ r, a: agA.get(r)!, c: loo.get(r)! }));
    const sumA = per.reduce((s, x) => s + x.a.agree, 0), sumC = per.reduce((s, x) => s + x.c.agree, 0), n = per.reduce((s, x) => s + x.c.n, 0);
    const rng = makeRng(a.seed + 3);
    const diffs: number[] = [];
    for (let b = 0; b < a.reps; b++) {
      let sa = 0, sc = 0, sn = 0;
      for (let k = 0; k < per.length; k++) {
        const x = per[Math.floor(rng() * per.length)];
        sa += x.a.agree; sc += x.c.agree; sn += x.c.n;
      }
      diffs.push(sa / sn - sc / sn);
    }
    // Linear calibration map from LLM log-odds to human log-odds (for future use; descriptive).
    const mx = mean(llm), my = mean(adultFit.beta);
    let sxy = 0, sxx = 0;
    llm.forEach((x, i) => { sxy += (x - mx) * (adultFit.beta[i] - my); sxx += (x - mx) ** 2; });
    const slope = sxy / sxx;
    const reliabilityProduct = humanSplit.spearmanBrown * ((methodA?.splitHalf as { spearmanBrown: number })?.spearmanBrown ?? NaN);
    primary = {
      spearman: rho, ci95: [rhoLo, rhoHi], kendallTauB: tau,
      voteAgreementA: sum(sumA, n), voteCeiling: sum(sumC, n), diffAminusCeiling: sumA / n - sumC / n,
      diffCi95: [quantile(diffs, 0.025), quantile(diffs, 0.975)], adultVotes: n,
      disattenuatedSpearman: rho / Math.sqrt(reliabilityProduct),
      calibration: { slope, intercept: my - slope * mx, note: "human log-odds ~= intercept + slope * LLM log-odds" },
    };
    const okRho = rho >= PREREG.RHO_VALIDATED && rhoLo >= PREREG.RHO_LOWER_BOUND;
    const okCeil = sumA / n >= sumC / n - PREREG.CEILING_MARGIN;
    verdict = !gate.passed
      ? "INSUFFICIENT DATA: the data gate failed. Report every number as descriptive; no verdict."
      : okRho && okCeil
        ? "VALIDATED FOR RANKING: method A tracks the adult pool's ranking (rho >= 0.70, lower bound >= 0.50) and predicts single votes within 0.05 of the human ceiling."
        : rho >= PREREG.RHO_PARTLY
          ? `PARTLY VALIDATED: rho ${rho.toFixed(2)} (95% CI ${rhoLo.toFixed(2)} to ${rhoHi.toFixed(2)}); ${okRho ? "" : "rank criterion not met; "}${okCeil ? "" : "vote-level criterion not met"}.`
          : `NOT VALIDATED: rho ${rho.toFixed(2)} is below 0.50.`;
  }
  function sum(x: number, n: number) { return n ? x / n : NaN; }

  // ---- secondary: method B and the 12 validation items ----
  let twelve: Record<string, unknown> | null = null;
  if (adultFit) {
    const vIds = [...byVal.entries()].sort();
    const hum = vIds.map(([, id]) => adultFit.beta[ids.indexOf(id)]);
    twelve = { items: vIds.length };
    if (llmBeta) twelve.methodA_spearman = spearman(hum, vIds.map(([, id]) => llmBeta!.get(id)!));
    if (a.methodBPath && fs.existsSync(a.methodBPath)) {
      const B = loadMethodB(a.methodBPath);
      const bScores = vIds.map(([v]) => B.get(v)?.score ?? NaN);
      if (bScores.every(Number.isFinite)) {
        twelve.methodB_spearman = spearman(hum, bScores);
        if (llmBeta) twelve.methodA_vs_B_spearman = spearman(vIds.map(([, id]) => llmBeta!.get(id)!), bScores);
        twelve.methodB_scores = Object.fromEntries(vIds.map(([v], k) => [v, bScores[k]]));
      } else notes.push("Method B file lacks scores for some of the 12 validation items.");
    }
    if (a.abPath && fs.existsSync(a.abPath)) {
      const ab = loadAB(a.abPath);
      const abVotes: Vote[] = ab.first.map((k) => ({ left: byVal.get(k.left)!, right: byVal.get(k.right)!, winner: byVal.get(k.pick)!, rater: "sean-ab" }));
      const humanMap = new Map(ids.map((id, i) => [id, adultFit.beta[i]]));
      const agH = agreementWith(humanMap, abVotes).get("sean-ab");
      twelve.seanAB = {
        firstPicks: ab.first.length,
        repeatConsistency: ab.repeats.length ? ab.repeats.filter((r) => ab.first.find((f) => [f.left, f.right].sort().join() === [r.left, r.right].sort().join())?.pick === r.pick).length / ab.repeats.length : NaN,
        agreementWithAdultPool: agH ? agH.agree / agH.n : NaN,
        agreementWithMethodA: llmBeta ? (() => { const g = agreementWith(llmBeta!, abVotes).get("sean-ab")!; return g.agree / g.n; })() : NaN,
      };
    }
  }

  // ---- sensitivity analyses ----
  const sensitivity: Record<string, number> = {};
  if (llmBeta) {
    const llm = ids.map((id) => llmBeta!.get(id)!);
    const rhoFor = (vs: ExportVote[]) => (vs.length ? spearman(fitBT(ids, vs.map(toVote), { noCov: true }).beta, llm) : NaN);
    const ownerIds = new Set(ex.voters.filter((v) => truthy(v.is_owner)).map((v) => v.id));
    sensitivity.excludingFlaggedRaters = rhoFor(adultFirst.filter((v) => !flagged.has(v.voter_id)));
    sensitivity.excludingOwner = rhoFor(adultFirst.filter((v) => !ownerIds.has(v.voter_id)));
    sensitivity.beforeLeaderboardOnly = rhoFor(adultFirst.filter((v) => !truthy(v.after_board)));
    sensitivity.excludingCloseCalls = rhoFor(adultFirst.filter((v) => !truthy(v.close_call)));
    sensitivity.judgesAndCoachesOnly = rhoFor(first.filter((v) => v.role === "judge" || v.role === "coach"));
    sensitivity.studentsOnly = rhoFor(first.filter((v) => v.role === "student"));
  }

  const results = {
    round: ex.round, generated: new Date().toISOString(), reps: a.reps, seed: a.seed,
    counts: { votes: allVotes.length, revokedExcluded: allVotes.length - live.length, firstPresentation: first.length, repeats: repeats.length, adultFirst: adultFirst.length, skips: ex.skips?.length ?? 0 },
    gate, verdict, primary, twelve, sensitivity, methodA,
    reliability: { humanSplitHalf: humanSplit, scaleSeparationReliability: ssr, repeatConsistency, note: "Adaptive pair selection inflates SSR; split-half by rater is the primary reliability figure." },
    roles: { agreement: roleAgreement, outliers: roleOutliers.sort((x, y) => Math.abs(y.z) - Math.abs(x.z)) },
    raters: raterRows,
    leaderboards: Object.fromEntries(Object.entries(boards).map(([k, b]) => [k, { raters: b.raters, votes: b.votes, leftAdvantageElo: b.leftAdvantageElo, rows: b.rows }])),
    notes,
  };

  fs.mkdirSync(a.outDir, { recursive: true });
  fs.writeFileSync(path.join(a.outDir, "results.json"), JSON.stringify(results, null, 1));
  for (const [k, b] of Object.entries(boards)) fs.writeFileSync(path.join(a.outDir, `leaderboard_${k}.csv`), csv(b.rows));
  fs.writeFileSync(path.join(a.outDir, "raters.csv"), csv(raterRows));
  fs.writeFileSync(path.join(a.outDir, "report.md"), report(results));
  return results;
}

function f2(x: unknown, d = 2): string {
  if (typeof x !== "number" || !Number.isFinite(x)) return "n/a";
  return Number.isInteger(x) && Math.abs(x) >= 2 ? String(x) : x.toFixed(d);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function report(r: any): string {
  const L: string[] = [];
  L.push(`# WTP Question Rank: round ${r.round.id} analysis`, "", `Generated ${r.generated}. Bootstrap ${r.reps} reps, seed ${r.seed}, resampling raters.`, "");
  L.push(`**Verdict (pre-registered rule):** ${r.verdict}`, "");
  L.push(`Data gate: ${r.gate.countedAdultRaters} adult raters with >= ${PREREG.MIN_VOTES_PER_COUNTED_RATER} votes (need ${PREREG.MIN_ADULT_RATERS}); fewest adult comparisons on any item ${r.gate.minAdultGamesPerItem} (need ${PREREG.MIN_ADULT_GAMES_PER_ITEM}). ${r.gate.passed ? "Passed." : "Failed."}`, "");
  if (r.primary) {
    const p = r.primary;
    L.push("## Primary comparison: adult pool vs LLM method A (36 items)", "");
    L.push(`- Spearman ${f2(p.spearman)} (95% CI ${f2(p.ci95[0])} to ${f2(p.ci95[1])}); Kendall tau-b ${f2(p.kendallTauB)}.`);
    L.push(`- Single adult votes predicted by method A: ${f2(p.voteAgreementA, 3)}; by the other adults (leave-one-rater-out ceiling): ${f2(p.voteCeiling, 3)}; difference ${f2(p.diffAminusCeiling, 3)} (95% CI ${f2(p.diffCi95[0], 3)} to ${f2(p.diffCi95[1], 3)}), over ${p.adultVotes} votes.`);
    L.push(`- Spearman corrected for both rankings' split-half reliability (descriptive): ${f2(p.disattenuatedSpearman)}.`);
    L.push(`- Calibration map (descriptive): human log-odds = ${f2(p.calibration.intercept, 3)} + ${f2(p.calibration.slope, 3)} x LLM log-odds.`, "");
  }
  if (r.twelve) {
    L.push("## The 12 A/B validation items (secondary, n = 12)", "");
    for (const [k, v] of Object.entries(r.twelve)) if (typeof v === "number") L.push(`- ${k}: ${f2(v)}`);
    if (r.twelve.seanAB) for (const [k, v] of Object.entries(r.twelve.seanAB)) L.push(`- Sean A/B ${k}: ${f2(v as number)}`);
    L.push("");
  }
  if (Object.keys(r.sensitivity).length) {
    L.push("## Sensitivity: Spearman with method A under each restriction", "");
    for (const [k, v] of Object.entries(r.sensitivity)) L.push(`- ${k}: ${f2(v)}`);
    L.push("");
  }
  L.push("## Reliability", "");
  L.push(`- Human split-half by rater (median of ${r.reliability.humanSplitHalf.splits}): ${f2(r.reliability.humanSplitHalf.median)}; Spearman–Brown ${f2(r.reliability.humanSplitHalf.spearmanBrown)}.`);
  if (r.methodA) L.push(`- LLM split-half: Spearman–Brown ${f2(r.methodA.splitHalf.spearmanBrown)}.`);
  L.push(`- Scale separation reliability (inflated by adaptive pairing): ${f2(r.reliability.scaleSeparationReliability)}.`);
  L.push(`- Swapped repeats answered the same way: ${f2(r.reliability.repeatConsistency)}.`, "");
  L.push("## Leaderboard: adults pooled", "", "| # | item | val | rating | 95% CI | rank range | games |", "|--:|---|---|--:|---|---|--:|");
  (r.leaderboards.adults?.rows ?? []).forEach((x: any, k: number) =>
    L.push(`| ${k + 1} | ${x.id} | ${x.val_id ?? ""} | ${Math.round(x.rating)} | ${Math.round(x.lo)}–${Math.round(x.hi)} | ${x.rankLo}–${x.rankHi} | ${x.games}${x.ranked ? "" : " (unranked)"} |`),
  );
  L.push("", "## Roles", "");
  for (const g of r.roles.agreement) L.push(`- ${g.a} vs ${g.b}: Spearman ${f2(g.spearman)} on ${g.items} items`);
  for (const o of r.roles.outliers.slice(0, 15)) L.push(`- ${o.role} departs from the pool on ${o.id}: ${o.devElo > 0 ? "+" : ""}${Math.round(o.devElo)} points (z ${f2(o.z, 1)})`);
  L.push("", "## Raters flagged", "");
  for (const x of r.raters.filter((x: any) => x.flags)) L.push(`- ${x.label} (${x.role}): ${x.flags}; ${x.votes} votes; median ${Math.round((x.medianServerMs || x.medianClientMs) / 1000)} s; left share ${f2(x.leftShare)}`);
  if (r.notes.length) L.push("", "## Notes", "", ...r.notes.map((n: string) => `- ${n}`));
  return L.join("\n") + "\n";
}

// ---------- CLI ----------

function parseArgs(argv: string[]): AnalyzeArgs {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const req = (k: string) => {
    const v = get(k);
    if (!v) throw new Error(`missing --${k}`);
    return v;
  };
  return {
    exportPath: req("export"),
    itemsPath: req("items"),
    llmDesignPath: get("llm-design"),
    llmOutDir: get("llm-out"),
    methodBPath: get("method-b"),
    abPath: get("ab"),
    outDir: get("out") ?? "analysis-out",
    reps: Number(get("reps") ?? RATING.BOOTSTRAP_REPS),
    seed: Number(get("seed") ?? 20261124),
  };
}

if (process.argv[1] && process.argv[1].endsWith("analyze.ts")) {
  const r = analyze(parseArgs(process.argv.slice(2)));
  console.log(r.verdict);
}
