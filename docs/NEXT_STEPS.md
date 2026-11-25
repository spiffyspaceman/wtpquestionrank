# Next steps (launch, BUILD_STEPS §10)

*Saved 24 November 2026. When the owner asks "what are the next steps", answer from this file and update it as
steps finish.*

## Where things stand

- Live at `https://wtpquestionrank.spiffyspaceman.com`. Pushes to `main` deploy through Workers Builds after the tests pass.
- D1 `wtpquestionrank` (id `de56eb48-…10dc`) has migration 0001 applied.
- Turnstile, `CODE_PEPPER` and `TURNSTILE_SECRET` are set and verified on the live site.
- Cloudflare Access protects `/admin` (team `falling-mouse-d5eb.cloudflareaccess.com`, one-time PIN), and the Worker
  verifies the Access token itself.
- A Cloudflare API token "wtpquestionrank D1 setup" (D1 Edit plus Workers Scripts Read) is saved on the Claude
  environment "wtpquestionrank". It expires 2 December 2026. Delete it in My Profile > API Tokens once launch is done.

## Done on 25 November 2026

- Item set `state-launch-v1` loaded: 36 published questions; stored file hash equals the pre-registered
  `8cb28a9e…53510d0` (Claude checked in D1).
- **Round 1 opened at 01:39 UTC**; the item set froze then.
- Test codes `Other 01`, `Other 02`, `Other 03` revoked unused (no votes). **`Other 04`** (made 01:39, so **Show link**
  works for it) is the live test code: one batch of 10 votes so far, leaderboard not yet opened. Claude checked in D1
  (state as of the owner's "next steps" question on 25 Nov).
- From 25 Nov the admin Voters table has **Show link** for any active code (recomputed from `CODE_PEPPER`, audited;
  only the hash is stored).
- Cloudflare's zone-wide Web Analytics beacon: left in place, blocked by the site's CSP (owner decision).
- Turnstile does not pass a headless browser, so live test votes are the owner's to cast.

- Built 25 Nov, live once pushed: the voter home page `/start` (sign-in and invite links land there; it offers
  "Continue your batch" when one is part-done), optional reason pills (up to two of nine), tap-a-card to pick, and
  the admin **Study health** panel (data gate, votes per day, reasons given, rater flags). The deploy applies
  migration 0002 (`vote_reasons`) to D1 before the Worker goes live. Both voter-facing changes are logged in
  DEVIATIONS.md.

## Owner: now

1. **Finish the test with `Other 04`** (Show link in admin if needed): judge 10 more pairs to reach 20, ticking one
   close call, skipping one, tapping a reason or two, and picking at least once by tapping a card; the Leaderboard
   link appears. Check that the home page counts the votes and, if you stop mid-batch, offers to continue it. Open it, try **Info** and the unit/year chart. Then open
   the same link on a second device: you should land where the first left off.
2. Confirm whether the **24 added question texts** were checked against CCE's PDFs. The item set is now frozen, so a
   wrong text found later is a logged deviation, not a fix.

## Claude: after the test votes

3. Build the round export from D1 and run `analysis/analyze.ts` on it with the method A outputs in `llm-arm/`.

## Owner: finish

4. In `/admin`, select **Refresh intervals** and then **JSON** (it downloads in pages and saves one file). Upload the
   JSON to Claude, who compares it with the export from step 3.
5. **Revoke `Other 04`.** Its sessions end, the caches rebuild and saved intervals are dropped; the analysis excludes
   revoked codes.
6. Make the real codes by role, ticking **My own code** for the owner's. Download each CSV (label, role, code, link)
   and keep it with the list of names (any code can be shown again with **Show link**). Send each person their link.
7. As votes come in, select **Refresh intervals** now and then, and export the JSON and **reasons CSV** at least
   weekly (reasons are not in the JSON). Glance at **Study health** for the gate and for flagged raters. Time Travel keeps
   only 7 days on Free, and the admin banner reminds you.
8. At freeze: export the JSON and run the analysis command in BUILD_STEPS §10 step 5.
9. After launch, delete the Cloudflare API token "wtpquestionrank D1 setup" (expires 2 December 2026 anyway).

## Later (owner decisions, 25 Nov 2026)

- **Round 2: every published WTP question.** After Round 1 freezes, Claude builds a full item set (State and National
  Finals, every cycle) from CCE's published PDFs and adds a one-click "Load" in admin, so no JSON file is needed.
  `items/corpus.csv` lists 420 questions (216 State, 204 NF) but holds scores only, not text. Round 1 stays the
  pre-registered 36.
- **Two quoted sources found but not yet confirmed**, so not linked on the leaderboard: John Adams to Richard Price,
  19 April 1790 (Founders Online, Adams/06-20-02-0188), and Paul Howe, "Eroding Norms and Democratic
  Deconsolidation," *Journal of Democracy* 28:4 (2017). Founders Online blocks automated readers, and the journal page
  shows only the opening. If the owner opens them and sees the quoted words, add them to `items/sources_v1.json`.
- Leaderboard unlock stays at 20 votes (pre-registered).

