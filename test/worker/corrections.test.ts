// Going back within a batch (owner decision, 25 Nov 2026): corrections are appended, never edits; the newest answer
// counts on the leaderboard and in the exports; the cache stays equal to a rebuild from the log.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";

const db = () => env.DB;

async function cache(): Promise<string[]> {
  const r = await db().prepare("SELECT round_id, pool, left_q, right_q, left_wins, n FROM pair_counts ORDER BY 1,2,3,4").all();
  return r.results.map((x) => JSON.stringify(x));
}

/** The cache must equal a fresh rebuild from the (effective) vote log. */
async function expectCacheMatchesRebuild(round: string): Promise<void> {
  const before = await cache();
  const r = await admin(`/admin/api/rounds/${round}/rebuild`, { body: {} });
  expect(r.status).toBe(200);
  expect(await cache()).toEqual(before);
}

describe("corrections", () => {
  beforeEach(() => mockOutbound());

  it("change the winner: the vote row stays, a correction is appended, and every reader sees the new answer", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const [p0, p1] = b.pairs;
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "L", reasons: ["position"] } });
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p1.pairId, pick: "R" } });

    const r = await json(call("/api/correct", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "R", closeCall: true, reasons: ["source"], other: "clearer stem" } }));
    expect(r.corrected).toBe(true);
    expect(r.votes).toBe(2);

    const orig = await db().prepare("SELECT winner_q, left_q, right_q, close_call FROM votes WHERE batch_pair_id = ?").bind(p0.pairId).first<{ winner_q: string; left_q: string; right_q: string; close_call: number }>();
    expect(orig!.winner_q).toBe(orig!.left_q); // the log is unchanged
    const eff = await db().prepare("SELECT winner_q, close_call FROM votes_effective WHERE batch_pair_id = ?").bind(p0.pairId).first<{ winner_q: string; close_call: number }>();
    expect(eff).toEqual({ winner_q: orig!.right_q, close_call: 1 });
    await expectCacheMatchesRebuild(round);

    // The batch shows the current answer, as sides, never ids.
    const again = await getBatch(v.cookie);
    expect(again.all[0].answer).toEqual({ pick: "R", closeCall: true, reasons: ["source"], other: "clearer stem" });
    expect(again.all[1].answer).toEqual({ pick: "R", closeCall: false, reasons: [], other: null });
    expect(again.start).toBe(2);

    // Exports: the JSON and votes CSV carry the corrected winner; reasons are the correction's; corrections.csv has both.
    const ex = await json(admin(`/admin/api/rounds/${round}/export.json`));
    expect(ex.votes.find((x: { left_q: string; right_q: string }) => x.left_q === orig!.left_q && x.right_q === orig!.right_q).winner_q).toBe(orig!.right_q);
    const reasons = await (await admin(`/admin/api/rounds/${round}/export/reasons.csv`)).text();
    expect(reasons).toMatch(/,source,\r\n/);
    expect(reasons).toMatch(/,other,clearer stem\r\n/);
    expect(reasons).not.toMatch(/,position,/);
    const corr = (await (await admin(`/admin/api/rounds/${round}/export/corrections.csv`)).text()).trim().split(/\r?\n/);
    expect(corr).toHaveLength(2);
    expect(corr[1]).toContain(`,${orig!.left_q},${orig!.right_q},${orig!.left_q},0,${orig!.right_q},1,`);

    // Changing it back restores the first winner; the cache follows.
    await call("/api/correct", { cookie: v.cookie, body: { pairId: p0.pairId, pick: "L" } });
    expect((await db().prepare("SELECT winner_q FROM votes_effective WHERE batch_pair_id = ?").bind(p0.pairId).first<{ winner_q: string }>())!.winner_q).toBe(orig!.left_q);
    expect((await db().prepare("SELECT count(*) AS n FROM vote_corrections").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(2);
    await expectCacheMatchesRebuild(round);

    const h = await json(admin(`/admin/api/rounds/${round}/health`));
    expect(h.corrections.rows).toBeGreaterThanOrEqual(2);
  });

  it("sending the same answer again writes nothing", async () => {
    await openNewRound();
    const v = await voter("coach");
    const b = await getBatch(v.cookie);
    const pairId = b.pairs[0].pairId;
    await call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "L", reasons: ["current", "source"] } });
    const before = (await db().prepare("SELECT count(*) AS n FROM vote_corrections").first<{ n: number }>())!.n;
    const r = await json(call("/api/correct", { cookie: v.cookie, body: { pairId, pick: "L", reasons: ["source", "current"] } }));
    expect(r.unchanged).toBe(true);
    expect((await db().prepare("SELECT count(*) AS n FROM vote_corrections").first<{ n: number }>())!.n).toBe(before);
  });

  it("a skipped pair can become a vote, which counts like any first vote", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const pairId = b.pairs[0].pairId;
    await call("/api/skip", { cookie: v.cookie, body: { pairId, clientMs: 1000 } });
    expect((await getBatch(v.cookie)).all[0].answer).toEqual({ skipped: true });
    const r = await json(call("/api/correct", { cookie: v.cookie, body: { pairId, pick: "R" } }));
    expect(r.ok).toBe(true);
    expect(r.votes).toBe(1);
    expect((await getBatch(v.cookie)).all[0].answer).toMatchObject({ pick: "R" });
    expect(await db().prepare("SELECT 1 FROM skips WHERE batch_pair_id = ?").bind(pairId).first()).not.toBeNull(); // the skip stays in the log
    await expectCacheMatchesRebuild(round);
  });

  it("refuses answers in a finished batch once the next batch has started, and other voters' pairs", async () => {
    await openNewRound();
    const v = await voter("judge");
    const first = await getBatch(v.cookie);
    await voteN(v.cookie, 10);
    await getBatch(v.cookie); // starts the next batch
    const r = await call("/api/correct", { cookie: v.cookie, body: { pairId: first.all[0].pairId, pick: "R" } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("batch_closed");

    const w = await voter("coach");
    const theirs = await getBatch(w.cookie);
    const x = await call("/api/correct", { cookie: v.cookie, body: { pairId: theirs.pairs[0].pairId, pick: "R" } });
    expect(x.status).toBe(404);
  });

  it("writes nothing once the round is frozen", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const pairId = b.pairs[0].pairId;
    await call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "L" } });
    const before = await cache();
    await admin(`/admin/api/rounds/${round}/freeze`, { body: {} });
    const r = await call("/api/correct", { cookie: v.cookie, body: { pairId, pick: "R" } });
    expect(r.status).toBe(409);
    expect(await cache()).toEqual(before);
    expect(await db().prepare("SELECT 1 FROM vote_corrections c JOIN votes v ON v.id = c.vote_id WHERE v.batch_pair_id = ?").bind(pairId).first()).toBeNull();
  });

  it("the correction tables are append-only and the winner must be one of the pair", async () => {
    await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    await call("/api/vote", { cookie: v.cookie, body: { pairId: b.pairs[0].pairId, pick: "L" } });
    const vote = await db().prepare("SELECT id FROM votes WHERE batch_pair_id = ?").bind(b.pairs[0].pairId).first<{ id: number }>();
    const bad = await db()
      .prepare("INSERT INTO vote_corrections (token, vote_id, winner_q, close_call, created_at) VALUES ('t-bad', ?, 'not-in-pair', 0, 'x')")
      .bind(vote!.id)
      .run()
      .catch((e: Error) => e.message);
    expect(String(bad)).toMatch(/one of the pair/);
    await call("/api/correct", { cookie: v.cookie, body: { pairId: b.pairs[0].pairId, pick: "R", reasons: ["source"], other: "x" } });
    for (const sql of [
      "UPDATE vote_corrections SET close_call = 1",
      "DELETE FROM vote_corrections",
      "UPDATE correction_reasons SET reason = 'current'",
      "DELETE FROM correction_reasons",
      "UPDATE correction_other SET note = 'y'",
      "DELETE FROM correction_other",
    ]) {
      const m = await db().prepare(sql).run().then(() => "ran").catch((e: Error) => e.message);
      expect(m, sql).toMatch(/append-only/);
    }
  });
});
