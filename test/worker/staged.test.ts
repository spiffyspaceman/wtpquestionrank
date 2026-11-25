// A round that opens its questions in stages (owner decision, 25 Nov 2026; migration 0008).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import launch from "../../items/launch_items_v1.json";
import { BUILTIN_SETS } from "../../src/worker/builtin-sets";
import { firstGroup, HELD, nextGroup, STAGE, type StageItem } from "../../src/worker/staging";
import { admin, call, getBatch, json, mockOutbound, quorum, voteN, voter } from "./helpers";

const SET = BUILTIN_SETS[0];
const ALL = (SET.file.items as { id: string; level: string; unit: number }[]).map((i) => ({ id: i.id, level: i.level, unit: i.unit }));
const LAUNCH = new Set((launch as { items: { id: string }[] }).items.map((i) => i.id));
/** Every question of the set but those held back for a defect in their loaded text: what a round can reach. */
const REACHABLE = SET.questions - HELD.size;
const inPlay = async (round: string) =>
  (await env.DB.prepare("SELECT question_id FROM round_in_play WHERE round_id = ? ORDER BY 1").bind(round).all<{ question_id: string }>()).results.map((r) => r.question_id);

/** Load the full set and return a draft round on it, staged as the built-in loader makes it. Other rounds are closed first. */
async function draftFullRound(): Promise<string> {
  await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
  const made = await json(admin(`/admin/api/builtin-sets/${SET.id}`, { body: {} }));
  if (made.roundCreated) return made.roundCreated;
  // Tests in this file share a database: the set's own round was used by an earlier test, so make another like it.
  const { id } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name: "All questions again", itemSetId: SET.id } }));
  await admin(`/admin/api/rounds/${id}/staging`, { body: { staged: true, autoGrow: true } });
  return id;
}

async function openFullRound(): Promise<string> {
  const round = await draftFullRound();
  expect((await admin(`/admin/api/rounds/${round}/open`, { body: {} })).status).toBe(200);
  return round;
}

/** Give every question in play `n` comparisons in a pool, by writing the cache the growth rule reads. */
async function settle(round: string, pool: string, n: number): Promise<void> {
  const ids = await inPlay(round);
  // A ring: each question meets its two neighbours n/2 times.
  for (let k = 0; k < ids.length; k++)
    await env.DB.prepare(
      `INSERT INTO pair_counts (round_id, pool, left_q, right_q, left_wins, n) VALUES (?1, ?2, ?3, ?4, 0, ?5)
       ON CONFLICT (round_id, pool, left_q, right_q) DO UPDATE SET n = n + excluded.n`,
    )
      .bind(round, pool, ids[k], ids[(k + 1) % ids.length], n / 2)
      .run();
}

describe("the order questions join in", () => {
  it("starts with the 36 launch questions, then keeps units and levels even", () => {
    const first = firstGroup(ALL);
    expect(new Set(first)).toEqual(LAUNCH);
    const next = nextGroup(ALL, new Set(first), STAGE.STEP);
    expect(next).toHaveLength(STAGE.STEP);
    expect(new Set(next).size).toBe(STAGE.STEP);
    expect(next.some((id) => LAUNCH.has(id))).toBe(false);
    // The launch questions are all State, six a unit; the next group brings National Finals level, four a unit.
    const by = new Map(ALL.map((i) => [i.id, i]));
    for (let u = 1; u <= 6; u++) expect(next.filter((id) => by.get(id)!.level === "NF" && by.get(id)!.unit === u)).toHaveLength(4);
    // The same input gives the same group, and the order is not the ids' own order.
    expect(nextGroup(ALL, new Set(first), STAGE.STEP)).toEqual(next);
    expect([...next].sort()).not.toEqual(next);
  });

  it("brings every question in, once each, and stays even on the way", () => {
    const playing = new Set(firstGroup(ALL));
    const by = new Map(ALL.map((i) => [i.id, i]));
    for (;;) {
      const g = nextGroup(ALL, playing, STAGE.STEP);
      if (!g.length) break;
      for (const id of g) {
        expect(playing.has(id)).toBe(false);
        playing.add(id);
      }
      const counts = new Map<string, number>();
      for (const id of playing) counts.set(`${by.get(id)!.level}|${by.get(id)!.unit}`, (counts.get(`${by.get(id)!.level}|${by.get(id)!.unit}`) ?? 0) + 1);
      const waiting = ALL.filter((i) => !playing.has(i.id));
      // Once National Finals has caught up with the six-a-unit head start of the launch questions, no level-and-unit
      // group with questions still waiting is ahead of another by more than one.
      const open = [...new Set(waiting.map((i) => `${i.level}|${i.unit}`))].map((s) => counts.get(s) ?? 0);
      if (open.length > 1 && Math.min(...open) >= 6) expect(Math.max(...open) - Math.min(...open)).toBeLessThanOrEqual(1);
    }
    // Every question joins except those held back for a known defect in their loaded text.
    expect(playing.size).toBe(ALL.length - HELD.size);
    for (const id of HELD) {
      expect(ALL.some((i) => i.id === id)).toBe(true);
      expect(playing.has(id)).toBe(false);
    }
  });

  it("a set without the launch questions starts with an even first group", () => {
    const some: StageItem[] = ALL.filter((i) => !LAUNCH.has(i.id));
    const first = firstGroup(some);
    expect(first).toHaveLength(STAGE.FIRST);
    const by = new Map(ALL.map((i) => [i.id, i]));
    for (const level of ["State", "NF"]) for (let u = 1; u <= 6; u++) expect(first.filter((id) => by.get(id)!.level === level && by.get(id)!.unit === u)).toHaveLength(3);
  });
});

