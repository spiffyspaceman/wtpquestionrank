// The full question set that ships with the site (owner decision, 25 Nov 2026: every question in one round).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SETS } from "../../src/worker/builtin-sets";
import { admin, call, getBatch, json, loadItems, mockOutbound, voteN, voter } from "./helpers";

const SET = BUILTIN_SETS[0];

describe("built-in question set", () => {
  beforeEach(() => mockOutbound());

  it("lists one set holding every transcribed question; the list is admin only", async () => {
    const r = await json(admin("/admin/api/builtin-sets"));
    expect(r.sets).toHaveLength(1);
    expect(r.sets[0]).toMatchObject({ id: SET.id, roundName: "All questions", questions: SET.questions });
    expect(SET.questions).toBeGreaterThanOrEqual(324);
    expect((await call("/admin/api/builtin-sets")).status).toBe(403);
  });

  it("every question is published, has a stem and two bullets, a unique id, and no footnote left in it", () => {
    const ids = new Set<string>();
    for (const it of SET.file.items as { id: string; published: boolean; stem: string; bullets: string[] }[]) {
      expect(it.published).toBe(true);
      expect(it.stem.length > 40 && it.bullets.length === 2 && it.bullets.every((x) => x.length > 15), it.id).toBe(true);
      expect(/[*†‡]|https?:|\baccessed\b/.test(it.stem + it.bullets.join(" ")), it.id).toBe(false);
      expect(ids.has(it.id)).toBe(false);
      ids.add(it.id);
    }
  });

  it("loads beside the launch set (same ids, same texts), makes one draft round, is safe to repeat, and runs at full size", async () => {
    await loadItems(); // the 36 launch questions are also in the full set
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state IN ('open', 'frozen')").run();
    const first = await json(admin(`/admin/api/builtin-sets/${SET.id}`, { body: {} }));
    expect(first).toMatchObject({ ok: true, n: SET.questions });
    expect(first.roundCreated).toBeTruthy();
    const again = await json(admin(`/admin/api/builtin-sets/${SET.id}`, { body: {} }));
    expect(again).toMatchObject({ already: true, roundCreated: null });
    expect((await json(admin("/admin/api/builtin-sets"))).sets[0]).toMatchObject({ loaded: true, current: true, rounds: ["draft"] });
    // An older build of the same set on the site (same questions, footnotes since corrected) is reported as not current,
    // and loading again brings the footnotes up to date without touching any text.
    await env.DB.prepare("UPDATE item_sets SET file_sha256 = 'older-build' WHERE id = ?").bind(SET.id).run();
    await env.DB.prepare("UPDATE questions SET notes_json = '{\"marks\":[],\"notes\":[]}' WHERE id = 'st-2019-20-u5-q3'").run();
    expect((await json(admin("/admin/api/builtin-sets"))).sets[0]).toMatchObject({ loaded: true, current: false, toAdd: 0 });
    expect(await json(admin(`/admin/api/builtin-sets/${SET.id}`, { body: {} }))).toMatchObject({ ok: true, added: 0 });
    expect((await json(admin("/admin/api/builtin-sets"))).sets[0]).toMatchObject({ current: true });
    expect((await admin("/admin/api/builtin-sets/nope-v1", { body: {} })).status).toBe(404);

    // The whole flow on a round of this size: a batch, twenty votes, the leaderboard with every question.
    expect((await admin(`/admin/api/rounds/${first.roundCreated}/open`, { body: {} })).status).toBe(200);
    const v = await voter("judge");
    const b = await getBatch(v.cookie);
    expect(b.pairs).toHaveLength(10);
    expect(JSON.stringify(b.all)).not.toMatch(/"(id|cycle|unit|level|q|source)"/);
    // Footnotes travel with the questions: on the voting page as marks and notes, with no access date.
    const withNotes = b.all.flatMap((p) => [p.left, p.right] as { notes?: { mark: string; parts: [string, string | null][] }[]; marks?: unknown[] }[]).filter((s) => s.notes?.length);
    expect(withNotes.length).toBeGreaterThan(0);
    expect(JSON.stringify(withNotes)).not.toMatch(/accessed [A-Z]/);
    const stored = await env.DB.prepare("SELECT count(*) AS n FROM questions WHERE notes_json LIKE '%\"mark\"%'").first<{ n: number }>();
    expect(stored!.n).toBeGreaterThan(300);
    // The 36 launch questions were loaded first, without notes; loading the full set filled theirs in.
    const launch = await env.DB.prepare("SELECT notes_json FROM questions WHERE id = 'st-2019-20-u5-q3'").first<{ notes_json: string }>();
    expect(JSON.parse(launch!.notes_json).notes[0].text).toMatch(/Madison/);
    await voteN(v.cookie, 20);
    const board = await json(call("/api/leaderboard", { cookie: v.cookie }));
    expect(board.rows.some((r: { notes: unknown[] }) => r.notes.length > 0)).toBe(true);
    expect(board.round.name).toBe("All questions");
    // The round is staged (migration 0008): the board lists the questions in play, the 36 launch questions first.
    expect(board.rows).toHaveLength(36);
    expect(board.staged).toEqual({ inPlay: 36, total: SET.questions - 1 }); // one question is held out of play
    expect(board.votes).toBe(20);
    const ex = await json(admin(`/admin/api/rounds/${first.roundCreated}/export.json`));
    expect(ex.votes).toHaveLength(20);
  });
});
