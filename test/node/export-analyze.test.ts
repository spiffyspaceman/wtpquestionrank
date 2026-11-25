// BUILD_STEPS §6.8: an export from a scripted session of the real Worker passes through analyze().
//
// The Worker is bundled with esbuild and run in workerd through Miniflare, with a local D1 that has the migrations
// applied. Its outbound fetches (Turnstile, Access certs) go to a small mock worker. About 25 voters judge batches
// through the voter API; the admin API freezes the round and exports it; analyze() runs on that export with the
// real method A outputs in llm-arm/.
import { webcrypto as crypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze, type RoundExport } from "../../analysis/analyze";
import { makeRng, sigmoid } from "../../src/rating/rating";

const root = path.resolve(__dirname, "../..");
const HOST = "wtpquestionrank.spiffyspaceman.com";
const ORIGIN = `https://${HOST}`;
const TEAM = "e2eteam.cloudflareaccess.com";
const AUD = "e2e-aud";
const itemsPath = path.join(root, "items/launch_items_v1.json");
const itemsRaw = fs.readFileSync(itemsPath);
const items: { id: string; stem: string }[] = JSON.parse(itemsRaw.toString("utf8")).items;

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

let mf: Miniflare;
let privateKey: CryptoKey;

async function adminToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg: "RS256", kid: "e2e" })}.${enc({ iss: `https://${TEAM}`, aud: [AUD], sub: "e2e-owner", exp: now + 900, nbf: now - 5 })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
  return `${input}.${b64u(new Uint8Array(sig))}`;
}

