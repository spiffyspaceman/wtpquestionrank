// BUILD_STEPS §6.4 and §6.5: batches never carry question ids; votes are safe against double submits,
// other voters' pairs and frozen rounds; pair_counts equals a rebuild from the log.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter, type ClientPair } from "./helpers";
import itemsRaw from "../../items/launch_items_v1.json?raw";

const items: { id: string; cycle: string; unit: number; source: string }[] = JSON.parse(itemsRaw).items;

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

/** A stable preference so votes are not all "L". */
const prefer = (p: ClientPair): "L" | "R" => (p.left.stem.length % 7 >= p.right.stem.length % 7 ? "L" : "R");

async function pairCountsTable(): Promise<string[]> {
  const r = await env.DB.prepare("SELECT round_id, pool, left_q, right_q, left_wins, n FROM pair_counts ORDER BY 1,2,3,4").all();
  return r.results.map((x) => JSON.stringify(x));
}

describe("batches", () => {
  beforeEach(() => mockOutbound());

  it("hand out ten pairs with stems and bullets only: no question ids, cycle, unit or source", async () => {
    await openNewRound();
    const v = await voter("judge");
    const res = await call("/api/batch", { cookie: v.cookie });
    const text = await res.text();
    const b = JSON.parse(text);
    expect(b.pairs).toHaveLength(10);
    expect([...keysOf(b)].sort()).toEqual(["bullets", "done", "left", "pairId", "pairs", "right", "size", "stem"]);
    for (const it of items) {
      expect(text).not.toContain(it.id);
      expect(text).not.toContain(it.source);
    }
    expect(text).not.toMatch(/"(cycle|unit|level|qnum|q|val_id|left_q|right_q|reason|is_repeat)"/);
    for (const p of b.pairs) {
      expect(p.pairId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(p.left.stem).not.toBe(p.right.stem);
      expect(p.left.bullets.length).toBeGreaterThan(0);
    }
  });

  it("return the same unfinished batch until every pair is answered", async () => {
    await openNewRound();
    const v = await voter("coach");
    const a = await getBatch(v.cookie);
    const b = await getBatch(v.cookie);
    expect(b.pairs.map((p) => p.pairId)).toEqual(a.pairs.map((p) => p.pairId));
    for (const p of a.pairs.slice(0, 3)) await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    await call("/api/skip", { cookie: v.cookie, body: { pairId: a.pairs[3].pairId, clientMs: 1000 } });
    const c = await getBatch(v.cookie);
    expect(c.pairs.map((p) => p.pairId)).toEqual(a.pairs.slice(4).map((p) => p.pairId));
    expect(c.size).toBe(10);
  });

  it("add one swapped repeat per batch once 20 trials are behind the voter, and never otherwise repeat a pair", async () => {
    await openNewRound();
    const v = await voter("judge");
    const seen = new Map<string, number>(); // "leftStem||rightStem" -> batch number
    let repeats = 0;
    for (let batch = 1; batch <= 6; batch++) {
      const b = await getBatch(v.cookie);
      expect(b.pairs).toHaveLength(10);
      let inBatch = 0;
      for (const p of b.pairs) {
        const fwd = `${p.left.stem}||${p.right.stem}`;
        const rev = `${p.right.stem}||${p.left.stem}`;
        if (seen.has(rev) || seen.has(fwd)) {
          // Only a repeat, only with sides swapped, only after 20 trials.
          expect(seen.has(rev)).toBe(true);
          expect(batch).toBeGreaterThanOrEqual(3);
          inBatch++;
        } else seen.set(fwd, batch);
        await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: prefer(p), clientMs: 30_000 } });
      }
      expect(inBatch).toBe(batch >= 3 ? 1 : 0);
      repeats += inBatch;
    }
    expect(repeats).toBe(4);
    const dup = await env.DB.prepare(
      `SELECT item_lo, item_hi, count(*) AS n FROM votes WHERE voter_id = (SELECT id FROM voters WHERE label = ?)
        GROUP BY item_lo, item_hi HAVING n > 2 OR (n = 2 AND SUM(is_repeat) <> 1)`,
    )
      .bind(v.label)
      .all();
    expect(dup.results).toEqual([]);
  });

  it("refuse when no round is open", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    await admin(`/admin/api/rounds/${id}/freeze`, { body: {} });
    const r = await call("/api/batch", { cookie: v.cookie });
    expect(r.status).toBe(409);
  });
});

