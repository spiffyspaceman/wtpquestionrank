// A judge may judge only some units, at State, Nationals or both (owner decision, 26 Nov 2026; migration 0010).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SETS } from "../../src/worker/builtin-sets";
import { bridgePair } from "../../src/worker/bridge";
import { SLICE_PLAY } from "../../src/worker/slice";
import { HELD } from "../../src/worker/staging";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";

const SET = BUILTIN_SETS[0];
const META = new Map((SET.file.items as { id: string; level: string; unit: number }[]).map((i) => [i.id, i]));

/** A fresh staged round on the full set, open, with every other round closed. */
async function openFullRound(): Promise<string> {
  await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
  const made = await json(admin(`/admin/api/builtin-sets/${SET.id}`, { body: {} }));
  let id: string = made.roundCreated;
  if (!id) {
    id = (await json<{ id: string }>(admin("/admin/api/rounds", { body: { name: "All questions again", itemSetId: SET.id } }))).id;
    await admin(`/admin/api/rounds/${id}/staging`, { body: { staged: true, autoGrow: true } });
  }
  expect((await admin(`/admin/api/rounds/${id}/open`, { body: {} })).status).toBe(200);
  return id;
}
const setSlice = (cookie: string, body: unknown) => call("/api/slice", { cookie, body });
/** The questions of every pair in the voter's batches in a round, with their unit and level. */
async function shown(round: string, label: string): Promise<{ unit: number; level: string; id: string }[]> {
  const r = await env.DB.prepare(
    `SELECT bp.left_q AS a, bp.right_q AS b FROM batch_pairs bp JOIN batches x ON x.id = bp.batch_id JOIN voters u ON u.id = x.voter_id
      WHERE x.round_id = ? AND u.label = ?`,
  ).bind(round, label).all<{ a: string; b: string }>();
  return r.results.flatMap((p) => [p.a, p.b]).map((id) => ({ ...META.get(id)!, id }));
}
const inPlay = async (round: string) =>
  new Set((await env.DB.prepare("SELECT question_id FROM round_in_play WHERE round_id = ?").bind(round).all<{ question_id: string }>()).results.map((r) => r.question_id));

