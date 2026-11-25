// The admin page's paged export must produce exactly what the one-shot export routes produce.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildRoundExport, votesCsvFrom, type ExportVoteRow } from "../../src/worker/export-shape";
import { admin, call, getBatch, json, mockOutbound, openNewRound, voteN, voter } from "./helpers";

async function stitched(roundId: string, kind: "json" | "votes", limit: number) {
  const meta = await json(admin(`/admin/api/rounds/${roundId}/export-meta?kind=${kind}`));
  const votes: ExportVoteRow[] = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = await json(admin(`/admin/api/rounds/${roundId}/export-votes?after=${after}&limit=${limit}`));
    pages++;
    votes.push(...page.votes);
    if (page.next === null) break;
    after = page.next;
  }
  return { meta, votes, pages };
}

describe("paged export", () => {
  beforeEach(() => mockOutbound());

  it("stitches to the same JSON and votes CSV as the one-shot routes", async () => {
    const id = await openNewRound();
    const a = await voter("judge");
    const s = await voter("student");
    await voteN(a.cookie, 25);
    await voteN(s.cookie, 8);
    const b = await getBatch(s.cookie);
    await call("/api/skip", { cookie: s.cookie, body: { pairId: b.pairs[0].pairId, clientMs: 10 } });

    const { meta, votes, pages } = await stitched(id, "json", 7);
    expect(pages).toBeGreaterThan(4);
    const oneShot = await (await admin(`/admin/api/rounds/${id}/export.json`)).text();
    expect(JSON.stringify(buildRoundExport(meta, votes))).toBe(oneShot);

    const csv = await (await admin(`/admin/api/rounds/${id}/export/votes.csv`)).text();
    expect(votesCsvFrom(votes)).toBe(csv);
  });

  it("caps a page at 2,000 votes and audits the export once, by kind", async () => {
    const id = await openNewRound();
    const v = await voter("coach");
    await voteN(v.cookie, 3);
    const page = await json(admin(`/admin/api/rounds/${id}/export-votes?after=0&limit=999999`));
    expect(page.votes).toHaveLength(3);
    expect(page.next).toBeNull();
    await stitched(id, "votes", 2000);
    const rows = await env.DB.prepare("SELECT action FROM admin_audit WHERE detail_json LIKE ? ORDER BY id").bind(`%"${id}"%`).all<any>();
    expect(rows.results.map((r) => r.action).filter((x: string) => x.startsWith("export"))).toEqual(["export_votes_csv"]);
  });
});
