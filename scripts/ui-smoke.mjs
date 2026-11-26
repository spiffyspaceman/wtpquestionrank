// Browser smoke test of the voting flow against a local copy of the site.
//
//   npm run build && npm run test:ui          (SHOTS=some/dir saves screenshots there)
//
// Not part of `npm test`: it needs a Chromium that Playwright can drive, which the Cloudflare build image does not
// have. Install Playwright yourself (`npm i -g playwright && npx playwright install chromium`) or run it where one is
// provided. The Worker's outbound calls are stubbed (Turnstile always passes), so no network is needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// A database of its own for each run, so a run never sees the last run's rounds and voters.
const PERSIST = fs.mkdtempSync(path.join(os.tmpdir(), "wtpqr-smoke-"));
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
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "wtpquestionrank", "--local", "--persist-to", PERSIST], { stdio: "ignore" });
  worker = await unstable_startWorker({
    config: "wrangler.jsonc",
    dev: {
      server: { hostname: "127.0.0.1", port: PORT },
      persist: PERSIST,
      inspector: false,
      outboundService: () => Response.json({ success: true, hostname: "localhost" }),
    },
  });
  await worker.ready;

  // Seed through the admin API: items, an open round, one fresh judge code.
  const adminLogin = await post("/admin/api/login", { secret: vars.ADMIN_SECRET });
  if (adminLogin.status !== 200) throw new Error("admin login failed: is ADMIN_SECRET set and Access off in .dev.vars?");
  const adm = adminLogin.cookie;
  // The full question set, as on the site: its round opens in stages, the 36 launch questions first, with footnotes.
  const sets = await get("/admin/api/builtin-sets", adm);
  const loaded = await post(`/admin/api/builtin-sets/${sets.sets[0].id}`, {}, adm);
  if (loaded.status !== 200) throw new Error("loading the full set failed: " + JSON.stringify(loaded.json));
  const ROUND = loaded.json.roundCreated;
  await post(`/admin/api/rounds/${ROUND}/open`, {}, adm);
  const code = (await post("/admin/api/codes", { role: "judge", count: 1 }, adm)).json.codes[0];
  const session = (await post("/api/redeem", { code: code.code, turnstileToken: "smoke-token" })).cookie;

  browser = await chromium.launch();

  // An invite link signs in with one tap. Turnstile's script is replaced by a stand-in that passes at once (the
  // Worker's own check is stubbed above), so this runs without the network.
  const linked = (await post("/admin/api/codes", { role: "coach", count: 1 }, adm)).json.codes[0];
  const linkCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await linkCtx.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.turnstile={render:function(el,o){setTimeout(function(){o.callback('smoke-token')},0);return 'w'},reset:function(){}};" }),
  );
  const linkPage = await linkCtx.newPage();
  await linkPage.goto(`${B}/#${linked.code}`);
  await linkPage.waitForURL(B + "/start");
  await linkPage.waitForSelector("#startBtn:not([hidden])");
  check((await linkPage.textContent("#who")) === "Coach", "an invite link signs in with one tap and lands on the home page");
  check(!(await linkPage.evaluate(() => history.length > 3)) && !linkPage.url().includes(linked.code), "the code is not left in the address bar");
  // On a phone the two questions stack.
  await linkPage.goto(B + "/vote");
  await linkPage.waitForSelector("#judge:not([hidden])");
  const stacked = await linkPage.evaluate(() => document.querySelector("#rightCard").getBoundingClientRect().top >= document.querySelector("#leftCard").getBoundingClientRect().bottom);
  check(stacked && (await linkPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), "on a phone the questions stack and the page fits the width");
  await linkCtx.close();

  // Sign-up by email: the owner's sign-up link opens a form (email, optional name, role); afterwards the address
  // typed in the sign-in box is the way back in.
  const joinLink = (await post("/admin/api/join-links", {}, adm)).json;
  const joinCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // The stand-in issues a fresh token after reset(), as the real widget does: the page needs one for each request.
  await joinCtx.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "window.turnstile={render:function(el,o){window.__o=o;setTimeout(function(){o.callback('smoke-token')},0);return 'w'},reset:function(){setTimeout(function(){window.__o.callback('smoke-token-again')},0)}};",
    }),
  );
  const joinPage = await joinCtx.newPage();
  joinPage.on("pageerror", (e) => failures.push("join page: " + e.message));
  await joinPage.goto(B + "/join");
  await joinPage.waitForFunction(() => !document.querySelector("#msg").hidden);
  check(!(await joinPage.isVisible("#join")) && (await joinPage.textContent("#msg")).includes("sign-up link"), "the sign-up page without its link shows no form");
  await joinPage.goto(`${B}/join#${joinLink.word}`);
  await joinPage.waitForSelector("#join");
  check(!joinPage.url().includes(joinLink.word), "the sign-up link's word is not left in the address bar");
  check(!(await joinPage.isVisible("#profile")) && (await joinPage.textContent("#go")) === "Continue", "sign-up asks for the email alone at first");
  if (SHOTS) (fs.mkdirSync(SHOTS, { recursive: true }), await joinPage.screenshot({ path: `${SHOTS}/join-first.png`, fullPage: true }));
  await joinPage.fill("#email", "Smoke.Tester@Example.org");
  await joinPage.click("#go");
  await joinPage.waitForSelector("#profile:not([hidden])");
  check((await joinPage.textContent("#go")) === "Sign up and start" && (await joinPage.evaluate(() => document.activeElement?.id)) === "profileNote", "a new address is then asked for a name and a role");
  await joinPage.waitForTimeout(100);
  await joinPage.click("#go");
  check((await joinPage.textContent("#msg")).includes("Choose the role"), "sign-up asks for a role before it finishes");
  await joinPage.fill("#name", "Smoke Tester");
  await joinPage.check('input[name="role"][value="teacher"]');
  if (SHOTS) (fs.mkdirSync(SHOTS, { recursive: true }), await joinPage.screenshot({ path: `${SHOTS}/join.png`, fullPage: true }));
  check((await joinPage.locator('input[name="role"]').count()) === 5 && (await joinPage.locator('input[name="role"][value="student"]').count()) === 0, "the roles offered are the five adult roles");
  await joinPage.click("#go");
  await joinPage.waitForURL(B + "/start");
  await joinPage.waitForSelector("#startBtn:not([hidden])");
  check((await joinPage.textContent("#who")) === "Teacher", "signing up by email lands on the home page in the chosen role");
  check(!(await joinPage.content()).toLowerCase().includes("smoke.tester"), "the address is not shown on the voter's page");
  await joinPage.click("#signOut");
  await joinPage.waitForURL(B + "/");
  await joinPage.waitForFunction(() => window.turnstile);
  await joinPage.fill("#code", "smoke.tester@example.org");
  await joinPage.waitForTimeout(100);
  await joinPage.click("#go");
  await joinPage.waitForURL(B + "/start");
  check(true, "the address typed in the sign-in box signs back in");
  // Opening the sign-up link again later: the email alone signs in, and nothing more is asked.
  await joinPage.click("#signOut");
  await joinPage.waitForURL(B + "/");
  await joinPage.goto(`${B}/join#${joinLink.word}`);
  await joinPage.waitForSelector("#join");
  await joinPage.waitForFunction(() => window.turnstile);
  await joinPage.fill("#email", "smoke.tester@example.org");
  await joinPage.waitForTimeout(100);
  await joinPage.click("#go");
  await joinPage.waitForURL(B + "/start");
  check(true, "through the sign-up link again, a known address signs in with the email alone");
  const listed = (await get("/admin/api/codes", adm)).voters.find((v) => v.email === "smoke.tester@example.org");
  check(Boolean(listed) && listed.name === "Smoke Tester" && listed.role === "teacher", "the owner's list shows the address, the name and the role");
  await joinCtx.close();

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
  // A first visit: the task comes before the Start button, and the zero count is not the headline.
  const order = await page.evaluate(() => {
    const before = (a, b) => Boolean(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { taskFirst: before("#taskH", "#startBtn") && before("#criterion", "#startBtn") && before("#startBtn", "#strongH"), countHidden: document.querySelector("#tallyH").hidden };
  });
  check(order.taskFirst && order.countHidden, "first visit: the task comes first, then Start, then the guidance, without the zero count");
  await shot("start");

  // What you judge: all questions by default; choosing some units saves at once and applies from the next batch.
  const nearStart = await page.evaluate(() => {
    const p = document.querySelector("#slicePanel").getBoundingClientRect(), b = document.querySelector("#startBtn").getBoundingClientRect();
    return b.top >= p.bottom && b.top - p.bottom < 40;
  });
  check((await text("#sliceH")) === "Narrow your set" && nearStart && (await page.isChecked("#judge-mode-all")), "Narrow your set sits right above Start, all questions by default");
  check((await text("#startBtn")) === "Start a batch: all questions", "the Start button names the set it starts");
  await page.check("#judge-mode-some");
  check(await page.isVisible("#judge-unit-1") && (await page.locator(".slice-boxes input:checked").count()) === 8, "choosing some units starts from every box ticked");
  check(await page.isVisible("#judge-bridge") && (await page.isChecked("#judge-bridge")) && (await text("#judge-bridge-why")).includes("ranked against one another"), "the bridge-pair box shows, ticked, and says why it helps");
  for (const u of [1, 2, 3, 6]) await page.uncheck(`#judge-unit-${u}`);
  await page.uncheck("#judge-level-State");
  await page.waitForFunction(() => document.querySelector("#sliceStatus").textContent.includes("Units 4 and 5, Nationals only"));
  check((await text("#startBtn")) === "Start a batch: Units 4 and 5, Nationals only, plus one pair from outside it", "and the button follows the set, bridge pair included");
  await shot("start-slice");
  check((await get("/api/me", session)).slice?.units?.join() === "4,5" && (await get("/api/me", session)).slice?.bridge === true, "the choice is saved on the server");
  await page.uncheck("#judge-bridge");
  await page.waitForFunction(() => document.querySelector("#startBtn").textContent === "Start a batch: Units 4 and 5, Nationals only");
  check((await get("/api/me", session)).slice?.bridge === undefined, "unticking the bridge box saves a set without it");
  await page.check("#judge-bridge");
  await page.waitForFunction(() => document.querySelector("#startBtn").textContent.endsWith("from outside it"));
  await page.uncheck("#judge-level-NF");
  check((await text("#sliceStatus")).includes("at least one"), "an empty level row is refused, not saved");
  await page.check("#judge-mode-all");
  await page.waitForFunction(() => document.querySelector("#sliceStatus").textContent.includes("all questions"));
  check((await get("/api/me", session)).slice === null && !(await page.isVisible("#judge-unit-1")), "and All questions puts it back");

  // Day and night: the toggle switches the colours, names the scheme it leads to, and the choice follows the reader.
  const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const day = await paper();
  const nightOn = () => page.getAttribute("#themeToggle", "aria-checked");
  check((await nightOn()) === "false", "in day colours the Night switch is off");
  await page.click("#themeToggle");
  check((await paper()) !== day && (await nightOn()) === "true", "the switch turns night colours on");
  await shot("start-night");

  // Vote: choose, reasons, Next
  await page.goto(B + "/vote");
  await page.waitForSelector("#judge:not([hidden])");
  check((await text("#position")).startsWith("Pair 1 of 10"), "voting opens on pair 1 of 10");
  check((await paper()) !== day && (await page.getAttribute("#themeToggle", "aria-checked")) === "true", "the night choice carries over to the voting page");
  await shot("vote-night");
  await page.click("#themeToggle");
  check((await paper()) === day, "and the switch turns it off again");
  check(!(await page.isVisible("#after")), "reasons and Next are hidden before a pick");
  // Narrow mid-batch: the set is named on the voting page; a new set starts a new batch at once.
  check((await text("#setText")) === "Your set: all questions." && (await text("#narrowBtn")) === "Narrow", "the voting page names the judge's set");
  {
    const before = (await get("/api/batch", session)).pairs.map((p) => p.pairId);
    await page.click("#narrowBtn");
    check(await page.isVisible("#narrowPanel") && (await page.isChecked("#narrow-mode-some")), "Narrow opens the boxes, everything ticked");
    for (const u of [2, 3, 4, 5, 6]) await page.uncheck(`#narrow-unit-${u}`);
    await page.click("#narrowApply");
    await page.waitForFunction(() => document.querySelector("#msg").textContent.includes("New batch"));
    const after = (await get("/api/batch", session)).pairs.map((p) => p.pairId);
    check(after.length > 0 && !after.some((id) => before.includes(id)), "applying a new set starts a new batch at once");
    check((await text("#setText")).includes("Unit 1") && (await text("#position")).startsWith("Pair 1 of"), "and the page shows it from its first pair");
    // Back to all questions, the same way, for the checks that follow.
    await page.click("#narrowBtn");
    await page.check("#narrow-mode-all");
    await page.click("#narrowApply");
    await page.waitForFunction(() => document.querySelector("#msg").textContent.startsWith("New batch: all questions"));
    await page.waitForSelector("#judge:not([hidden])");
    check((await text("#position")).startsWith("Pair 1 of 10"), "and back to all questions the same way");
  }

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
  const back = await page.evaluate(() => ({
    tallyFirst: Boolean(document.querySelector("#startBtn").compareDocumentPosition(document.querySelector("#taskH")) & Node.DOCUMENT_POSITION_FOLLOWING),
    count: document.querySelector("#tallyH").hidden,
  }));
  const high = await page.evaluate(() => Boolean(document.querySelector("#startBtn").compareDocumentPosition(document.querySelector("#unlockLine")) & Node.DOCUMENT_POSITION_FOLLOWING) && document.querySelector("#startBtn").getBoundingClientRect().top < 260);
  check(back.tallyFirst && !back.count && high, "a returning voter sees the count with Continue right under it");
  await shot("start-returning");
  check((await text("#resumeLine")).includes("8 pairs left"), "home offers the part-done batch (8 pairs left)");

  // Finish the batch
  await page.goto(B + "/vote");
  await page.waitForSelector("#judge:not([hidden])");
  // Another device answers the pair on screen first: that answer stands, and the page says so and moves on.
  const elsewhere = (await get("/api/batch", session)).pairs.find((x) => x.answer === null);
  await post("/api/vote", { pairId: elsewhere.pairId, pick: "R", closeCall: false, clientMs: 1000 }, session);
  await page.click("#leftCard");
  await page.click("#next");
  await page.waitForFunction(() => document.querySelector("#msg").textContent.includes("another device"), null, { timeout: 5000 }).catch(() => {});
  check((await text("#msg")).includes("another device"), "a pair answered on another device first is reported, not shown as saved here");
  const held = (await get("/api/batch", session)).pairs.find((x) => x.pairId === elsewhere.pairId);
  check(held.answer.pick === "R", "and the first answer is the one that stands");
  let linkTried = false, noteSent = false, sawNotes = false;
  for (let i = 0; i < 10 && !(await page.isVisible("#between")); i++) {
    sawNotes ||= (await page.locator(".card .fnotes").count()) > 0;
    // A link in a footnote opens the source; it does not choose the question.
    if (!linkTried && (await page.locator(".card .fnotes a").count())) {
      linkTried = true;
      await page.evaluate(() => {
        const a = document.querySelector(".card .fnotes a");
        a.addEventListener("click", (e) => e.preventDefault(), { once: true });
        a.click();
      });
      check((await page.getAttribute("#pickL", "aria-pressed")) === "false" && (await page.getAttribute("#pickR", "aria-pressed")) === "false", "a click on a footnote link does not choose the question");
    }
    await page.click("#leftCard");
    if (!noteSent) {
      // Other with a few words, and Close call, reach the server with the vote.
      noteSent = true;
      await page.click("#pills .pill >> nth=9");
      await page.fill("#otherText", "asks for a judgment");
      await page.check("#close");
    }
    await page.click("#next");
    await page.waitForTimeout(150);
  }
  check(sawNotes, "published footnotes show under the questions");
  // (Asking for the batch again here would start the next one, so the saved vote is read from the owner's export.)
  const reasonsCsv = await (await fetch(`${B}/admin/api/rounds/${ROUND}/export/reasons.csv`, { headers: { cookie: adm } })).text();
  const noteRow = reasonsCsv.split("\n").find((l) => l.includes("asks for a judgment"));
  const col = (name) => reasonsCsv.split("\n")[0].split(",").indexOf(name);
  check(Boolean(noteRow) && noteRow.split(",")[col("close_call")] === "1" && noteRow.split(",")[col("reason")] === "other", "an Other note and Close call are saved with the vote");
  check(await page.isVisible("#between"), "the batch ends on Batch done");
  check((await focused()) === "betweenH", "Batch done takes focus");
  await shot("batch-done");

  // Leaderboard: more votes through the API until it unlocks (ten votes; one pair above was skipped, and the change
  // of set left pairs unanswered). One voter's handful of votes ranks nothing, and the page says so plainly.
  for (let k = 0; k < 3 && !(await get("/api/me", session)).unlocked; k++) {
    const more = await get("/api/batch", session);
    for (const p of more.pairs.filter((x) => x.answer === null)) await post("/api/vote", { pairId: p.pairId, pick: "L", closeCall: false, clientMs: 30000 }, session);
  }
  // One voter's ten votes open the board at once: there is no wait for other voters.
  await page.goto(B + "/board");
  await page.waitForSelector("#content:not([hidden])");
  check(/\d+ votes\./.test(await text("#summary")), "the leaderboard opens after ten votes and says how many votes it rests on");
  check((await text("#noneRanked")).includes("furthest along"), "with nothing ranked, it says how far along the questions are");
  check(!(await page.isVisible("#explore")), "with nothing ranked, the charts are left out");
  const cells = await page.$$eval("#all tbody tr td:nth-child(2)", (tds) => tds.map((td) => td.textContent));
  check(cells.length > 0 && cells.every((c) => /^\d+ of 5$/.test(c)), "an unranked question shows its comparison count, not a rating");
  check(!(await page.isVisible("#roleNote")) && (await page.locator("#tabs button").count()) === 2, "the voter's own role board is offered beside All adults, with no wait for other voters");
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the leaderboard fits a phone's width");
  await shot("board-phone");
  await page.setViewportSize({ width: 1280, height: 900 });

  // A ranked leaderboard: five more judges vote through the API until every question in play has a rank.
  for (let j = 0; j < 5; j++) {
    const c = (await post("/admin/api/codes", { role: "judge", count: 1 }, adm)).json.codes[0];
    const s = (await post("/api/redeem", { code: c.code, turnstileToken: "smoke-token" })).cookie;
    for (let b = 0; b < 6; b++)
      for (const p of (await get("/api/batch", s)).pairs.filter((x) => x.answer === null))
        await post("/api/vote", { pairId: p.pairId, pick: p.left.stem < p.right.stem ? "L" : "R", closeCall: false, reasons: ["position"], clientMs: 30000 }, s);
  }
  await page.goto(B + "/board");
  await page.waitForSelector("#top .hero-card");
  check((await text("#top .hero-card .score strong")) === "#1" && /^rating \d+$/.test(await text("#top .hero-card .score .rating")), "the top card leads with the rank, the rating beside it");
  check((await page.locator("#top10 > li").count()) === 4 && (await text("#top10 > li >> nth=0 >> .score strong")) === "#2" && (await text("#top10H")) === "Top 5", "the list carries on from #2 to #5");
  check(Boolean(await text("#top .hero-card .summ")) && (await page.locator("#top10 > li .summ").count()) === 4, "each top question shows its topic label");
  await page.click("#moreTop");
  check((await page.locator("#top10 > li").count()) === 9 && (await text("#top10H")) === "Top 10" && (await page.getAttribute("#moreTop", "aria-expanded")) === "true", "Show the top 10 opens the list to #10");
  await page.click("#moreTop");
  check((await page.locator("#top10 > li").count()) === 4, "and closes it again");
  const wide = await page.evaluate(() => {
    const list = document.querySelector("#top10").getBoundingClientRect(), main = document.querySelector("main").getBoundingClientRect(), ex = document.querySelector("#explore").getBoundingClientRect(), top = document.querySelector("#topSection").getBoundingClientRect();
    return list.width > main.width * 0.8 && ex.bottom <= top.top;
  });
  check(wide, "the chart comes first, then the top question and the list at full width");
  check(await page.isVisible("#explore") && (await page.locator("#chart svg").count()) === 1, "the charts appear once questions are ranked");
  for (const t of ["scatter", "dist", "h2h"]) await page.click(`#tab-${t}`);
  check((await page.locator("#chart table.heat").count()) === 1, "each chart tab draws, the head-to-head table last");
  check((await page.locator("#tabs button").count()) === 2 && !(await page.isVisible("#roleNote")), "both boards are still offered once more judges have voted");
  check((await text("#all tbody tr >> nth=0 >> td >> nth=0")) === "#1", "the table lists ranks first");
  // The filter: the same boxes as the home page; ranks stay the round's ranks.
  await page.click("#filterSummary");
  for (const u of [2, 3, 4, 5, 6]) await page.uncheck(`#show-unit-${u}`);
  await page.waitForFunction(() => document.querySelector("#summary").textContent.includes("Showing"));
  const tags = await page.$$eval("#all tbody tr td.q .tag", (els) => els.map((e) => e.textContent));
  check(tags.length > 0 && tags.every((t) => /U1Q/.test(t)) && /U1Q/.test(await text("#top .hero-card .tag")), "the filter shows only the units ticked, top question included");
  await shot("board-filtered");
  await page.click("#filterAll");
  check(!(await text("#summary")).includes("Showing"), "Show all clears it");
  // Whether the first 36 have all settled by now depends on the pairs drawn, so the round may or may not have taken
  // its next group of 24; the Unit 1 set chosen above may also have brought in Unit 1 questions, 6 at a time. Either
  // way the page and the admin table must agree on the number in play.
  const inPlay = Number((/(\d+) of \d+ questions are in play/.exec(await text("#summary")) ?? [])[1]);
  check(inPlay >= 36 && inPlay % 6 === 0, "the summary says how many questions are in play");
  await shot("board-ranked");
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the ranked leaderboard fits a phone's width");
  await page.setViewportSize({ width: 1280, height: 900 });

  // Admin: the page loads its tables and shows the staged round.
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { cookie: adm } });
  const adminPage = await adminCtx.newPage();
  adminPage.on("pageerror", (e) => errors.push("admin: " + e.message));
  await adminPage.goto(B + "/admin");
  await adminPage.waitForSelector("#rounds tbody tr");
  check(new RegExp(`${inPlay} of \\d+ in play`).test(await adminPage.textContent("#rounds tbody tr")), "the admin page lists the round with its questions in play");
  await adminPage.waitForSelector("#joinLinks tbody tr");
  check((await adminPage.textContent("#joinLinks tbody tr")).includes("open") && (await adminPage.textContent("#voters")).includes("smoke.tester@example.org"), "the admin page lists the sign-up link and the address that signed up");
  await adminCtx.close();

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
  fs.rmSync(PERSIST, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} failed` : "\nAll passed");
process.exit(failures.length ? 1 : 0);
