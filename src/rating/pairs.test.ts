import { describe, expect, it } from "vitest";
import { PAIRING } from "./config";
import { pairKey, selectBatch, type PairingState } from "./pairs";
import { makeRng } from "./rating";

const ids = Array.from({ length: 36 }, (_, i) => `q${String(i).padStart(2, "0")}`);

function freshState(over: Partial<PairingState> = {}): PairingState {
  return {
    items: ids,
    beta: new Map(),
    se: new Map(),
    games: new Map(),
    done: new Set(),
    history: [],
    repeated: new Set(),
    trials: 0,
    ...over,
  };
}

/** Run a voter through `batches` batches, recording what they saw, as the server would. */
function runVoter(state: PairingState, batches: number, seed: number) {
  const rng = makeRng(seed);
  const seen: ReturnType<typeof selectBatch> = [];
  for (let b = 0; b < batches; b++) {
    const batch = selectBatch(state, rng);
    for (const p of batch) {
      state.trials++;
      if (p.isRepeat) state.repeated.add(pairKey(p.left, p.right));
      else {
        state.done.add(pairKey(p.left, p.right));
        state.history.push({ trial: state.trials, left: p.left, right: p.right });
        state.games.set(p.left, (state.games.get(p.left) ?? 0) + 1);
        state.games.set(p.right, (state.games.get(p.right) ?? 0) + 1);
      }
      seen.push(p);
    }
  }
  return seen;
}

describe("selectBatch", () => {
  it("returns a full batch with exactly the configured size", () => {
    const b = selectBatch(freshState(), makeRng(1));
    expect(b).toHaveLength(PAIRING.BATCH_SIZE);
    expect(b.every((p) => p.left !== p.right)).toBe(true);
  });

  it("never gives a voter a pair they have already judged, in either order", () => {
    const st = freshState();
    const seen = runVoter(st, 40, 2);
    const firsts = seen.filter((p) => !p.isRepeat).map((p) => pairKey(p.left, p.right));
    expect(new Set(firsts).size).toBe(firsts.length);
  });

  it("caps how often one item appears in a batch", () => {
    for (let s = 0; s < 20; s++) {
      const b = selectBatch(freshState(), makeRng(100 + s)).filter((p) => !p.isRepeat);
      const c = new Map<string, number>();
      for (const p of b) for (const x of [p.left, p.right]) c.set(x, (c.get(x) ?? 0) + 1);
      expect(Math.max(...c.values())).toBeLessThanOrEqual(PAIRING.MAX_PER_ITEM_PER_BATCH);
    }
  });

  it("adds one repeat per batch once old enough, with sides swapped and the gap respected", () => {
    const st = freshState();
    const seen = runVoter(st, 8, 3);
    const reps = seen.filter((p) => p.isRepeat);
    expect(reps.length).toBeGreaterThan(0);
    // The first repeat can only appear after REPEAT_MIN_GAP trials.
    const firstRepIdx = seen.findIndex((p) => p.isRepeat);
    expect(firstRepIdx + 1).toBeGreaterThan(PAIRING.REPEAT_MIN_GAP);
    for (const r of reps) {
      const orig = st.history.find((h) => pairKey(h.left, h.right) === pairKey(r.left, r.right))!;
      expect(r.left).toBe(orig.right);
      expect(r.right).toBe(orig.left);
    }
    // No pair repeated twice.
    const rk = reps.map((r) => pairKey(r.left, r.right));
    expect(new Set(rk).size).toBe(rk.length);
  });

  it("during warm-up, favours the least-compared items", () => {
    const games = new Map(ids.map((id, i) => [id, i < 6 ? 0 : 20]));
    const st = freshState({ games });
    let low = 0, total = 0;
    for (let s = 0; s < 30; s++) {
      for (const p of selectBatch(st, makeRng(200 + s))) {
        total += 2;
        low += [p.left, p.right].filter((x) => (games.get(x) ?? 0) === 0).length;
      }
    }
    // Low-count items are 1/6 of the pool but should fill far more than 1/6 of slots.
    expect(low / total).toBeGreaterThan(0.4);
  });

  it("after warm-up, prefers informative pairs but does not use only nearest neighbours", () => {
    const beta = new Map(ids.map((id, i) => [id, -2 + (4 * i) / 35]));
    const se = new Map(ids.map((id) => [id, 0.3]));
    const games = new Map(ids.map((id) => [id, 30]));
    let near = 0, far = 0, total = 0;
    for (let s = 0; s < 60; s++) {
      const st = freshState({ beta, se, games });
      for (const p of selectBatch(st, makeRng(300 + s))) {
        const d = Math.abs(beta.get(p.left)! - beta.get(p.right)!);
        total++;
        if (d < 0.5) near++;
        if (d > 2) far++;
      }
    }
    // Close pairs are about 13% of all pairs; the selector should over-sample them...
    expect(near / total).toBeGreaterThan(0.25);
    // ...but still hand out some far pairs (exploration), keeping the comparison graph broad.
    expect(far / total).toBeGreaterThan(0.05);
  });

  it("randomises sides", () => {
    const st = freshState();
    const seen = runVoter(st, 30, 4).filter((p) => !p.isRepeat);
    const leftIsSmaller = seen.filter((p) => p.left < p.right).length / seen.length;
    expect(leftIsSmaller).toBeGreaterThan(0.4);
    expect(leftIsSmaller).toBeLessThan(0.6);
  });

  it("is deterministic for a given seed", () => {
    expect(selectBatch(freshState(), makeRng(9))).toEqual(selectBatch(freshState(), makeRng(9)));
  });

  it("returns an empty batch once the voter has judged every pair", () => {
    const small = ["a", "b", "c"];
    const st = freshState({
      items: small,
      done: new Set([pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")]),
      history: [{ trial: 1, left: "a", right: "b" }],
      trials: 50,
    });
    expect(selectBatch(st, makeRng(1))).toEqual([]);
  });

  it("hands out the last few pairs when fewer than a batch remain", () => {
    const small = ["a", "b", "c", "d"];
    const st = freshState({ items: small, done: new Set([pairKey("a", "b"), pairKey("a", "c")]) });
    const b = selectBatch(st, makeRng(1), { repeats: 0 });
    expect(b.map((p) => pairKey(p.left, p.right)).sort()).toEqual(
      [pairKey("a", "d"), pairKey("b", "c"), pairKey("b", "d"), pairKey("c", "d")].sort(),
    );
  });
});
