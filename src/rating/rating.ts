// Bradley–Terry ratings for pairwise votes, fit in one batch over the whole vote log.
//
// Model: P(left item wins) = sigmoid(beta_left - beta_right + theta), where theta is a
// left-side advantage. Each beta has a Normal(0, ITEM_PRIOR_SD^2) prior, so the fit is a
// maximum a posteriori (MAP) estimate. The prior keeps undefeated items finite and makes
// the betas sum to zero, so the average item sits at exactly ELO_BASE.
//
// The fit depends only on how many times each ordered pair came out each way, never on vote
// order. Shuffling the log returns the same ratings. That is the reason to use it over online Elo.
//
// Pure TypeScript, no dependencies: runs in a Cloudflare Worker, a browser, and Node.

import { RATING } from "./config";

// ---------- random numbers (seeded, so bootstraps and pair draws are reproducible) ----------

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sigmoid = (x: number): number =>
  x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));

/** Log-odds strength to the displayed chess-style scale: 1000 + 400 * log10-odds. */
export const toElo = (logOdds: number): number => RATING.ELO_BASE + (RATING.ELO_SCALE * logOdds) / Math.LN10;
/** Displayed-scale difference to log-odds difference. */
export const eloDiffToLogOdds = (d: number): number => (d * Math.LN10) / RATING.ELO_SCALE;

// ---------- generic sparse logistic MAP solver (Newton–Raphson) ----------

/** One binomial observation: `succ` successes in `n` trials, linear predictor sum(val[k] * param[idx[k]]). */
export interface LogitRow {
  idx: number[];
  val: number[];
  succ: number;
  n: number;
}

export interface LogitFit {
  theta: Float64Array;
  /** Posterior covariance (inverse negative Hessian at the mode), row-major p x p. */
  cov: Float64Array;
  iterations: number;
  converged: boolean;
}

function cholesky(a: Float64Array, p: number): Float64Array {
  const l = new Float64Array(p * p);
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * p + j];
      for (let k = 0; k < j; k++) s -= l[i * p + k] * l[j * p + k];
      if (i === j) {
        if (!(s > 0)) throw new Error("matrix not positive definite");
        l[i * p + i] = Math.sqrt(s);
      } else {
        l[i * p + j] = s / l[j * p + j];
      }
    }
  }
  return l;
}

function cholSolve(l: Float64Array, p: number, b: Float64Array): Float64Array {
  const y = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l[i * p + k] * y[k];
    y[i] = s / l[i * p + i];
  }
  const x = new Float64Array(p);
  for (let i = p - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < p; k++) s -= l[k * p + i] * x[k];
    x[i] = s / l[i * p + i];
  }
  return x;
}

function logPosterior(theta: Float64Array, priorVar: ArrayLike<number>, rows: LogitRow[]): number {
  let lp = 0;
  for (let j = 0; j < theta.length; j++) lp -= (theta[j] * theta[j]) / (2 * priorVar[j]);
  for (const r of rows) {
    let eta = 0;
    for (let k = 0; k < r.idx.length; k++) eta += r.val[k] * theta[r.idx[k]];
    // log sigmoid(eta) * succ + log(1 - sigmoid(eta)) * (n - succ), computed stably
    const logP = eta >= 0 ? -Math.log1p(Math.exp(-eta)) : eta - Math.log1p(Math.exp(eta));
    const logQ = logP - eta;
    lp += r.succ * logP + (r.n - r.succ) * logQ;
  }
  return lp;
}

