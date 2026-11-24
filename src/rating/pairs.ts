// Choosing the next batch of pairs for one voter.
//
// Rules, in priority order:
// 1. Never hand a voter a pair (in either order) they have already judged or skipped.
// 2. Warm-up: until every item has PAIRING.WARMUP_GAMES comparisons, favour the least-compared items.
// 3. After warm-up, EXPLORE_FRACTION of new pairs are uniformly random. The rest are drawn at random
//    with probability proportional to an information score, p(1-p) * (se_a^2 + se_b^2): close
//    ratings and uncertain items score high. Drawing (not taking the top score) keeps the design
//    from collapsing onto nearest neighbours.
// 4. One swapped repeat per batch, of a pair the voter first saw at least REPEAT_MIN_GAP trials ago.
// 5. Sides are random for new pairs; a repeat is shown with the sides of its first showing swapped.

import { PAIRING } from "./config";
import { sigmoid } from "./rating";

export const pairKey = (a: string, b: string): string => (a < b ? a + "|" + b : b + "|" + a);

export interface PairingState {
  /** Items active in this round. */
  items: string[];
  /** Current pooled strengths (log-odds) and SEs. Missing items count as 0 and ITEM_PRIOR_SD. */
  beta: Map<string, number>;
  se: Map<string, number>;
  /** First-presentation comparisons per item across all voters. */
  games: Map<string, number>;
  /** pairKey of every pair this voter has judged or skipped. */
  done: Set<string>;
  /** This voter's first presentations in order: trial number (1-based), sides as shown. */
  history: { trial: number; left: string; right: string }[];
  /** pairKeys this voter has already been shown as a repeat. */
  repeated: Set<string>;
  /** Number of trials (votes + skips, repeats included) this voter has completed. */
  trials: number;
}

export interface IssuedPair {
  left: string;
  right: string;
  isRepeat: boolean;
  reason: "warmup" | "explore" | "info" | "repeat";
}

export interface PairingOptions {
  size?: number;
  warmupGames?: number;
  exploreFraction?: number;
  maxPerItem?: number;
  repeats?: number;
  repeatMinGap?: number;
  defaultSe?: number;
}

function weightedPick<T>(xs: T[], w: number[], rng: () => number): number {
  let total = 0;
  for (const x of w) total += x;
  if (!(total > 0)) return Math.floor(rng() * xs.length);
  let u = rng() * total;
  for (let i = 0; i < xs.length; i++) {
    u -= w[i];
    if (u <= 0) return i;
  }
  return xs.length - 1;
}

export function selectBatch(state: PairingState, rng: () => number, opts: PairingOptions = {}): IssuedPair[] {
  const size = opts.size ?? PAIRING.BATCH_SIZE;
  const warmup = opts.warmupGames ?? PAIRING.WARMUP_GAMES;
  const explore = opts.exploreFraction ?? PAIRING.EXPLORE_FRACTION;
  const maxPer = opts.maxPerItem ?? PAIRING.MAX_PER_ITEM_PER_BATCH;
  const nRepeats = opts.repeats ?? PAIRING.REPEATS_PER_BATCH;
  const gap = opts.repeatMinGap ?? PAIRING.REPEAT_MIN_GAP;
  const defaultSe = opts.defaultSe ?? 2;

  const items = [...state.items].sort();
  const g = (id: string) => state.games.get(id) ?? 0;
  const b = (id: string) => state.beta.get(id) ?? 0;
  const s = (id: string) => state.se.get(id) ?? defaultSe;

  // Candidate unordered pairs the voter has not done.
  const cands: [string, string][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (!state.done.has(pairKey(items[i], items[j]))) cands.push([items[i], items[j]]);

  // Repeat eligible?
  const active = new Set(items);
  const repeatPool = state.history.filter(
    (h) =>
      active.has(h.left) &&
      active.has(h.right) &&
      state.trials + 1 - h.trial >= gap &&
      !state.repeated.has(pairKey(h.left, h.right)),
  );
  // A voter who has judged every pair is done: no repeats on their own.
  const nRep = cands.length > 0 ? Math.min(nRepeats, repeatPool.length) : 0;
  const nNew = Math.min(size - nRep, cands.length);

  const used = new Map<string, number>();
  const chosen = new Set<string>();
  const out: IssuedPair[] = [];
  const inWarmup = items.some((id) => g(id) < warmup);

  for (let slot = 0; slot < nNew; slot++) {
    const ok = cands.filter(
      ([x, y]) => !chosen.has(pairKey(x, y)) && (used.get(x) ?? 0) < maxPer && (used.get(y) ?? 0) < maxPer,
    );
    const pool = ok.length ? ok : cands.filter(([x, y]) => !chosen.has(pairKey(x, y)));
    if (!pool.length) break;
    let k: number;
    let reason: IssuedPair["reason"];
    if (inWarmup) {
      // Favour pairs whose items have the fewest comparisons (counting this batch).
      const cnt = (id: string) => g(id) + (used.get(id) ?? 0);
      const w = pool.map(([x, y]) => 1 / (1 + cnt(x) + cnt(y)) ** 3);
      k = weightedPick(pool, w, rng);
      reason = "warmup";
    } else if (rng() < explore) {
      k = Math.floor(rng() * pool.length);
      reason = "explore";
    } else {
      const w = pool.map(([x, y]) => {
        const p = sigmoid(b(x) - b(y));
        return p * (1 - p) * (s(x) ** 2 + s(y) ** 2);
      });
      k = weightedPick(pool, w, rng);
      reason = "info";
    }
    const [x, y] = pool[k];
    chosen.add(pairKey(x, y));
    used.set(x, (used.get(x) ?? 0) + 1);
    used.set(y, (used.get(y) ?? 0) + 1);
    out.push(rng() < 0.5 ? { left: x, right: y, isRepeat: false, reason } : { left: y, right: x, isRepeat: false, reason });
  }

  // Insert repeats at random positions after the first slot, sides swapped from the first showing.
  const repPicked = new Set<number>();
  for (let r = 0; r < nRep; r++) {
    let k = Math.floor(rng() * repeatPool.length);
    while (repPicked.has(k)) k = (k + 1) % repeatPool.length;
    repPicked.add(k);
    const h = repeatPool[k];
    const pos = out.length === 0 ? 0 : 1 + Math.floor(rng() * out.length);
    out.splice(pos, 0, { left: h.right, right: h.left, isRepeat: true, reason: "repeat" });
  }
  return out;
}
