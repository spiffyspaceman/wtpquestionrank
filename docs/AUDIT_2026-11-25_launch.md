# Launch audit of WTP Question Rank, 25 November 2026

*Scope: the repo at `3074255` (equal to `main`), production's state read through the D1 API (counts only, no
change), a local copy at full size seeded with simulated votes, and a simulation of the round with the site's own
pairing and rating code. Fixes and features are on branch `claude/lucid-cannon-64slmj`. Nothing was pushed to `main`,
and no Cloudflare setting, secret or production row was touched. An earlier audit of the same day is in
`docs/AUDIT_2026-11-25.md`; this one covers what was built after it and the plan to open the 438-question round.*

## Verdict

**The site is ready to go live once this branch is merged, but not on the plan it had this morning.** The owner
expects fewer than 25 voters in the first two weeks. With all 438 questions in play, that many voters would not bring
a single question to a rank, and every voter would unlock an empty leaderboard. The round now opens in stages: the 36
launch questions first, then 24 at a time as the questions in play settle. Everything else the audit found is
smaller: five correctness defects in the Worker (all fixed), one question with a cut-off bullet (held out of play),
footnote slips (fixed), and gaps in the automated tests (the worst ones closed). `npm test` runs 184 tests and
passes; the typecheck passes; the browser smoke test passes 50 checks; an accessibility scan of every page reports
nothing.

## How the audit was done

- **Read:** `CLAUDE.md`, `README.md`, `DEVIATIONS.md`, both pre-registration files, `docs/NEXT_STEPS.md`, the earlier
  audit, every file in `src/worker/` and `src/web/`, all migrations, and the frozen pairing and config files.
- **Ran:** `npm test`, `npm run typecheck`, `npm run build`, `npm run test:ui`; a local copy with the full set
  loaded and 22 simulated voters; Playwright screenshots at 1280 and 390 pixels in day and night colours; axe-core
  4 on eleven page states; and a simulation of the round (below).
- **Three independent reviews by subagents**, each given the code and not my conclusions: Worker correctness and
  security, the automated test suite (with mutation checks), and the integrity of the 438 question texts and 339
  footnotes. Their confirmed findings are folded in below and marked.
- **Production:** read-only queries for migrations, rounds, item sets, and counts of questions, voters and votes.
- **Not done:** no vote, sign-in or admin action on the live site; no load test on Cloudflare itself. Timings are
  from this machine, not from Workers. No question text was checked against a PDF: the PDFs are not in this session.

## The study design does not fit the expected turnout, and staging fixes that

**Rule.** A question is ranked after 10 comparisons, and each vote gives one comparison to two questions. So N
questions need at least 5N votes before all are ranked: 2,190 for 438 questions, 180 for 36.

**Facts.** The owner expects fewer than 25 voters. At 20 to 40 votes each, that is 500 to 1,000 votes in two weeks.
I ran the round forward with `src/rating/pairs.ts` and `src/rating/rating.ts` unchanged: 22 voters taking batches in
turn, each question given a true strength (normal, standard deviation 0.8 logits, about 140 rating points), and
each vote drawn from the Bradley–Terry model with a small per-voter side bias. "Tracks the truth" below is
Spearman's rank correlation between the fitted and the true strengths.

| Votes | All 438 at once: ranked | tracks the truth (all 438) | Staged: in play | ranked | tracks the truth (ranked) |
|---|---|---|---|---|---|
| 250 | 0 | 0.33 | 36 | 35 to 36 | 0.69 to 0.92 |
| 500 | 0 | 0.39 to 0.44 | 60 | 50 to 56 | 0.85 to 0.89 |
| 1,000 | 0 | 0.54 to 0.58 | 84 | 84 | 0.86 to 0.87 |
| 1,500 | 10 to 14 | 0.66 to 0.68 | 108 | 108 | 0.89 to 0.91 |
| 2,000 | 175 to 180 | 0.70 to 0.72 | 132 | 132 | 0.87 to 0.90 |

Two seeds per design; one longer all-at-once run reached 272 ranked at 2,200 votes, all 438 at 4,500 (0.84) and 0.88
at 6,600. With 36 questions alone, the order tracks the truth at 0.87 after 500 votes and 0.92 after 1,000.

