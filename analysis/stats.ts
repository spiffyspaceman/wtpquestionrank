// Small statistics helpers for the analysis script. No dependencies.
import { ranksOf } from "../src/rating/rating";

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function pearson(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/** Spearman rank correlation with average ranks for ties. */
export function spearman(a: number[], b: number[]): number {
  const avgRanks = (xs: number[]) => {
    const order = xs.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  return pearson(avgRanks(a), avgRanks(b));
}

/** Kendall's tau-b. */
export function kendallTauB(a: number[], b: number[]): number {
  let c = 0, d = 0, ta = 0, tb = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      const x = Math.sign(a[i] - a[j]);
      const y = Math.sign(b[i] - b[j]);
      if (x === 0 && y === 0) continue;
      if (x === 0) ta++;
      else if (y === 0) tb++;
      else if (x === y) c++;
      else d++;
    }
  return (c - d) / Math.sqrt((c + d + ta) * (c + d + tb));
}

/** Two-sided exact binomial p-value for k successes in n trials at p = 0.5. */
export function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const logC = (m: number, r: number) => lgamma(m + 1) - lgamma(r + 1) - lgamma(m - r + 1);
  const pk = (r: number) => Math.exp(logC(n, r) - n * Math.LN2);
  const obs = pk(k);
  let p = 0;
  for (let r = 0; r <= n; r++) if (pk(r) <= obs * (1 + 1e-9)) p += pk(r);
  return Math.min(1, p);
}

function lgamma(z: number): number {
  // Lanczos approximation, adequate for integer arguments used here.
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export { ranksOf };
