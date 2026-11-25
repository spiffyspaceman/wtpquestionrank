// Questions added to a round that is already running (owner decision, 25 Nov 2026; migration 0006).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, itemsRaw, json, loadItems, mockOutbound, voteN, voter } from "./helpers";

const q = (k: number, stem = `Stem ${k}?`) => ({
  id: `grow-${String(k).padStart(2, "0")}`, level: "State", cycle: "2020-21", unit: 1, q: (k % 3) + 1, published: true,
  stem, bullets: ["One?", "Two?"], source: "test",
});
const file = (n: number, over: Record<string, unknown> = {}) => JSON.stringify({ item_set: "grow", version: 1, open_ended: true, items: Array.from({ length: n }, (_, k) => q(k)), ...over });
const load = (raw: string) => admin("/admin/api/items", { raw, headers: { "content-type": "application/octet-stream" } });

describe("open-ended item sets", () => {
  beforeEach(() => mockOutbound());

  it("new questions join a running round: they are paired at once and appear on the board unranked", async () => {
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
    expect((await json(load(file(8)))).n).toBe(8);
    const { id: round } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name: "Growing", itemSetId: "grow-v1" } }));
    await admin(`/admin/api/rounds/${round}/open`, { body: {} });
    const v = await voter("judge");
    await voteN(v.cookie, 20);

    // Two more questions, after the round opened and the set froze.
    const more = await json(load(file(10)));
    expect(more).toMatchObject({ ok: true, added: 2, n: 10 });
    expect((await json(load(file(10)))).already).toBe(true);
    const added = await env.DB.prepare("SELECT question_id, added_at FROM item_set_items WHERE item_set_id = 'grow-v1' AND added_at IS NOT NULL ORDER BY 1").all();
    expect(added.results.map((r) => r.question_id)).toEqual(["grow-08", "grow-09"]);

    // The next batch already pairs the newcomers (the least-compared questions come first).
    const b = await getBatch(v.cookie);
    const inBatch = await env.DB.prepare(
      "SELECT count(*) AS n FROM batch_pairs WHERE id IN (" + b.all.map(() => "?").join(",") + ") AND (left_q IN ('grow-08','grow-09') OR right_q IN ('grow-08','grow-09'))",
    ).bind(...b.all.map((p) => p.pairId)).first<{ n: number }>();
    expect(inBatch!.n).toBeGreaterThan(0);

    // The board lists all ten; the newcomers have no rank until they have 10 comparisons.
    const board = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(board.rows).toHaveLength(10);
    expect(board.rows.filter((r: { games: number; rank: number | null }) => r.games === 0).every((r: { rank: number | null }) => r.rank === null)).toBe(true);
    const audit = await env.DB.prepare("SELECT detail_json FROM admin_audit WHERE action = 'add_items' ORDER BY id DESC LIMIT 1").first<{ detail_json: string }>();
    expect(JSON.parse(audit!.detail_json).added).toEqual(["grow-08", "grow-09"]);
  });

  it("a set only grows: no question leaves it, and no loaded text changes", async () => {
    await load(file(10));
    const fewer = await load(file(9));
    expect(fewer.status).toBe(409);
    expect((await fewer.json() as { error: string; ids: string[] })).toMatchObject({ error: "items_removed", ids: ["grow-09"] });
    const reworded = await load(JSON.stringify({ item_set: "grow", version: 1, open_ended: true, items: [...Array.from({ length: 10 }, (_, k) => q(k, k === 3 ? "Changed?" : undefined)), q(10)] }));
    expect(reworded.status).toBe(409);
    expect((await reworded.json() as { error: string; ids: string[] })).toMatchObject({ error: "text_conflict", ids: ["grow-03"] });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM item_set_items WHERE item_set_id = 'grow-v1'").first<{ n: number }>())!.n).toBe(10);
  });

  it("the launch set is not open-ended: a different file under its name is refused", async () => {
    await loadItems();
    const f = JSON.parse(itemsRaw);
    f.items.push(q(99));
    const r = await load(JSON.stringify(f));
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toBe("item_set_exists");
    // Nor can asking for it in the file open a set that already exists.
    const r2 = await load(JSON.stringify({ ...f, open_ended: true }));
    expect((await r2.json() as { error: string }).error).toBe("item_set_exists");
  });
});