describe("what a judge judges", () => {
  beforeEach(() => mockOutbound());

  it("is all questions until the judge chooses; the choice is checked, kept, and can go back to all", async () => {
    await openNewRound();
    const v = await voter("judge");
    expect(await json(call("/api/me", { cookie: v.cookie }))).toMatchObject({ slice: null });
    expect(await json(setSlice(v.cookie, { units: [5, 4, 4], levels: ["NF"] }))).toMatchObject({ ok: true, slice: { units: [4, 5], levels: ["NF"] } });
    expect(await json(call("/api/me", { cookie: v.cookie }))).toMatchObject({ slice: { units: [4, 5], levels: ["NF"] } });
    // Every unit and both levels is the same as all questions.
    expect(await json(setSlice(v.cookie, { units: [1, 2, 3, 4, 5, 6], levels: ["NF", "State"] }))).toMatchObject({ ok: true, slice: null });
    expect(await json(setSlice(v.cookie, { units: [2], levels: ["State", "NF"] }))).toMatchObject({ slice: { units: [2], levels: ["State", "NF"] } });
    expect(await json(setSlice(v.cookie, { all: true }))).toMatchObject({ ok: true, slice: null });
    for (const bad of [{}, { units: [], levels: ["NF"] }, { units: [4], levels: [] }, { units: [7], levels: ["NF"] }, { units: ["4"], levels: ["NF"] }, { units: [4], levels: ["Nationals"] }, { units: 4, levels: "NF" }, []])
      expect((await setSlice(v.cookie, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await call("/api/slice", { body: { all: true } })).status).toBe(401);
    // Students may choose too.
    const s = await voter("student");
    expect((await setSlice(s.cookie, { units: [3], levels: ["State"] })).status).toBe(200);
  });

  it("a Nationals slice in a staged round brings its questions into play, for everyone, and every pair stays inside it", async () => {
    const round = await openFullRound();
    const before = await inPlay(round);
    expect([...before].some((id) => META.get(id)!.level === "NF")).toBe(false);
    const v = await voter("judge");
    await setSlice(v.cookie, { units: [4, 5], levels: ["NF"] });
    await voteN(v.cookie, 25);
    const seen = await shown(round, v.label);
    expect(seen.length).toBeGreaterThanOrEqual(50);
    for (const q of seen) expect(q.level === "NF" && [4, 5].includes(q.unit), q.id).toBe(true);
    const now = await inPlay(round);
    const joined = [...now].filter((id) => !before.has(id));
    expect(joined.length).toBeGreaterThanOrEqual(SLICE_PLAY.MIN_IN_PLAY);
    for (const id of joined) expect(META.get(id)).toMatchObject({ level: "NF" });
    // Both units, evenly: the same balanced order as any group.
    const per = [4, 5].map((u) => joined.filter((id) => META.get(id)!.unit === u).length);
    expect(Math.abs(per[0] - per[1])).toBeLessThanOrEqual(1);
    // The batches record the slice; a general judge's batches record none, and can draw the new questions.
    const recorded = await env.DB.prepare("SELECT DISTINCT b.slice_json FROM batches b JOIN voters u ON u.id = b.voter_id WHERE u.label = ?").bind(v.label).all<{ slice_json: string }>();
    expect(recorded.results.map((r) => JSON.parse(r.slice_json))).toEqual([{ units: [4, 5], levels: ["NF"] }]);
    const g = await voter("coach");
    await getBatch(g.cookie);
    const gb = await env.DB.prepare("SELECT b.slice_json FROM batches b JOIN voters u ON u.id = b.voter_id WHERE u.label = ?").bind(g.label).first<{ slice_json: string | null }>();
    expect(gb!.slice_json).toBeNull();
    // The leaderboard lists the newcomers, since they are in play for everyone, and tells the judge their own choice.
    await voteN(g.cookie, 20);
    const board = await json(call("/api/leaderboard", { cookie: g.cookie }));
    expect(board.rows).toHaveLength(now.size);
    expect(board.slice).toBeNull();
    expect((await json(call("/api/leaderboard", { cookie: v.cookie }))).slice).toEqual({ units: [4, 5], levels: ["NF"] });
  });

  it("a one-unit slice is kept supplied as the judge works through it, and never brings in the held question", async () => {
    const round = await openFullRound();
    const v = await voter("judge");
    await setSlice(v.cookie, { units: [1], levels: ["State"] });
    const mine = async () => [...(await inPlay(round))].filter((id) => META.get(id)!.unit === 1 && META.get(id)!.level === "State");
    await getBatch(v.cookie);
    expect((await mine()).length).toBeGreaterThanOrEqual(SLICE_PLAY.MIN_IN_PLAY);
    const first = (await mine()).length;
    // 12 questions make 66 pairs; past about 56 votes fewer than 10 new pairs remain, and more of the slice joins.
    const cast = await voteN(v.cookie, 80);
    expect(cast).toBe(80);
    expect((await mine()).length).toBeGreaterThan(first);
    for (const q of await shown(round, v.label)) expect(q.unit === 1 && q.level === "State", q.id).toBe(true);
    for (const id of HELD) expect((await inPlay(round)).has(id)).toBe(false);
  });

  it("with the round's growth switched off, a slice brings nothing in: the judge gets what of it is in play", async () => {
    const round = await openFullRound();
    await admin(`/admin/api/rounds/${round}/staging`, { body: { autoGrow: false } });
    const before = await inPlay(round);
    const v = await voter("judge");
    await setSlice(v.cookie, { units: [3], levels: ["NF"] });
    expect(await json(call("/api/batch", { cookie: v.cookie }))).toMatchObject({ done: true, pairs: [] });
    const w = await voter("judge");
    await setSlice(w.cookie, { units: [3], levels: ["State"] });
    await voteN(w.cookie, 10);
    for (const q of await shown(round, w.label)) expect(q.unit === 3 && q.level === "State", q.id).toBe(true);
    expect(await inPlay(round)).toEqual(before);
    // Switched back on, the slice is supplied again.
    await admin(`/admin/api/rounds/${round}/staging`, { body: { autoGrow: true } });
    await getBatch(v.cookie);
    expect((await inPlay(round)).size).toBeGreaterThan(before.size);
  });

  it("a new set mid-batch ends the rest of that batch: the next batch follows the new set, and answers given stay", async () => {
    const round = await openFullRound();
    const v = await voter("judge");
    const b1 = await getBatch(v.cookie);
    await call("/api/vote", { cookie: v.cookie, body: { pairId: b1.pairs[0].pairId, pick: "L" } });
    await call("/api/skip", { cookie: v.cookie, body: { pairId: b1.pairs[1].pairId } });
    expect(await json(setSlice(v.cookie, { units: [6], levels: ["State"] }))).toMatchObject({ changed: true, ended: 8 });
    expect((await json(call("/api/me", { cookie: v.cookie }))).batch).toBeNull();
    const b2 = await getBatch(v.cookie);
    expect(b2.all.some((p) => b1.all.some((q) => q.pairId === p.pairId))).toBe(false);
    const rows = await env.DB.prepare("SELECT b.slice_json, b.ended_at FROM batches b JOIN voters u ON u.id = b.voter_id WHERE u.label = ? ORDER BY b.created_at, b.rowid").bind(v.label).all<{ slice_json: string | null; ended_at: string | null }>();
    expect(rows.results.map((r) => r.slice_json)).toEqual([null, JSON.stringify({ units: [6], levels: ["State"] })]);
    expect(rows.results[0].ended_at).toBeTruthy();
    expect(rows.results[1].ended_at).toBeNull();
    // The vote and the skip stand; the eight unanswered pairs are neither.
    const counts = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM votes WHERE batch_pair_id IN (SELECT id FROM batch_pairs WHERE batch_id = ?1)) AS votes,
              (SELECT count(*) FROM skips WHERE batch_pair_id IN (SELECT id FROM batch_pairs WHERE batch_id = ?1)) AS skips`,
    ).bind((await env.DB.prepare("SELECT batch_id FROM batch_pairs WHERE id = ?").bind(b1.pairs[0].pairId).first<{ batch_id: string }>())!.batch_id).first();
    expect(counts).toEqual({ votes: 1, skips: 1 });
    // A page left open on the old batch cannot answer its set-aside pairs: one may come back in a later batch, and
    // the answer would then count for both copies. Vote, skip and correct all refuse; the given answers are untouched.
    for (const [path, body] of [["/api/vote", { pick: "L" }], ["/api/skip", {}], ["/api/correct", { pick: "R" }]] as const) {
      const r = await call(path, { cookie: v.cookie, body: { pairId: b1.pairs[2].pairId, ...body } });
      expect(r.status).toBe(409);
      expect((await r.json<{ error: string }>()).error).toBe("batch_ended");
    }
    expect((await call("/api/skip", { cookie: v.cookie, body: { pairId: b1.pairs[1].pairId } })).status).toBe(200);
    const h = await json(admin(`/admin/api/rounds/${round}/health`));
    expect(h.scale).toMatchObject({ endedBatches: 1 });
  });

  it("the same set again ends nothing: a judge cannot discard pairs without narrowing", async () => {
    await openFullRound();
    const v = await voter("judge");
    await setSlice(v.cookie, { units: [2], levels: ["State"] });
    const b1 = await getBatch(v.cookie);
    expect(await json(setSlice(v.cookie, { units: [2], levels: ["State"] }))).toMatchObject({ changed: false, ended: 0 });
    expect((await getBatch(v.cookie)).all.map((p) => p.pairId)).toEqual(b1.all.map((p) => p.pairId));
    // A batch whose pairs are all answered has nothing to end.
    await voteN(v.cookie, b1.pairs.length);
    expect(await json(setSlice(v.cookie, { all: true }))).toMatchObject({ changed: true, ended: 0 });
  });

  it("in a round that is not staged, a slice only filters; a slice with nothing in the round says so", async () => {
    const round = await openNewRound(); // the 36 launch questions, all State
    const v = await voter("judge");
    await setSlice(v.cookie, { units: [2], levels: ["State"] });
    await voteN(v.cookie, 12);
    for (const q of await shown(round, v.label)) expect(q.unit).toBe(2);
    const w = await voter("judge");
    await setSlice(w.cookie, { units: [3], levels: ["NF"] });
    expect(await json(call("/api/batch", { cookie: w.cookie }))).toMatchObject({ done: true, pairs: [] });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM round_in_play WHERE round_id = ?").bind(round).first<{ n: number }>())!.n).toBe(0);
  });

  it("a bridge pair, when chosen, sets one question of the set beside one in play outside it, once a batch", async () => {
    const round = await openFullRound();
    const v = await voter("judge");
    const want = { units: [4, 5], levels: ["NF"], bridge: true };
    expect(await json(setSlice(v.cookie, want))).toMatchObject({ slice: want });
    expect((await json(call("/api/me", { cookie: v.cookie }))).slice).toEqual(want);
    await voteN(v.cookie, 30);
    const rows = await env.DB.prepare(
      `SELECT bp.batch_id, bp.left_q, bp.right_q, bp.bridge, bp.is_repeat FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id
        JOIN voters u ON u.id = b.voter_id WHERE u.label = ? ORDER BY b.created_at, bp.position`,
    ).bind(v.label).all<{ batch_id: string; left_q: string; right_q: string; bridge: number; is_repeat: number }>();
    const mine = (id: string) => META.get(id)!.level === "NF" && [4, 5].includes(META.get(id)!.unit);
    const play = await inPlay(round);
    const batches = [...new Set(rows.results.map((r) => r.batch_id))];
    expect(batches).toHaveLength(3);
    for (const b of batches) {
      const pairs = rows.results.filter((r) => r.batch_id === b);
      expect(pairs).toHaveLength(10);
      const bridges = pairs.filter((r) => r.bridge === 1);
      expect(bridges).toHaveLength(1);
      const [x] = bridges;
      expect(x.is_repeat).toBe(0);
      expect(mine(x.left_q) !== mine(x.right_q)).toBe(true);
      expect(play.has(x.left_q) && play.has(x.right_q)).toBe(true);
      for (const r of pairs.filter((r) => r.bridge === 0)) expect(mine(r.left_q) && mine(r.right_q)).toBe(true);
    }
    // The export marks them, and Study health counts them.
    const csv = await (await admin(`/admin/api/rounds/${round}/export/votes.csv`)).text();
    const lines = csv.trim().split(/\r?\n/).slice(1).filter((l) => l.includes(v.label));
    expect(lines.filter((l) => l.endsWith(",1"))).toHaveLength(3);
    // Study health counts first presentations: the third batch may hold one swapped repeat.
    const repeats = rows.results.filter((r) => r.is_repeat === 1).length;
    expect((await json(admin(`/admin/api/rounds/${round}/health`))).scale).toMatchObject({ bridgeVotes: 3, sliceVotes: 30 - repeats });
    // Turning the box off is a change of set; the same units without it draw no bridge pair.
    expect(await json(setSlice(v.cookie, { units: [4, 5], levels: ["NF"], bridge: false }))).toMatchObject({ changed: true, slice: { units: [4, 5], levels: ["NF"] } });
    await voteN(v.cookie, 10);
    const last = await env.DB.prepare(
      `SELECT sum(bp.bridge) AS n FROM batch_pairs bp WHERE bp.batch_id = (SELECT b.id FROM batches b JOIN voters u ON u.id = b.voter_id WHERE u.label = ? ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1)`,
    ).bind(v.label).first<{ n: number }>();
    expect(last!.n).toBe(0);
  });

  it("a set saved before the bridge box existed keeps no bridge pair; with nothing outside the set, there is none to give", async () => {
    // A stored choice without the field is read as no bridge.
    await openNewRound();
    const v = await voter("judge");
    await env.DB.prepare("UPDATE voters SET slice_json = ? WHERE label = ?").bind(JSON.stringify({ units: [1], levels: ["State"] }), v.label).run();
    expect((await json(call("/api/me", { cookie: v.cookie }))).slice).toEqual({ units: [1], levels: ["State"] });
    const state = (items: string[], all: string[], done: string[] = []) => ({
      items,
      beta: new Map(all.map((id) => [id, 0])),
      se: new Map(all.map((id) => [id, 1])),
      games: new Map(all.map((id) => [id, 0])),
      done: new Set(done),
      history: [],
      repeated: new Set<string>(),
      trials: 0,
    });
    const rng = () => 0.5;
    expect(bridgePair(state(["a", "b"], ["a", "b"]), [], rng)).toBeNull();
    expect(bridgePair(state(["a"], ["a", "x"], ["a|x"]), [], rng)).toBeNull();
    const p = bridgePair(state(["a"], ["a", "x"]), [], rng)!;
    expect([p.left, p.right].sort()).toEqual(["a", "x"]);
    expect(p).toMatchObject({ isRepeat: false, reason: "info" });
  });

  it("the votes CSV carries each vote's slice, the owner sees each voter's choice, and Study health counts cross-unit comparisons", async () => {
    const round = await openFullRound();
    const v = await voter("judge");
    await setSlice(v.cookie, { units: [4, 5], levels: ["NF"] });
    await voteN(v.cookie, 10);
    const g = await voter("coach");
    await voteN(g.cookie, 10);
    const csv = await (await admin(`/admin/api/rounds/${round}/export/votes.csv`)).text();
    const [head, ...lines] = csv.trim().split(/\r?\n/);
    expect(head.split(",").slice(-2)).toEqual(["batch_slice", "bridge_pair"]);
    expect(lines.filter((l) => l.includes(`""units"":[4,5]`))).toHaveLength(10);
    // The coach judged all questions: no slice, and no bridge pair.
    expect(lines.filter((l) => l.endsWith(",,0"))).toHaveLength(10);
    const list = await json(admin("/admin/api/codes"));
    expect(JSON.parse(list.voters.find((x: { label: string }) => x.label === v.label).slice_json)).toEqual({ units: [4, 5], levels: ["NF"] });
    const h = await json(admin(`/admin/api/rounds/${round}/health`));
    // Twenty adult votes are twenty comparisons. The slice judge's ten are all within Units 4 and 5 Nationals.
    expect(h.scale).toMatchObject({ adultComparisons: 20, sliceVotes: 10, sliceVoters: 1 });
    expect(h.scale.crossUnit).toBeLessThanOrEqual(20);
    const perUnit = h.scale.perUnit.reduce((s: number, u: { games: number }) => s + u.games, 0);
    expect(perUnit).toBe(20 + h.scale.crossUnit);
    const backup = await json(admin("/admin/api/backup/voters"));
    expect(backup.rows.some((r: { slice_json: string | null }) => r.slice_json)).toBe(true);
  });
});
