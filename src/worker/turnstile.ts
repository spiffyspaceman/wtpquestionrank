// Server-side Turnstile check.
// Docs (read 24 Nov 2026): https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
import type { Env } from "./env";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(env: Env, token: string, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return false; // fail closed
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) {
      console.error(`turnstile siteverify: HTTP ${res.status}`);
      return false;
    }
    const out = (await res.json()) as { success?: boolean; hostname?: string; "error-codes"?: string[] };
    if (out.success !== true) {
      console.error(`turnstile siteverify: ${(out["error-codes"] ?? []).join(",")}`);
      return false;
    }
    // The token must have been solved on this site. Local development uses Cloudflare's test keys, whose tokens
    // report a placeholder hostname, so the check applies only on a real host.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.PROD_HOST) && out.hostname !== env.PROD_HOST) {
      console.error(`turnstile siteverify: hostname ${out.hostname}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`turnstile siteverify: ${String(e)}`);
    return false;
  }
}