async function req(p: string, o: { method?: string; body?: unknown; raw?: Uint8Array; cookie?: string; admin?: boolean } = {}) {
  const method = o.method ?? (o.body !== undefined || o.raw ? "POST" : "GET");
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.9" };
  if (method !== "GET") headers.origin = ORIGIN;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = o.cookie;
  if (o.admin) headers["cf-access-jwt-assertion"] = await adminToken();
  const res = await mf.dispatchFetch(`${ORIGIN}${p}`, {
    method,
    headers,
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  return res;
}

describe("export from a scripted session runs through analyze()", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtpqr-e2e-"));
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    privateKey = kp.privateKey;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "e2e", alg: "RS256" };

    const bundle = await build({
      entryPoints: [path.join(root, "src/worker/index.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser", "import"],
    });
    const mock = `export default { async fetch(req) {
      const u = new URL(req.url);
      if (u.hostname === "challenges.cloudflare.com") return Response.json({ success: true, hostname: ${JSON.stringify(HOST)} });
      if (u.hostname === ${JSON.stringify(TEAM)}) return Response.json({ keys: [${JSON.stringify(jwk)}] });
      return new Response("blocked " + u.href, { status: 599 });
    } }`;
    mf = new Miniflare(convertV4MiniflareOptions({
      workers: [
        {
          name: "app",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-11-01",
          d1Databases: { DB: "e2e-db" },
          bindings: {
            PROD_HOST: HOST,
            ACCESS_TEAM_DOMAIN: TEAM,
            ACCESS_AUD: AUD,
            TURNSTILE_SITEKEY: "e2e",
            CODE_PEPPER: "e2e-pepper",
            TURNSTILE_SECRET: "e2e-secret",
          },
          serviceBindings: { ASSETS: "mock" },
          outboundService: "mock",
        },
        { name: "mock", modules: true, script: mock },
      ],
    }));
    const db = await mf.getD1Database("DB", "app");
    for (const m of await readD1Migrations(path.join(root, "migrations"))) for (const q of m.queries) await db.prepare(q).run();
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  it("produces a RoundExport that analyze() accepts", async () => {
    // Admin: load items, open a round, make codes (one owner, one to revoke later).
    const load = (await (await req("/admin/api/items", { raw: itemsRaw, admin: true })).json()) as any;
    expect(load.fileSha256).toBe("8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0");
    const { id: roundId } = (await (await req("/admin/api/rounds", { body: { name: "E2E", itemSetId: load.itemSet }, admin: true })).json()) as any;
    expect((await req(`/admin/api/rounds/${roundId}/open`, { body: {}, admin: true })).status).toBe(200);
    const roles = ["judge", "judge", "judge", "judge", "coach", "coach", "coach", "coach", "alumni", "alumni", "alumni", "teacher", "teacher", "other", "other", "judge", "coach", "alumni", "teacher", "other", "student", "student", "student"];
    const codes: { label: string; code: string; role: string }[] = [];
    for (const role of new Set(roles)) {
      const n = roles.filter((r) => r === role).length;
      const out = (await (await req("/admin/api/codes", { body: { role, count: n, owner: false }, admin: true })).json()) as any;
      codes.push(...out.codes);
    }
    const owner = ((await (await req("/admin/api/codes", { body: { role: "judge", count: 1, owner: true }, admin: true })).json()) as any).codes[0];
    codes.push(owner);

    // Voters: a shared latent ranking plus personal noise, as in analysis/analyze.test.ts.
    const rng = makeRng(7);
    const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const truth = new Map(items.map((i) => [i.stem, 1.2 * normal()]));
    let totalVotes = 0;
    for (const [k, c] of codes.entries()) {
      const r = await req("/api/redeem", { body: { code: c.code, turnstileToken: "ok" } });
      expect(r.status).toBe(200);
      const cookie = (r.headers.get("set-cookie") ?? "").match(/(__Host-wtpqr=[^;]+)/)![1];
      const own = new Map([...truth].map(([s, b]) => [s, b + 0.4 * normal()]));
      const target = 40 + (k % 3) * 5;
      let done = 0;
      let skipped = false;
      while (done < target) {
        const br = await req("/api/batch", { cookie });
        const b = (await br.json()) as any;
        if (br.status !== 200 || !b.pairs?.length) throw new Error(`voter ${k} after ${done} votes: batch ${br.status}: ${JSON.stringify(b)}`);
        expect(JSON.stringify(b)).not.toMatch(/st-20\d\d/);
        for (const p of b.pairs) {
          if (done === 22) await req("/api/leaderboard", { cookie }); // some votes land after the board
          if (!skipped && done === 5 && k % 4 === 0) {
            skipped = true;
            await req("/api/skip", { cookie, body: { pairId: p.pairId, clientMs: 3000 } });
            continue;
          }
          const pL = sigmoid(own.get(p.left.stem)! - own.get(p.right.stem)! + 0.1);
          const pick = rng() < pL ? "L" : "R";
          const v = await req("/api/vote", { cookie, body: { pairId: p.pairId, pick, closeCall: rng() < 0.15, clientMs: 20_000 + Math.round(30_000 * rng()) } });
          expect(v.status).toBe(200);
          done++;
          totalVotes++;
        }
      }
    }
    // Revoke one voter; the analysis must exclude them.
    expect((await req("/admin/api/codes/revoke", { body: { label: codes[2].label }, admin: true })).status).toBe(200);
    expect((await req(`/admin/api/rounds/${roundId}/freeze`, { body: {}, admin: true })).status).toBe(200);

    const exRes = await req(`/admin/api/rounds/${roundId}/export.json`, { admin: true });
    expect(exRes.status).toBe(200);
    const ex = (await exRes.json()) as RoundExport;
    expect(ex.votes.length).toBe(totalVotes);
    expect(ex.voters.length).toBe(codes.length);
    expect(ex.votes.some((v) => v.is_repeat === 1)).toBe(true);
    expect(ex.votes.some((v) => v.after_board === 1)).toBe(true);
    expect(ex.skips!.length).toBeGreaterThan(0);
    const exportPath = path.join(tmp, "round.json");
    fs.writeFileSync(exportPath, JSON.stringify(ex));

    const result = analyze({
      exportPath,
      itemsPath,
      llmDesignPath: path.join(root, "llm-arm/design.json"),
      llmOutDir: path.join(root, "llm-arm/out"),
      outDir: path.join(tmp, "out"),
      reps: 50,
      seed: 20261124,
    });
    expect(result.counts.revokedExcluded).toBeGreaterThan(0);
    expect(result.raters.length).toBe(codes.length);
    expect(typeof result.verdict).toBe("string");
    expect(fs.existsSync(path.join(tmp, "out", "report.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "out", "leaderboard_adults.csv"))).toBe(true);
  });
});
