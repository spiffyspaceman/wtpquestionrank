// Concurrency and ordering guarantees found in the architecture audit (24 Nov 2026).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";
import itemsRaw from "../../items/launch_items_v1.json?raw";

const ids: string[] = JSON.parse(itemsRaw).items.map((i: { id: string }) => i.id);

describe("races", () => {
  beforeEach(() => mockOutbound());

  it("concurrent batch requests create one batch and all get the same pairs", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    const results = await Promise.all(Array.from({ length: 5 }, () => call("/api/batch", { cookie: v.cookie }).then((r) => r.json<any>())));
    const n = await env.DB.prepare("SELECT count(*) AS n FROM batches WHERE round_id = ? AND voter_id = (SELECT id FROM voters WHERE label = ?)")
      .bind(id, v.label)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
    const first = results[0].pairs.map((p: { pairId: string }) => p.pairId);
    expect(first).toHaveLength(10);
    for (const r of results) expect(r.pairs.map((p: { pairId: string }) => p.pairId)).toEqual(first);
  });

  it("concurrent submits of one pair write one vote and count it once", async () => {
    const id = await openNewRound();
    const v = await voter("coach");
    const p = (await getBatch(v.cookie)).pairs[0];
    const res = await Promise.all(
      Array.from({ length: 5 }, (_, k) => call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: k % 2 ? "L" : "R" } })),
    );
    for (const r of res) expect(r.status).toBe(200);
    const votes = await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE batch_pair_id = ?").bind(p.pairId).first<{ n: number }>();
    expect(votes?.n).toBe(1);
    const counts = await env.DB.prepare("SELECT pool, SUM(n) AS n FROM pair_counts WHERE round_id = ? GROUP BY pool ORDER BY pool").bind(id).all<any>();
    expect(counts.results).toEqual([
      { pool: "adults", n: 1 },
      { pool: "all", n: 1 },
      { pool: "coach", n: 1 },
    ]);
  });

  it("a vote on a pair whose round froze writes nothing, not even counts", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    const p = (await getBatch(v.cookie)).pairs[0];
    await admin(`/admin/api/rounds/${id}/freeze`, { body: {} });
    expect((await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } })).status).toBe(409);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM pair_counts WHERE round_id = ?").bind(id).first<any>()).n).toBe(0);
  });
});

describe("ordering and reminders", () => {
  beforeEach(() => mockOutbound());

  it("unplayed items on a board do not come out in question-id order", async () => {
    const id = await openNewRound();
    const b = await json(admin(`/admin/api/rounds/${id}/board?pool=student`));
    const order: string[] = b.rows.map((r: { id: string }) => r.id);
    expect(new Set(order)).toEqual(new Set(ids));
    expect(order).not.toEqual([...ids].sort());
    // Stable: the same order every time.
    const again = await json(admin(`/admin/api/rounds/${id}/board?pool=student`));
    expect(again.rows.map((r: { id: string }) => r.id)).toEqual(order);
  });

  it("only a JSON or votes CSV export quiets the export reminder", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 2);
    const before = await json(admin("/admin/api/status"));
    if (before.lastExportAt === null) expect(before.exportOverdue).toBe(true);
    await admin(`/admin/api/rounds/${id}/export/voters.csv`);
    const afterVoters = await json(admin("/admin/api/status"));
    expect(afterVoters.lastExportAt).toBe(before.lastExportAt);
    await admin(`/admin/api/rounds/${id}/export.json`);
    const afterJson = await json(admin("/admin/api/status"));
    expect(afterJson.lastExportAt).not.toBe(before.lastExportAt);
    expect(afterJson.exportOverdue).toBe(false);
  });

  it("a rebuild with nothing to change writes no rows; a revoke rewrites only what changed", async () => {
    const id = await openNewRound();
    const a = await voter("judge");
    const b = await voter("coach");
    await voteN(a.cookie, 40);
    await voteN(b.cookie, 10);
    const full = (await env.DB.prepare("SELECT count(*) AS n FROM pair_counts WHERE round_id = ?").bind(id).first<any>()).n;
    const noop = await json(admin(`/admin/api/rounds/${id}/rebuild`, { body: {} }));
    expect(noop.rowsWritten).toBe(0);
    await admin("/admin/api/codes/revoke", { body: { label: b.label } });
    const audit = await env.DB.prepare("SELECT detail_json FROM admin_audit WHERE action = 'revoke_code' ORDER BY id DESC LIMIT 1").first<any>();
    expect(JSON.parse(audit.detail_json).rebuilt).toEqual([id]);
    const after = (await env.DB.prepare("SELECT count(*) AS n FROM pair_counts WHERE round_id = ?").bind(id).first<any>()).n;
    expect(after).toBeLessThan(full);
    const again = await json(admin(`/admin/api/rounds/${id}/rebuild`, { body: {} }));
    expect(again.rowsWritten).toBe(0);
  });
});
