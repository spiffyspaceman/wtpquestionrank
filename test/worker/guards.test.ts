// BUILD_STEPS §5 and §6.7: host guard, Origin check, response headers.
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, mockOutbound, openNewRound, voter } from "./helpers";

describe("host guard", () => {
  beforeEach(() => mockOutbound());

  it("returns 404 for /api and /admin on any host but PROD_HOST", async () => {
    for (const host of [
      "wtpquestionrank.example.workers.dev",
      "abc123-wtpquestionrank.example.workers.dev",
      "branch.wtpquestionrank.spiffyspaceman.com",
      "spiffyspaceman.com",
    ]) {
      for (const path of ["/api/me", "/api/batch", "/api/leaderboard", "/api/config", "/admin", "/admin/api/status", "/api"]) {
        const r = await call(path, { host });
        expect(r.status, `${host}${path}`).toBe(404);
      }
      // Even with a valid admin token or a valid session.
      expect((await admin("/admin/api/status", { host })).status).toBe(404);
      expect((await call("/api/redeem", { host, body: { code: "x", turnstileToken: "t" }, origin: `https://${host}` })).status).toBe(404);
    }
  });

  it("a session cookie from production gets nothing on another host", async () => {
    await openNewRound();
    const v = await voter("judge");
    expect((await call("/api/me", { cookie: v.cookie })).status).toBe(200);
    expect((await call("/api/me", { cookie: v.cookie, host: "preview.example.workers.dev" })).status).toBe(404);
  });
});

describe("origin and body checks", () => {
  beforeEach(() => mockOutbound());

  it("refuses state-changing requests with a missing or foreign Origin", async () => {
    expect((await call("/api/redeem", { body: { code: "x", turnstileToken: "t" }, origin: null })).status).toBe(403);
    expect((await call("/api/redeem", { body: { code: "x", turnstileToken: "t" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/redeem", { body: { code: "x", turnstileToken: "t" }, origin: "http://wtpquestionrank.spiffyspaceman.com" })).status).toBe(403);
    expect((await admin("/admin/api/codes", { body: { role: "judge", count: 1 }, origin: "https://evil.example" })).status).toBe(403);
  });

  it("caps voter bodies at 2 KB", async () => {
    const r = await call("/api/redeem", { body: { code: "x", turnstileToken: "t".repeat(2100) } });
    expect(r.status).toBe(413);
  });
});

describe("response headers", () => {
  beforeEach(() => mockOutbound());

  it("sets CSP (self plus Turnstile), noindex and no-store on API responses", async () => {
    const r = await call("/api/config");
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
