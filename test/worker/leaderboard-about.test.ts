// Leaderboard (only) shows each question's level, year, unit, number and confirmed quoted sources, plus averages by
// unit and by year. Question ids never appear. Owner decision 25 Nov 2026, logged in DEVIATIONS.md.
import { beforeEach, describe, expect, it } from "vitest";
import itemsRaw from "../../items/launch_items_v1.json?raw";
import sourcesFile from "../../items/sources_v1.json";
import { call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";

const items: { id: string; cycle: string; unit: number; q: number; stem: string }[] = JSON.parse(itemsRaw).items;
const sources = sourcesFile.sources as Record<string, { label: string; url: string }[]>;

describe("leaderboard question info and groups", () => {
  beforeEach(() => mockOutbound());

  it("gives year, unit, number and confirmed sources for every question, and still no ids", async () => {
    await openNewRound();
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
