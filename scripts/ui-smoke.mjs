// Browser smoke test of the voting flow against a local copy of the site.
//
//   npm run build && npm run test:ui          (SHOTS=some/dir saves screenshots there)
//
// Not part of `npm test`: it needs a Chromium that Playwright can drive, which the Cloudflare build image does not
// have. Install Playwright yourself (`npm i -g playwright && npx playwright install chromium`) or run it where one is
// provided. The Worker's outbound calls are stubbed (Turnstile always passes), so no network is needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { unstable_startWorker } from "wrangler";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright is not installed. See the note at the top of scripts/ui-smoke.mjs.");
  process.exit(2);
}

const PORT = 8787; // must match PROD_HOST below
const B = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS;
const VARS = ".dev.vars";
const madeVars = !fs.existsSync(VARS);
if (madeVars)
  fs.writeFileSync(
    VARS,
    [
      `PROD_HOST=localhost:${PORT}`,
      "TURNSTILE_SITEKEY=1x00000000000000000000AA",
      "TURNSTILE_SECRET=1x0000000000000000000000000000000AA",
      "CODE_PEPPER=0000000000000000000000000000000000000000000000000000000000000000",
      "ADMIN_SECRET=ui-smoke-admin-secret",
      "ACCESS_TEAM_DOMAIN=",
      "ACCESS_AUD=",
      "",
    ].join("\n"),
  );
