// BUILD_STEPS §6.7 and §4: admin login, items, rounds, codes, raw votes, exports.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EXPORT_SKIP_KEYS, EXPORT_VOTE_KEYS, EXPORT_VOTER_KEYS } from "../../src/worker/exports";
import { accessToken, admin, call, getBatch, ITEM_SET, itemsRaw, json, loadItems, makeCodes, mockOutbound, openNewRound, voteN, voter } from "./helpers";

const PREREG_ITEM_SHA = "8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0";
const withToken = async (tok: string) => call("/admin/api/status", { headers: { "cf-access-jwt-assertion": tok } });

describe("admin login (Cloudflare Access token, verified by the Worker)", () => {
  beforeEach(() => mockOutbound());

  it("refuses a request without a token", async () => {
    expect((await call("/admin/api/status")).status).toBe(403);
    expect((await call("/admin")).status).toBe(403);
  });

  it("accepts a valid token and logs its sub, never the email", async () => {
    const r = await withToken(await accessToken());
    expect(r.status).toBe(200);
    expect((await r.json<any>()).actor).toBe("owner-sub-123");
    await admin("/admin/api/rounds", { body: { name: "x", itemSetId: "missing" } });
    await loadItems();
    const a = await env.DB.prepare("SELECT actor, detail_json FROM admin_audit").all<{ actor: string; detail_json: string }>();
    expect(a.results.length).toBeGreaterThan(0);
    for (const row of a.results) {
      expect(row.actor).toBe("owner-sub-123");
      expect(row.detail_json).not.toContain("@");
    }
  });

  it("refuses a wrong audience, a wrong issuer, an expired or not-yet-valid token, and no sub", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await withToken(await accessToken({ aud: ["someone-else"] }))).status).toBe(403);
    expect((await withToken(await accessToken({ iss: "https://evil.cloudflareaccess.com" }))).status).toBe(403);
    expect((await withToken(await accessToken({ exp: now - 3600 }))).status).toBe(403);
    expect((await withToken(await accessToken({ nbf: now + 3600 }))).status).toBe(403);
    expect((await withToken(await accessToken({ sub: undefined }))).status).toBe(403);
  });

  it("refuses a bad signature, an unknown key id, and garbage", async () => {
    const good = await accessToken();
    const [h, p, s] = good.split(".");
    const flipped = s.slice(0, -2) + (s.slice(-2) === "AA" ? "AB" : "AA");
    expect((await withToken(`${h}.${p}.${flipped}`)).status).toBe(403);
    const tamperedPayload = btoa(JSON.stringify({ ...JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))), sub: "x" })).replace(/=+$/, "");
    expect((await withToken(`${h}.${tamperedPayload}.${s}`)).status).toBe(403);
    expect((await withToken(await accessToken({}, "other-kid"))).status).toBe(403);
    expect((await withToken("not.a.jwt")).status).toBe(403);
  });

  it("ignores ADMIN_SECRET while Access is configured", async () => {
    const r = await call("/admin/api/login", { body: { secret: "s3cret" }, env: { ADMIN_SECRET: "s3cret" } });
    expect(r.status).toBe(403);
  });

  it("fallback: with no Access, ADMIN_SECRET buys a short admin cookie; without either, nothing", async () => {
    const noAccess = { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "", ADMIN_SECRET: "a-long-admin-secret" };
    expect((await call("/admin/api/login", { body: { secret: "wrong" }, env: noAccess })).status).toBe(403);
    const ok = await call("/admin/api/login", { body: { secret: "a-long-admin-secret" }, env: noAccess });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get("set-cookie") ?? "").match(/(__Host-wtpqr-admin=[^;]+)/)![1];
    expect((await call("/admin/api/status", { cookie, env: noAccess })).status).toBe(200);
    expect((await call("/admin/api/status", { cookie: cookie + "x", env: noAccess })).status).toBe(403);
    // The cookie dies with the secret.
    expect((await call("/admin/api/status", { cookie, env: { ...noAccess, ADMIN_SECRET: "rotated" } })).status).toBe(403);
    expect((await call("/admin/api/status", { env: { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "", ADMIN_SECRET: undefined } })).status).toBe(403);
  });
});

