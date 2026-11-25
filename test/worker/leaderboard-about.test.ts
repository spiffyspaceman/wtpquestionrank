// Leaderboard (only) shows each question's level, year, unit, number and confirmed quoted sources, plus averages by
// unit and by year. Question ids never appear. Owner decision 25 Nov 2026, logged in DEVIATIONS.md.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import itemsRaw from "../../items/launch_items_v1.json?raw";
import sourcesFile from "../../items/sources_v1.json";
import { call, getBatch, json, mockOutbound, openNewRound, quorum, voteN, voter } from "./helpers";

const items: { id: string; cycle: string; unit: number; q: number; stem: string }[] = JSON.parse(itemsRaw).items;
const sources = sourcesFile.sources as Record<string, { label: string; url: string }[]>;

describe("leaderboard question info and groups", () => {
  beforeEach(() => mockOutbound());

  it("gives year, unit, number and confirmed sources for every question, and still no ids", async () => {
    await openNewRound();
    await quorum("other"); // two more adults, so three stand behind the adults board
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    const res = await call("/api/leaderboard", { cookie: v.cookie });
    const text = await res.text();
    for (const it of items) expect(text).not.toContain(it.id);
    const b = JSON.parse(text);
    for (const row of b.rows) {
      const it = items.find((i) => i.stem === row.stem)!;
      expect(row.about).toMatchObject({ level: "State", cycle: it.cycle, unit: it.unit, question: it.q });
      expect(row.about.sources).toEqual(sources[it.id] ?? []);
    }
    expect(b.rows.filter((r: any) => r.about.sources.length).length).toBe(Object.keys(sources).length);
  });

  it("averages ranked questions only, per unit and per year", async () => {
    await openNewRound();
    await quorum("other"); // two more adults, so three stand behind the adults board
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    const b = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(b.groups.units.map((g: any) => g.label)).toEqual(["Unit 1", "Unit 2", "Unit 3", "Unit 4", "Unit 5", "Unit 6"]);
    expect(b.groups.units.reduce((s: number, g: any) => s + g.n, 0)).toBe(36);
    expect(b.groups.years.reduce((s: number, g: any) => s + g.n, 0)).toBe(36);
    for (const g of [...b.groups.units, ...b.groups.years]) {
      const members = b.rows.filter((r: any) => (g.label.startsWith("Unit") ? `Unit ${r.about.unit}` : r.about.cycle) === g.label && r.rank !== null);
      expect(g.ranked).toBe(members.length);
      if (members.length) expect(g.mean).toBe(Math.round(members.reduce((s: number, r: any) => s + r.rating, 0) / members.length));
      else expect(g.mean).toBeNull();
    }
  });

  it("never sends year, unit or sources with a voting batch", async () => {
    await openNewRound();
    const v = await voter("coach");
    const b = await getBatch(v.cookie);
    expect(JSON.stringify(b)).not.toMatch(/"(about|cycle|unit|question|sources)"/);
  });
});

describe("leaderboard data for the charts", () => {
  beforeEach(() => mockOutbound());

  it("sends head-to-head counts added up by group, never per question, and reason counts without any Other words", async () => {
    const round = await openNewRound();
    await quorum("other");
    const v = await voter("judge");
    const b0 = await getBatch(v.cookie);
    await call("/api/vote", { cookie: v.cookie, body: { pairId: b0.pairs[0].pairId, pick: "L", reasons: ["position"], other: "secret words here" } });
    await voteN(v.cookie, 19);
    const res = await call("/api/leaderboard", { cookie: v.cookie });
    const text = await res.text();
    for (const it of items) expect(text).not.toContain(it.id);
    expect(text).not.toContain("secret words");
    const b = JSON.parse(text);
    // Nothing per question: no list of pairs, and no rating, range or win count for a question that is not ranked.
    expect(b.pairs).toBeUndefined();
    for (const r of b.rows) if (r.rank === null) expect(r).toMatchObject({ rating: null, lo: null, hi: null, wins: null });
    // Each grouping's cells: two different groups, named as the page names them, with a's wins out of n.
    expect(Object.keys(b.h2h).sort()).toEqual(["qnum", "quote", "unit", "year"]);
    for (const cells of Object.values(b.h2h) as { a: string; b: string; aw: number; n: number }[][])
      for (const c of cells) {
        expect(c.a < c.b).toBe(true);
        expect(c.aw >= 0 && c.aw <= c.n && c.n > 0).toBe(true);
      }
    for (const c of b.h2h.unit) expect(c.a).toMatch(/^Unit [1-6]$/);
    for (const c of b.h2h.qnum) expect(c.b).toMatch(/^Question [1-3]$/);
    // The unit cells hold every comparison between questions of different units, once, with the right winner count.
    const cross = await env.DB.prepare(
      `SELECT count(*) AS n, SUM(CASE WHEN (v.winner_q = v.left_q) = (ql.unit < qr.unit) THEN 1 ELSE 0 END) AS low_wins
         FROM votes v JOIN questions ql ON ql.id = v.left_q JOIN questions qr ON qr.id = v.right_q
        WHERE v.round_id = ? AND ql.unit <> qr.unit`,
    ).bind(round).first<{ n: number; low_wins: number }>();
    expect(b.h2h.unit.reduce((s: number, c: { n: number }) => s + c.n, 0)).toBe(cross!.n);
    expect(b.h2h.unit.reduce((s: number, c: { aw: number }) => s + c.aw, 0)).toBe(cross!.low_wins);
    expect(cross!.n).toBeGreaterThan(10);
    expect(b.votes).toBe(22);
    const given = b.rows.flatMap((r: any) => r.reasons);
    expect(given.map((x: any) => x.code).sort()).toEqual(["other", "position"]);
    for (const x of given) expect(Object.keys(x).sort()).toEqual(["code", "n"]);
  });
});
