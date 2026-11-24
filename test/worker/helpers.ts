// Test helpers: call the app, mock Turnstile and Access, seed items, rounds and voters.
import { env } from "cloudflare:test";
import { vi } from "vitest";
import itemsRaw from "../../items/launch_items_v1.json?raw";
import { resetAccessCertCache } from "../../src/worker/access";
import type { Env } from "../../src/worker/env";
import app from "../../src/worker/index";
import { base64url } from "../../src/worker/util";

export const HOST = "wtpquestionrank.spiffyspaceman.com";
export const ORIGIN = `https://${HOST}`;
export { itemsRaw };

// ---------- outbound mocks ----------

let keyPair: CryptoKeyPair | null = null;
const KID = "test-kid-1";

async function keys(): Promise<CryptoKeyPair> {
  keyPair ??= (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return keyPair;
}

/** Turnstile passes for token "pass" and fails otherwise. Access certs are served from a test key pair. */
export function mockOutbound(): void {
  resetAccessCertCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const req = input instanceof Request ? input : null;
      void req;
      return Response.json({ success: lastTurnstileOk });
    }
    if (url === `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      const jwk = await crypto.subtle.exportKey("jwk", (await keys()).publicKey);
      return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
    }
    return new Response("unexpected outbound fetch " + url, { status: 599 });
  });
}

let lastTurnstileOk = true;
export function turnstileWill(pass: boolean): void {
  lastTurnstileOk = pass;
}

export async function accessToken(over: Record<string, unknown> = {}, kid = KID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid, typ: "JWT" };
  const payload = {
    iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
    aud: [env.ACCESS_AUD],
    sub: "owner-sub-123",
    email: "owner@example.invalid",
    iat: now,
    nbf: now - 5,
    exp: now + 600,
    ...over,
  };
  const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await keys()).privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

// ---------- calling the app ----------

export interface CallOpts {
  method?: string;
  body?: unknown;
  raw?: BodyInit;
  cookie?: string;
  headers?: Record<string, string>;
  host?: string;
  origin?: string | null;
  env?: Partial<Env>;
  ip?: string;
}

export async function call(path: string, o: CallOpts = {}): Promise<Response> {
  const method = o.method ?? (o.body !== undefined || o.raw !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  headers["cf-connecting-ip"] = o.ip ?? "203.0.113.7";
  const req = new Request(`https://${o.host ?? HOST}${path}`, {
    method,
    headers,
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  return app.fetch(req, { ...env, ...(o.env ?? {}) } as Env, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
}

export async function admin(path: string, o: CallOpts = {}): Promise<Response> {
  return call(path, { ...o, headers: { ...(o.headers ?? {}), "cf-access-jwt-assertion": await accessToken() } });
}

export async function json<T = any>(r: Response | Promise<Response>): Promise<T> {
  return (await r).json() as Promise<T>;
}

export function sessionCookie(r: Response): string {
  const sc = r.headers.get("set-cookie") ?? "";
  const m = sc.match(/(__Host-wtpqr=[^;]+)/);
  if (!m) throw new Error("no session cookie in " + sc);
  return m[1];
}

// ---------- seeding ----------

export const ITEM_SET = "state-launch-v1";

export async function loadItems(): Promise<{ ok: boolean; itemSet: string; fileSha256: string }> {
  return json(admin("/admin/api/items", { raw: itemsRaw, headers: { "content-type": "application/octet-stream" } }));
}

export async function openNewRound(name = "Round"): Promise<string> {
  const db = env.DB;
  await db.prepare("UPDATE rounds SET state = 'frozen', frozen_at = ? WHERE state = 'open'").bind(new Date().toISOString()).run();
  if (!(await db.prepare("SELECT 1 FROM item_sets WHERE id = ?").bind(ITEM_SET).first())) await loadItems();
  const { id } = await json<{ id: string }>(admin("/admin/api/rounds", { body: { name, itemSetId: ITEM_SET } }));
  const r = await admin(`/admin/api/rounds/${id}/open`, { body: {} });
  if (r.status !== 200) throw new Error("open failed: " + (await r.text()));
  return id;
}

export async function makeCodes(role: string, count = 1, owner = false): Promise<{ label: string; code: string }[]> {
  const r = await json<{ codes: { label: string; code: string }[] }>(admin("/admin/api/codes", { body: { role, count, owner } }));
  return r.codes;
}

/** A redeemed voter: returns the session cookie. */
export async function voter(role = "judge"): Promise<{ cookie: string; label: string; code: string }> {
  const [c] = await makeCodes(role);
  turnstileWill(true);
  const r = await call("/api/redeem", { body: { code: c.code, turnstileToken: "tok" } });
  if (r.status !== 200) throw new Error("redeem failed: " + (await r.text()));
  return { cookie: sessionCookie(r), label: c.label, code: c.code };
}

export interface ClientPair {
  pairId: string;
  left: { stem: string; bullets: string[] };
  right: { stem: string; bullets: string[] };
}

export async function getBatch(cookie: string): Promise<{ done: boolean; size: number; pairs: ClientPair[] }> {
  const r = await call("/api/batch", { cookie });
  if (r.status !== 200) throw new Error("batch failed: " + r.status + " " + (await r.text()));
  return r.json();
}

/** Vote through `n` pairs, fetching batches as needed. `pick` chooses L or R. */
export async function voteN(cookie: string, n: number, pick: (p: ClientPair, k: number) => "L" | "R" = () => "L"): Promise<number> {
  let done = 0;
  while (done < n) {
    const b = await getBatch(cookie);
    if (b.done || !b.pairs.length) break;
    for (const p of b.pairs) {
      if (done >= n) break;
      const r = await call("/api/vote", { cookie, body: { pairId: p.pairId, pick: pick(p, done), closeCall: false, clientMs: 25_000 } });
      if (r.status !== 200) throw new Error("vote failed: " + (await r.text()));
      done++;
    }
  }
  return done;
}