export function fitLogisticMAP(
  p: number,
  priorVar: ArrayLike<number>,
  rows: LogitRow[],
  opts: { maxIter?: number; tol?: number; wantCov?: boolean } = {},
): LogitFit {
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-10;
  let theta = new Float64Array(p);
  let lp = logPosterior(theta, priorVar, rows);
  let iterations = 0;
  let converged = false;
  let lastL: Float64Array | null = null;
  for (; iterations < maxIter; iterations++) {
    const grad = new Float64Array(p);
    const H = new Float64Array(p * p); // negative Hessian
    for (let j = 0; j < p; j++) {
      grad[j] = -theta[j] / priorVar[j];
      H[j * p + j] = 1 / priorVar[j];
    }
    for (const r of rows) {
      let eta = 0;
      for (let k = 0; k < r.idx.length; k++) eta += r.val[k] * theta[r.idx[k]];
      const mu = sigmoid(eta);
      const resid = r.succ - r.n * mu;
      const w = r.n * mu * (1 - mu);
      for (let a = 0; a < r.idx.length; a++) {
        const ia = r.idx[a];
        grad[ia] += r.val[a] * resid;
        for (let b = 0; b < r.idx.length; b++) H[ia * p + r.idx[b]] += r.val[a] * r.val[b] * w;
      }
    }
    const L = cholesky(H, p);
    lastL = L;
    const step = cholSolve(L, p, grad);
    // Newton step with halving if the log-posterior does not improve (it is concave, so rarely needed).
    let t = 1;
    let next = new Float64Array(p);
    let nextLp = -Infinity;
    for (let h = 0; h < 30; h++) {
      for (let j = 0; j < p; j++) next[j] = theta[j] + t * step[j];
      nextLp = logPosterior(next, priorVar, rows);
      if (nextLp >= lp - 1e-12) break;
      t /= 2;
    }
    let maxStep = 0;
    for (let j = 0; j < p; j++) maxStep = Math.max(maxStep, Math.abs(next[j] - theta[j]));
    theta = next;
    lp = nextLp;
    if (maxStep < tol) {
      converged = true;
      iterations++;
      break;
    }
  }
  let cov = new Float64Array(0);
  if (opts.wantCov !== false && lastL) {
    // Recompute the Hessian at the final theta for the covariance.
    const H = new Float64Array(p * p);
    for (let j = 0; j < p; j++) H[j * p + j] = 1 / priorVar[j];
    for (const r of rows) {
      let eta = 0;
      for (let k = 0; k < r.idx.length; k++) eta += r.val[k] * theta[r.idx[k]];
      const mu = sigmoid(eta);
      const w = r.n * mu * (1 - mu);
      for (let a = 0; a < r.idx.length; a++)
        for (let b = 0; b < r.idx.length; b++) H[r.idx[a] * p + r.idx[b]] += r.val[a] * r.val[b] * w;
    }
    const L = cholesky(H, p);
    cov = new Float64Array(p * p);
    for (let j = 0; j < p; j++) {
      const e = new Float64Array(p);
      e[j] = 1;
      const col = cholSolve(L, p, e);
      for (let i = 0; i < p; i++) cov[i * p + j] = col[i];
    }
  }
  return { theta, cov, iterations, converged };
}

// ---------- Bradley–Terry on votes ----------

/** One judged pair as shown. `winner` is the id of the item picked. */
export interface Vote {
  left: string;
  right: string;
  winner: string;
  rater?: string;
  role?: string;
}

/** Counts by ordered pair: how often the left item won when `left` was shown left of `right`. */
export interface PairCount {
  left: string;
  right: string;
  leftWins: number;
  n: number;
}

export function aggregate(votes: Vote[]): PairCount[] {
  const m = new Map<string, PairCount>();
  for (const v of votes) {
    if (v.winner !== v.left && v.winner !== v.right) throw new Error(`winner ${v.winner} not in pair`);
    const k = v.left + "\u0000" + v.right;
    let c = m.get(k);
    if (!c) m.set(k, (c = { left: v.left, right: v.right, leftWins: 0, n: 0 }));
    c.n++;
    if (v.winner === v.left) c.leftWins++;
  }
  return [...m.values()];
}

export interface BTOptions {
  itemPriorSd?: number;
  /** Estimate a left-side advantage (default true). */
  leftEffect?: boolean;
  leftPriorSd?: number;
  /** Skip the covariance (faster; used inside the bootstrap). */
  noCov?: boolean;
}

export interface BTFit {
  ids: string[];
  /** Log-odds strengths, summing to zero. */
  beta: number[];
  /** Approximate posterior SD of each beta (Laplace). NaN when noCov. */
  se: number[];
  /** Displayed ratings, 1000 + 400 * log10-odds. */
  rating: number[];
  /** Left-side advantage in log-odds (0 when not estimated) and its SE. */
  left: number;
  leftSe: number;
  /** First-presentation comparisons and wins per item, in the votes given. */
  games: number[];
  wins: number[];
  nVotes: number;
  converged: boolean;
  iterations: number;
}

