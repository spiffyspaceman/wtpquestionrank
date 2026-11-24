// Admin authentication.
//
// Primary: Cloudflare Access in front of /admin*, and this Worker verifies the Access token on every request
// (signature against the team's certs, iss, aud, exp, nbf), so a missed route or a non-Access host cannot get in.
// Docs (read 24 Nov 2026): https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
//
// Fallback, only when Access is not configured: ADMIN_SECRET exchanged for a short signed admin cookie.
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env } from "./env";
import { base64urlDecode, hmacHex, safeEqual } from "./util";

export const ADMIN_COOKIE = "__Host-wtpqr-admin";
const ADMIN_SESSION_SECONDS = 8 * 3600;
const CLOCK_SKEW_S = 60;
const CERT_TTL_MS = 10 * 60 * 1000;

interface Jwk extends JsonWebKey {
  kid?: string;
}
let certCache: { team: string; at: number; keys: Jwk[] } | null = null;

/** For tests: forget cached signing keys. */
export function resetAccessCertCache(): void {
  certCache = null;
}

async function accessKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && certCache && certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  certCache = { team, at: Date.now(), keys: body.keys ?? [] };
  return certCache.keys;
}

const dec = new TextDecoder();

export function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

/** Returns the token's `sub` when valid, or null. Never throws on a bad token. */
export async function verifyAccessJwt(env: Env, token: string | undefined): Promise<string | null> {
  if (!token || !accessConfigured(env)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(base64urlDecode(parts[0]))) as { alg?: string; kid?: string };
    const payload = JSON.parse(dec.decode(base64urlDecode(parts[1]))) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      nbf?: number;
      sub?: string;
    };
    if (header.alg !== "RS256" || !header.kid) return null;
    let keys = await accessKeys(env.ACCESS_TEAM_DOMAIN);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await accessKeys(env.ACCESS_TEAM_DOMAIN, true); // key rotation
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64urlDecode(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_S) return null;
    if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_S) return null;
    if (!payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// ---------- ADMIN_SECRET fallback ----------

async function adminCookieValue(secret: string, exp: number): Promise<string> {
  return `${exp}.${await hmacHex(secret, "admin-session:" + exp)}`;
}

async function verifyAdminCookie(env: Env, value: string | undefined): Promise<boolean> {
  if (!value || !env.ADMIN_SECRET) return false;
  const [expS] = value.split(".");
  const exp = Number(expS);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(value, await adminCookieValue(env.ADMIN_SECRET, exp));
}

/** Exchange ADMIN_SECRET for an admin cookie. Only when Access is not configured. */
export async function adminSecretLogin(c: Context<AppEnv>, secret: unknown): Promise<boolean> {
  const env = c.env;
  if (accessConfigured(env) || !env.ADMIN_SECRET || typeof secret !== "string") return false;
  const a = await hmacHex("cmp", secret);
  const b = await hmacHex("cmp", env.ADMIN_SECRET);
  if (!safeEqual(a, b)) return false;
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS;
  setCookie(c, ADMIN_COOKIE, await adminCookieValue(env.ADMIN_SECRET, exp), {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return true;
}

/** The admin actor for this request ('sub' of the Access token, or 'admin-secret'), or null. */
export async function adminActor(c: Context<AppEnv>): Promise<string | null> {
  if (accessConfigured(c.env)) return verifyAccessJwt(c.env, c.req.header("cf-access-jwt-assertion"));
  if (await verifyAdminCookie(c.env, getCookie(c, ADMIN_COOKIE))) return "admin-secret";
  return null;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = await adminActor(c);
  if (!actor) return c.json({ error: "not_admin" }, 403);
  c.set("actor", actor);
  await next();
};
