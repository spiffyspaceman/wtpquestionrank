// BUILD_STEPS §6.3: redeem and sessions.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeCode } from "../../src/worker/auth";
import { admin, call, json, makeCodes, mockOutbound, openNewRound, sessionCookie, turnstileWill } from "./helpers";

const redeem = (code: string, ip = "198.51.100.1", token = "tok") => call("/api/redeem", { body: { code, turnstileToken: token }, ip });

describe("redeem", () => {
  beforeEach(() => {
    mockOutbound();
    turnstileWill(true);
  });

  it("a right code creates a __Host- session cookie that works on /api/me", async () => {
    await openNewRound();
    const [c] = await makeCodes("coach");
    const r = await redeem(c.code);
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Host-wtpqr=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/i);
    const me = await json(call("/api/me", { cookie: sessionCookie(r) }));
    expect(me.role).toBe("Coach");
    expect(me.votes).toBe(0);
    expect(me.unlocked).toBe(false);
    expect(JSON.stringify(me)).not.toMatch(/voter_id|"id"/);
  });

  it("the code is the login: lower case, spaces and look-alike letters still work, on a second device", async () => {
    const [c] = await makeCodes("judge");
    const sloppy = c.code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(normalizeCode(sloppy)).toBe(normalizeCode(c.code));
    const a = await redeem(c.code);
    const b = await redeem(sloppy);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sessionCookie(a)).not.toBe(sessionCookie(b));
    const n = await env.DB.prepare("SELECT count(*) AS n FROM sessions s JOIN voters v ON v.id = s.voter_id WHERE v.label = ?")
      .bind(c.label)
      .first<{ n: number }>();
    expect(n?.n).toBe(2); // two devices, one voter
  });

  it("stores only a hash of the code", async () => {
    const [c] = await makeCodes("alumni");
    const row = await env.DB.prepare("SELECT * FROM voters WHERE label = ?").bind(c.label).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(normalizeCode(c.code));
    expect(JSON.stringify(row)).not.toContain(c.code);
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a wrong code is counted against a hashed client key, never the raw IP", async () => {
    const r = await redeem("ZZZZ-ZZZZ-ZZZZ", "192.0.2.55");
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error).toBe("wrong_code");
    const rows = await env.DB.prepare("SELECT * FROM attempts").all<{ key_hash: string; count: number }>();
    expect(rows.results.some((x) => x.count >= 1)).toBe(true);
    expect(JSON.stringify(rows.results)).not.toContain("192.0.2.55");
  });

  it("the 11th wrong code in a day is refused, even before Turnstile and even with a right code", async () => {
    const ip = "192.0.2.99";
    for (let k = 0; k < 10; k++) expect((await redeem(`WRNG-${k}000-0000`, ip)).status).toBe(403);
    const eleventh = await redeem("WRNG-1100-0000", ip);
    expect(eleventh.status).toBe(429);
    const [c] = await makeCodes("judge");
    expect((await redeem(c.code, ip)).status).toBe(429);
    // A different client is unaffected.
    expect((await redeem(c.code, "192.0.2.100")).status).toBe(200);
  });

  it("a revoked code is refused, and its existing sessions stop working", async () => {
    const [c] = await makeCodes("teacher");
    const first = await redeem(c.code);
    const cookie = sessionCookie(first);
    expect((await call("/api/me", { cookie })).status).toBe(200);
    expect((await admin("/admin/api/codes/revoke", { body: { label: c.label } })).status).toBe(200);
    const again = await redeem(c.code);
    expect(again.status).toBe(403);
    expect((await again.json<any>()).error).toBe("revoked");
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });

  it("a failed Turnstile check is refused and does not count as a wrong code", async () => {
    const [c] = await makeCodes("other");
    turnstileWill(false);
    const r = await redeem(c.code, "192.0.2.200");
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error).toBe("turnstile_failed");
    turnstileWill(true);
    expect((await redeem(c.code, "192.0.2.200")).status).toBe(200);
  });

  it("refuses a Turnstile token solved on another site", async () => {
    const [c] = await makeCodes("judge");
    turnstileWill(true, "evil.example");
    const r = await redeem(c.code, "192.0.2.201");
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error).toBe("turnstile_failed");
  });

  it("refuses to run without the secrets", async () => {
    const [c] = await makeCodes("judge");
    const r = await call("/api/redeem", { body: { code: c.code, turnstileToken: "t" }, env: { TURNSTILE_SECRET: undefined } });
    expect(r.status).toBe(503);
  });

  it("no session means 401 on /api/me and a forged cookie gets nothing", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { cookie: "__Host-wtpqr=forged" })).status).toBe(401);
  });
});
