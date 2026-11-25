// Fixes from the launch audit of 25 Nov 2026 (docs/AUDIT_2026-11-25_launch.md).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";

/**
 * A database that runs `first` once, just before the next db.batch() it is asked for: the moment between a
 * request's checks and its write, where another request or an admin action can land.
 */
function interleave(first: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await first();
          }
          return target.batch(stmts);
        };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("launch audit fixes", () => {
  beforeEach(() => mockOutbound());

  it("a vote refused because the round froze does not add its reasons or a count to another request's vote", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const p = (await getBatch(v.cookie)).pairs[0];
    // The second submit has passed its checks when the first lands and the round freezes.
    const DB = interleave(async () => {
      expect((await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L", reasons: ["position"] } })).status).toBe(200);
      await admin(`/admin/api/rounds/${round}/freeze`, { body: {} });
    });
    const late = await call("/api/vote", { cookie: v.cookie, env: { DB }, body: { pairId: p.pairId, pick: "R", reasons: ["substance"], other: "late words" } });
    expect(late.status).toBe(409);
    const vote = await env.DB.prepare("SELECT id, winner_q, left_q FROM votes WHERE batch_pair_id = ?").bind(p.pairId).first<{ id: number; winner_q: string; left_q: string }>();
    expect(vote!.winner_q).toBe(vote!.left_q);
    const reasons = await env.DB.prepare("SELECT reason FROM vote_reasons WHERE vote_id = ?").bind(vote!.id).all<{ reason: string }>();
    expect(reasons.results.map((r) => r.reason)).toEqual(["position"]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM vote_other WHERE vote_id = ?").bind(vote!.id).first<{ n: number }>())!.n).toBe(0);
    const counts = await env.DB.prepare("SELECT pool, SUM(n) AS n FROM pair_counts WHERE round_id = ? GROUP BY pool ORDER BY pool").bind(round).all();
    expect(counts.results).toEqual([{ pool: "adults", n: 1 }, { pool: "all", n: 1 }, { pool: "judge", n: 1 }]);
  });

  it("the same holds when the code is revoked between the two submits", async () => {
    const round = await openNewRound();
    const v = await voter("coach");
    const p = (await getBatch(v.cookie)).pairs[0];
    const DB = interleave(async () => {
      await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
      await admin("/admin/api/codes/revoke", { body: { label: v.label } });
    });
    await call("/api/vote", { cookie: v.cookie, env: { DB }, body: { pairId: p.pairId, pick: "R", reasons: ["current"] } });
    // The revoked voter's one vote is out of the cache and stays out.
    const counts = await env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM pair_counts WHERE round_id = ?").bind(round).first<{ n: number }>();
    expect(counts!.n).toBe(0);
    const mine = await env.DB.prepare("SELECT count(*) AS n FROM vote_reasons r JOIN votes w ON w.id = r.vote_id WHERE w.batch_pair_id = ?").bind(p.pairId).first<{ n: number }>();
    expect(mine!.n).toBe(0);
  });

  it("no batch is issued into a round that closed while the pairs were being chosen", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const DB = interleave(() => admin(`/admin/api/rounds/${round}/close`, { body: {} }));
    const r = await call("/api/batch", { cookie: v.cookie, env: { DB } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "no_open_round" });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM batches WHERE round_id = ?").bind(round).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("revoking again finishes a revoke that stopped before the caches were rebuilt", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 10);
    // As if the first revoke failed after its first step: the code is revoked, its votes are still counted.
    await env.DB.prepare("UPDATE voters SET revoked_at = ? WHERE label = ?").bind(new Date().toISOString(), v.label).run();
    const sum = () => env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM pair_counts WHERE round_id = ? AND pool = 'all'").bind(round).first<{ n: number }>();
    expect((await sum())!.n).toBe(10);
    expect(await json(admin("/admin/api/codes/revoke", { body: { label: v.label } }))).toMatchObject({ ok: true, already: true });
    expect((await sum())!.n).toBe(0);
    const audit = await env.DB.prepare("SELECT detail_json FROM admin_audit WHERE action = 'revoke_code' ORDER BY id DESC LIMIT 1").first<{ detail_json: string }>();
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ label: v.label, repaired: true });
    // A third press changes nothing and writes no further audit row.
    const before = await env.DB.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'revoke_code'").first<{ n: number }>();
    await admin("/admin/api/codes/revoke", { body: { label: v.label } });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'revoke_code'").first<{ n: number }>())!.n).toBe(before!.n);
  });

  it("a round cannot open on a question set whose load did not finish", async () => {
    await env.DB.prepare("INSERT INTO item_sets (id, name, version, display_mode, file_sha256, created_at, open_ended) VALUES ('half-v1', 'half', 1, 'full_text', 'loading', ?, 0)")
      .bind(new Date().toISOString())
      .run();
    const { id } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name: "Half loaded", itemSetId: "half-v1" } }));
    const r = await admin(`/admin/api/rounds/${id}/open`, { body: {} });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "set_loading" });
    expect((await env.DB.prepare("SELECT state FROM rounds WHERE id = ?").bind(id).first<{ state: string }>())!.state).toBe("draft");
    expect((await env.DB.prepare("SELECT frozen_at FROM item_sets WHERE id = 'half-v1'").first<{ frozen_at: string | null }>())!.frozen_at).toBeNull();
  });
});
