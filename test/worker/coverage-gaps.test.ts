// Behaviours the launch audit's mutation checks found no test for (docs/AUDIT_2026-11-25_launch.md): a ranked
// leaderboard, corrected answers in the votes CSV and the paged export, the unlock count with repeats, a revoked
// voter's reasons, an Origin-less POST, an expired session, and a second page of the backup.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import itemsRaw from "../../items/launch_items_v1.json?raw";
import { admin, call, type ClientPair, getBatch, json, mockOutbound, openNewRound, quorum, voteN, voter } from "./helpers";

const items: { id: string; stem: string }[] = JSON.parse(itemsRaw).items;

describe("coverage gaps closed after the launch audit", () => {
  beforeEach(() => mockOutbound());

  it("ranks questions by rating once they have ten comparisons, strongest first", async () => {
    const round = await openNewRound();
    // A known order: of any two questions, the one whose stem comes first in the alphabet wins.
    const place = new Map([...items].sort((x, y) => (x.stem < y.stem ? -1 : 1)).map((i, k) => [i.stem, k]));
    await quorum("other");
    const v = await voter("judge");
    await voteN(v.cookie, 260, (p: ClientPair) => (place.get(p.left.stem)! < place.get(p.right.stem)! ? "L" : "R"));
    const b = await json(call("/api/leaderboard", { cookie: v.cookie }));
    const ranked = b.rows.filter((r: { rank: number | null }) => r.rank !== null);
    expect(ranked.length).toBeGreaterThanOrEqual(30);
    // Ranked rows come first, in rank order from 1, and a better rank never has a lower rating.
    expect(b.rows.slice(0, ranked.length)).toEqual(ranked);
    ranked.forEach((r: { rank: number; rating: number; games: number; wins: number }, k: number) => {
      expect(r.rank).toBe(k + 1);
      expect(r.games).toBeGreaterThanOrEqual(10);
      expect(Number.isInteger(r.rating) && Number.isInteger(r.wins)).toBe(true);
      if (k) expect(r.rating).toBeLessThanOrEqual(ranked[k - 1].rating);
    });
    // The board's order is the known order, near enough: the top is from the front of the alphabet, the bottom from
    // the back, and rank and place rise together.
    const places: number[] = ranked.map((r: { stem: string }) => place.get(r.stem)!);
    expect(places[0]).toBeLessThan(6);
    expect(places[places.length - 1]).toBeGreaterThan(29);
    const n = places.length, mean = (n - 1) / 2, mp = places.reduce((s, x) => s + x, 0) / n;
    const cov = places.reduce((s, x, k) => s + (k - mean) * (x - mp), 0);
    const corr = cov / Math.sqrt(places.reduce((s, _, k) => s + (k - mean) ** 2, 0) * places.reduce((s, x) => s + (x - mp) ** 2, 0));
    expect(corr).toBeGreaterThan(0.8);
    expect(ranked[0].wins / ranked[0].games).toBeGreaterThan(0.8);
    expect(ranked[0].rating).toBeGreaterThan(1000);
    expect(ranked[ranked.length - 1].rating).toBeLessThan(1000);
    // Unit and year averages rest on ranked questions only.
    expect(b.groups.units.reduce((s: number, g: { ranked: number }) => s + g.ranked, 0)).toBe(ranked.length);
    // A saved snapshot's ranges reach the ranked rows.
    const input = await json(admin(`/admin/api/rounds/${round}/bootstrap-input`));
    const payload = { ids: input.items, rating: input.items.map(() => 1000), ratingLo: input.items.map(() => 900), ratingHi: input.items.map(() => 1100) };
    await admin(`/admin/api/rounds/${round}/snapshots`, { body: { snapshots: [{ pool: "adults", n_votes: 1, n_raters: 1, last_vote_id: 1, config: {}, payload }] } });
    const again = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(again.rows[0]).toMatchObject({ rank: 1, lo: 900, hi: 1100 });
  });

  it("a corrected answer is the one in the votes CSV, the paged export and the JSON export", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const p = (await getBatch(v.cookie)).pairs[0];
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    await call("/api/correct", { cookie: v.cookie, body: { pairId: p.pairId, pick: "R", closeCall: true } });
    const row = await env.DB.prepare("SELECT left_q, right_q FROM votes WHERE batch_pair_id = ?").bind(p.pairId).first<{ left_q: string; right_q: string }>();
    const page = await json(admin(`/admin/api/rounds/${round}/export-votes?after=0`));
    expect(page.votes).toHaveLength(1);
    expect(page.votes[0]).toMatchObject({ winner_q: row!.right_q, close_call: 1 });
    const csv = await (await admin(`/admin/api/rounds/${round}/export/votes.csv`)).text();
    const [head, line] = csv.trim().split("\n");
    const cols = head.split(",");
    const cells = line.split(",");
    expect(cells[cols.indexOf("winner_q")]).toBe(row!.right_q);
    expect(cells[cols.indexOf("close_call")]).toBe("1");
    const full = await json(admin(`/admin/api/rounds/${round}/export.json`));
    expect(full.votes[0]).toMatchObject({ winner_q: row!.right_q, close_call: 1 });
  });

  it("a swapped repeat does not count toward the twenty votes that open the leaderboard", async () => {
    await openNewRound();
    await quorum("other");
    const v = await voter("judge");
    const key = (p: ClientPair) => [p.left.stem, p.right.stem].sort().join("|");
    const seen = new Set<string>();
    const vote = (p: ClientPair) => call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    // Batch 1: ten votes. Batch 2: ten skips, so the first pairs are now twenty trials old and a repeat is due.
    for (const p of (await getBatch(v.cookie)).pairs) (seen.add(key(p)), await vote(p));
    for (const p of (await getBatch(v.cookie)).pairs) await call("/api/skip", { cookie: v.cookie, body: { pairId: p.pairId } });
    const third = (await getBatch(v.cookie)).pairs;
    const repeat = third.find((p) => seen.has(key(p)));
    expect(repeat).toBeTruthy();
    await vote(repeat!);
    // Nine first votes in this batch: 19 first votes and one repeat, 20 votes in all.
    for (const p of third.filter((x) => x !== repeat)) await vote(p);
    const counted = await env.DB.prepare("SELECT count(*) AS n, SUM(is_repeat) AS repeats FROM votes v JOIN voters u ON u.id = v.voter_id WHERE u.label = ?").bind(v.label).first<{ n: number; repeats: number }>();
    expect(counted).toEqual({ n: 20, repeats: 1 });
    expect(await json(call("/api/me", { cookie: v.cookie }))).toMatchObject({ votes: 19, unlocked: false });
    expect((await call("/api/leaderboard", { cookie: v.cookie })).status).toBe(403);
    // The twentieth first vote opens it, and the vote's own answer says so.
    const next = (await getBatch(v.cookie)).pairs[0];
    expect(await json(vote(next))).toMatchObject({ votes: 20, unlocked: true });
    expect((await call("/api/leaderboard", { cookie: v.cookie })).status).toBe(200);
  });

  it("a revoked voter's reasons leave the leaderboard with their votes", async () => {
    await openNewRound();
    await quorum("other");
    const a = await voter("judge");
    const b = await voter("judge");
    for (const p of (await getBatch(a.cookie)).pairs) await call("/api/vote", { cookie: a.cookie, body: { pairId: p.pairId, pick: "L", reasons: ["tradeoffs"] } });
    await voteN(b.cookie, 20);
    const total = (board: { rows: { reasons: { n: number }[] }[] }) => board.rows.reduce((s, r) => s + r.reasons.reduce((t, x) => t + x.n, 0), 0);
    expect(total(await json(call("/api/leaderboard", { cookie: b.cookie })))).toBe(10);
    await admin("/admin/api/codes/revoke", { body: { label: a.label } });
    const after = await json(call("/api/leaderboard", { cookie: b.cookie }));
    expect(total(after)).toBe(0);
    expect(after.votes).toBe(22);
  });

  it("a POST without an Origin is refused as such, even with a live session; an expired session is no session", async () => {
    await openNewRound();
    const v = await voter("judge");
    const p = (await getBatch(v.cookie)).pairs[0];
    const bare = await call("/api/vote", { cookie: v.cookie, origin: null, body: { pairId: p.pairId, pick: "L" } });
    expect(bare.status).toBe(403);
    expect(await bare.json()).toMatchObject({ error: "bad_origin" });
    const other = await call("/api/vote", { cookie: v.cookie, origin: "https://example.org", body: { pairId: p.pairId, pick: "L" } });
    expect(await other.json()).toMatchObject({ error: "bad_origin" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE batch_pair_id = ?").bind(p.pairId).first<{ n: number }>())!.n).toBe(0);

    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE voter_id = (SELECT id FROM voters WHERE label = ?)").bind(new Date(Date.now() - 1000).toISOString(), v.label).run();
    expect((await call("/api/me", { cookie: v.cookie })).status).toBe(401);
    expect((await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } })).status).toBe(401);
    expect((await call("/api/leaderboard", { cookie: v.cookie })).status).toBe(404);
  });

  it("the backup pages through a table larger than one page without losing or repeating a row", async () => {
    const now = new Date().toISOString();
    for (let k = 0; k < 13; k++)
      await env.DB.batch(Array.from({ length: 80 }, (_, j) => env.DB.prepare("INSERT INTO admin_audit (at, actor, action, detail_json) VALUES (?, 'test', 'filler', ?)").bind(now, JSON.stringify({ k, j }))));
    const want = (await env.DB.prepare("SELECT count(*) AS n FROM admin_audit").first<{ n: number }>())!.n;
    expect(want).toBeGreaterThan(1000);
    const start = await json(admin("/admin/api/backup"));
    const listed = start.tables.find((t: { name: string }) => t.name === "admin_audit").rows;
    const ids: number[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await json(admin(`/admin/api/backup/admin_audit?after=${after}`));
      pages++;
      ids.push(...page.rows.map((r: { id: number }) => r.id));
      if (page.next === null) break;
      after = page.next;
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(listed);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });
});