export function fitBTCounts(ids: string[], counts: PairCount[], opts: BTOptions = {}): BTFit {
  const n = ids.length;
  const ix = new Map(ids.map((id, i) => [id, i]));
  const useLeft = opts.leftEffect !== false;
  const p = n + (useLeft ? 1 : 0);
  const priorVar = new Float64Array(p);
  priorVar.fill((opts.itemPriorSd ?? RATING.ITEM_PRIOR_SD) ** 2);
  if (useLeft) priorVar[n] = (opts.leftPriorSd ?? RATING.LEFT_PRIOR_SD) ** 2;
  const games = new Array(n).fill(0);
  const wins = new Array(n).fill(0);
  const rows: LogitRow[] = [];
  let nVotes = 0;
  for (const c of counts) {
    const a = ix.get(c.left);
    const b = ix.get(c.right);
    if (a === undefined || b === undefined) continue; // item not in this fit (e.g. retired)
    if (a === b) throw new Error("item paired with itself");
    if (c.n <= 0) continue;
    rows.push(
      useLeft
        ? { idx: [a, b, n], val: [1, -1, 1], succ: c.leftWins, n: c.n }
        : { idx: [a, b], val: [1, -1], succ: c.leftWins, n: c.n },
    );
    games[a] += c.n;
    games[b] += c.n;
    wins[a] += c.leftWins;
    wins[b] += c.n - c.leftWins;
    nVotes += c.n;
  }
  const fit = fitLogisticMAP(p, priorVar, rows, { wantCov: !opts.noCov });
  const beta = Array.from(fit.theta.subarray(0, n));
  const se = beta.map((_, i) => (opts.noCov ? NaN : Math.sqrt(fit.cov[i * p + i])));
  return {
    ids: [...ids],
    beta,
    se,
    rating: beta.map(toElo),
    left: useLeft ? fit.theta[n] : 0,
    leftSe: useLeft && !opts.noCov ? Math.sqrt(fit.cov[n * p + n]) : NaN,
    games,
    wins,
    nVotes,
    converged: fit.converged,
    iterations: fit.iterations,
  };
}

export function fitBT(ids: string[], votes: Vote[], opts: BTOptions = {}): BTFit {
  return fitBTCounts(ids, aggregate(votes), opts);
}

/** Model probability that item a beats item b, side-neutral. */
export function winProb(fit: BTFit, a: string, b: string): number {
  const i = fit.ids.indexOf(a);
  const j = fit.ids.indexOf(b);
  return sigmoid(fit.beta[i] - fit.beta[j]);
}

// ---------- bootstrap intervals ----------

export interface BootstrapResult {
  ids: string[];
  /** Percentile interval on the displayed scale. */
  ratingLo: number[];
  ratingHi: number[];
  /** Percentile interval of the rank (1 = best). */
  rankLo: number[];
  rankHi: number[];
  reps: number;
  /** "rater": resample raters with all their votes (default). "vote": resample single votes. */
  unit: "rater" | "vote";
  clusters: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function ranksOf(values: number[]): number[] {
  // Rank 1 = highest. Ties share the better rank.
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]);
  const r = new Array(values.length);
  for (let k = 0; k < order.length; k++) {
    r[order[k][1]] = k > 0 && order[k][0] === order[k - 1][0] ? r[order[k - 1][1]] : k + 1;
  }
  return r;
}

/**
 * Bootstrap percentile intervals. By default resamples raters, not votes: one person's votes are
 * correlated, so resampling single votes understates the uncertainty. Votes with no rater are
 * each their own cluster.
 */
export function bootstrapBT(
  ids: string[],
  votes: Vote[],
  opts: BTOptions & {
    reps?: number;
    seed?: number;
    unit?: "rater" | "vote";
    level?: number;
    /** Called with each replicate's log-odds strengths, e.g. to bootstrap a correlation with another ranking. */
    onDraw?: (beta: number[]) => void;
  } = {},
): BootstrapResult {
  const reps = opts.reps ?? RATING.BOOTSTRAP_REPS;
  const unit = opts.unit ?? "rater";
  const level = opts.level ?? RATING.CI_LEVEL;
  const rng = makeRng(opts.seed ?? 20261124);
  const groups = new Map<string, Vote[]>();
  votes.forEach((v, k) => {
    const key = unit === "rater" && v.rater ? "r:" + v.rater : "v:" + k;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(v);
  });
  const clusters = [...groups.values()].map(aggregate);
  const C = clusters.length;
  const draws: number[][] = ids.map(() => []);
  const rankDraws: number[][] = ids.map(() => []);
  for (let b = 0; b < reps; b++) {
    const mult = new Array(C).fill(0);
    for (let k = 0; k < C; k++) mult[Math.floor(rng() * C)]++;
    const m = new Map<string, PairCount>();
    for (let c = 0; c < C; c++) {
      if (!mult[c]) continue;
      for (const pc of clusters[c]) {
        const key = pc.left + "\u0000" + pc.right;
        let t = m.get(key);
        if (!t) m.set(key, (t = { left: pc.left, right: pc.right, leftWins: 0, n: 0 }));
        t.leftWins += pc.leftWins * mult[c];
        t.n += pc.n * mult[c];
      }
    }
    const f = fitBTCounts(ids, [...m.values()], { ...opts, noCov: true });
    opts.onDraw?.(f.beta);
    const rk = ranksOf(f.beta);
    for (let i = 0; i < ids.length; i++) {
      draws[i].push(f.rating[i]);
      rankDraws[i].push(rk[i]);
    }
  }
  const a = (1 - level) / 2;
  const ratingLo: number[] = [];
  const ratingHi: number[] = [];
  const rankLo: number[] = [];
  const rankHi: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const d = draws[i].sort((x, y) => x - y);
    const r = rankDraws[i].sort((x, y) => x - y);
    ratingLo.push(quantile(d, a));
    ratingHi.push(quantile(d, 1 - a));
    rankLo.push(Math.round(quantile(r, a)));
    rankHi.push(Math.round(quantile(r, 1 - a)));
  }
  return { ids: [...ids], ratingLo, ratingHi, rankLo, rankHi, reps, unit, clusters: C };
}

