# Next steps

*Rewritten 25 November 2026 after the launch audit (`docs/AUDIT_2026-11-25_launch.md`). When the owner asks "what are
the next steps", answer from this file and update it as steps finish.*

## Where things stand

**Production, read on 25 Nov 2026 at about 05:50 UTC (counts only, through the D1 API):**
- Migrations 0001 to 0007 are applied.
- The first round ("Test", id `C5TW5gelpkQa`, the pre-registered Round 1) is **closed** (05:33 UTC). It holds 20 votes,
  all from the owner's revoked test code, so the registered comparison has ended without a verdict (PREREG §9).
- The full set `all-questions-v1` is loaded: 438 questions, every one with its footnotes. Its round, "All questions"
  (id `ZF_IZnsCUnZU`), is a **draft**: no batch, no vote.
- Four codes exist, all revoked. No live code.

**Merged to `main` on 25 Nov 2026 at the owner's word ("build, merge, and ship", and later "build and ship that"
for email sign-up); 218 tests pass, the typecheck passes, and the browser smoke test passes 72 checks.** What went
live:
- **Sign-up by email** (migration 0009, evening of 25 Nov): a sign-up link from admin, an address, an optional name
  and a self-chosen adult role; the address is then the login. Not verified; students keep codes. Since late on 25 Nov the
  page asks for the email alone and for the rest only when the address is new.
- **Judges may choose units** (26 Nov, migration 0010): "What you judge" on the home page, All questions or some
  units at State, Nationals or both; the leaderboard has a matching filter; Study health counts cross-unit
  comparisons. Watch that number: if it stays low, the single ranking across units is thin.
- **Home page** (late on 25 Nov): the Start button follows the task on a first visit and sits under the count after that.
- **Staged opening** (migration 0008): the round opens with the 36 launch questions in play and adds 24 at a time
  whenever every question in play has 12 adult comparisons. The deploy marks the draft round as staged.