**Conclusion.** At this turnout the all-at-once round gives voters nothing to look at for the whole period and a
coarse order of everything; the staged round gives a board from the first day and a sound order of the questions in
play. All-at-once is the better design only when the aim is the eventual order of every question and nobody needs a
board in the meantime. The owner chose staging that grows by itself (decision table below).

**Limits of the simulation.** The true spread of human judgments is unknown; with a smaller spread every correlation
above is lower, for both designs. The simulation's growth rule counted every voter's comparisons; the site counts
adult comparisons only, so students' votes do not advance the round and real growth is slower when students vote.
Simulated voters never tire, skip or recognise a question.

### Other points on the design

- **The registered comparison is over.** Production shows round "Test" (the pre-registered Round 1) closed at 05:33
  UTC with 20 votes, all from a revoked code. PREREG §9 then gives no verdict. The first 36 questions of the staged
  round are the same 36, judged under today's conditions, and the votes cast before the second group joins can be
  compared with method A and A2 as an exploratory analysis. `docs/NEXT_STEPS.md` says how.
- **A rating from two comparisons was shown as if it meant something.** An unranked question showed "1303, won
  100%" after three comparisons. Unranked questions now show their comparison count only, and the Worker no longer
  sends the other numbers.
- **Small role boards exposed individual votes.** With two or three voters in a role, each could work out the others'
  picks from that role's board. A role board now waits for three voters in that role (owner's choice; I recommended
  five).
- **One swapped repeat per batch costs a tenth of the votes.** From the third batch on, one pair in ten is a repeat
  that measures consistency and never feeds the ratings. With scarce votes that is a real price. I left it: it is the
  only measure of rater consistency the site has, and it sits in the frozen pairing rule (the Worker could switch it
  off through an option without touching the frozen file).
- **Twenty votes is 20 to 40 minutes of reading before the board opens.** A pair of questions runs about 170 words
  with bullets (median 83 words a question). The place is saved between visits, which softens it. Unchanged.

## The Worker had five correctness defects; all are fixed

Found by the code review subagent and confirmed there with tests that forced the interleaving; I re-read and fixed
each. Line numbers are as of `3074255`.

1. **A refused vote could add its reasons and a cache count to another request's vote** (`src/worker/voter.ts:426`,
   `src/worker/data.ts:79`). Two submits of one pair at once, with the round closed or the code revoked between them:
   the second insert wrote nothing, but its reason and cache statements still ran against the first request's vote.
   Result: one vote carrying three reasons and counted twice until the next cache rebuild. Fix: every companion
   statement now carries the vote insert's own conditions.
2. **Revoke could stop half-done and could not be repeated** (`src/worker/admin.ts:491`). If the cache rebuild failed
   once, the code was revoked but its votes stayed in the board, and pressing Revoke again did nothing. Fix: Revoke
   on an already revoked code runs the rebuild again and writes the audit row if anything changed.
3. **A batch could be issued into a round that had just closed** (`src/worker/voter.ts:248`). Ten pairs served, every
   vote refused. Fix: the insert checks that the round is still open, and the page is told voting is closed.
4. **A round could be opened on a set whose load had stopped part-way** (`src/worker/admin.ts:313`). For a set that
   is not open-ended this froze it half-loaded for good. Fix: Open is refused until the load finishes.
5. **The full backup left out `round_board_seen`** (`src/worker/admin.ts:571`). After a restore, the lock on
   pre-leaderboard answers and the `after_board` flag would have been wrong. Fix: the table is in the backup, along
   with the new `round_in_play`.

**Left as they are, none urgent:**
- `GET /api/batch` reads every vote on the site through the view `votes_effective` (731 rows read after 360 votes;
  about 35 ms at 20,000 votes, measured locally by the subagent). Fine at this turnout.
- The voter's own Other note is sent back when they go Back within their batch. The owner chose to keep it; the rule
  in `CLAUDE.md` now says a note never appears on another voter's page.
