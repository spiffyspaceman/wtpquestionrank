// Reason pills (owner decision, 25 Nov 2026), the home page's resume state, and the admin study health panel.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REASONS } from "../../src/worker/reasons";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";

const db = () => env.DB;

/** Reasons stored for one pair (storage is shared by the tests in a file). */
async function reasonsFor(pairId: string): Promise<string[]> {
  const r = await db()
    .prepare("SELECT x.reason FROM vote_reasons x JOIN votes v ON v.id = x.vote_id WHERE v.batch_pair_id = ? ORDER BY x.reason")
    .bind(pairId)
    .all<{ reason: string }>();
  return r.results.map((x) => x.reason);
}

describe("reasons on a vote", () => {
  beforeEach(() => mockOutbound());

  it("stores up to two known codes with the vote, and exports them", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const r = await call("/api/vote", { cookie: v.cookie, body: { pairId: b.pairs[0].pairId, pick: "R", reasons: ["source", "position", "source"] } });
    expect(r.status).toBe(200);
    expect(await reasonsFor(b.pairs[0].pairId)).toEqual(["position", "source"]);

    const csv = await (await admin(`/admin/api/rounds/${round}/export/reasons.csv`)).text();
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("vote_id,created_at,label,voter_id,role,is_repeat,left_q,right_q,winner_q,close_call,reason,note");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/,position,$/);
  });

  it("refuses unknown codes, free text and more than two, and writes nothing", async () => {
    await openNewRound();
    const v = await voter("coach");
    const b = await getBatch(v.cookie);
    const pairId = b.pairs[0].pairId;
    for (const reasons of [["nice wording"], ["position", "source", "current"], "position", [1]]) {
      const r = await call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "L", reasons } });
      expect(r.status).toBe(400);
    }
    expect(await db().prepare("SELECT 1 FROM votes WHERE batch_pair_id = ?").bind(pairId).first()).toBeNull();
    expect(await reasonsFor(pairId)).toEqual([]);
  });

  it("a double submit keeps the first vote's reasons only", async () => {
    await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const pairId = b.pairs[0].pairId;
    await call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "L", reasons: ["current"] } });
    const again = await json(call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "R", reasons: ["followup"] } }));
    expect(again.duplicate).toBe(true);
    expect(await reasonsFor(pairId)).toEqual(["current"]);
  });

  it("writes no reason when the round froze before the vote", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const before = (await db().prepare("SELECT count(*) AS n FROM vote_reasons").first<{ n: number }>())?.n;
    await admin(`/admin/api/rounds/${round}/freeze`, { body: {} });
    const r = await call("/api/vote", { cookie: v.cookie, body: { pairId: b.pairs[0].pairId, pick: "L", reasons: ["position"] } });
    expect(r.status).toBe(409);
    expect((await db().prepare("SELECT count(*) AS n FROM vote_reasons").first<{ n: number }>())?.n).toBe(before);
  });

  it("the migration's CHECK lists exactly the codes the Worker accepts", async () => {
    const sql = (await db().prepare("SELECT sql FROM sqlite_schema WHERE name = 'vote_reasons'").first<{ sql: string }>())!.sql;
    const inCheck = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual(REASONS.map((r) => r.code).sort());
  });
});

describe("the Other reason", () => {
  beforeEach(() => mockOutbound());

  async function otherNote(pairId: string): Promise<string | null> {
    const r = await db()
      .prepare("SELECT x.note FROM vote_other x JOIN votes v ON v.id = x.vote_id WHERE v.batch_pair_id = ?")
      .bind(pairId)
      .first<{ note: string }>();
    return r?.note ?? null;
  }

  it("stores a cleaned note of up to 20 words with one listed reason, and exports it safely", async () => {
    const round = await openNewRound();
    const v = await voter("student");
    const b = await getBatch(v.cookie);
    const [p1, p2, p3] = b.pairs.map((p) => p.pairId);
    let r = await call("/api/vote", { cookie: v.cookie, body: { pairId: p1, pick: "L", reasons: ["current"], other: "  Clearer\n bullets,   less\u0000 jargon " } });
    expect(r.status).toBe(200);
    expect(await otherNote(p1)).toBe("Clearer bullets, less jargon");
    expect(await reasonsFor(p1)).toEqual(["current"]);
    // "Other" with no words is still a choice.
    r = await call("/api/vote", { cookie: v.cookie, body: { pairId: p2, pick: "R", other: "" } });
    expect(r.status).toBe(200);
    expect(await otherNote(p2)).toBe("");
    // A note that a spreadsheet would read as a formula is exported as text.
    await call("/api/vote", { cookie: v.cookie, body: { pairId: p3, pick: "R", other: "=1+1 better" } });

    const csv = await (await admin(`/admin/api/rounds/${round}/export/reasons.csv`)).text();
    expect(csv).toContain(',other,"Clearer bullets, less jargon"');
    expect(csv).toContain(",other,'=1+1 better");
    expect(csv).not.toMatch(/,other,=/);

    const h = await json(admin(`/admin/api/rounds/${round}/health`));
    expect(h.reasons.notes.map((n: { note: string }) => n.note)).toEqual(["=1+1 better", "Clearer bullets, less jargon"]);
    expect(h.reasons.counts.find((c: { reason: string }) => c.reason === "other").n).toBe(3);
  });

  it("refuses more than 20 words, a non-string, and Other on top of two listed reasons", async () => {
    await openNewRound();
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    const pairId = b.pairs[0].pairId;
    const long = Array.from({ length: 21 }, (_, i) => "w" + i).join(" ");
    for (const body of [
      { other: long },
      { other: 42 },
      { other: "x".repeat(201) },
      { reasons: ["position", "source"], other: "also this" },
    ]) {
      const r = await call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "L", ...body } });
      expect(r.status).toBe(400);
    }
    expect(await db().prepare("SELECT 1 FROM votes WHERE batch_pair_id = ?").bind(pairId).first()).toBeNull();
    const ok = await call("/api/vote", { cookie: v.cookie, body: { pairId, pick: "L", other: Array.from({ length: 20 }, () => "fine").join(" ") } });
    expect(ok.status).toBe(200);
  });
});

