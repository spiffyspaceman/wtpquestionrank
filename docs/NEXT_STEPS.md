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

## All published questions in one standing round (owner decisions, 25 Nov 2026)

The owner chose: every published State and National Finals question he has, **in one round** that keeps growing as
questions are added, on **Workers Paid** (upgraded 25 Nov); the first round renamed **"Test"** (done in production
25 Nov) and ended when the big round opens, which ends the registered comparison without a verdict (DEVIATIONS.md).

**Texts: 438 questions, the owner's full set** (`items/transcribed.json`; bundled as `items/rounds/all.json`).

| Level | Cycles | Questions | Source |
|---|---|---|---|
| State | 2014-15 to 2026-27 (13) | 234 | CCE's PDFs |
| National Finals | 2014-15 to 2019-20 (6) | 108 | CCE's PDFs |
| National Finals | 2020-21 to 2025-26 (6; two cycles have 2 questions a unit) | 96 | the owner's text extracts of CCE's PDFs |

How far to trust them:
- The transcriber reproduces all 36 launch texts exactly.
- For the 17 cycles with both a PDF and a usable extract, the two agree on every question (after joining words
  hyphenated across a line, which both got wrong in five places).
- The 2014-15 State PDF has a faulty text layer (fragments repeated). Claude read all six page images and corrected
  27 places; one more correction in 2025-26. Each is listed in `items/corrections.json`.
- **Not checked against a PDF:** the 96 National Finals questions from 2020-21 on. They come from the owner's
  extracts alone. A wrong text found after loading cannot be edited; the corrected text would be a new question.
- Nothing before 2014-15 is in hand, so the set covers 13 years, not 20.

**What a round this size costs** (Node timings; the plan is now Workers Paid): about 0.45 s of CPU for a new batch
and 0.1 s for a leaderboard view at 438 questions. Every question reaches 10 comparisons (a rank) after about 2,200
votes and 30 comparisons after about 6,600.

**Live on `main` since 25 Nov, 04:54 UTC (`d980440`; 154 tests pass).** Checked in production after the deploy:
migrations 0005 and 0006 applied; the one earlier leaderboard view carried over to the round "Test"; the launch set
is not open-ended; 20 votes, one round ("Test", open). What went live: migrations 0005 (several open
rounds; `after_board` and the correction lock per round) and 0006 (open-ended sets: questions can join the running
round); batch assignment; no round name on voter pages; the bundled 438-question set and the admin button **Load or
update the full question set**; **Rename** for rounds; a test that runs a batch, 20 votes, the leaderboard and the
export on all 438.

**Footnotes (owner decision, 25 Nov; built on the dev branch, not on `main`; 161 tests pass).** Each question
shows CCE's published source notes: the asterisk in the text, the note under the bullets, on the voting page and the
leaderboard, with "accessed <date>" left out. 341 notes on 317 of the 438 questions. Migration 0007.

**Link check, 25 Nov, from this environment** (`items/links.json`, 189 addresses):

| Result | Count | Shown as |
|---|---|---|
| Page opened | 34 (30 hold the quoted words) | a link |
| Confirmed dead | 0 | |
| Could not be checked | 155 | plain text, not a link |

Of the 155, 143 sit on 74 hosts this environment's network refuses (two requests to allow them were rejected by the
service), and 12 are Founders Online, which turns away automated readers. The four pages that opened without the
quoted words: `avalon.law.yale.edu/18th_century/mchenry.asp` (State 2026-27 U1Q1),
`press-pubs.uchicago.edu/founders/documents/v1ch14s47.html` (NF 2021-22 U6Q2), the Journal of Democracy article
(State 2018-19 U6Q2; the page shows only the opening), and a Cornell syllabus page (State 2024-25 U5Q2).

### Owner: now

