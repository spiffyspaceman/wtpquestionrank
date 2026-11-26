// The bridge pair (owner decision, 26 Nov 2026; migration 0012). A judge who narrows the set to some units may keep
// one pair per batch that sets a question of the set beside one from outside it. Those pairs tie a narrow set to the
// rest of the round's one scale; without them a set judged only within itself floats against the others.
//
// The frozen pairing code draws the other nine pairs from the set and is not changed. This picks the tenth among the
// questions in play with the same weight the pairing code gives an informative pair, p(1 - p)(se_a^2 + se_b^2):
// most weight on pairs whose outcome is least certain and whose questions are least settled.

import { PAIRING } from "../rating/config";
import { pairKey, type IssuedPair, type PairingState } from "../rating/pairs";
import { sigmoid } from "../rating/rating";

/**
 * One pair with a question of the set (`state.items`) on one side and a question in play outside it on the other, or
 * null when there is none to give (no question outside the set is in play, or the judge has seen every such pair).
 * `issued` is the rest of the batch: its pairs are not offered again, and a question already in it twice is passed
 * over while another will do. `state.beta` holds every question in play.
 */
export function bridgePair(state: PairingState, issued: IssuedPair[], rng: () => number): IssuedPair | null {
  const mine = new Set(state.items);
  const outside = [...state.beta.keys()].filter((id) => !mine.has(id));
  if (!mine.size || !outside.length) return null;
  const taken = new Set(issued.map((p) => pairKey(p.left, p.right)));
  const used = new Map<string, number>();
  for (const p of issued) for (const id of [p.left, p.right]) used.set(id, (used.get(id) ?? 0) + 1);
  const b = (id: string) => state.beta.get(id) ?? 0;
  const s = (id: string) => state.se.get(id) ?? 2;

  const pairs: [string, string][] = [];
  for (const x of mine)
    for (const y of outside) if (!state.done.has(pairKey(x, y)) && !taken.has(pairKey(x, y))) pairs.push([x, y]);
  if (!pairs.length) return null;
  const roomy = pairs.filter(([x, y]) => (used.get(x) ?? 0) < PAIRING.MAX_PER_ITEM_PER_BATCH && (used.get(y) ?? 0) < PAIRING.MAX_PER_ITEM_PER_BATCH);
  const pool = roomy.length ? roomy : pairs;
  const w = pool.map(([x, y]) => {
    const p = sigmoid(b(x) - b(y));
    return p * (1 - p) * (s(x) ** 2 + s(y) ** 2);
  });
  const total = w.reduce((a, v) => a + v, 0);
  let k = pool.length - 1;
  if (total > 0) {
    let r = rng() * total;
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) <= 0) {
      k = i;
      break;
    }
  } else k = Math.floor(rng() * pool.length);
  const [x, y] = pool[k];
  return rng() < 0.5 ? { left: x, right: y, isRepeat: false, reason: "info" } : { left: y, right: x, isRepeat: false, reason: "info" };
}
