// Fixes from the audit of 25 Nov 2026 (docs/AUDIT_2026-11-25.md).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/worker/env";
import app from "../../src/worker/index";
import { chunks, MAX_BOUND } from "../../src/worker/util";
import { BACKUP_TABLES } from "../../src/worker/admin";
import { admin, call, getBatch, HOST, json, makeCodes, mockOutbound, openNewRound, ORIGIN, sessionCookie, voteN, voter } from "./helpers";

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

  it("a vote from before the leaderboard keeps its answer once the voter has opened it; later votes can still change", async () => {
    const round = await openNewRound();
    const v = await voter("coach");
    const [p0, p1, p2] = (await getBatch(v.cookie)).pairs;
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "L" } });
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p1.pairId, pick: "L" } });
    expect((await call("/api/correct", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "R" } })).status).toBe(200);
    const pause = () => new Promise((r) => setTimeout(r, 15));
    await pause();
    await env.DB.prepare("INSERT INTO round_board_seen (voter_id, round_id, seen_at) SELECT id, ?, ? FROM voters WHERE label = ?")
      .bind(round, new Date().toISOString(), v.label)
      .run();
    await pause();

    // Before-the-board votes are now fixed: nothing is appended and the cache does not move.
    const refused = await call("/api/correct", { cookie: v.cookie, body: { pairId: p1.pairId, pick: "R" } });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe("board_seen");
    const eff = await env.DB.prepare("SELECT winner_q = left_q AS l, correction_id FROM votes_effective WHERE batch_pair_id = ?").bind(p1.pairId).first();
    expect(eff).toEqual({ l: 1, correction_id: null });

    // A vote cast after the board is marked after_board = 1 and can still be changed within its batch.
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p2.pairId, pick: "L" } });
    expect((await call("/api/correct", { cookie: v.cookie, body: { pairId: p2.pairId, pick: "R" } })).status).toBe(200);

    const rows = (await (await admin(`/admin/api/rounds/${round}/export/corrections.csv`)).text()).trim().split(/\r?\n/);
    expect(rows[0].endsWith(",vote_after_board,correction_after_board")).toBe(true);
    expect(rows.slice(1).map((r) => r.split(",").slice(-2).join(","))).toEqual(["0,0", "1,1"]);
    const snap = async () => (await env.DB.prepare("SELECT pool, left_q, right_q, left_wins, n FROM pair_counts WHERE round_id = ? ORDER BY 1,2,3").bind(round).all()).results;
    const before = await snap();
    await admin(`/admin/api/rounds/${round}/rebuild`, { body: {} });
    expect(await snap()).toEqual(before);
  });
});

describe("sign out", () => {
  beforeEach(() => mockOutbound());

  it("ends this device's session only, and clears the cookie", async () => {
    await openNewRound();
    const [c] = await makeCodes("judge");
    const signIn = async () => sessionCookie(await call("/api/redeem", { body: { code: c.code, turnstileToken: "tok" } }));
    const a = await signIn(), b = await signIn();
    const out = await call("/api/signout", { cookie: a, body: {} });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-wtpqr=;.*Max-Age=0/);
    expect((await call("/api/me", { cookie: a })).status).toBe(401);
    expect((await call("/api/me", { cookie: b })).status).toBe(200);
    // No session at all is not an error, and a foreign Origin is still refused.
    expect((await call("/api/signout", { body: {} })).status).toBe(200);
    expect((await call("/api/signout", { cookie: b, body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/me", { cookie: b })).status).toBe(200);
  });
});

describe("admin: backup, invitation tracker, gate forecast", () => {
  beforeEach(() => mockOutbound());

  it("the backup pages through every listed table and holds no hash or session", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 12);
    const head = await json(admin("/admin/api/backup"));
    expect(head.tables.map((t: { name: string }) => t.name)).toEqual(Object.keys(BACKUP_TABLES));
    const all: Record<string, Record<string, unknown>[]> = {};
    for (const t of head.tables as { name: string; rows: number }[]) {
      const rows: Record<string, unknown>[] = [];
      let after = 0;
      for (;;) {
        const page = await json(admin(`/admin/api/backup/${t.name}?after=${after}`));
        rows.push(...page.rows);
        if (page.next === null) break;
        after = page.next;
      }
      expect(rows.length, t.name).toBe(t.rows);
      all[t.name] = rows;
    }
    expect(all.votes.filter((x) => x.round_id === round)).toHaveLength(12);
    expect(all.batch_pairs.length).toBeGreaterThanOrEqual(20);
    expect(all.batches.some((b) => typeof b.seed === "number")).toBe(true);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/code_hash|token_hash|key_hash|_rowid/);
    for (const t of ["sessions", "attempts", "pair_counts", "rating_snapshots", "sqlite_master", "votes; DROP TABLE votes"])
      expect((await admin(`/admin/api/backup/${encodeURIComponent(t)}`)).status, t).toBe(404);
    // A backup quiets the export reminder, as the JSON export does.
    expect((await json(admin("/admin/api/status"))).exportOverdue).toBe(false);
  });

  it("the voter list says who has signed in and how far each is from the unlock", async () => {
    await openNewRound();
    const v = await voter("judge");
    const [unused] = await makeCodes("coach");
    await voteN(v.cookie, 7);
    const r = await json(admin("/admin/api/codes"));
    expect(r.unlockAt).toBe(10);
    const row = (label: string) => r.voters.find((x: { label: string }) => x.label === label);
    expect(row(v.label).round_votes).toBe(7);
    expect(row(v.label).signed_in_at).toBeTruthy();
    expect(row(v.label).last_vote_at).toBeTruthy();
    expect(row(unused.label).round_votes).toBe(0);
    expect(row(unused.label).signed_in_at).toBeNull();
  });

  it("study health forecasts the gate from counts alone", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 10);
    const f = (await json(admin(`/admin/api/rounds/${round}/health`))).forecast;
    // 36 items need 30 adult comparisons each: 1,080, of which 20 are in. At least (1080 - 20) / 2 votes remain.
    expect(f.adultVotesNeeded).toBe(530);
    expect(f.itemsShort).toHaveLength(12);
    expect(f.itemsShort[0].games).toBeLessThanOrEqual(f.itemsShort[11].games);
    // Ten votes on one day; if the run crossed midnight UTC they fall on two days and the pace halves.
    expect([10, 5]).toContain(f.adultVotesPerDay);
    expect(f.daysAtThisPace).toBe(f.adultVotesPerDay === 10 ? 53 : 106);
    expect(f.ratersShort).toBe(15);
    expect(f.adultsUnderThreshold).toBe(1);
    expect(f.adultVotesToThreshold).toBe(10);
  });
});
