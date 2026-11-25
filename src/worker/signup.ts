// Sign-up by email (owner decision, 25 Nov 2026; migration 0009). An adult who opens the owner's sign-up link gives
// an email address, an optional name and the role that fits them best, and can vote at once. The address is not
// verified: it works as a username, so anyone who knows a voter's address and the site can sign in as them. The
// owner accepted that for a round shared only with people he trusts. Students do not sign up this way.
import { POOLED_ROLES, type Role } from "../rating/config";
import { inviteCode, normalizeCode } from "./auth";
import type { Env } from "./env";
import { ROLE_NAMES } from "./pools";
import { cleanNote } from "./reasons";
import { hmacHex } from "./util";

/** The roles the sign-up form offers: the adult roles. A student is given a code by the owner. */
export const SIGNUP_ROLES: readonly Role[] = POOLED_ROLES;

export const EMAIL_MAX = 254;
export const NAME_MAX = 60;

/** A plausible address, lower-cased and trimmed; null when it is not one. The site never sends mail to it. */
export function cleanEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length < 6 || e.length > EMAIL_MAX) return null;
  return /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e) && !e.includes("..") ? e : null;
}

/** An optional name: control characters out, runs of white space made one space. Null for none; false when too long. */
export function cleanName(v: unknown): string | null | false {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 4 * NAME_MAX) return false;
  const n = cleanNote(v);
  if (n.length > NAME_MAX) return false;
  return n || null;
}

/** True when what was typed in the sign-in box is an email address and not an invite code. */
export const looksLikeEmail = (v: string): boolean => v.includes("@");

/** The word of a sign-up link, derived from CODE_PEPPER and the link's id, in the shape of an invite code. */
export async function joinWord(env: Env, linkId: string): Promise<string> {
  // The same derivation as an invite code, under its own prefix, so a link's word can be shown again at any time.
  return inviteCode(env, "join-link:" + linkId);
}

/** The only form of a link's word the database holds. */
export async function joinWordHash(env: Env, word: string): Promise<string> {
  if (!env.CODE_PEPPER) throw new Error("CODE_PEPPER is not set");
  return hmacHex(env.CODE_PEPPER, "join:" + normalizeCode(word));
}

/** The next free label for a role ("Judge 08"), from the labels in use. */
export async function nextLabel(db: D1Database, role: string): Promise<string> {
  const name = ROLE_NAMES[role];
  const labels = await db.prepare("SELECT label FROM voters WHERE label LIKE ?").bind(`${name} %`).all<{ label: string }>();
  const next = 1 + Math.max(0, ...labels.results.map((l) => Number(l.label.slice(name.length + 1)) || 0));
  return `${name} ${String(next).padStart(2, "0")}`;
}
