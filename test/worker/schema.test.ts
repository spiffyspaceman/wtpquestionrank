// BUILD_STEPS §6.2: migrations apply cleanly to a local D1; the append-only triggers hold.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const now = "2026-11-24T00:00:00Z";
const db = () => env.DB;

async function fails(sql: string, ...args: unknown[]): Promise<string | false> {
  try {
    await db().prepare(sql).bind(...args).run();
    return false;
  } catch (e) {
    return String((e as Error).message);
  }
}

describe("schema on local D1", () => {
  beforeAll(async () => {
    const d = db();
    for (const q of ["a", "b", "c"])
      await d.prepare("INSERT INTO questions VALUES (?,'State','2021-22',1,1,1,'stem','[]','src',NULL,'h',NULL,?)").bind(q, now).run();
    await d.prepare("INSERT INTO item_sets VALUES ('s1','set',1,'full_text','h',?,NULL)").bind(now).run();
    for (const q of ["a", "b"]) await d.prepare("INSERT INTO item_set_items VALUES ('s1',?)").bind(q).run();
    await d.prepare("INSERT INTO rounds VALUES ('r1','R1','s1','open',?,?,NULL,NULL)").bind(now, now).run();
    await d.prepare("INSERT INTO voters VALUES ('v1','h1','judge','Judge 01',0,?,NULL,NULL)").bind(now).run();
    await d.prepare("INSERT INTO batches VALUES ('b1','r1','v1',7,?)").bind(now).run();
    await d.prepare("INSERT INTO batch_pairs VALUES ('p0','b1',0,'a','b',0,'info',?)").bind(now).run();
    await d
      .prepare(
        `INSERT INTO votes (batch_pair_id,round_id,item_set_id,voter_id,role,left_q,right_q,item_lo,item_hi,winner_q,
                            close_call,is_repeat,after_board,client_ms,server_ms,created_at)
         VALUES ('p0','r1','s1','v1','judge','a','b','a','b','a',0,0,0,30000,31000,?)`,
      )
      .bind(now)
      .run();
    await d.prepare("INSERT INTO skips (batch_pair_id,round_id,voter_id,item_lo,item_hi,is_repeat,client_ms,created_at) VALUES ('p0','r1','v1','a','b',0,1,?)").bind(now).run();
    await d.prepare("INSERT INTO admin_audit (at,actor,action,detail_json) VALUES (?,?,?,?)").bind(now, "sub", "x", "{}").run();
  });

  it("creates every table and all twenty triggers and both views (0001 to 0004)", async () => {
    const t = await db().prepare("SELECT type, count(*) AS n FROM sqlite_schema WHERE type IN ('table','trigger','view') AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' AND name <> 'd1_migrations' GROUP BY type").all<{ type: string; n: number }>();
    const by = Object.fromEntries(t.results.map((r) => [r.type, r.n]));
    expect(by.trigger).toBe(20);
    expect(by.table).toBe(19);
    expect(by.view).toBe(2);
  });

  it("rejects UPDATE and DELETE on votes", async () => {
    expect(await fails("UPDATE votes SET winner_q = 'b' WHERE id = 1")).toMatch(/append-only/);
    expect(await fails("DELETE FROM votes WHERE id = 1")).toMatch(/append-only/);
    const n = await db().prepare("SELECT count(*) AS n FROM votes").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("rejects UPDATE and DELETE on skips and admin_audit", async () => {
    expect(await fails("UPDATE skips SET client_ms = 2")).toMatch(/append-only/);
    expect(await fails("DELETE FROM skips")).toMatch(/append-only/);
    expect(await fails("UPDATE admin_audit SET actor = 'x'")).toMatch(/append-only/);
    expect(await fails("DELETE FROM admin_audit")).toMatch(/append-only/);
  });

  it("vote_reasons takes only known codes, once per vote, and is append-only", async () => {
    expect(await fails("INSERT INTO vote_reasons VALUES (1, 'position')")).toBe(false);
    expect(await fails("INSERT INTO vote_reasons VALUES (1, 'position')")).toMatch(/UNIQUE|PRIMARY/);
    expect(await fails("INSERT INTO vote_reasons VALUES (1, 'nice wording')")).toMatch(/CHECK/);
    expect(await fails("UPDATE vote_reasons SET reason = 'source'")).toMatch(/append-only/);
    expect(await fails("DELETE FROM vote_reasons")).toMatch(/append-only/);
  });

  it("vote_other holds one note per vote, at most 200 characters, append-only", async () => {
    expect(await fails("INSERT INTO vote_other VALUES (1, 'too vague')")).toBe(false);
    expect(await fails("INSERT INTO vote_other VALUES (1, 'again')")).toMatch(/UNIQUE|PRIMARY/);
    expect(await fails("INSERT INTO vote_other VALUES (2, ?)", "x".repeat(201))).toMatch(/CHECK/);
    expect(await fails("UPDATE vote_other SET note = 'x'")).toMatch(/append-only/);
    expect(await fails("DELETE FROM vote_other")).toMatch(/append-only/);
  });

  it("allows only one open round (partial unique index)", async () => {
    expect(await fails("INSERT INTO rounds VALUES ('r2','R2','s1','open',?,?,NULL,NULL)", now, now)).toMatch(/UNIQUE/);
    expect(await fails("INSERT INTO rounds VALUES ('r3','R3','s1','draft',?,NULL,NULL,NULL)", now)).toBe(false);
  });

  it("rejects a draft question, and question text cannot change", async () => {
    expect(await fails("INSERT INTO questions VALUES ('d','State','2026-27',1,1,0,'s','[]','src',NULL,'h',NULL,?)", now)).toMatch(/CHECK/);
    expect(await fails("UPDATE questions SET stem = 'x' WHERE id = 'a'")).toMatch(/immutable/);
  });

  it("freezes item set membership once frozen_at is set", async () => {
    await db().prepare("UPDATE item_sets SET frozen_at = ? WHERE id = 's1'").bind(now).run();
    expect(await fails("INSERT INTO item_set_items VALUES ('s1','c')")).toMatch(/frozen/);
    expect(await fails("DELETE FROM item_set_items WHERE item_set_id = 's1'")).toMatch(/frozen/);
  });

  it("one first vote and at most one repeat per pair per voter", async () => {
    const d = db();
    await d.prepare("INSERT INTO batch_pairs VALUES ('p1','b1',1,'b','a',1,'repeat',?)").bind(now).run();
    await d.prepare("INSERT INTO batch_pairs VALUES ('p2','b1',2,'a','b',0,'info',?)").bind(now).run();
    const ins = `INSERT INTO votes (batch_pair_id,round_id,item_set_id,voter_id,role,left_q,right_q,item_lo,item_hi,winner_q,
                   close_call,is_repeat,after_board,client_ms,server_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    expect(await fails(ins, "p1", "r1", "s1", "v1", "judge", "b", "a", "a", "b", "b", 1, 1, 0, 1, 1, now)).toBe(false);
    expect(await fails(ins, "p2", "r1", "s1", "v1", "judge", "a", "b", "a", "b", "b", 0, 0, 0, 1, 1, now)).toMatch(/UNIQUE/);
  });
});