describe("home page state", () => {
  beforeEach(() => mockOutbound());

  it("/api/me reports a part-done batch, and nothing once it is finished", async () => {
    await openNewRound();
    const v = await voter("judge");
    expect((await json(call("/api/me", { cookie: v.cookie }))).batch).toBeNull();
    const b = await getBatch(v.cookie);
    for (const p of b.pairs.slice(0, 3)) await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "L" } });
    const me = await json(call("/api/me", { cookie: v.cookie }));
    expect(me.batch).toEqual({ size: 10, remaining: 7 });
    expect(me.votes).toBe(3);
    for (const p of b.pairs.slice(3)) await call("/api/vote", { cookie: v.cookie, body: { pairId: p.pairId, pick: "R" } });
    expect((await json(call("/api/me", { cookie: v.cookie }))).batch).toBeNull();
  });
});

describe("study health", () => {
  beforeEach(() => mockOutbound());

  it("reports the data gate, votes per day, reasons and rater flags", async () => {
    const round = await openNewRound();
    const fast = await voter("judge");
    const steady = await voter("coach");
    const kid = await voter("student");
    // 20 left picks with no timing beyond the server's own (tests run in well under 20 s): fast and one-sided.
    await voteN(fast.cookie, 20, () => "L");
    await voteN(steady.cookie, 5, (_p, k) => (k % 2 ? "L" : "R"));
    await voteN(kid.cookie, 3);
    const b = await getBatch(steady.cookie);
    await call("/api/vote", { cookie: steady.cookie, body: { pairId: b.pairs[0].pairId, pick: "L", reasons: ["position", "current"] } });

    const h = await json(admin(`/admin/api/rounds/${round}/health`));
    expect(h.gate.countedAdultRaters).toBe(1);
    expect(h.gate.MIN_ADULT_RATERS).toBe(15);
    expect(h.gate.passed).toBe(false);
    expect(h.gate.items).toBe(36);
    expect(h.gate.adultVotes).toBeGreaterThanOrEqual(26);
    // One day's worth, or two when the run crosses midnight UTC: the days hold every vote between them.
    expect([1, 2]).toContain(h.perDay.length);
    expect(h.perDay.reduce((s: number, d: { votes: number }) => s + d.votes, 0)).toBe(h.reasons.votes);
    if (h.perDay.length === 1) expect(h.perDay[0].voters).toBe(3);
    expect(h.reasons.votesWithReason).toBe(1);
    expect(h.reasons.counts.map((x: { reason: string }) => x.reason).sort()).toEqual(["current", "position"]);

    const byLabel = new Map(h.raters.map((r: { label: string }) => [r.label, r]));
    const f = byLabel.get(fast.label) as { flags: string[]; votes: number };
    expect(f.votes).toBe(20);
    expect(f.flags).toEqual(["too_fast", "one_side"]);
    expect((byLabel.get(steady.label) as { flags: string[] }).flags).toEqual([]); // under 20 votes: never flagged
    // No §7 measure (repeat agreement, split-half, correlation) is shown before the analysis runs.
    expect(JSON.stringify(h)).not.toMatch(/agree|spearman|rho|splitHalf/i);
  });

  it("leaves revoked codes out", async () => {
    const round = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 4);
    await admin("/admin/api/codes/revoke", { body: { label: v.label } });
    const h = await json(admin(`/admin/api/rounds/${round}/health`));
    expect(h.raters).toHaveLength(0);
    expect(h.perDay).toHaveLength(0);
  });
});