const vars = Object.fromEntries(fs.readFileSync(VARS, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

let worker, browser;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

async function post(path, body, cookie) {
  const r = await fetch(B + path, {
    method: "POST",
    headers: { origin: B, "content-type": typeof body === "string" ? "application/octet-stream" : "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], json: await r.json().catch(() => ({})) };
}
const get = async (path, cookie) => (await fetch(B + path, { headers: cookie ? { cookie } : {} })).json();

try {
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "wtpquestionrank", "--local"], { stdio: "ignore" });
  worker = await unstable_startWorker({
    config: "wrangler.jsonc",
    dev: {
      server: { hostname: "127.0.0.1", port: PORT },
      inspector: false,
      outboundService: () => Response.json({ success: true, hostname: "localhost" }),
    },
  });
  await worker.ready;

  // Seed through the admin API: items, an open round, one fresh judge code.
  const adminLogin = await post("/admin/api/login", { secret: vars.ADMIN_SECRET });
  if (adminLogin.status !== 200) throw new Error("admin login failed: is ADMIN_SECRET set and Access off in .dev.vars?");
  const adm = adminLogin.cookie;
  await post("/admin/api/items", fs.readFileSync("items/launch_items_v1.json", "utf8"), adm);
  const status = await get("/admin/api/status", adm);
  if (!status.rounds.some((r) => r.state === "open")) {
    const made = await post("/admin/api/rounds", { name: "UI smoke", itemSetId: "state-launch-v1" }, adm);
    await post(`/admin/api/rounds/${made.json.id}/open`, {}, adm);
  }
  const code = (await post("/admin/api/codes", { role: "judge", count: 1 }, adm)).json.codes[0];
  const session = (await post("/api/redeem", { code: code.code, turnstileToken: "smoke-token" })).cookie;

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { cookie: session } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name) => SHOTS && (fs.mkdirSync(SHOTS, { recursive: true }), await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }));
  const text = (sel) => page.textContent(sel);
  const focused = () => page.evaluate(() => document.activeElement?.id ?? "");

  // Home
  await page.goto(B + "/start");
  await page.waitForSelector("#startBtn:not([hidden])");
  check((await text("#votes")) === "0", "home shows 0 pairs judged for a new code");
  check(await page.isVisible("#signOut"), "home offers Sign out");
  await shot("start");

  // Vote: choose, reasons, Next
  await page.goto(B + "/vote");
  await page.waitForSelector("#judge:not([hidden])");
  check((await text("#position")).startsWith("Pair 1 of 10"), "voting opens on pair 1 of 10");
  check(!(await page.isVisible("#after")), "reasons and Next are hidden before a pick");
  await page.keyboard.press("ArrowRight");
  check((await page.getAttribute("#pickR", "aria-pressed")) === "true", "Right arrow chooses B");
  check((await text("#whyText")) === "Why is B better?", "the reasons heading names the chosen side");
  const leftInk = await page.evaluate(() => getComputedStyle(document.querySelector("#leftCard")).opacity);
  check(leftInk === "1", "the unchosen question keeps full-ink text");
  await page.keyboard.press("1");
  await page.keyboard.press("2");
  check((await text("#reasonsHint")) === "Two chosen", "two reasons: the hint says Two chosen");
  check(await page.isDisabled(".pill >> nth=2"), "two reasons: the other pills are off");
  await shot("vote-picked");
  await page.focus("#next");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#position").textContent.startsWith("Pair 2"));
  check((await focused()) === "position", "after Next, keyboard focus is on the pair counter");

  // Back: the saved answer is shown and can be changed
  await page.click("#back");
  check((await text("#position")) === "Pair 1 of 10, answered", "Back shows pair 1 as answered");
  check((await page.getAttribute("#pickR", "aria-pressed")) === "true", "Back shows the saved pick");
  check(await page.isVisible("#saveHint"), "an answered pair says Next saves the change");
  await page.keyboard.press("ArrowLeft");
  await page.click("#next");
  await page.waitForFunction(() => document.querySelector("#position").textContent.startsWith("Pair 2"));
  const batch = await get("/api/batch", session);
  check(batch.pairs[0].answer?.pick === "L", "the changed answer is the one the server holds");

  // Skip by key, then with the letter keys switched off
  await page.keyboard.press("s");
  await page.waitForFunction(() => document.querySelector("#position").textContent.startsWith("Pair 3"));
  check(true, "S skips a pair");
  await page.evaluate(() => localStorage.setItem("wtpqr-keys-off", "1"));
  await page.keyboard.press("s");
  await page.waitForTimeout(300);
  check((await text("#position")).startsWith("Pair 3"), "with letter keys off, S does nothing");
  await page.keyboard.press("ArrowLeft");
  check((await page.getAttribute("#pickL", "aria-pressed")) === "true", "with letter keys off, arrows still choose");
  await page.evaluate(() => localStorage.removeItem("wtpqr-keys-off"));

  // Enter on a link follows the link
  await page.focus("a.brand");
  await page.keyboard.press("Enter");
  await page.waitForURL(B + "/start");
  check(true, "Enter on the masthead link goes home instead of voting");
  check((await text("#resumeLine")).includes("8 pairs left"), "home offers the part-done batch (8 pairs left)");

  // Finish the batch
  await page.goto(B + "/vote");
  await page.waitForSelector("#judge:not([hidden])");
  for (let i = 0; i < 10 && !(await page.isVisible("#between")); i++) {
    await page.click("#leftCard");
    await page.click("#next");
    await page.waitForTimeout(150);
  }
  check(await page.isVisible("#between"), "the batch ends on Batch done");
  check((await focused()) === "betweenH", "Batch done takes focus");
  await shot("batch-done");

  // Sign out
  await page.goto(B + "/start");
  await page.waitForSelector("#startBtn:not([hidden])");
  await page.click("#signOut");
  await page.waitForURL(B + "/");
  check((await fetch(B + "/api/me", { headers: { cookie: session } })).status === 401, "Sign out ends the session");
  await shot("signed-out");

  check(errors.length === 0, `no script errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.error(e);
} finally {
  await browser?.close();
  await worker?.dispose();
  if (madeVars) fs.rmSync(VARS, { force: true });
}
console.log(failures.length ? `\n${failures.length} failed` : "\nAll passed");
process.exit(failures.length ? 1 : 0);
