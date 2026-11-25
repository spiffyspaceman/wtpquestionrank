// WTP Question Rank Worker: guards, voter API, admin API, static pages.
import { Hono } from "hono";
import { accessConfigured, adminActor } from "./access";
import { adminApi } from "./admin";
import type { AppEnv } from "./env";
import { hostGuard, originAndSize, securityHeaders } from "./guards";
import { voterApi } from "./voter";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", hostGuard);
app.use("*", originAndSize);

app.route("/api", voterApi);
app.route("/admin/api", adminApi);

// The admin page. With Access configured, it needs a valid Access token like every other /admin request.
// Without Access (fallback), the page is a login shell and holds no data.
app.get("/admin", async (c) => {
  if (accessConfigured(c.env) && !(await adminActor(c))) return c.json({ error: "not_admin" }, 403);
  return c.env.ASSETS.fetch(new Request(new URL("/admin", c.req.url)));
});
app.all("/admin/*", (c) => c.json({ error: "not_found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// Everything else is a static page or asset.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error(err);
  // A signed-in admin is told what went wrong; everyone else gets no detail.
  const admin = Boolean(c.get("actor"));
  return c.json({ error: "server_error", ...(admin ? { message: `Server error: ${String(err?.message ?? err).slice(0, 300)}` } : {}) }, 500);
});

export default app;
