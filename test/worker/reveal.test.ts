// Invite codes can be shown again in admin, without storing them: they are recomputed from CODE_PEPPER and the
// voter id and checked against the stored hash.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { codeHash, generateCode } from "../../src/worker/auth";
import { admin, call, json, makeCodes, mockOutbound, sessionCookie, turnstileWill } from "./helpers";

describe("reveal invite codes", () => {
  beforeEach(() => {
    mockOutbound();
    turnstileWill(true);
  });

  it("shows the same code that was handed out, and that code signs in", async () => {
    const [c] = await makeCodes("judge");
    const r = await json(admin(`/admin/api/codes/reveal?label=${encodeURIComponent(c.label)}`));
    expect(r).toEqual({ label: c.label, code: c.code });
    const s = await call("/api/redeem", { body: { code: r.code, turnstileToken: "t" } });
    expect(s.status).toBe(200);
    expect(sessionCookie(s)).toBeTruthy();
  });

  it("stores only the hash and audits each reveal by label, never the code", async () => {
    const [c] = await makeCodes("coach");
    await admin(`/admin/api/codes/reveal?label=${encodeURIComponent(c.label)}`);
    const row = await env.DB.prepare("SELECT * FROM voters WHERE label = ?").bind(c.label).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(c.code);
    const audit = await env.DB.prepare("SELECT detail_json FROM admin_audit WHERE action = 'reveal_code' ORDER BY id DESC LIMIT 1").first<any>();
    expect(JSON.parse(audit.detail_json)).toEqual({ label: c.label });
    expect(audit.detail_json).not.toContain(c.code);
    // The voter list itself never carries codes.
    expect(await (await admin("/admin/api/codes")).text()).not.toContain(c.code);
  });

  it("says so plainly for a code made the old (random) way", async () => {
    const old = generateCode();
    await env.DB.prepare("INSERT INTO voters (id, code_hash, role, label, is_owner, created_at) VALUES ('legacy-1', ?, 'other', 'Other 99', 0, ?)")
      .bind(await codeHash(env, old), new Date().toISOString())
      .run();
    const r = await admin("/admin/api/codes/reveal?label=Other%2099");
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error).toBe("not_recoverable");
  });

  it("refuses revoked codes, unknown labels and non-admins", async () => {
    const [c] = await makeCodes("teacher");
    await admin("/admin/api/codes/revoke", { body: { label: c.label } });
    expect((await admin(`/admin/api/codes/reveal?label=${encodeURIComponent(c.label)}`)).status).toBe(409);
    expect((await admin("/admin/api/codes/reveal?label=Nobody%2001")).status).toBe(404);
    expect((await call(`/admin/api/codes/reveal?label=${encodeURIComponent(c.label)}`)).status).toBe(403);
  });
});