- **Leaderboard:** rank leads; no rating for an unranked question; the list has the full width with the charts
  after it; a board (All adults, or a voter's own role) shows once three voters stand behind it; head-to-head counts
  are sent added up by group.
- **`/start`** puts the task first on a first visit and says whether voting has yet to open or has ended.
- **Pairing:** a skipped pair that is later voted on counts as one trial toward the repeat gap.
- One question with a cut-off bullet is held out of play; two footnote details that gave away level or year are not
  shown; five footnote slips are corrected.
- Fixes from the code reviews, and the tests that guard them (`docs/AUDIT_2026-11-25_launch.md`).

## Voting is open (25 Nov 2026, 21:13 UTC)

Read from production at 21:55 UTC: the corrected footnotes are loaded, "All questions" is open with 36 questions in
play, one sign-up link is open, and one voter is live: the owner, "Judge 01", signed up by email, 20 votes, marked
as the owner's account (set by Claude through the D1 API at his word; `admin_audit` has the row). Steps 2, 3 and 5
below are done, and step 4 is under way. Still open: step 0 (confirm Workers Paid), inviting people, and step 6.
Since late on 25 Nov no board waits for other voters, so the owner can open the leaderboard now.

## Owner: to go live

0. **Confirm the Worker is on Workers Paid** (Cloudflare dashboard > Workers & Pages > Plans). The notes say you
   upgraded on 25 November; the saved API token cannot read the plan, so Claude could not check. It matters from the
   start: choosing a batch took about 8 ms in Node with 36 to 60 questions in play, 11 ms at 84, 25 ms at 108 and
   39 ms at 132, against the Free plan's 10 ms per request. On Free, voting would begin to fail as the round grows.
1. **Done 25 Nov:** merged and deployed; production checked afterwards (see "Deploy check" below).
2. In `/admin`, a notice at the top says the full question set has corrected footnotes to load. Press **Load it now**.
   No question is added and no question text changes.
3. Under **Rounds**, "All questions" should read "437; opens with 36, 24 more join by themselves at 12 adult
   comparisons each" (437 because one question is held out of play; see step 6). Press **Open**. The item set
   freezes then.
4. **Invite people, either way or both.**
   - **By email sign-up (new, 25 Nov evening):** under **Email sign-up** in `/admin`, press **Make a sign-up link**,
     then **Show link**, and share that link with the adults you trust. Each gives an email, optionally a name, and
     picks a role; their address is then their login. The address is not verified, so treat the link like a key:
     **Close** it when you are done inviting, and make a new one later if you need to. Students do not use it.
   - **By code:** for students, and for anyone you would rather hand a personal link.
   **Make the codes by role**, ticking **My own code** for yours. Download each CSV (label, role, code, link) and keep
   it with your list of names. Send each person their link.
5. **Cast a few votes yourself first** with a throwaway code, on a phone and on a computer, then revoke that code
   (the analysis and the board exclude revoked codes). Things to try: a pick, two reasons, Other with a few words,
   Close call, Skip, Back and a changed answer, and Batch done. The leaderboard opens at 20 votes; since late on
   25 Nov it no longer waits for other voters.
6. **Send Claude page 1 of CCE's 2019-20 State questions PDF** (Unit 1). Question 1's second bullet was cut off in
   transcription ("...taught us about"), so that question is held out of play until its full text is added.

## Deploy check (Claude, 25 Nov 2026, 13:25 UTC)

`main` is at `2c83d35`. The new build was live about 90 seconds after the push. Read from production afterwards,
changing nothing:
- Migration `0008_staged_rounds.sql` is applied; the table `round_in_play` and its three triggers exist.
- "All questions" is still a draft, now marked staged and growing by itself, with no question in play and no vote.
  "Test" is closed and untouched.
- The stored set is still the earlier build of the file (hash `73b4433f6018…`), which is why admin offers the
  corrected footnotes (step 2).
- The live pages serve the files this branch builds (same file names); `/`, `/start`, `/vote` and `/board` answer
  200; `/api/me` 401 and `/api/leaderboard` 404 without a session; `/admin/api/status` redirects to Cloudflare Access;
  plain http redirects to https; the content policy, HSTS and `no-store` headers are as tested.
- Not checked, because they need a sign-in: a real vote, the leaderboard, and the admin page on the live site.

## Deploy check for email sign-up (Claude, 25 Nov 2026, 20:40 UTC)

`main` is at `ad7572d`. The new build was live about two minutes after the push. Read from production afterwards,
changing nothing:
- Migration `0009_email_signup.sql` is applied: `voters` has `email`, `name` and `join_link_id`, and the one-voter-
  per-address index exists. The four existing voters (all revoked) have no address. There is no sign-up link yet.
- The rounds are as they were: "Test" closed, "All questions" a staged draft with no vote.
- `/join` answers 200 and serves the file this branch builds; the sign-in box reads "Your invite code or email";
  `/api/join` refuses an empty request; `/admin/api/join-links` redirects to Cloudflare Access.
- Not checked, because they need a sign-in and a real Turnstile check: a real sign-up, signing back in by email, and
  the admin panel on the live site. Try one sign-up yourself before sharing the link.

## Owner: while the round runs

- **Weekly:** **Download full backup**, and the JSON, reasons CSV and corrections CSV exports. The backup is the only
  export that holds the batches, the pairing trail and which questions were in play when.
- **Study health** shows votes per day and flagged raters. Its "data gate" lines are the pre-registered numbers
  applied to the questions in play; they are a guide to coverage, not a verdict.
- **Rounds > Questions** lets you stop the round adding questions by itself, or add the next 24 now. A group that has
  joined cannot be taken out.
- **Refresh intervals** now and then, so the board shows ranges.
- If a voter reports a dead footnote link, tell Claude. The 52 addresses on sites that refuse automated readers are
  the likeliest.

## Owner: Cloudflare (yours; the saved token cannot change these)

- Nothing to change in the build command any more: `npm run build` now runs the typecheck itself, so the existing
  command (`npm ci && npm test && npm run build`) stops a deploy on a type error.
- Delete the API token "wtpquestionrank D1 setup" (D1 Edit plus Workers Scripts Read) once launch is done. It expires
  2 December 2026 anyway.
- Always Use HTTPS is zone-wide, so it also changes `reader.spiffyspaceman.com`. Optional: the Worker redirects http
  itself.

## Claude: next

- When the PDF page arrives: add State 2019-20 U1Q1 under a new id with its full text, rebuild the set, merge at the
  owner's word; the owner presses **Load**.
- Check against a PDF, when one is in hand, the wording the audit could not settle from the text alone (list in the
  audit report, "Question texts").
- After a week of votes: read the vote counts and the pace, and tell the owner whether 24 at 12 comparisons is the
  right step. Both numbers are in `src/worker/staging.ts`.
- Before any merge that touches `src/web`: `npm run premerge` (the browser test cannot run in Cloudflare's build).
- Open, none urgent: the leaderboard's reasons query reads the round's votes through the views on each view (fine
  below about 20,000 votes; a cache table is the fix if it is ever needed); five footnote addresses recorded as
  dead could not be rechecked from this environment (the proxy answers 403 or 404 for hosts it refuses).

## What to expect from the data

From a simulation with the site's own pairing and rating code (22 voters; details in the audit report):

| Votes cast | Questions in play | Ranked | How well the ranked order tracks the truth |
|---|---|---|---|
| 250 | 36 | about 35 | about 0.7 to 0.9 |
| 500 | 60 | about 50 | about 0.85 |
| 1,000 | 84 | 84 | about 0.87 |
| 2,000 | 132 | 132 | about 0.9 |

With all 438 in play at once the same 1,000 votes rank nothing, and 2,000 votes rank about 175 at about 0.7. At this
pace the round reaches all 438 questions after roughly 8,000 votes (my extrapolation from the two rows above).

## The question set

**438 questions** (`items/transcribed.json`; bundled as `items/rounds/all.json`): State 2014-15 to 2026-27 (234, from
CCE's PDFs), National Finals 2014-15 to 2019-20 (108, from CCE's PDFs) and National Finals 2020-21 to 2025-26 (96, from
the owner's text extracts; two cycles have two questions a unit).

How far to trust the texts:
- The transcriber reproduces all 36 launch texts exactly, and for the 17 cycles with both a PDF and an extract the
  two agree on every question.
- The 2014-15 State PDF has a faulty text layer; 27 places were corrected against the page images, and one more in
  2025-26 (`items/corrections.json`).
- The 96 National Finals questions from 2020-21 on were not checked against a PDF.
- The audit read all 438 questions and 339 footnotes. It found no duplicate question, one cut-off bullet (held out
  of play), one question whose opening quotation uses two single quote marks in place of a double one, and seven
  places where a word may be missing that only the PDF can settle.
- Nothing before 2014-15 is in hand.

**Footnote links** (`items/links.json`, 189 addresses): 89 pages opened and are links; 42 dead ones show a replacement
that was opened first; 6 dead ones are dropped and the citation stays; 52 on sites that refuse automated readers are
linked at the owner's word. Five of the six "dropped" records carry the note "the network here refused the host", so
they were not proven dead from this environment; recheck them when the network allows.

**Adding questions later** (for example National Finals 2026-27): send Claude the PDF or a text extract. Claude
transcribes it, checks it, rebuilds the set and merges at your word; you press **Load or update the full question
set**. In a staged round that is already open, added questions come into play at once.

## Method A and A2 (on file)

Method A (30 judges, 3,780 judgments) and A2 (the same with the human arm's guidance and reasons; all 30 judges kept,
a 26-judge fit beside it) cover the 36 launch questions. The registered comparison ended without a verdict when
"Test" closed. The votes on the first 36 questions of "All questions", cast before the second group joins, can be
compared with A and A2 as an exploratory analysis. `analysis/first_group.ts` makes that slice from the round's JSON
export and the full backup (which says when each question joined):

```
npx tsx analysis/first_group.ts --export round.json --backup wtpqr-backup.json --out first-group.json
npx tsx analysis/analyze.ts --export first-group.json --items items/launch_items_v1.json \
    --llm-design llm-arm/design.json --llm-out llm-arm/out --out analysis-out/first-group
```

Run the second command again with `--llm-out llm-arm/out-a2` and `llm-arm/out-a2-without4`, each with its own `--out`.

## Later (owner decisions, 25 Nov 2026)

- Two quoted sources found but not confirmed, so not linked: John Adams to Richard Price, 19 April 1790 (Founders
  Online, Adams/06-20-02-0188), and Paul Howe, "Eroding Norms and Democratic Deconsolidation," *Journal of Democracy*
  28:4 (2017). If the owner opens them and sees the quoted words, add them to `items/sources_v1.json`.
- Leaderboard unlock stays at 20 votes.