describe("items", () => {
  beforeEach(() => mockOutbound());

  it("loads the launch file as state-launch-v1 with the pre-registered file hash", async () => {
    const r = await loadItems();
    expect(r.itemSet).toBe(ITEM_SET);
    expect(r.fileSha256).toBe(PREREG_ITEM_SHA);
    const set = await env.DB.prepare("SELECT file_sha256, (SELECT count(*) FROM item_set_items WHERE item_set_id = id) AS n FROM item_sets WHERE id = ?")
      .bind(ITEM_SET)
      .first<any>();
    expect(set).toMatchObject({ file_sha256: PREREG_ITEM_SHA, n: 36 });
    const again = await loadItems();
    expect(again).toMatchObject({ ok: true, already: true });
    const q = await env.DB.prepare("SELECT text_sha256 FROM questions LIMIT 1").first<any>();
    expect(q.text_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a file with any item not marked published: true", async () => {
    const f = JSON.parse(itemsRaw);
    f.item_set = "drafts";
    f.items[3].published = false;
    delete f.items[5].published;
    const r = await admin("/admin/api/items", { raw: JSON.stringify(f) });
    expect(r.status).toBe(400);
    const body = await r.json<any>();
    expect(body.error).toBe("unpublished");
    expect(body.ids).toEqual([f.items[3].id, f.items[5].id]);
    expect(await env.DB.prepare("SELECT 1 FROM item_sets WHERE id = 'drafts-v1'").first()).toBeNull();
  });

  it("refuses a changed text under an existing question id, and a different file under an existing item set", async () => {
    await loadItems();
    const f = JSON.parse(itemsRaw);
    f.item_set = "other";
    f.items[0].stem += " (edited)";
    expect((await admin("/admin/api/items", { raw: JSON.stringify(f) })).status).toBe(409);
    const g = JSON.parse(itemsRaw);
    g.created = "changed";
    expect((await admin("/admin/api/items", { raw: JSON.stringify(g) })).status).toBe(409);
  });

  it("freezes the item set when its first round opens", async () => {
    await openNewRound();
    const s = await env.DB.prepare("SELECT frozen_at FROM item_sets WHERE id = ?").bind(ITEM_SET).first<any>();
    expect(s.frozen_at).toBeTruthy();
  });
});

describe("rounds", () => {
  beforeEach(() => mockOutbound());

  it("create as draft, open (several may be open), freeze, close; no other moves", async () => {
    await loadItems();
    await env.DB.prepare("UPDATE rounds SET state = 'closed' WHERE state = 'open'").run();
    const a = (await json(admin("/admin/api/rounds", { body: { name: "A", itemSetId: ITEM_SET } }))).id;
    const b = (await json(admin("/admin/api/rounds", { body: { name: "B", itemSetId: ITEM_SET } }))).id;
    expect((await env.DB.prepare("SELECT state FROM rounds WHERE id = ?").bind(a).first<any>()).state).toBe("draft");
    expect((await admin(`/admin/api/rounds/${a}/freeze`, { body: {} })).status).toBe(409);
    expect((await admin(`/admin/api/rounds/${a}/open`, { body: {} })).status).toBe(200);
    // A second round opens beside the first (migration 0005).
    expect((await admin(`/admin/api/rounds/${b}/open`, { body: {} })).status).toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM rounds WHERE state = 'open'").first<any>()).n).toBe(2);
    expect((await admin(`/admin/api/rounds/${a}/freeze`, { body: {} })).status).toBe(200);
    expect((await admin(`/admin/api/rounds/${a}/open`, { body: {} })).status).toBe(409);
    expect((await admin(`/admin/api/rounds/${b}/open`, { body: {} })).status).toBe(409);
    expect((await admin(`/admin/api/rounds/${a}/close`, { body: {} })).status).toBe(200);
    const audit = await env.DB.prepare("SELECT action FROM admin_audit WHERE action LIKE '%_round'").all<any>();
    expect(audit.results.map((r) => r.action)).toEqual(expect.arrayContaining(["create_round", "open_round", "freeze_round", "close_round"]));
  });
});

describe("codes", () => {
  beforeEach(() => mockOutbound());

  it("numbers labels per role, flags the owner's code, shows codes once", async () => {
    const a = await makeCodes("judge", 2);
    const b = await makeCodes("judge", 1, true);
    expect(a.map((c) => c.label)).toEqual(["Judge 01", "Judge 02"]);
    expect(b[0].label).toBe("Judge 03");
    for (const c of [...a, ...b]) expect(c.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const list = await admin("/admin/api/codes");
    const text = await list.text();
    for (const c of [...a, ...b]) expect(text).not.toContain(c.code);
    const owner = JSON.parse(text).voters.find((v: any) => v.label === "Judge 03");
    expect(owner.is_owner).toBe(1);
    const audit = await env.DB.prepare("SELECT detail_json FROM admin_audit WHERE action = 'create_codes'").all<any>();
    for (const row of audit.results) for (const c of [...a, ...b]) expect(row.detail_json).not.toContain(c.code);
  });

  it("rejects bad roles and counts", async () => {
    expect((await admin("/admin/api/codes", { body: { role: "parent", count: 1 } })).status).toBe(400);
    expect((await admin("/admin/api/codes", { body: { role: "judge", count: 0 } })).status).toBe(400);
    expect((await admin("/admin/api/codes", { body: { role: "judge", count: 201 } })).status).toBe(400);
  });
});

describe("raw votes and exports", () => {
  beforeEach(() => mockOutbound());

  it("pages and filters raw votes by role, label and repeat", async () => {
    const id = await openNewRound();
    const j = await voter("judge");
    const s = await voter("student");
    await voteN(j.cookie, 30);
    await voteN(s.cookie, 5);
    const all = await json(admin(`/admin/api/votes?round=${id}`));
    expect(all.total).toBe(35);
    expect(all.votes).toHaveLength(35);
    expect((await json(admin(`/admin/api/votes?round=${id}&role=student`))).total).toBe(5);
    expect((await json(admin(`/admin/api/votes?round=${id}&label=${encodeURIComponent(j.label)}`))).total).toBe(30);
    expect((await json(admin(`/admin/api/votes?round=${id}&repeat=1`))).total).toBe(1);
    const p1 = await json(admin(`/admin/api/votes?page=1`));
    expect(p1.page).toBe(1);
  });

  it("exports JSON in exactly the RoundExport shape, and CSVs; each export is audited", async () => {
    const id = await openNewRound();
    const v = await voter("coach");
    await voteN(v.cookie, 12);
    const b = await getBatch(v.cookie);
    await call("/api/skip", { cookie: v.cookie, body: { pairId: b.pairs[0].pairId, clientMs: 500 } });
    const r = await admin(`/admin/api/rounds/${id}/export.json`);
    expect(r.headers.get("content-disposition")).toMatch(/attachment/);
    const ex = await r.json<any>();
    expect(Object.keys(ex).sort()).toEqual(["round", "skips", "voters", "votes"]);
    expect(Object.keys(ex.round).sort()).toEqual(["id", "item_set_id", "name", "state"]);
    expect(ex.votes).toHaveLength(12);
    expect(ex.skips).toHaveLength(1);
    expect(ex.voters).toHaveLength(1);
    for (const x of ex.votes) expect(Object.keys(x)).toEqual([...EXPORT_VOTE_KEYS]);
    for (const x of ex.voters) expect(Object.keys(x)).toEqual([...EXPORT_VOTER_KEYS]);
    for (const x of ex.skips) expect(Object.keys(x)).toEqual([...EXPORT_SKIP_KEYS]);

    const voters = await (await admin(`/admin/api/rounds/${id}/export/voters.csv`)).text();
    expect(voters.split("\r\n")[0]).toBe("label,role,revoked_at");
    const votes = await (await admin(`/admin/api/rounds/${id}/export/votes.csv`)).text();
    expect(votes.trim().split("\r\n")).toHaveLength(13);
    const skips = await (await admin(`/admin/api/rounds/${id}/export/skips.csv`)).text();
    expect(skips.trim().split("\r\n")).toHaveLength(2);
    const ratings = await (await admin(`/admin/api/rounds/${id}/export/ratings.csv`)).text();
    expect(ratings.trim().split("\r\n")).toHaveLength(1 + 36 * 8);
    const status = await json(admin("/admin/api/status"));
    expect(status.lastExportAt).toBeTruthy();
    expect(status.exportOverdue).toBe(false);
  });

  it("flags an export overdue when votes exist and no export is newer than 7 days", async () => {
    const id = await openNewRound();
    const v = await voter("judge");
    await voteN(v.cookie, 1);
    await env.DB.prepare("INSERT INTO admin_audit (at, actor, action, detail_json) VALUES (?, 'x', 'noop', '{}')").bind(new Date().toISOString()).run();
    const status = await json(admin("/admin/api/status"));
    const lastAt = status.lastExportAt ? Date.parse(status.lastExportAt) : 0;
    expect(status.exportOverdue).toBe(Date.now() - lastAt > 7 * 86_400_000);
    void id;
  });
});
