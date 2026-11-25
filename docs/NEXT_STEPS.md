# Next steps (launch, BUILD_STEPS §10)

*Saved 24 November 2026. When the owner asks "what are the next steps", answer from this file and update it as
steps finish.*

## Where things stand

- Live at `https://wtpquestionrank.spiffyspaceman.com`. Pushes to `main` deploy through Workers Builds after the tests pass.
- D1 `wtpquestionrank` (id `de56eb48-…10dc`): each deploy applies any new migration before the Worker goes live
  (0001 to 0004 exist in the repo; production was not read during the 25 Nov audit).
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
  "Continue your batch" when one is part-done), optional reason pills (up to two of nine, plus Other with up to 20 words), choose-then-Next voting, Back and Forward within a batch (changed answers count; `corrections.csv`), and
  the admin **Study health** panel (data gate, votes per day, reasons given, rater flags). The deploy applies
  migration 0002 (`vote_reasons`) to D1 before the Worker goes live. Both voter-facing changes are logged in
  DEVIATIONS.md.

- **Leaderboard redesigned (25 Nov, live):** top question, #2–#10 beside four adjustable charts, searchable and
  sortable list. The owner reached 20 test votes with `Other 04` the same day (20 votes in D1 when checked).

## Owner: now

1. **Test with `Other 04`: 20 votes done (25 Nov).** If not tried yet: tick a close call, skip a pair, give a
   reason (once with Other and a few words), go Back and change an answer, and open the new leaderboard (top
   question, Explore charts, search). Then open the same link on a second device: it should land where the first
   left off.
2. Confirm whether the **24 added question texts** were checked against CCE's PDFs. The item set is now frozen, so a
   wrong text found later is a logged deviation, not a fix.

## Claude: after the test votes (done 25 Nov 2026)

3. **Done.** Built the Round 1 export from D1 (read-only, through `votes_effective`, as the admin export does): 1 voter
   (`Other 04`), 20 votes, 0 skips, 0 repeats, 1 close call, 0 corrections, all cast before the leaderboard was
   opened. SHA-256 `f06bf630…54c7`. `analysis/analyze.ts` ran on it with the method A files in `llm-arm/` and returned
   the expected verdict: the data gate fails (1 adult rater of 15; fewest comparisons on any item 0 of 30). The live
   rating cache matches the log (20 comparisons, 13 left wins, in every pool). Method B was not run:
   `Validation_Machine_Records_2026-11-24.jsonl` is not in the repo.

## Owner: finish

4. In `/admin`, select **Refresh intervals** and then **JSON** (it downloads in pages and saves one file). Upload the
   JSON to Claude, who compares it with the export from step 3.
5. **Revoke `Other 04`.** Its sessions end, the caches rebuild and saved intervals are dropped; the analysis excludes
   revoked codes.
6. Make the real codes by role, ticking **My own code** for the owner's. Download each CSV (label, role, code, link)
   and keep it with the list of names (any code can be shown again with **Show link**). Send each person their link.
7. As votes come in, select **Refresh intervals** now and then, and export the JSON, **reasons CSV** and
   **corrections CSV** at least weekly (neither is in the JSON). Glance at **Study health** for the gate and for flagged raters. Time Travel keeps
   only 7 days on Free, and the admin banner reminds you.
8. At freeze: export the JSON and run the analysis command in BUILD_STEPS §10 step 5.
9. After launch, delete the Cloudflare API token "wtpquestionrank D1 setup" (expires 2 December 2026 anyway).

## After the audit of 25 Nov 2026 (`docs/AUDIT_2026-11-25.md`)

**Live on `main` (merged 25 Nov at the owner's word):** chunked question lookups, the correction cache fix, https
only, long caching for hashed files, two new `corrections.csv` columns, keyboard fixes on the voting page, the export
order.

**Built on branch `claude/busy-franklin-ct2lna`, waiting for the owner's word to merge (owner decisions, 25 Nov):**
- a vote from before the leaderboard cannot be changed once the voter has opened it (DEVIATIONS.md);
- Sign out on `/start`; the unchosen question stays readable; a switch for letter and number keys; four short
  status lines (DEVIATIONS.md);
- admin: **Download full backup**, the invitation tracker in the Voters table, the gate forecast in Study health;
- `npm run test:ui`, a browser smoke test of the voting flow (not part of the deploy).

### Owner: now

A. **Say "merge"** and Claude puts the branch above on `main` (it deploys). Nothing in it adds a migration.
B. **Cloudflare, two settings.** The saved API token cannot read or change either (it holds D1 Edit and Workers
   Scripts Read only), so these are yours:
   1. Workers & Pages > `wtpquestionrank` > Settings > Build > Build command: set it to
      `npm ci && npm run typecheck && npm test && npm run build`.
   2. Always Use HTTPS (zone `spiffyspaceman.com` > SSL/TLS > Edge Certificates). It is zone-wide, so it also changes
      `reader.spiffyspaceman.com`. Optional: the Worker now redirects http to https by itself.
C. **Read `PREREG_Addendum_A2_DRAFT.md`** and one packet, for example `llm-arm/packets-a2/b0j0.md`. Answer its three
   open points (the 0.10 margin, close calls, model and effort). On your yes Claude removes DRAFT, hashes the file,
   logs it in DEVIATIONS.md and runs the 30 judges. Nothing has run.
D. After the merge, add to the weekly routine in step 7: **Download full backup** (it holds the batches and pairing
   trail that no other export has).

### Claude: later

- **Round 2 as six rounds by unit** (owner decision, 25 Nov), after Round 1 freezes. Before it opens: migration 0005
  so `after_board` is kept per round, not per voter (audit finding 6); the item sets per unit; the offline linked
  fit.
- Audit items still open, none urgent: a skipped pair later voted on counts as two trials (finding 17); the
  leaderboard's reasons query reads every vote on each view (finding 20); the page ignores `duplicate` from another
  device (finding 21); `/start` says "No round yet" after the last round closes (finding 22); the leaderboard layout
  notes in the design review.

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

