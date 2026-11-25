// The remaining recommendations of the launch audit (docs/AUDIT_2026-11-25_launch.md), built 25 Nov 2026.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CSP } from "../../src/worker/guards";
import { admin, call, getBatch, ITEM_SET, json, lastSiteverify, loadItems, mockOutbound, openNewRound, quorum, voteN, voter, type ClientPair } from "./helpers";

const key = (p: ClientPair) => [p.left.stem, p.right.stem].sort().join("|");
const vote = (cookie: string, p: ClientPair, pick: "L" | "R" = "L") => call("/api/vote", { cookie, body: { pairId: p.pairId, pick } });

/** Run `first` once, just before the next db.batch(): the moment between a request's checks and its write. */
function interleave(first: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(env.DB, {
    get(target, k) {
      if (k === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await first();
          }
          return target.batch(stmts);
        };
      const v = Reflect.get(target, k);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("launch audit recommendations", () => {
  beforeEach(() => mockOutbound());

  it("a pair skipped and then voted on is one trial, so the swapped repeat does not come a trial early", async () => {
    await openNewRound();
    const v = await voter("judge");
    const seen = new Set<string>();
    const first = (await getBatch(v.cookie)).pairs;
    // Pair 1 is skipped for good. Pair 5 is skipped, then voted on by going back. The other eight are voted on.
    await call("/api/skip", { cookie: v.cookie, body: { pairId: first[0].pairId } });
    for (const p of first.slice(1, 4)) (seen.add(key(p)), await vote(v.cookie, p));
    await call("/api/skip", { cookie: v.cookie, body: { pairId: first[4].pairId } });
    for (const p of first.slice(5)) (seen.add(key(p)), await vote(v.cookie, p));
    expect(await json(call("/api/correct", { cookie: v.cookie, body: { pairId: first[4].pairId, pick: "L" } }))).toMatchObject({ ok: true });
    seen.add(key(first[4]));
    for (const p of (await getBatch(v.cookie)).pairs) (seen.add(key(p)), await vote(v.cookie, p));
    // Twenty trials so far, and the earliest voted pair was the second: nineteen trials ago, one short of the gap.
    // Counting the skip-then-vote twice made it twenty-one and brought a repeat into this batch.
    const third = (await getBatch(v.cookie)).pairs;
    expect(third).toHaveLength(10);
    expect(third.filter((p) => seen.has(key(p)))).toHaveLength(0);
    for (const p of third) (seen.add(key(p)), await vote(v.cookie, p));
    // Thirty trials: now a repeat is due, and it comes.
    expect((await getBatch(v.cookie)).pairs.filter((p) => seen.has(key(p)))).toHaveLength(1);
  });

  it("time on a pair runs from the voter's previous answer, not from when the batch was issued", async () => {
    await openNewRound();
    const v = await voter("judge");
    const [a, b] = (await getBatch(v.cookie)).pairs;
    await new Promise((r) => setTimeout(r, 1200));
    await vote(v.cookie, a);
    await vote(v.cookie, b);
    const ms = await env.DB.prepare("SELECT server_ms FROM votes WHERE batch_pair_id IN (?, ?) ORDER BY id").bind(a.pairId, b.pairId).all<{ server_ms: number }>();
    expect(ms.results[0].server_ms).toBeGreaterThanOrEqual(1200);
    // The second pair's time is the gap between the two answers; from the batch's issue it would exceed the first.
    expect(ms.results[1].server_ms).toBeLessThan(ms.results[0].server_ms);
  });

  it("opening one round's leaderboard does not lock answers given in another round", async () => {
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
    if (!(await env.DB.prepare("SELECT 1 FROM item_sets WHERE id = ?").bind(ITEM_SET).first())) await loadItems();
    const open = async (name: string) => {
      const { id } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name, itemSetId: ITEM_SET } }));
      await admin(`/admin/api/rounds/${id}/open`, { body: {} });
      return id;
    };
    const first = await open("First");
    await quorum("other");
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    expect((await json(call("/api/leaderboard", { cookie: v.cookie }))).round.id).toBe(first);
    // A second round opens; the voter's next batch goes there, and they have not seen its board.
    const second = await open("Second");
    const p = (await getBatch(v.cookie)).pairs[0];
    expect((await env.DB.prepare("SELECT b.round_id FROM batch_pairs p JOIN batches b ON b.id = p.batch_id WHERE p.id = ?").bind(p.pairId).first<{ round_id: string }>())!.round_id).toBe(second);
    await vote(v.cookie, p, "L");
    const changed = await call("/api/correct", { cookie: v.cookie, body: { pairId: p.pairId, pick: "R" } });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ corrected: true });
  });

  it("when a round closes as a batch is being chosen, the batch comes from the next open round", async () => {
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
    if (!(await env.DB.prepare("SELECT 1 FROM item_sets WHERE id = ?").bind(ITEM_SET).first())) await loadItems();
    const ids: string[] = [];
    for (const name of ["Closing", "Staying"]) {
      const { id } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name, itemSetId: ITEM_SET } }));
      await admin(`/admin/api/rounds/${id}/open`, { body: {} });
      ids.push(id);
    }
    const v = await voter("judge");
    const DB = interleave(() => admin(`/admin/api/rounds/${ids[0]}/close`, { body: {} }));
    const r = await call("/api/batch", { cookie: v.cookie, env: { DB } });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { pairs: { pairId: string }[] };
    expect(b.pairs).toHaveLength(10);
    const where = await env.DB.prepare("SELECT b.round_id FROM batch_pairs p JOIN batches b ON b.id = p.batch_id WHERE p.id = ?").bind(b.pairs[0].pairId).first<{ round_id: string }>();
    expect(where!.round_id).toBe(ids[1]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM batches WHERE round_id = ?").bind(ids[0]).first<{ n: number }>())!.n).toBe(0);
  });

  it("two requests for codes at the same moment both succeed, with different labels", async () => {
    const DB = interleave(async () => {
      expect((await admin("/admin/api/codes", { body: { role: "teacher", count: 3 } })).status).toBe(200);
    });
    const late = await admin("/admin/api/codes", { body: { role: "teacher", count: 3 }, env: { DB } });
    expect(late.status).toBe(200);
    const made = ((await late.json()) as { codes: { label: string; code: string }[] }).codes;
    expect(made).toHaveLength(3);
    const all = await env.DB.prepare("SELECT label FROM voters WHERE role = 'teacher'").all<{ label: string }>();
    expect(new Set(all.results.map((x) => x.label)).size).toBe(all.results.length);
    // Each code returned signs in as the label it came with.
    for (const m of made) {
      const r = await call("/api/redeem", { body: { code: m.code, turnstileToken: "tok" } });
      expect(r.status).toBe(200);
    }
  });

  it("/api/me tells a round still to open from voting that has ended", async () => {
    await openNewRound();
    const v = await voter("judge");
    expect(await json(call("/api/me", { cookie: v.cookie }))).toMatchObject({ open: true, ended: false });
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
    await env.DB.prepare("DELETE FROM rounds WHERE state = 'draft'").run();
    expect(await json(call("/api/me", { cookie: v.cookie }))).toMatchObject({ open: false, ended: true });
    await admin("/admin/api/rounds", { body: { name: "Waiting", itemSetId: ITEM_SET } });
    expect(await json(call("/api/me", { cookie: v.cookie }))).toMatchObject({ open: false, ended: false });
  });

  it("reads a batch's answers by index, not by scanning the vote log", async () => {
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id, batch_pair_id, winner_q, close_call FROM votes_effective WHERE batch_pair_id IN (?, ?)").bind("a", "b").all<{ detail: string }>();
    const text = plan.results.map((r) => r.detail).join(" | ");
    expect(text).toMatch(/SEARCH v USING (COVERING )?INDEX/);
    expect(text).not.toMatch(/SCAN v\b/);
  });

  it("sends Turnstile the secret, the token and the visitor's address under their documented names", async () => {
    await openNewRound();
    await voter("coach");
    expect(lastSiteverify).toMatchObject({ secret: "test-turnstile-secret", response: "tok", remoteip: "203.0.113.7" });
    expect(Object.keys(lastSiteverify!).sort()).toEqual(["remoteip", "response", "secret"]);
  });

  it("every response carries the exact content policy, HSTS and the other fixed headers", async () => {
    expect(CSP).toBe(
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    for (const path of ["/api/config", "/api/me", "/api/nope"]) {
      const h = (await call(path)).headers;
      expect(h.get("content-security-policy")).toBe(CSP);
      expect(h.get("strict-transport-security")).toBe("max-age=31536000");
      expect(h.get("x-content-type-options")).toBe("nosniff");
      expect(h.get("x-frame-options")).toBe("DENY");
      expect(h.get("referrer-policy")).toBe("no-referrer");
      expect(h.get("cache-control")).toBe("no-store");
    }
  });
});
