// Fixes from the audit of 25 Nov 2026 (docs/AUDIT_2026-11-25.md).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/worker/env";
import app from "../../src/worker/index";
import { chunks, MAX_BOUND } from "../../src/worker/util";
import { admin, call, getBatch, HOST, json, mockOutbound, openNewRound, ORIGIN, voter } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const assets = { fetch: async () => new Response("file", { headers: { "cache-control": "public, max-age=0, must-revalidate" } }) } as unknown as Fetcher;

describe("plain http", () => {
  it("redirects reads to https and refuses writes", async () => {
    const get = await app.fetch(new Request(`http://${HOST}/start?x=1`), env as Env, ctx);
    expect(get.status).toBe(308);
    expect(get.headers.get("location")).toBe(`https://${HOST}/start?x=1`);
    const post = await app.fetch(
      new Request(`http://${HOST}/api/redeem`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }),
      env as Env,
      ctx,
    );
    expect(post.status).toBe(400);
    expect(await post.json()).toEqual({ error: "https_required" });
  });
});

describe("cache headers on static files", () => {
  it("hashed build files are immutable, fonts are kept a month, pages still revalidate", async () => {
    const get = (path: string) => call(path, { env: { ASSETS: assets } });
    expect((await get("/assets/vote-abc123.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await get("/fonts/wtpqr-schola-regular.woff2")).headers.get("cache-control")).toBe("public, max-age=2592000");
    expect((await get("/vote")).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("a missing build file is not cached", async () => {
    const missing = { fetch: async () => new Response(null, { status: 404 }) } as unknown as Fetcher;
    expect((await call("/assets/nope.js", { env: { ASSETS: missing } })).headers.get("cache-control")).toBeNull();
  });
});

describe("more than 100 questions", () => {
  beforeEach(() => mockOutbound());

  it("chunks stay under D1's 100 bound parameters", () => {
    const parts = chunks(Array.from({ length: 420 }, (_, i) => i));
    expect(parts.every((p) => p.length <= MAX_BOUND && p.length < 100)).toBe(true);
    expect(parts.flat()).toHaveLength(420);
    expect(chunks([])).toEqual([]);
  });

  it("an item file of 130 questions loads, and loads again unchanged", async () => {
    const items = Array.from({ length: 130 }, (_, i) => ({
      id: `big-${String(i).padStart(3, "0")}`, level: "State", cycle: "2020-21", unit: (i % 6) + 1, q: (i % 3) + 1, published: true,
      stem: `Stem ${i}?`, bullets: ["One?", "Two?"], source: "test",
    }));
    const raw = JSON.stringify({ item_set: "big-test", version: 1, items });
    const load = () => admin("/admin/api/items", { raw, headers: { "content-type": "application/octet-stream" } });
    expect((await json(load())).n).toBe(130);
    expect((await json(load())).already).toBe(true);
    // A different file under the same name is checked against all 130 stored texts.
    const changed = JSON.stringify({ item_set: "big-test", version: 2, items: items.map((x, i) => (i === 129 ? { ...x, stem: "Changed?" } : x)) });
    const r = await admin("/admin/api/items", { raw: changed, headers: { "content-type": "application/octet-stream" } });
    expect(r.status).toBe(409);
    expect((await r.json() as { ids: string[] }).ids).toEqual(["big-129"]);
  });
});

describe("corrections, audit fixes", () => {
  beforeEach(() => mockOutbound());

  it("two corrections of one vote at the same moment leave the cache equal to a rebuild", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const [p] = (await getBatch(v.cookie)).pairs;
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    for (let k = 0; k < 4; k++) {
      // One changes the winner; the other keeps the winner it read and changes only the close call.
      await Promise.all([
        call("/api/correct", { cookie: v.cookie, body: { pairId: p.pairId, pick: k % 2 ? "L" : "R", closeCall: false, reasons: k % 2 ? ["source"] : [] } }),
        call("/api/correct", { cookie: v.cookie, body: { pairId: p.pairId, pick: k % 2 ? "R" : "L", closeCall: true } }),
      ]);
      const snap = async () => (await env.DB.prepare("SELECT pool, left_q, right_q, left_wins, n FROM pair_counts WHERE round_id = ? ORDER BY 1,2,3").bind(round).all()).results;
      const before = await snap();
      await admin(`/admin/api/rounds/${round}/rebuild`, { body: {} });
      expect(await snap()).toEqual(before);
    }
  });

  it("corrections.csv says whether a change was made after the voter first opened the leaderboard", async () => {
    const round = await openNewRound();
    const v = await voter("coach");
    const [p0, p1] = (await getBatch(v.cookie)).pairs;
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "L" } });
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p1.pairId, pick: "L" } });
    await call("/api/correct", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "R" } });
    const pause = () => new Promise((r) => setTimeout(r, 15));
    await pause();
    await env.DB.prepare("UPDATE voters SET board_seen_at = ? WHERE label = ?").bind(new Date().toISOString(), v.label).run();
    await pause();
    await call("/api/correct", { cookie: v.cookie, body: { pairId: p1.pairId, pick: "R" } });
    const rows = (await (await admin(`/admin/api/rounds/${round}/export/corrections.csv`)).text()).trim().split(/\r?\n/);
    expect(rows[0].endsWith(",vote_after_board,correction_after_board")).toBe(true);
    expect(rows).toHaveLength(3);
    // The first change came before the board was opened (the time was set after it); the second came after.
    expect(rows.slice(1).map((r) => r.split(",").slice(-2).join(","))).toEqual(["0,0", "0,1"]);
  });
});