- The adults board has no minimum number of voters. On the first day it may rest on one or two people; nothing is
  ranked that early, so it shows little.

**Checked and sound** (subagent, by test or by reading): no statement can bind more than 100 values; no request data
is concatenated into SQL; eight batch requests at once across two rounds make one batch; a correction racing a
leaderboard view is refused inside the transaction; no voter response carries an id, cycle, unit, level or round name;
footnote links can only be http or https and are built as text nodes, never markup; the Access token checks, host
and origin guards and sign-out read without fault.

## A second review, of this branch's own diff, found no blocker

A fresh subagent read `git diff origin/main...HEAD` after the work above and ran its own probes: migration 0008 on
a production-like database, four batch requests at once on a settled round (one group joins), two `/grow` calls at
once (one group joins), a double open (36 once), and an unfinished batch across a join (it can be finished). It
raised seven points. Fixed: the leaderboard page now falls back to the adults board when a role board is refused;
unranked rows are ordered by comparisons, not by the rating that is no longer sent; the held question no longer
counts toward the total a round can reach, and it is out of play in a round opened all at once too. Left: the
head-to-head counts sent for the charts still let a determined reader work out an unranked question's wins; with two
open rounds, a batch refused by a round that just closed is not retried in the other; two requests to make codes at
the same instant collide on a label and one fails (admin only). And one point for the owner: **the round needs
Workers Paid** (next section).

## Efficiency is no longer a constraint once the round is staged, provided the Worker is on Workers Paid

Local timings on a busy machine, so read them as ratios:

| | All 438 in play | 36 in play |
|---|---|---|
| A new batch (median) | about 650 ms | about 30 ms |
| Leaderboard response | 426 KB | 37 KB |
| Loading the full set | 0.3 s | the same |

