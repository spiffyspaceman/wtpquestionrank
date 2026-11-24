// BUILD_STEPS §6.6: the leaderboard is 404 without a session, locked under 20 first votes, and never shows a pool
// the voter may not see.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";
import itemsRaw from "../../items/launch_items_v1.json?raw";

const ids: string[] = JSON.parse(itemsRaw).items.map((i: { id: string }) => i.id);

describe("leaderboard", () => {
  beforeEach(() => mockOutbound());

  it("is 404 without a session, with noindex", async () => {
    const r = await call("/api/leaderboard");
    expect(r.status).toBe(404);
    expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("is locked under 20 first-presentation votes", async () => {
    await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 19);
    const r = await call("/api/leaderboard", { cookie: v.cookie });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "locked", votes: 19, unlockAt: 20 });
    expect((await json(call("/api/me", { cookie: v.cookie }))).unlocked).toBe(false);
  });

  it("unlocks at 20; shows the adults board and the voter's own role only; never sends question ids", async () => {
    await openNewRound();
    const v = await voter("coach");
    await voteN(v.cookie, 20);
    expect((await json(call("/api/me", { cookie: v.cookie }))).unlocked).toBe(true);
    const r = await call("/api/leaderboard", { cookie: v.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
    const text = await r.text();
    const b = JSON.parse(text);
    expect(b.pool).toBe("adults");
    expect(b.pools.map((p: { id: string }) => p.id)).toEqual(["adults", "coach"]);
    expect(b.rows).toHaveLength(36);
    for (const id of ids) expect(text).not.toContain(id);
    // Ranks only at 10 or more games.
    for (const row of b.rows) {
      if (row.games < 10) expect(row.rank).toBeNull();
      else expect(row.rank).toBeGreaterThan(0);
    }
    expect((await call("/api/leaderboard?pool=coach", { cookie: v.cookie })).status).toBe(200);
    for (const pool of ["judge", "student", "all", "teacher", "nonsense"])
      expect((await call(`/api/leaderboard?pool=${pool}`, { cookie: v.cookie })).status).toBe(403);
  });

  it("students see their own board and the adults board, and their votes stay out of the adults board", async () => {
    const id = await openNewRound();
    const s = await voter("student");
    await voteN(s.cookie, 20);
    const own = await json(call("/api/leaderboard?pool=student", { cookie: s.cookie }));
    expect(own.votes).toBe(20);
    const adults = await json(call("/api/leaderboard?pool=adults", { cookie: s.cookie }));
    expect(adults.votes).toBe(0);
    expect((await call("/api/leaderboard?pool=judge", { cookie: s.cookie })).status).toBe(403);
    void id;
  });

  it("records the first view, and every later vote carries after_board = 1", async () => {
    await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    await call("/api/leaderboard", { cookie: v.cookie });
    const seen = await env.DB.prepare("SELECT board_seen_at FROM voters WHERE label = ?").bind(v.label).first<{ board_seen_at: string }>();
    expect(seen?.board_seen_at).toBeTruthy();
    await voteN(v.cookie, 3);
    const flags = await env.DB.prepare(
      "SELECT after_board FROM votes WHERE voter_id = (SELECT id FROM voters WHERE label = ?) ORDER BY id",
    )
      .bind(v.label)
      .all<{ after_board: number }>();
    const f = flags.results.map((x) => x.after_board);
    expect(f.slice(0, 20).every((x) => x === 0)).toBe(true);
    expect(f.slice(-3).every((x) => x === 1)).toBe(true);
    // A second view does not move the first-view time.
    await call("/api/leaderboard", { cookie: v.cookie });
    const again = await env.DB.prepare("SELECT board_seen_at FROM voters WHERE label = ?").bind(v.label).first<{ board_seen_at: string }>();
    expect(again?.board_seen_at).toBe(seen?.board_seen_at);
  });

  it("shows interval bounds once the admin saves a snapshot", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 20);
    const input = await json(admin(`/admin/api/rounds/${id}/bootstrap-input`));
    const payload = { ids: input.items, rating: input.items.map(() => 1000), ratingLo: input.items.map(() => 900), ratingHi: input.items.map(() => 1100) };
    const save = await admin(`/admin/api/rounds/${id}/snapshots`, {
      body: { snapshots: [{ pool: "adults", n_votes: 20, n_raters: 1, last_vote_id: 1, config: {}, payload }] },
    });
    expect(save.status).toBe(200);
    const b = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(b.intervalsAsOf).toBeTruthy();
    expect(b.rows.every((r: { lo: number; hi: number }) => r.lo === 900 && r.hi === 1100)).toBe(true);
  });
});
