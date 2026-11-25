// The unit sets that ship with the site (owner decision, 25 Nov 2026): loaded one per request, each with a draft round.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SETS } from "../../src/worker/builtin-sets";
import { admin, call, json, loadItems, mockOutbound } from "./helpers";

describe("built-in unit sets", () => {
  beforeEach(() => mockOutbound());

  it("lists twelve sets, one per unit and level, none over 40 questions", async () => {
    const r = await json(admin("/admin/api/builtin-sets"));
    expect(r.sets).toHaveLength(12);
    expect(r.sets.map((s: { roundName: string }) => s.roundName)).toContain("Unit 3, National Finals");
    expect(Math.max(...r.sets.map((s: { questions: number }) => s.questions))).toBeLessThanOrEqual(40);
    expect((await call("/admin/api/builtin-sets")).status).toBe(403);
  });

  it("loads a set beside the launch set (same ids, same texts), makes one draft round, and is safe to repeat", async () => {
    await loadItems(); // the 36 launch questions; twelve of them are also in State unit sets
    const id = "state-u1-v1";
    const first = await json(admin(`/admin/api/builtin-sets/${id}`, { body: {} }));
    expect(first.ok).toBe(true);
    expect(first.n).toBe(BUILTIN_SETS.find((b) => b.id === id)!.questions);
    expect(first.roundCreated).toBeTruthy();
    const round = await env.DB.prepare("SELECT name, state FROM rounds WHERE item_set_id = ?").bind(id).all<{ name: string; state: string }>();
    expect(round.results).toEqual([{ name: "Unit 1, State", state: "draft" }]);
    const again = await json(admin(`/admin/api/builtin-sets/${id}`, { body: {} }));
    expect(again.already).toBe(true);
    expect(again.roundCreated).toBeNull();
    const list = await json(admin("/admin/api/builtin-sets"));
    expect(list.sets.find((s: { id: string }) => s.id === id)).toMatchObject({ loaded: true, rounds: ["draft"] });
    expect((await admin("/admin/api/builtin-sets/nope-v1", { body: {} })).status).toBe(404);
  });

  it("every built-in question is published, has a stem and two bullets, and belongs to its set's unit and level", () => {
    const ids = new Set<string>();
    for (const b of BUILTIN_SETS) {
      const f = b.file as unknown as { level: string; unit: number; items: { id: string; level: string; unit: number; published: boolean; stem: string; bullets: string[] }[] };
      for (const it of f.items) {
        expect(it.published).toBe(true);
        expect(it.level === f.level && it.unit === f.unit, it.id).toBe(true);
        expect(it.stem.length > 40 && it.bullets.length === 2 && it.bullets.every((x) => x.length > 15), it.id).toBe(true);
        expect(/[*†‡]|https?:|\baccessed\b/.test(it.stem + it.bullets.join(" ")), it.id).toBe(false);
        expect(ids.has(it.id)).toBe(false);
        ids.add(it.id);
      }
    }
    expect(ids.size).toBe(324);
  });
});
