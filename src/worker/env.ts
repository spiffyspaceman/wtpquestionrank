// Bindings, variables and secrets the Worker reads, and the Hono context types.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The only host allowed to reach /api and /admin. */
  PROD_HOST: string;
  /** e.g. "yourteam.cloudflareaccess.com". Empty until Access is set up. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag. Empty until Access is set up. */
  ACCESS_AUD: string;
  TURNSTILE_SITEKEY: string;
  /** Secret. HMAC key for invite codes and the daily attempt salt. Losing it invalidates every code. */
  CODE_PEPPER?: string;
  /** Secret. Turnstile secret key. */
  TURNSTILE_SECRET?: string;
  /** Secret, optional. Used only when Access is not configured. */
  ADMIN_SECRET?: string;
}

export interface VoterRow {
  id: string;
  role: string;
  label: string;
  is_owner: number;
  revoked_at: string | null;
  board_seen_at: string | null;
}

export interface RoundRow {
  id: string;
  name: string;
  item_set_id: string;
  state: "draft" | "open" | "frozen" | "closed";
  created_at: string;
  opened_at: string | null;
  frozen_at: string | null;
  closed_at: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { voter: VoterRow; actor: string };
};