1. **Say "merge"** for the footnotes build (migration 0007; voters will see footnotes under questions).
2. In `/admin`: revoke `Other 04` and **Close** the round "Test" first (otherwise its 36 questions show footnotes
   too). Closing it ends the registered comparison without a verdict and cannot be undone.
3. Press **Load or update the full question set** (438 questions with their footnotes; it makes a draft round "All
   questions", which you can rename). Open it, make the codes by role, and send the links.
4. **To finish the link check**, either allow the hosts in this environment's settings (Network access > Allowed
   domains; the list is in `items/links.json` under "the network here refused the host") and tell Claude, or run
   `python3 items/check_links.py` on your own computer from a copy of the repo and send back `items/links.json`.
   Until then those addresses show as plain text.
5. Weekly: **Download full backup**, and the JSON, reasons and corrections exports.

### Adding questions later (for example National Finals 2026-27)

1. Send Claude the new PDF (or a text extract of it) when CCE publishes it.
2. Claude transcribes it, checks it against the file, rebuilds the set, checks the new links, and merges at your word.
3. You press **Load or update the full question set** in `/admin`. The new questions join the running round at
   once, dated, and are paired first until they catch up. Nothing already loaded changes.

Without Claude: the Items form in `/admin` takes a JSON item file. Uploading a newer `all.json` (the whole set plus
the new questions, same ids and texts for the old ones) does the same thing. The file format is in
`items/rounds/all.json`.

### Claude: next

- After the merge: time a batch on the deployed Worker; cut the cost of "Refresh intervals" for a round this size.
- When the links can be checked: rerun `items/check_links.py`; for each dead one, look for the same source elsewhere,
  open it, find the quoted words, and record it as the replacement; otherwise the address is dropped.

## After the audit of 25 Nov 2026 (`docs/AUDIT_2026-11-25.md`)

**Live on `main` (merged 25 Nov at the owner's word):** chunked question lookups, the correction cache fix, https
only, long caching for hashed files, two new `corrections.csv` columns, keyboard fixes on the voting page, the export
order.

**Also live on `main` (merged 25 Nov at the owner's word, `6873a9a`):**
- a vote from before the leaderboard cannot be changed once the voter has opened it (DEVIATIONS.md);
- Sign out on `/start`; the unchosen question stays readable; a switch for letter and number keys; four short
  status lines (DEVIATIONS.md);
- admin: **Download full backup**, the invitation tracker in the Voters table, the gate forecast in Study health;
- `npm run test:ui`, a browser smoke test of the voting flow (not part of the deploy).

### Owner: now

A. **Look at the live voting page once** with `Other 04` before revoking it: pick a side (the other question should
   stay readable on a dashed outline), choose two reasons ("Two chosen"), go Back ("Next saves the change"), and try
   Sign out on `/start`. In `/admin`, try **Download full backup** and look at the Voters table and Study health.
B. **Cloudflare, two settings.** The saved API token cannot read or change either (it holds D1 Edit and Workers
   Scripts Read only), so these are yours:
   1. Workers & Pages > `wtpquestionrank` > Settings > Build > Build command: set it to
      `npm ci && npm run typecheck && npm test && npm run build`.
   2. Always Use HTTPS (zone `spiffyspaceman.com` > SSL/TLS > Edge Certificates). It is zone-wide, so it also changes
      `reader.spiffyspaceman.com`. Optional: the Worker now redirects http to https by itself.
C. **Method A2 is done** (25 Nov): 30 judges, 3,780 judgments, none invalid. Four judges appear to have ranked the
   questions first; by your decision all 30 stay and a 26-judge fit is reported beside it (`DEVIATIONS.md`). At the
   analysis (step 8), run `analysis/analyze.ts` three times: with `--llm-out llm-arm/out` (method A, the verdict),
   `--llm-out llm-arm/out-a2`, and `--llm-out llm-arm/out-a2-without4`, each with its own `--out` folder.
D. Add to the weekly routine in step 7: **Download full backup** (it holds the batches and pairing trail that no
   other export has).

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