describe("votes", () => {
  beforeEach(() => mockOutbound());

  it("record the winner, timings and role; a double submit is harmless", async () => {
    await openNewRound();
    const v = await voter("alumni");
    const b = await getBatch(v.cookie);
    const p = b.pairs[0];
    const before = await pairCountsTable();
    const first = await json(call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "R", closeCall: true, clientMs: 41_000 } }));
    expect(first).toMatchObject({ ok: true, votes: 1, remaining: 9 });
    const afterFirst = await pairCountsTable();
    expect(afterFirst.length).toBeGreaterThan(before.length);
    const second = await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L", closeCall: false, clientMs: 1 } });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true, votes: 1 });
    expect(await pairCountsTable()).toEqual(afterFirst);
    const rows = await env.DB.prepare("SELECT * FROM votes WHERE batch_pair_id = ?").bind(p.pairId).all<Record<string, any>>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0];
    expect(row.winner_q).toBe(row.right_q);
    expect(row.close_call).toBe(1);
    expect(row.client_ms).toBe(41_000);
    expect(row.server_ms).toBeGreaterThanOrEqual(0);
    expect(row.role).toBe("alumni");
    expect(row.after_board).toBe(0);
    expect(row.is_repeat).toBe(0);
  });

  it("a pair from another voter's batch is refused", async () => {
    await openNewRound();
    const a = await voter("judge");
    const b = await voter("judge");
    const pa = (await getBatch(a.cookie)).pairs[0];
    const r = await call("/api/vote", { cookie: b.cookie, body: { pairId: pa.pairId, pick: "L" } });
    expect(r.status).toBe(404);
    const s = await call("/api/skip", { cookie: b.cookie, body: { pairId: pa.pairId } });
    expect(s.status).toBe(404);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE batch_pair_id = ?").bind(pa.pairId).first<any>()).n).toBe(0);
  });

  it("a vote in a frozen round is refused", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    const p = (await getBatch(v.cookie)).pairs[0];
    await admin(`/admin/api/rounds/${id}/freeze`, { body: {} });
    const r = await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error).toBe("round_not_open");
  });

  it("bad picks and oversized bodies are refused", async () => {
    await openNewRound();
    const v = await voter("judge");
    const p = (await getBatch(v.cookie)).pairs[0];
    expect((await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "left" } })).status).toBe(400);
    expect((await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L", pad: "x".repeat(3000) } })).status).toBe(413);
    expect((await call("/api/vote", { body: { pairId: p.pairId, pick: "L" } })).status).toBe(401);
  });

  it("a skipped pair is not offered again and does not count as a vote", async () => {
    await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const skipped = b.pairs[0];
    const r = await json(call("/api/skip", { cookie: v.cookie, body: { pairId: skipped.pairId, clientMs: 2000 } }));
    expect(r.votes).toBe(0);
    for (const p of b.pairs.slice(1)) await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    const key = `${skipped.left.stem}||${skipped.right.stem}`;
    for (let k = 0; k < 2; k++) {
      const next = await getBatch(v.cookie);
      for (const p of next.pairs) {
        expect([`${p.left.stem}||${p.right.stem}`, `${p.right.stem}||${p.left.stem}`]).not.toContain(key);
        await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "R" } });
      }
    }
  });

  it("pair_counts matches a rebuild from votes after a scripted session of 50 votes", async () => {
    const id = await openNewRound();
    const judge = await voter("judge");
    const student = await voter("student");
    const coach = await voter("coach");
    expect(await voteN(judge.cookie, 20, prefer)).toBe(20);
    expect(await voteN(student.cookie, 15, prefer)).toBe(15);
    expect(await voteN(coach.cookie, 15, () => "R")).toBe(15);
    const live = await pairCountsTable();
    const pools = new Set(live.map((r) => JSON.parse(r)).filter((r) => r.round_id === id).map((r) => r.pool));
    expect([...pools].sort()).toEqual(["adults", "all", "coach", "judge", "student"]);
    const n = (await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE round_id = ?").bind(id).first<any>()).n;
    expect(n).toBe(50);
    expect((await admin(`/admin/api/rounds/${id}/rebuild`, { body: {} })).status).toBe(200);
    expect(await pairCountsTable()).toEqual(live);
    // Students are not in the adults pool; repeats never enter the counts.
    const sums = await env.DB.prepare("SELECT pool, SUM(n) AS n FROM pair_counts WHERE round_id = ? GROUP BY pool").bind(id).all<any>();
    const by = Object.fromEntries(sums.results.map((r) => [r.pool, r.n]));
    const firsts = (await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE round_id = ? AND is_repeat = 0").bind(id).first<any>()).n;
    expect(by.all).toBe(firsts);
    expect(by.adults).toBe(by.judge + by.coach);
  });

  it("revoking a voter takes their votes out of the counts, matching a rebuild", async () => {
    const id = await openNewRound();
    const a = await voter("judge");
    const b = await voter("judge");
    await voteN(a.cookie, 10, prefer);
    await voteN(b.cookie, 10, () => "L");
    await admin("/admin/api/codes/revoke", { body: { label: b.label } });
    const after = await pairCountsTable();
    const total = (await env.DB.prepare("SELECT SUM(n) AS n FROM pair_counts WHERE round_id = ? AND pool = 'all'").bind(id).first<any>()).n;
    expect(total).toBe(10);
    await admin(`/admin/api/rounds/${id}/rebuild`, { body: {} });
    expect(await pairCountsTable()).toEqual(after);
    // The log keeps every vote.
    expect((await env.DB.prepare("SELECT count(*) AS n FROM votes WHERE round_id = ?").bind(id).first<any>()).n).toBe(20);
  });
});
