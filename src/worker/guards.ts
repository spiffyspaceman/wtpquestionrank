// Request guards that apply before any route: host, origin, body size, response headers.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";

export const VOTER_BODY_LIMIT = 2 * 1024;
export const ADMIN_BODY_LIMIT = 1024 * 1024;

/** True for /api, /api/..., /admin, /admin/... */
export function isDataPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || path === "/admin" || path.startsWith("/admin/");
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

/** The Origin a state-changing request must carry. Local hosts use http (wrangler dev only). */
export function expectedOrigin(prodHost: string): string {
  return (isLocalHost(prodHost) ? "http://" : "https://") + prodHost;
}

/**
 * Host guard: /api and /admin answer only on PROD_HOST. Preview builds, workers.dev and Version URLs
 * get 404 and so never touch production data, whatever bindings they have.
 */
export const hostGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  // Plain http is never served: a code typed into an http page would cross the network unencrypted. Reads are
  // redirected; anything else is refused. Local development (http://localhost) is exempt.
  if (url.protocol === "http:" && !isLocalHost(url.host)) {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "https_required" }, 400);
    url.protocol = "https:";
    return c.redirect(url.href, 308);
  }
  if (isDataPath(url.pathname) && url.host !== c.env.PROD_HOST) return c.json({ error: "not_found" }, 404);
  await next();
};

/** Origin check and body cap on every state-changing request to /api and /admin. */
export const originAndSize: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !isDataPath(path)) return next();
  if (c.req.header("origin") !== expectedOrigin(c.env.PROD_HOST)) return c.json({ error: "bad_origin" }, 403);
  const limit = path.startsWith("/admin") ? ADMIN_BODY_LIMIT : VOTER_BODY_LIMIT;
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > limit) return c.json({ error: "body_too_large" }, 413);
  // Content-Length can be absent (chunked); count the body as it streams and stop at the cap.
  if (await exceeds(c.req.raw.clone().body, limit)) return c.json({ error: "body_too_large" }, 413);
  await next();
};

async function exceeds(body: ReadableStream<Uint8Array> | null, limit: number): Promise<boolean> {
  if (!body) return false;
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return true;
    }
  }
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers on every response, pages included. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  const set = (k: string, v: string) => {
    try {
      h.set(k, v);
    } catch {
      // Immutable headers (a fetched asset response): copy into a new Response.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set(k, v);
    }
  };
  set("Content-Security-Policy", CSP);
  set("X-Robots-Tag", "noindex, nofollow");
  set("Referrer-Policy", "no-referrer");
  set("X-Content-Type-Options", "nosniff");
  set("X-Frame-Options", "DENY");
  set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  set("Strict-Transport-Security", "max-age=31536000");
  const path = new URL(c.req.url).pathname;
  if (isDataPath(path)) set("Cache-Control", "no-store");
  // Built files carry a content hash in their name, so a browser may keep them for good; the fonts never change
  // under their names. Without this every page view asks the Worker again for each file (the default is max-age=0).
  else if (c.res.status === 200 && path.startsWith("/assets/")) set("Cache-Control", "public, max-age=31536000, immutable");
  else if (c.res.status === 200 && path.startsWith("/fonts/")) set("Cache-Control", "public, max-age=2592000");
};