describe("staged rounds", () => {
  beforeEach(() => mockOutbound());

  it("the full set's round opens with the launch questions in play; batches and the board hold only those", async () => {
    const round = await openFullRound();
    const r = await env.DB.prepare("SELECT staged, auto_grow FROM rounds WHERE id = ?").bind(round).first<{ staged: number; auto_grow: number }>();
    expect(r).toEqual({ staged: 1, auto_grow: 1 });
    expect(new Set(await inPlay(round))).toEqual(LAUNCH);

    const v = await voter("judge");
    await voteN(v.cookie, 20);
    await quorum("other");
    const shown = await env.DB.prepare("SELECT left_q, right_q FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id WHERE b.round_id = ?").bind(round).all<{ left_q: string; right_q: string }>();
    expect(shown.results.length).toBeGreaterThanOrEqual(20);
    for (const p of shown.results) expect(LAUNCH.has(p.left_q) && LAUNCH.has(p.right_q)).toBe(true);

    const board = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(board.rows).toHaveLength(36);
    expect(board.staged).toEqual({ inPlay: 36, total: REACHABLE });
    // No question has ten comparisons after twenty votes: none has a rank, a rating, a range or a win count.
    for (const row of board.rows) expect(row).toMatchObject({ rank: null, rating: null, wins: null, lo: null, hi: null });
    // With no rating sent, the order must not follow the rating either: most comparisons first.
    const games = board.rows.map((r: { games: number }) => r.games);
    expect(games).toEqual([...games].sort((x: number, y: number) => y - x));

    const status = await json(admin("/admin/api/status"));
    expect(status.rounds.find((x: { id: string }) => x.id === round)).toMatchObject({ staged: 1, auto_grow: 1, n_in_play: 36, n_items: REACHABLE });
    const health = await json(admin(`/admin/api/rounds/${round}/health`));
    expect(health.gate.items).toBe(36);
    expect((await json(admin(`/admin/api/rounds/${round}/bootstrap-input`))).items).toHaveLength(36);
  });

  it("the next group joins once every question in play has 12 adult comparisons, and not on student votes alone", async () => {
    const round = await openFullRound();
    await quorum("other");
    const v = await voter("judge");
    await getBatch(v.cookie);
    expect(await inPlay(round)).toHaveLength(36);

    await settle(round, "student", 12);
    await settle(round, "all", 12);
    await voteN(v.cookie, 10);
    await getBatch(v.cookie);
    expect(await inPlay(round)).toHaveLength(36);

    await settle(round, "adults", 12);
    await voteN(v.cookie, 10);
    const b = await getBatch(v.cookie); // a new batch: the rule is checked before it is chosen
    const now = await inPlay(round);
    expect(now).toHaveLength(36 + STAGE.STEP);
    const joined = await env.DB.prepare("SELECT count(DISTINCT joined_at) AS times FROM round_in_play WHERE round_id = ?").bind(round).first<{ times: number }>();
    expect(joined!.times).toBe(2);
    // The newcomers are paired at once: they have the fewest comparisons.
    const fresh = new Set(now.filter((id) => !LAUNCH.has(id)));
    const pairs = await env.DB.prepare(`SELECT left_q, right_q FROM batch_pairs WHERE id IN (${b.all.map(() => "?").join(",")})`).bind(...b.all.map((p) => p.pairId)).all<{ left_q: string; right_q: string }>();
    expect(pairs.results.some((p) => fresh.has(p.left_q) || fresh.has(p.right_q))).toBe(true);
    // The newcomers are not settled, so the next batch adds nothing more.
    await voteN(v.cookie, 10);
    await getBatch(v.cookie);
    expect(await inPlay(round)).toHaveLength(36 + STAGE.STEP);
    expect((await json(call("/api/leaderboard", { cookie: v.cookie }))).staged).toEqual({ inPlay: 36 + STAGE.STEP, total: REACHABLE });
  });

  it("the owner can stop it growing by itself, add a group by hand, and cannot change staging once it is open", async () => {
    const round = await openFullRound();
    expect(await json(admin(`/admin/api/rounds/${round}/staging`, { body: { autoGrow: false } }))).toMatchObject({ ok: true, staged: true, autoGrow: false });
    await settle(round, "adults", 12);
    const v = await voter("judge");
    await getBatch(v.cookie);
    expect(await inPlay(round)).toHaveLength(36);

    const grown = await json(admin(`/admin/api/rounds/${round}/grow`, { body: {} }));
    expect(grown).toMatchObject({ ok: true, added: STAGE.STEP, inPlay: 36 + STAGE.STEP, total: REACHABLE });
    expect(await json(admin(`/admin/api/rounds/${round}/staging`))).toMatchObject({ staged: true, autoGrow: false, inPlay: 60, fewestAdultGames: 0 });
    const off = await admin(`/admin/api/rounds/${round}/staging`, { body: { staged: false } });
    expect(off.status).toBe(409);
    const audit = await env.DB.prepare("SELECT detail_json FROM admin_audit WHERE action = 'grow_round' ORDER BY id DESC LIMIT 1").first<{ detail_json: string }>();
    expect(JSON.parse(audit!.detail_json).added).toHaveLength(STAGE.STEP);
    // Questions in play never leave, and the database itself refuses a change of staging on an open round.
    await expect(env.DB.prepare("DELETE FROM round_in_play WHERE round_id = ?").bind(round).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE rounds SET staged = 0 WHERE id = ?").bind(round).run()).rejects.toThrow(/fixed once/);
    // Admin only.
    expect((await call(`/admin/api/rounds/${round}/grow`, { body: {} })).status).toBe(403);
  });

  it("a draft round can be switched to open all at once; a round that is not staged has every question in play", async () => {
    const round = await draftFullRound();
    expect(await json(admin(`/admin/api/rounds/${round}/staging`, { body: { staged: false } }))).toMatchObject({ staged: false, autoGrow: false });
    await admin(`/admin/api/rounds/${round}/open`, { body: {} });
    expect(await inPlay(round)).toHaveLength(0);
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    await quorum("other");
    const board = await json(call("/api/leaderboard", { cookie: v.cookie }));
    // Every question but the held one, which is in play in no round, staged or not.
    expect(board.rows).toHaveLength(REACHABLE);
    expect(board.staged).toBeNull();
    const held = await env.DB.prepare("SELECT stem FROM questions WHERE id = ?").bind([...HELD][0]).first<{ stem: string }>();
    expect(board.rows.some((r: { stem: string }) => r.stem === held!.stem)).toBe(false);
    expect((await admin(`/admin/api/rounds/${round}/grow`, { body: {} })).status).toBe(409);
  });

  it("a question added to the set after a staged round opened comes into play at once", async () => {
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
    const q = (k: number) => ({ id: `stg-${String(k).padStart(2, "0")}`, level: k % 2 ? "NF" : "State", cycle: "2020-21", unit: (k % 6) + 1, q: (k % 3) + 1, published: true, stem: `Staged stem ${k}?`, bullets: ["One?", "Two?"], source: "test" });
    const file = (n: number) => JSON.stringify({ item_set: "stg", version: 1, open_ended: true, items: Array.from({ length: n }, (_, k) => q(k)) });
    const load = (raw: string) => admin("/admin/api/items", { raw, headers: { "content-type": "application/octet-stream" } });
    await load(file(50));
    const { id: round } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name: "Staged test", itemSetId: "stg-v1" } }));
    await admin(`/admin/api/rounds/${round}/staging`, { body: { staged: true, autoGrow: true } });
    await admin(`/admin/api/rounds/${round}/open`, { body: {} });
    expect(await inPlay(round)).toHaveLength(STAGE.FIRST);
    expect((await json(load(file(52)))).added).toBe(2);
    const now = await inPlay(round);
    expect(now).toHaveLength(STAGE.FIRST + 2);
    expect(now).toEqual(expect.arrayContaining(["stg-50", "stg-51"]));
  });

  it("the backup holds the questions in play and the per-round leaderboard views", async () => {
    const round = await openFullRound();
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    await quorum("other");
    await call("/api/leaderboard", { cookie: v.cookie });
    const start = await json(admin("/admin/api/backup"));
    const names = start.tables.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["round_in_play", "round_board_seen"]));
    const play = await json(admin("/admin/api/backup/round_in_play"));
    expect(play.rows.filter((x: { round_id: string }) => x.round_id === round)).toHaveLength(36);
    const seen = await json(admin("/admin/api/backup/round_board_seen"));
    expect(seen.rows.some((x: { round_id: string }) => x.round_id === round)).toBe(true);
  });
});
