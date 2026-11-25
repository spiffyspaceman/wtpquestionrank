// Several rounds open at once (owner decision, 25 Nov 2026; migration 0005): the site gives each new batch to the open
// round with the fewest batches, the leaderboard flag is kept round by round, and the unlock counts votes over all rounds.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, ITEM_SET, json, loadItems, mockOutbound, quorum, voteN, voter } from "./helpers";

/** Close everything, then open `n` rounds on the launch item set. */
async function openRounds(n: number): Promise<string[]> {
  await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
  if (!(await env.DB.prepare("SELECT 1 FROM item_sets WHERE id = ?").bind(ITEM_SET).first())) await loadItems();
  const ids: string[] = [];
  for (let k = 0; k < n; k++) {
    const { id } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name: `Unit ${k + 1}, State`, itemSetId: ITEM_SET } }));
    expect((await admin(`/admin/api/rounds/${id}/open`, { body: {} })).status).toBe(200);
    ids.push(id);
  }
  return ids;
}
const roundOfBatch = async (pairId: string) =>
  (await env.DB.prepare("SELECT b.round_id FROM batch_pairs p JOIN batches b ON b.id = p.batch_id WHERE p.id = ?").bind(pairId).first<{ round_id: string }>())!.round_id;

describe("several open rounds", () => {
  beforeEach(() => mockOutbound());

  it("each new batch goes to the open round with the fewest batches, and a part-done batch is served first", async () => {
    const rounds = await openRounds(3);
    const v = await voter("judge");
    const seen: string[] = [];
    for (let k = 0; k < 6; k++) {
      const b = await getBatch(v.cookie);
      seen.push(await roundOfBatch(b.pairs[0].pairId));
      // Asking again before finishing returns the same batch, not one from another round.
      expect((await getBatch(v.cookie)).all.map((p) => p.pairId)).toEqual(b.all.map((p) => p.pairId));
      await voteN(v.cookie, b.pairs.length);
    }
    // Six batches over three rounds: two each, in rotation.
    expect(seen.slice(0, 3).sort()).toEqual([...rounds].sort());
    expect(seen.slice(3).sort()).toEqual([...rounds].sort());
    // A second voter starts where the need is: all rounds are level, so the oldest round.
    const w = await voter("coach");
    expect(await roundOfBatch((await getBatch(w.cookie)).pairs[0].pairId)).toBe(rounds[0]);
  });

  it("the voter pages get no round name, and the batch still holds only stems and bullets", async () => {
    await openRounds(2);
    const v = await voter("judge");
    const me = await (await call("/api/me", { cookie: v.cookie })).text();
    expect(me).not.toMatch(/Unit \d|State|round/i);
    expect(JSON.parse(me).open).toBe(true);
    const batch = await (await call("/api/batch", { cookie: v.cookie })).text();
    expect(batch).not.toMatch(/Unit \d, State|"(round|round_id|cycle|unit|level|qnum)"/);
  });

  it("the leaderboard opens at 20 votes over all rounds, and after_board is kept round by round", async () => {
    const rounds = await openRounds(2);
    await quorum("other", 4); // two more adults in each round: a board is shown once three stand behind it
    const v = await voter("judge");
    await voteN(v.cookie, 19);
    expect((await call("/api/leaderboard", { cookie: v.cookie })).status).toBe(403);
    await voteN(v.cookie, 1); // 10 in each round
    const count = async (r: string) =>
      (await env.DB.prepare("SELECT count(*) AS n, sum(after_board) AS ab FROM votes WHERE round_id = ? AND voter_id = (SELECT id FROM voters WHERE label = ?)").bind(r, v.label).first<{ n: number; ab: number }>())!;
    expect([(await count(rounds[0])).n, (await count(rounds[1])).n]).toEqual([10, 10]);

    // Open the board of the second round only.
    const b = await json(call(`/api/leaderboard?round=${rounds[1]}`, { cookie: v.cookie }));
    expect(b.round.id).toBe(rounds[1]);
    expect(b.rounds.map((r: { id: string }) => r.id).sort()).toEqual([...rounds].sort());
    const seen = await env.DB.prepare("SELECT round_id FROM round_board_seen").all<{ round_id: string }>();
    expect(seen.results.filter((s) => rounds.includes(s.round_id)).map((s) => s.round_id)).toEqual([rounds[1]]);

    // Twenty more votes, ten per round: only those in the round whose board was opened are marked.
    await voteN(v.cookie, 20);
    expect((await count(rounds[0])).ab).toBe(0);
    expect((await count(rounds[1])).ab).toBe(10);

    // The round export carries that round's first view, or none.
    const ex0 = await json(admin(`/admin/api/rounds/${rounds[0]}/export.json`));
    const ex1 = await json(admin(`/admin/api/rounds/${rounds[1]}/export.json`));
    const mine = (ex: { voters: { label: string; board_seen_at: string | null }[] }) => ex.voters.find((x) => x.label === v.label)!;
    expect(mine(ex0).board_seen_at).toBeNull();
    expect(mine(ex1).board_seen_at).toBeTruthy();
  });

  it("with no round asked for, the board shown is the round the voter has judged most; an unknown id falls back to it", async () => {
    const rounds = await openRounds(2);
    await quorum("other", 4);
    const v = await voter("judge");
    await voteN(v.cookie, 30); // batches go 0, 1, 0: twenty in the first round
    const b = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(b.round.id).toBe(rounds[0]);
    expect((await json(call("/api/leaderboard?round=nope", { cookie: v.cookie }))).round.id).toBe(rounds[0]);
  });

  it("a frozen round takes no new batches; the others carry on", async () => {
    const rounds = await openRounds(2);
    const v = await voter("judge");
    await admin(`/admin/api/rounds/${rounds[0]}/freeze`, { body: {} });
    for (let k = 0; k < 3; k++) {
      const b = await getBatch(v.cookie);
      expect(await roundOfBatch(b.pairs[0].pairId)).toBe(rounds[1]);
      await voteN(v.cookie, b.pairs.length);
    }
  });
});
