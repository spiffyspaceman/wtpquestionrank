// Invite codes, voter sessions and the wrong-code throttle.
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env, VoterRow } from "./env";
import { hmacHex, nowIso, randomId, sha256Hex, utcDay } from "./util";

export const SESSION_COOKIE = "__Host-wtpqr";
export const SESSION_DAYS = 90;
export const MAX_WRONG_CODES_PER_DAY = 10;

// Crockford base32: no I, L, O, U, so codes read aloud cleanly.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12; // 60 bits

/** A new code, shown as XXXX-XXXX-XXXX. */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Upper-case, drop spaces and dashes, read O as 0 and I or L as 1. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function pepper(env: Env): string {
  if (!env.CODE_PEPPER) throw new Error("CODE_PEPPER is not set");
  return env.CODE_PEPPER;
}

/** HMAC-SHA256(CODE_PEPPER, normalized code), hex. The only form of a code the database holds. */
export async function codeHash(env: Env, raw: string): Promise<string> {
  return hmacHex(pepper(env), "code:" + normalizeCode(raw));
}

/** SHA-256 of a daily salt plus the client IP. The salt is derived from the pepper, so nothing raw is stored. */
export async function attemptKey(env: Env, ip: string, day = utcDay()): Promise<string> {
  const salt = await hmacHex(pepper(env), "attempt-salt:" + day);
  return sha256Hex(salt + "|" + ip);
}

export async function wrongCodeCount(db: D1Database, key: string, day = utcDay()): Promise<number> {
  const r = await db.prepare("SELECT count FROM attempts WHERE key_hash = ? AND day = ?").bind(key, day).first<{ count: number }>();
  return r?.count ?? 0;
}

export async function recordWrongCode(db: D1Database, key: string, day = utcDay()): Promise<void> {
  const cutoff = utcDay(new Date(Date.now() - 2 * 86_400_000));
  await db.batch([
    db
      .prepare("INSERT INTO attempts (key_hash, day, count) VALUES (?, ?, 1) ON CONFLICT (key_hash, day) DO UPDATE SET count = count + 1")
      .bind(key, day),
    db.prepare("DELETE FROM attempts WHERE day < ?").bind(cutoff),
  ]);
}

export async function createSession(c: Context<AppEnv>, voterId: string): Promise<void> {
  const token = randomId(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sessions (token_hash, voter_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256Hex(token),
      voterId,
      now.toISOString(),
      expires.toISOString(),
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 86_400,
  });
}

/** The voter behind this request's session cookie, or null. Revoked voters and expired sessions count as none. */
export async function sessionVoter(c: Context<AppEnv>): Promise<VoterRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  return c.env.DB.prepare(
    `SELECT v.id, v.role, v.label, v.is_owner, v.revoked_at, v.board_seen_at
       FROM sessions s JOIN voters v ON v.id = s.voter_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND v.revoked_at IS NULL`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first<VoterRow>();
}

/** Require a live session. Answers 401 (or `status`) without one. */
export function requireVoter(status: 401 | 404 = 401): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const voter = await sessionVoter(c);
    if (!voter) return c.json({ error: status === 404 ? "not_found" : "no_session" }, status);
    c.set("voter", voter);
    await next();
  };
}