// ---------- extended model: how each role departs from the pooled ranking ----------

export interface RoleDeviationFit {
  ids: string[];
  roles: string[];
  /** Shared strength per item (log-odds). */
  beta: number[];
  /** dev[r][i]: role r's departure from beta[i], shrunk toward 0. */
  dev: number[][];
  devSe: number[][];
  /** Per-role left-side advantage. */
  left: number[];
  converged: boolean;
}

/**
 * Extended Bradley–Terry with rater-role effects. A role "main effect" is not estimable in a
 * paired comparison (a role that likes every item more cancels out), so the estimable role effects
 * are (1) a per-role departure from each item's pooled strength and (2) a per-role side bias.
 * Departures get a Normal(0, ROLE_DEVIATION_PRIOR_SD^2) prior: a role with few votes stays near the pool.
 */
export function fitRoleDeviation(
  ids: string[],
  votes: Vote[],
  opts: { itemPriorSd?: number; devPriorSd?: number; leftPriorSd?: number } = {},
): RoleDeviationFit {
  const n = ids.length;
  const roles = [...new Set(votes.map((v) => v.role ?? "unknown"))].sort();
  const R = roles.length;
  const ix = new Map(ids.map((id, i) => [id, i]));
  const rx = new Map(roles.map((r, i) => [r, i]));
  // params: beta[0..n), dev[r][i] at n + r*n + i, left[r] at n + R*n + r
  const p = n + R * n + R;
  const priorVar = new Float64Array(p);
  const sdI = opts.itemPriorSd ?? RATING.ITEM_PRIOR_SD;
  const sdD = opts.devPriorSd ?? RATING.ROLE_DEVIATION_PRIOR_SD;
  const sdL = opts.leftPriorSd ?? RATING.LEFT_PRIOR_SD;
  for (let j = 0; j < p; j++) priorVar[j] = j < n ? sdI ** 2 : j < n + R * n ? sdD ** 2 : sdL ** 2;
  const m = new Map<string, LogitRow>();
  for (const v of votes) {
    const a = ix.get(v.left);
    const b = ix.get(v.right);
    if (a === undefined || b === undefined) continue;
    const r = rx.get(v.role ?? "unknown")!;
    const key = `${a}|${b}|${r}`;
    let row = m.get(key);
    if (!row) {
      row = { idx: [a, b, n + r * n + a, n + r * n + b, n + R * n + r], val: [1, -1, 1, -1, 1], succ: 0, n: 0 };
      m.set(key, row);
    }
    row.n++;
    if (v.winner === v.left) row.succ++;
  }
  const fit = fitLogisticMAP(p, priorVar, [...m.values()]);
  const beta = Array.from(fit.theta.subarray(0, n));
  const dev: number[][] = [];
  const devSe: number[][] = [];
  for (let r = 0; r < R; r++) {
    dev.push(Array.from(fit.theta.subarray(n + r * n, n + (r + 1) * n)));
    devSe.push(ids.map((_, i) => Math.sqrt(fit.cov[(n + r * n + i) * p + (n + r * n + i)])));
  }
  const left = roles.map((_, r) => fit.theta[n + R * n + r]);
  return { ids: [...ids], roles, beta, dev, devSe, left, converged: fit.converged };
}
