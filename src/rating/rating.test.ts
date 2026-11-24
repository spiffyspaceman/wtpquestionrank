import { describe, expect, it } from "vitest";
import { RATING } from "./config";
import {
  aggregate,
  bootstrapBT,
  eloDiffToLogOdds,
  fitBT,
  fitBTCounts,
  fitLogisticMAP,
  fitRoleDeviation,
  makeRng,
  ranksOf,
  sigmoid,
  toElo,
  type Vote,
} from "./rating";

// ---- helpers ----
function spearman(a: number[], b: number[]): number {
  const ra = ranksOf(a);
  const rb = ranksOf(b);
  const n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/** Simulate votes from known strengths. Each rater has idiosyncratic noise on item strengths. */
function simulate(opts: {
  trueBeta: number[];
  raters: number;
  votesPerRater: number;
  left?: number;
  raterNoise?: number;
  seed?: number;
  role?: (r: number) => string;
  roleShift?: (role: string, item: number) => number;
}): { ids: string[]; votes: Vote[] } {
  const rng = makeRng(opts.seed ?? 1);
  const n = opts.trueBeta.length;
  const ids = opts.trueBeta.map((_, i) => `q${String(i).padStart(2, "0")}`);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const votes: Vote[] = [];
  for (let r = 0; r < opts.raters; r++) {
    const role = opts.role ? opts.role(r) : "judge";
    const own = opts.trueBeta.map((b, i) => b + (opts.raterNoise ?? 0) * normal() + (opts.roleShift?.(role, i) ?? 0));
    for (let k = 0; k < opts.votesPerRater; k++) {
      const a = Math.floor(rng() * n);
      let c = Math.floor(rng() * (n - 1));
      if (c >= a) c++;
      const p = sigmoid(own[a] - own[c] + (opts.left ?? 0));
      votes.push({ left: ids[a], right: ids[c], winner: rng() < p ? ids[a] : ids[c], rater: `r${r}`, role });
    }
  }
  return { ids, votes };
}

const spread = (n: number) => Array.from({ length: n }, (_, i) => -1.5 + (3 * i) / (n - 1));

// ---- tests ----
describe("scale", () => {
  it("maps log-odds to 1000 + 400 * log10-odds", () => {
    expect(toElo(0)).toBe(1000);
    expect(toElo(Math.LN10)).toBeCloseTo(1400, 10); // 10:1 odds = +400
    expect(eloDiffToLogOdds(400)).toBeCloseTo(Math.LN10, 12);
  });
  it("a 400-point gap means the higher item wins 10 times in 11", () => {
    expect(sigmoid(eloDiffToLogOdds(400))).toBeCloseTo(10 / 11, 12);
  });
});

describe("logistic MAP solver", () => {
  it("matches the closed form for two items with a flat-ish prior", () => {
    // a beats b 30 of 40. MLE of (beta_a - beta_b) = ln(30/10).
    const fit = fitLogisticMAP(2, [1e8, 1e8], [{ idx: [0, 1], val: [1, -1], succ: 30, n: 40 }]);
    expect(fit.converged).toBe(true);
    expect(fit.theta[0] - fit.theta[1]).toBeCloseTo(Math.log(3), 6);
  });
});

describe("Bradley–Terry fit", () => {
  const trueBeta = spread(12);
  const { ids, votes } = simulate({ trueBeta, raters: 40, votesPerRater: 60, seed: 7 });

  it("recovers known strengths", () => {
    const f = fitBT(ids, votes, { leftEffect: false });
    expect(f.converged).toBe(true);
    expect(spearman(f.beta, trueBeta)).toBeGreaterThan(0.97);
    const maxErr = Math.max(...f.beta.map((b, i) => Math.abs(b - trueBeta[i])));
    expect(maxErr).toBeLessThan(0.35);
  });

  it("centres the scale: betas sum to zero and the mean rating is 1000", () => {
    const f = fitBT(ids, votes);
    expect(f.beta.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 8);
    expect(f.rating.reduce((s, x) => s + x, 0) / f.rating.length).toBeCloseTo(RATING.ELO_BASE, 6);
  });

  it("does not depend on vote order (unlike online Elo)", () => {
    const rng = makeRng(99);
    const shuffled = [...votes];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = fitBT(ids, votes);
    const b = fitBT(ids, shuffled);
    a.beta.forEach((x, i) => expect(b.beta[i]).toBeCloseTo(x, 10));
  });

  it("gives an undefeated item a finite rating", () => {
    const v: Vote[] = [];
    for (let k = 0; k < 15; k++) v.push({ left: "A", right: "B", winner: "A" }, { left: "C", right: "A", winner: "A" });
    v.push({ left: "B", right: "C", winner: "B" });
    const f = fitBT(["A", "B", "C"], v);
    expect(Number.isFinite(f.rating[0])).toBe(true);
    expect(f.rating[0]).toBeGreaterThan(f.rating[1]);
    expect(f.games).toEqual([30, 16, 16]);
    expect(f.wins).toEqual([30, 1, 0]);
  });

  it("estimates a left-side advantage and removes it from the item ratings", () => {
    const sim = simulate({ trueBeta, raters: 40, votesPerRater: 80, left: 0.4, seed: 11 });
    const f = fitBT(sim.ids, sim.votes);
    expect(f.left).toBeGreaterThan(0.3);
    expect(f.left).toBeLessThan(0.5);
    expect(spearman(f.beta, trueBeta)).toBeGreaterThan(0.97);
    const none = fitBT(ids, votes);
    expect(Math.abs(none.left)).toBeLessThan(2.5 * none.leftSe);
  });

  it("ignores counts for items outside the fit", () => {
    const f = fitBTCounts(["A", "B"], [
      { left: "A", right: "B", leftWins: 3, n: 4 },
      { left: "A", right: "Z", leftWins: 4, n: 4 },
    ]);
    expect(f.nVotes).toBe(4);
  });

  it("rejects a vote whose winner was not shown", () => {
    expect(() => aggregate([{ left: "A", right: "B", winner: "C" }])).toThrow();
  });

  it("fits 36 items and 5,000 votes fast enough for a Worker request", () => {
    const sim = simulate({ trueBeta: spread(36), raters: 100, votesPerRater: 50, seed: 3 });
    const counts = aggregate(sim.votes);
    const t0 = performance.now();
    const f = fitBTCounts(sim.ids, counts);
    const ms = performance.now() - t0;
    expect(f.converged).toBe(true);
    // The Workers Free limit is 10 ms CPU per request (brief, 24 Nov 2026). Node is a rough proxy.
    console.log(`point fit, 36 items, ${counts.length} pair rows: ${ms.toFixed(2)} ms, ${f.iterations} iterations`);
    expect(ms).toBeLessThan(50);
  });
});

describe("bootstrap", () => {
  const trueBeta = spread(10);
  // Heterogeneous raters: each sees the items differently. Votes within a rater are correlated.
  const { ids, votes } = simulate({ trueBeta, raters: 15, votesPerRater: 80, raterNoise: 0.8, seed: 5 });

  it("is reproducible with a seed and brackets the point estimate", () => {
    const a = bootstrapBT(ids, votes, { reps: 200, seed: 1 });
    const b = bootstrapBT(ids, votes, { reps: 200, seed: 1 });
    expect(a.ratingLo).toEqual(b.ratingLo);
    const f = fitBT(ids, votes);
    f.rating.forEach((r, i) => {
      expect(a.ratingLo[i]).toBeLessThanOrEqual(r);
      expect(a.ratingHi[i]).toBeGreaterThanOrEqual(r);
      expect(a.rankLo[i]).toBeLessThanOrEqual(a.rankHi[i]);
    });
    expect(a.clusters).toBe(15);
  });

  it("gives wider intervals when it resamples raters than when it resamples single votes", () => {
    const byRater = bootstrapBT(ids, votes, { reps: 300, seed: 2, unit: "rater" });
    const byVote = bootstrapBT(ids, votes, { reps: 300, seed: 2, unit: "vote" });
    const w = (r: typeof byRater) => r.ratingHi.reduce((s, x, i) => s + x - r.ratingLo[i], 0) / r.ids.length;
    expect(w(byRater)).toBeGreaterThan(w(byVote));
  });
});

describe("role-deviation (extended) model", () => {
  it("finds the items on which one role departs from the pool", () => {
    const trueBeta = spread(10);
    const sim = simulate({
      trueBeta,
      raters: 60,
      votesPerRater: 80,
      seed: 21,
      role: (r) => (r % 2 ? "student" : "judge"),
      // Students like item 0 (the weakest) far more and item 9 (the strongest) far less.
      roleShift: (role, i) => (role === "student" ? (i === 0 ? 2 : i === 9 ? -2 : 0) : 0),
    });
    const f = fitRoleDeviation(sim.ids, sim.votes);
    expect(f.converged).toBe(true);
    const s = f.roles.indexOf("student");
    const j = f.roles.indexOf("judge");
    const gap0 = f.dev[s][0] - f.dev[j][0];
    const gap9 = f.dev[s][9] - f.dev[j][9];
    expect(gap0).toBeGreaterThan(1);
    expect(gap9).toBeLessThan(-1);
    const others = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => Math.abs(f.dev[s][i] - f.dev[j][i]));
    expect(Math.max(...others)).toBeLessThan(0.8);
  });
});