The cost of a batch grows with the square of the questions in play, because the pairing rule scores every pair.
The second reviewer timed the fit and pairing alone in Node: about 8 ms with 36 to 60 questions in play, 11 ms at
84, 25 ms at 108, 39 ms at 132 and 590 ms at 437. The Free plan allows 10 ms of CPU per request (the figure this
project recorded on 25 November; I did not reopen Cloudflare's page). `docs/NEXT_STEPS.md` says the owner moved to
Workers Paid that day; the saved API token cannot read the plan, so I could not confirm it. On Free, voting would
start to fail as the round grows. "Refresh intervals" (1,000 refits per pool in the
admin's browser) shrinks the same way, since it now fits only the questions in play.

## The pages are sound; four things changed and a few are left for the owner's eye

The design keeps to one serif at one weight, burgundy on warm stone, no bold and no capitals, which suits a hearing
packet. I did not restyle it.

**Changed, each with the owner's yes:**
- **A first visit to `/start` leads with the task.** It used to lead with "0 pairs judged" and the Start button, with
  the task explained underneath.
- **The leaderboard leads with rank.** "#1" is the large figure and the rating sits beside it in small type. The
  "Top question" label over the first card is gone; the card says "#1" itself.
- **The leaderboard says where things stand.** "353 votes. 36 of 438 questions are in play and 36 are ranked. More
  join as these settle." With nothing ranked it says how far along the furthest question is and leaves the charts
  out.
- **Unranked questions show "3 of 10"** in place of a rating, and the chart option to include unranked questions is
  gone.

**Accessibility.** axe-core found six issues, all minor: the small count in head-to-head cells measured 4.43:1 in
night colours, and two admin tables had an empty header. All fixed; the scan is clean on every page state, day and
night, at both widths. Keyboard flow and focus were covered by the earlier audit and are in the smoke test.

**Left for the owner's eye, not changed:**
- On a phone, two questions stack to about two screens and the ten reason pills take another half screen. It works;
  it is long.
- The Top 10 list beside the charts clamps each question to two lines. Giving the list the full width would let the
  questions be read; that undoes a layout the owner approved, so I left it.
- In admin, Study health still labels its coverage lines "data gate (PREREG §9)". For this round they are a guide to
  coverage of the questions in play, not a gate.

## The question texts are clean except for one cut-off bullet

The integrity subagent read all 438 questions and 339 footnotes and ran scripts for duplicates and artifacts.

- **No duplicate question.** No two share a stem or a stem and bullets, and no pair is more than 85% alike in full.
  Two questions open with the same quotation and ask about it differently (National Finals 2014-15 U5Q2 and State
  2015-16 U5Q2); they are distinct questions and may meet as a pair.
- **One bullet is cut off.** State 2019-20 U1Q1, second bullet, ends "...taught us about". The transcriber drops
  short lines that look like page furniture. The question is held out of play until the PDF page arrives.
- **One opening quotation uses two single quote marks** in place of a double one (National Finals 2021-22 U6Q2). It
  reads correctly on the page; left as loaded.
- **Seven places where a word may be missing**, which only the PDF can settle and which may be CCE's own: National
  Finals 2016-17 U5Q1 ("Do agree or disagree"), 2016-17 U6Q1 bullet 1 ("found the Declaration"), 2018-19 U2Q3 ("the
  Framers of Constitution"); State 2018-19 U1Q3 bullet 2 ("you do think"), 2014-15 U3Q2 bullet 1 ("agreement
  favorable"), 2026-27 U1Q2 ("conflict ... grow"), 2014-15 U5Q3 bullet 2 ("have been, ever found"). None is among the
  first 36.
- **Footnotes:** a sponsor line and a download stamp that gave away level or year are no longer shown (owner's
  yes); an address cut short at "&" is whole again; three spacing slips and two punctuation leftovers are fixed.
  Thirteen notes have no marker in the text and show under the bullets without one.
- **Links:** five of the six addresses recorded as dead and dropped carry the note "the network here refused the
  host". They were not proven dead from this environment. Dropping an address loses nothing a voter needs (the
  citation stays), so I left them and noted it in `docs/NEXT_STEPS.md`.
- **Clean:** every id matches its level, cycle, unit and number; every question has two bullets; the 36 launch
  questions are byte-identical to the frozen file; no hyphenation breaks, doubled words, page furniture, leftover
  markers or addresses in any stem or bullet.

## The automated tests

**The suite guarded the server's rules well and the things a voter looks at poorly; the worst gaps are closed.** The
test subagent made 49 single-line changes to the code in a scratch copy (mutants) and ran the full suite against
each. A mutant that passes is a defect the suite would not catch.

**What it caught:** the `after_board` flag, the guard against two batches, the unlock at 19, both cache-rebuild
filters, repeats entering the ratings, the published check, a removed Origin check, the host guard, the reasons limit,
pair ownership, the closed-batch rule, raw footnotes, an unchunked id list, and four of five staged-growth changes.

**What got through, and what now catches it:**

| A change that passed every test | Now caught by |
|---|---|
| The worst question ranked #1; no question ever ranked; no rating ever sent. No test had a question with 10 comparisons. | `test/worker/coverage-gaps.test.ts`: 260 votes in a known order, then the board's order is checked against it |
| The votes CSV and the paged JSON export ignoring corrected answers. The admin page's JSON button uses the paged path. | `coverage-gaps.test.ts` |
| Repeats counting toward the 20 votes that open the board | `coverage-gaps.test.ts` (19 first votes and one repeat stay locked) |
| A revoked voter's reasons staying on the board (the throwaway-code case) | `coverage-gaps.test.ts` |
| A session never expiring | `coverage-gaps.test.ts` |
| A POST with no Origin accepted (the old test saw a 403 from another cause) | `coverage-gaps.test.ts` checks the error is `bad_origin` |
| A backup cursor off by one (no test read a second page) | `coverage-gaps.test.ts` pages through 1,040 rows |
| The item loader sending one 5,000-statement batch, which local D1 accepts and production refuses | `test/worker/helpers.ts`: any `db.batch()` over 100 statements fails the request |
| An export field dropped (only the typecheck saw it, and the deploy did not run the typecheck) | `npm run build` now runs the typecheck first |
| Corrections sent as votes by the page; footnotes not drawn; the invite link ignored; Other and Close call never sent; the admin page throwing | `scripts/ui-smoke.mjs`, now 50 checks (27 when this audit began) |

I checked six of these by putting the change back and watching the new test fail.

**Still not covered, in order of risk:**
1. **The browser test is not in the deploy path.** The Cloudflare build image has no Chromium, so `npm run test:ui`
   runs only when someone runs it. Run it before every merge that touches `src/web`.
2. **`server_ms` measured from the batch's issue time** and **the correction lock applied across rounds** still
   pass every test. Both matter to the analysis more than to voters.
3. **Migrations are tested only on an empty database.** I rehearsed 0008 once by hand against production's shape
   (a closed round and a draft on the open-ended set); it is not an automated test.
4. **The Turnstile stand-in accepts anything**, so a wrong field in the Worker's siteverify call would pass. The
   live site verified a real sign-in on 25 November.
5. **Header changes** (a widened `connect-src`, HSTS dropped) pass.

**Flakiness.**
- **One test failed about one run in five on a busy machine** and would have stopped a deploy: a 50 ms wall-clock
  bound on a rating fit (`src/rating/rating.test.ts:150`). The subagent saw 15 failures in 68 runs; I saw one. The
  bound is now one second. Six full runs since then passed.
- **The browser test was not repeatable**: local database state carried over, so a third run failed. Each run now
  gets a throwaway database. Four runs in a row passed.
- **`test/node/export-analyze.test.ts` took 54 s under load** against a 120 s limit. Not changed.
- **Two assertions depend on the UTC date** and could fail in a run that crosses midnight (subagent, by reading).
  Not changed.

**One correction to the project's notes:** local D1 does enforce the 100-bound-parameter limit (a 101-parameter
query fails with "too many SQL variables"; I ran it). `CLAUDE.md` said it did not.

## Decisions the owner took during the audit

| Question | Decision |
|---|---|
| Expected voters in two weeks | Fewer than 25 |
| How the round opens | Staged, growing by itself (36 first; 24 more at 12 adult comparisons each) |
| Order in which questions join | Balanced shuffle across units and levels |
| First visit to `/start` | Task first |
| Unranked questions on the board | Comparison count only |
| The cut-off question | Held out of play until the PDF page arrives |
| Sponsor line and download stamp in footnotes | Leave both out |
| Role boards | Wait for three voters in the role |
| A voter's own Other note when going Back | Keep; the rule now says "never on another voter's page" |
| Rank or rating first on the board | Rank |

Each voter-visible change is in `DEVIATIONS.md`.

## The weakest link, and the strongest case against this plan

**The weakest link is turnout, and no design removes it.** Fewer than 25 voters cannot rank 438 questions. The
staged round reaches about 84 questions at 1,000 votes and would need roughly 8,000 to bring in all 438 (my
extrapolation from the simulation). If votes stop at 1,000, three quarters of the set is never shown to anyone, and
which quarter is shown was fixed by a shuffle, not by merit.

**The strongest opposing case is for opening all 438 at once.** Rule: when the goal is an order of every question
and votes are scarce, spread them evenly, because the first few comparisons of a question teach more than the
thirtieth. Facts: at 2,000 votes the all-at-once round orders all 438 at about 0.7, while the staged round knows
nothing about 306 of them. The board is a reward for voters, not the product. Conclusion: staging spends scarce
votes on precision the owner did not ask for and leaves most of the set unjudged. The same critic would add that
staging builds a second imbalance into the data: the launch questions gather many more comparisons than later
groups, and each group is compared mostly within itself, so the links between groups are thinner than the links
inside them.

**This imbalance is structural. It can be managed three ways.**
1. Watch the pace for a week. If votes run well ahead of 25 voters' worth, press **Add 24 now** more often or lower
   the 12-comparison bar; if they run behind, leave it. Both numbers are two constants in `src/worker/staging.ts`.
2. Treat the first 36 as the study that this turnout can finish. They carry the LLM rankings of method A and A2. If
   the adults' order of those 36 tracks method A, an LLM order of all 438 becomes defensible, which 25 people cannot
   produce by voting. That comparison is exploratory now that "Test" is closed, and should be reported as such.
3. Recruit. Every design above improves faster with voters than with any change to the code.
