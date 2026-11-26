# Deviations from PREREG_Human_vs_LLM.md

None as of 24 November 2026.

Recorded for completeness (not deviations): after the pre-registration was hashed, method A ran as registered
(30 judges, 3,780 judgments, no invalid records). Records: `llm-arm/MethodA36_Records_2026-11-24.jsonl`
(full, with reasons; SHA-256 1a1eee83504027af81086b35cbe94a2d0bea1de41ce12d44e71b89e71653a587) and
`llm-arm/MethodA36_Compact_2026-11-24.jsonl` (labels and picks only; SHA-256
9689cda446ac3d86aa7279531cf19c53349e35f31f9049fc8473650bd4be217f). `llm-arm/summarize.ts` was added after
registration to summarize the run; it is not part of the registered analysis.

## Clarifications (not deviations)

**24 November 2026: time on pair (`server_ms`).** Owner agreed. BUILD_STEPS §3 writes `server_ms = now - issued_at`,
where `issued_at` is the time the whole batch was sent. SPEC §2 calls the measure "time on pair", and
`analysis/analyze.ts` applies the pre-registered 20-second "too fast" flag to it. The Worker therefore measures each
pair from the later of the batch's `issued_at` and the voter's previous answer (vote or skip) in the same batch.
This changes no frozen file and no threshold. A batch resumed after a break carries the break on its next pair.

## Deviations

**25 November 2026: question details on the leaderboard (owner decision).** PREREG §2 says voters see only the stem
and two bullets; cycle, unit, level, number and source are hidden. That still holds on the voting page: batches carry
stem and bullets only. The leaderboard, which a voter reaches only after 20 first-presentation votes, now also shows
each question's level, cycle, unit and number behind an Info button, links to quoted sources that were opened and
confirmed (`items/sources_v1.json`), and average ratings by unit and by year. Effect: votes cast after a voter first
opens the leaderboard may be influenced by recognising cycles and units. Such votes are already flagged
(`after_board = 1`), and the §8 sensitivity analysis restricted to pre-board votes reports the result without them.
No frozen file, threshold, item or measure changes. The 20-vote unlock is unchanged (owner decision, same day).

**25 November 2026: home page with judging guidance (owner decision).** PREREG §2 and §5 give the LLM judges the
hearing-format paragraph and the criterion, and voters saw the criterion on the voting page. After sign-in, voters now
land on a home page (`/start`) that shows their vote count, the 20-vote leaderboard unlock, a button to start or
continue a batch, the hearing-format paragraph word for word as the LLM packets give it, the criterion, and a short
list of what strong hearing questions do. That list paraphrases general principles from the Center for Civic
Education's 2026-27 Question Writers Committee Toolkit (its rubric categories and question design principles), without
attribution, as the owner chose. Effect: human voters judge with guidance the LLM judges did not see, so a human–LLM
gap may partly reflect different instructions. The voting page itself still shows only stem and bullets. Votes cast
before this change can be told apart by time (`created_at` before the deploy recorded in the git log). No frozen file,
threshold, item or measure changes.

**25 November 2026: optional reasons with a vote (owner decision).** Before picking, a voter may tap up to two of nine
fixed reasons: Forces a real position; Real constitutional substance; Strong quote or source; More room for follow-up;
Hard trade-offs on every side; Competing ways to read the Constitution; Who should decide; Rewards connecting ideas;
Ties to current issues. They are stored as codes in a new append-only table `vote_reasons` (migration 0002, never free
text), exported as `reasons.csv`, and are not part of the JSON export or the registered analysis. Effect: the labels
name qualities a voter might then weigh, and they add a step to each pair. Reasons are optional, the pick is unchanged,
and every vote still counts the same. Also on the voting page, tapping a question's card or its button now chooses it
without sending the vote: the other side fades, the reasons and Close call appear, and Next sends the vote (amended
the same day at the owner's request). No frozen file, threshold, item or measure changes.

**25 November 2026: "Other" reason with a short explanation (owner decision).** A tenth pill, Other, counts as one of
the two reasons and opens a text box for the voter's own explanation, at most 20 words (the limit the LLM judges had on
their reasons). It is open to every voter, students included; the owner lifted the brief's no-free-text rule for this
field only. Notes are stored in `vote_other` (migration 0003, append-only), shown only to the owner, exported in
`reasons.csv`, and are not part of the JSON export or the registered analysis. Effect: as with the pills, an extra
optional step per pair. No frozen file, threshold, item or measure changes.

**25 November 2026: choose, then Next (owner decision; timing note).** Because the vote is now sent with Next, after
any reasons, `client_ms` and `server_ms` include the time spent on reasons. That can only lengthen a voter's median
time, so the pre-registered 20-second "too fast" flag (PREREG §4) becomes slightly less likely to fire. The threshold
is unchanged.

**25 November 2026: going back within a batch (owner decision).** A voter can move Back and Forward through the pairs
of their current batch, until the next batch starts, and change an answer. The vote log stays append-only: a change is
a new row in `vote_corrections` (with its own reasons in `correction_reasons` and `correction_other`; migration 0004),
and the original vote is never edited. The newest correction is the vote's answer everywhere: the leaderboard cache,
the JSON and votes CSV exports (so `analysis/analyze.ts` sees the corrected winner and close call), the reasons export
and the study health panel, all through the views `votes_effective` and `vote_reasons_effective`. `corrections.csv`
lists every change with the first and the corrected answer. A skipped pair can be voted on afterwards; the skip stays
in the log. Timing fields keep the first answer's values. Effect: a vote may record a voter's second thought rather
than the first; the corrections export shows how often. No frozen file, threshold, item or measure changes.

**25 November 2026: comparative reason labels (owner decision).** The nine pills now say what the chosen question does
better than the other (for example "Forces a clearer position" instead of "Forces a real position"), under a heading
"Why is A better?" or "Why is B better?", because both questions may be weak or both strong. The stored codes are
unchanged. Six reasons were recorded under the earlier wording, all from the owner's test code `Other 04`, which will
be revoked before launch.

**25 November 2026: leaderboard redesign with per-question reasons and charts (owner decision).** The leaderboard,
still reached only after 20 first-presentation votes, now shows: the top question in full; #2 to #10 with each
question's tag ("2024-25 U4Q1"); for each question the reasons voters gave when it won (codes and counts only, never
Other notes); win shares; head-to-head counts by row position (never question ids) for a unit, year or question-number
matrix; and charts the viewer can adjust in the browser. Effect: a voter who keeps voting after opening the board
has seen the crowd's ratings and reasons, which may shape later picks and reason choices. Those votes are already
marked `after_board = 1`, and the §8 sensitivity analysis restricted to pre-board votes reports the result without
them. No frozen file, threshold, item or measure changes.

**25 November 2026: an answer from before the leaderboard is fixed once the voter opens it (owner decision, after the
audit).** Going back within a batch (above) let a voter change a vote cast before the leaderboard after opening it,
while the vote stayed marked `after_board = 0`. From this deploy the Worker refuses such a change (`/api/correct`
answers 409 `board_seen`); votes cast after the leaderboard can still be changed within their batch. Effect: the
"before the leaderboard" votes of PREREG §8 now hold only answers given before it. Any change made before this deploy
shows in `corrections.csv` with `vote_after_board = 0` and `correction_after_board = 1`; when D1 was last checked on
25 November (`docs/NEXT_STEPS.md`) the only votes in Round 1 were the owner's 20 test votes (`Other 04`). No frozen file, threshold, item or measure changes.

**25 November 2026: the unchosen question stays readable (owner decision, after the audit).** After a pick, the other
question no longer fades to 45% opacity (its text measured about 2:1 against the card). It now sits flat on a dashed
outline with its text at full ink, and the chosen question has a solid burgundy outline. Effect: a voter can re-read
the other question before pressing Next, which may make changing the first tap more likely. No frozen file,
threshold, item or measure changes.

**25 November 2026: key switch, Sign out and four short lines (owner decision, after the audit).** The home page has
a "Letter and number keys" checkbox that turns the single-key shortcuts (S, C, 0 to 9) off in that browser; arrows
and Enter stay. The home page has a Sign out link (it ends the session on that device). The voting page says "Loading
the next pairs" before the first pair, "Two chosen" when the reason limit is reached, and "Next saves the change" on
a pair already answered; the leaderboard says "Loading the leaderboard". Effect: none expected on votes; recorded
because voters see them. No frozen file, threshold, item or measure changes.

## Clarifications added 25 November 2026 (audit)

- **Which votes steer the pairing.** `src/worker/voter.ts` fits the `all` pool (every live voter, students included)
  to choose pairs. PREREG §4 fixes the pairing rule but not the pool that feeds it. Student votes therefore help
  decide which pairs adults see; they do not enter the adult ratings.
- **Trials after a skipped pair is voted on.** A pair that is skipped and later voted on (by going back) counts as
  two trials toward the 20-trial gap before a swapped repeat, so that repeat can come one real trial early.
  Unchanged for now; the audit lists it as open.

## Addendum: method A2 (registered 25 November 2026)

**25 November 2026: `PREREG_Addendum_A2.md` (owner approved; "run A2").** A second LLM run, A2, repeats method A with
the human arm's guidance ("What strong hearing questions do") and the nine named reasons added to each packet. The
design (`llm-arm/design.json`, labels, pairs, order) is the registered one; only the instructions differ. A2 is
secondary: the §10 verdict is read from the registered method A run alone. Hashes, taken before any A2 judge saw a
packet:

| file | SHA-256 |
|---|---|
| `PREREG_Addendum_A2.md` | `0bf1e5ba8e89f26c6b65a3e9083e2a224f522164586e14388519a4679580e015` |
| `llm-arm/design_a2_hashes.json` (the 30 packet hashes) | `0a37e6a6930456ba90932478eb8430e876ed5b62489d5af808960cb78f594788` |
| `llm-arm/make_addendum_packets.py` | `a9aeab92a36a3f3bd70780051d60082911a097dfc4dae4b5729e80c92888eb48` |

State of the human data at registration: no §7 measure had been computed. Production D1 was not read that day after
the morning check recorded in `docs/NEXT_STEPS.md` (20 votes, all from the owner's test code `Other 04`).

**25 November 2026: A2 run record.** All 30 judges ran after the hashes above were logged. Output:
`llm-arm/out-a2/` and `llm-arm/MethodA2_Records_2026-11-25.jsonl` (SHA-256
`75aefc20e574b4a77e5c1cb504ad1b0aee6c7b618ee1d2e4e837f349d30246f2`), 3,780 judgments, none invalid under
`llm-arm/collect_a2.py`; the first-listed question won 50.7% of pairs. No rating was fitted and nothing was compared
with a human vote. Three facts about the run that the addendum did not foresee:

1. **Four judges appear to have ranked the questions first, against packet rule 2.** `b1j0`, `b1j1`, `b3j4` and
   `b4j2` gave one fixed reason per winning question (28 to 32 distinct reasons over 126 pairs; every other judge gave
   126, as did all 30 method A judges). One judge's working shows a score for each of the 36 questions from which the
   picks were generated. Other judges may have done the same with varied wording; that cannot be told from the
   output. What to do with these four is the owner's decision and is open (see `docs/NEXT_STEPS.md`).
2. **The judges' sessions carried this repository's `CLAUDE.md`** (the harness loads it for every subagent). It
   describes the study and the site but holds no label key, rating or judgment of any question. Each judge opened
   only its own packet: the tool logs show no other file read. Whether the method A judges had a comparable file in
   context is not recorded.
3. **Model.** Each judge was requested as `opus`, which this session lists as `claude-opus-5-5`, at default effort.
   The serving model was not independently confirmed per judge.

**25 November 2026: the four judges stay in; a fit without them is reported beside it (owner decision).** A2 is
reported with all 30 judges as run. No judge is re-run or replaced. As an addition to the addendum's §4, every A2
measure is also reported from the 26 judges other than `b1j0`, `b1j1`, `b3j4` and `b4j2`
(`llm-arm/out-a2-without4/`, the same output files less those four; `analysis/analyze.ts` lists the four as missing
and fits the rest). The addendum file itself is unchanged, so its hash above still holds. Losing those four leaves
blocks 1, 3 and 4 with fewer than six judges, so pairs in those blocks have fewer than six judgments in that fit.

**25 November 2026: Round 1 is to be closed early (owner decision; not yet carried out).** The owner decided to open
every published question from the last 20 years to voters now and to drop Round 1. When the first of the larger
rounds is ready, Round 1 will be frozen as it stands (20 votes when last checked, all from the owner's test code).
Under PREREG §9 the data gate then fails and "every number is reported as descriptive and no verdict is given":
the registered human-versus-LLM comparison ends without a verdict. Method A and A2 stay on file. The 36 launch
questions will appear again inside the larger State rounds, under different conditions (other questions in the round,
the guidance, reasons and leaderboard as they now are); any comparison of those votes with method A or A2 is
exploratory and is not the registered analysis. This entry records the decision; the freeze itself will be logged
with its time when the owner does it in `/admin`.

**25 November 2026: several rounds open at once, the site choosing the round for each batch (owner decision; built,
takes effect when merged).** Migration 0005 drops the one-open-round rule. Each new batch goes to the open round with
the fewest batches issued; a part-done batch is always served first; a voter cannot choose a round and the voter pages
carry no round name. Three things change with it:
- **Leaderboard unlock.** It still opens at 20 first-presentation votes, now counted over every round, not within
  one. With a single round the count is the same as before.
- **`after_board`, round by round.** A vote is marked `after_board = 1` when the voter had already opened that
  round's leaderboard (table `round_board_seen`), not any leaderboard. The lock on changing earlier answers follows
  the same rule. Views recorded before the migration are assigned to the round open at the time.
- **The leaderboard page** has a "Questions" picker when more than one round has a board, and opens on the round the
  voter has judged most.
Effect on Round 1 while it is the only open round: none; every rule above reduces to the old one. No frozen file,
threshold, item or measure changes.

**25 November 2026: every question in one round (owner decision; supersedes the rounds by unit).** The full set runs
as a single round, "All questions", so that every question is ranked on one scale. Voters will therefore compare
questions across units and across State and National Finals. The Worker moves to the Workers Paid plan to carry the
pairing cost; the pairing and rating code is the registered code, unchanged. Round 1 is frozen when that round opens,
as recorded above.

**25 November 2026: questions can be added to the full round while it runs (owner decision; built, takes effect when
merged).** The "All questions" set is open-ended (migration 0006): questions transcribed later are added to the same
set and round, each with the time it was added (`item_set_items.added_at`, and an `add_items` audit row). A set only
grows, and a loaded text never changes. The ratings are refit from the whole log, so a late question enters the next
fit; the pairing's warm-up rule (favour the least-compared questions until every question has six comparisons) then
applies again, so newcomers are paired first. Effects to keep in mind when reading that round's results: ratings are
centred on the average question, so every rating shifts a little when questions join; and voters who stopped before an
addition never judged the late questions. The launch set is not open-ended and cannot be made so (a database trigger
refuses it), so Round 1's 36 questions stay fixed.

**25 November 2026: the first round is renamed "Test" (owner decision).** The round that opened on 25 November under
the name "Round 1" (id `C5TW5gelpkQa`, item set `state-launch-v1`) is now named "Test". Claude changed the name in
production through the D1 API at the owner's request and added an `admin_audit` row (`rename_round`, actor
`claude-d1-token`). Nothing else about the round changed: 20 votes from one voter, the owner's test code. Where this
file and the pre-registration say "Round 1" or "the first round", they mean this round.

**25 November 2026: published footnotes are shown with each question (owner decision; built, takes effect when
merged).** PREREG §2 says voters see only the stem and the two bullets. From this change a question also carries the
source notes CCE prints under it: the asterisk stands in the text where CCE put it, and the note appears in small type
under the bullets, on the voting page and on the leaderboard. Two adjustments to the published notes, both the
owner's: the phrase "accessed <date>" is left out, because the date gives away the question's year; and a web address
is a link only where the page was checked and opened (`items/links.json`), is replaced or dropped where the page is
gone, and is plain text where it could not be checked. Effects: voters now know who is quoted and where from, which
the LLM judges of method A and A2 did not; a note can still hint at a question's era (a book published in 2016).
The stem and bullets are unchanged and are hashed as before. Cycle, unit, level, number and question ids still never
reach the voting page. The round "Test" would show the notes too once the full set is loaded; it is to be closed
before then.

**25 November 2026: day and night toggle (owner decision; built, takes effect when merged).** Every page has a
sliding "Night" switch in the masthead. Until now the colours followed the device's setting only. The choice is kept
in the reader's browser and nowhere else. Effect on votes: none expected; recorded because voters see it.

**25 November 2026: which footnote addresses are links (owner decisions, same day).** After the link check: 89
addresses whose pages opened are links; 42 dead ones show a replacement that was opened first (the same file at the
site's new address, or the same speech, column or document on its publisher's new page or a scholarly host); 6 dead
ones with no replacement are dropped and the citation stays; 52 on sites that refuse automated readers are linked
unconfirmed, at the owner's word. A replacement address is not the one CCE printed; `items/links.json` records both.

**25 November 2026: the full round opens in stages (owner decision, after the launch audit; built, takes effect when
merged).** The owner expects fewer than 25 voters in the first two weeks. A simulation with the registered pairing
and rating code (22 voters, true spread 0.8 logits; `docs/AUDIT_2026-11-25_launch.md`) showed that with all 438
questions in play at once no question reaches 10 comparisons before about 1,500 votes, so every early voter would
unlock an empty leaderboard. The round "All questions" therefore opens with part of its set in play and adds the rest
in groups (migration 0008, `src/worker/staging.ts`):
- **First group:** the 36 pre-registered launch questions.
- **Later groups:** 24 questions at a time, in a fixed shuffled order that keeps the questions in play even across
  the six units and across State and National Finals. Each group's joining time is stored (`round_in_play.joined_at`).
- **When:** a group joins when every question in play has 12 first-presentation comparisons from adults. The owner
  can switch this off and add groups by hand in `/admin`; a group that has joined never leaves.
- **Unchanged:** one round, one rating scale, the registered pairing and rating code (it is handed the questions in
  play), the 20-vote unlock, and the 10-comparison rank threshold. The leaderboard lists only the questions in play.
Effects to keep in mind when reading that round's results: early votes compare only the launch questions, so those
36 gather more comparisons than later arrivals; each group is compared mostly with itself and with what was already
in play; ratings are centred on the questions in play, so every rating shifts a little when a group joins; and votes
on the first 36 before the second group joined are the nearest thing this round holds to the closed Round 1, under
today's conditions (guidance, reasons, footnotes). Any comparison of those votes with method A or A2 is exploratory.

**25 November 2026: one question is held out of play (owner decision).** State 2019-20, Unit 1, Question 1 was
loaded with its second bullet cut off mid-sentence ("...taught us about"): the transcriber dropped the bullet's last
line. A loaded text cannot be edited, so the question never joins a staged round (`HELD` in `src/worker/staging.ts`).
When the owner supplies that page of CCE's PDF, the full text is added as a new question under a new id.

**25 November 2026: what the leaderboard shows (owner decisions, after the launch audit).**
- **No rating for an unranked question.** A question with fewer than 10 comparisons used to show a rating, a win
  share and a range; with two or three comparisons those are mostly chance. It now shows only its comparison count
  ("3 of 10"), and the Worker no longer sends the other numbers. The charts always use ranked questions only.
- **A role's own board waits for three voters.** A voter sees the pooled adults board and, once three voters in
  their own role have voted in the round, that role's board. With one or two voters behind it, a role board would
  let each work out the others' picks.
- The page says how many votes the board rests on, how many questions are in play and how many are ranked.
Effect on votes: a voter who keeps voting after opening the board sees less noise than before; such votes are
already marked `after_board = 1`.

**25 November 2026: the home page puts the task first on a first visit (owner decision).** A voter with no votes
yet sees the hearing format, the criterion and the guidance before the Start button; the count of zero is left out.
A returning voter sees the count and Continue first, as before. The words are unchanged.

**25 November 2026: two footnote details are not shown (owner decision).** As with "accessed <date>": the note
"This question is sponsored by the Bill of Rights Institute. The class providing the best response to this question
will receive the Special Question Award" (National Finals 2016-17, Unit 1, Question 3) and its marker are not shown,
because the line gives away the question's level; and the download stamp `?q=20240728143454` is left off one web
address (National Finals 2024-25, Unit 3, Question 3), because it gives away the year. Five extraction slips in
footnotes were also corrected (an address cut short at "&", three spacing slips, and stray punctuation left where an
access date or a dead address was taken out). Each data change is listed in `items/corrections.json`. No stem or
bullet changed.

**25 November 2026: the leaderboard leads with rank, not rating (owner decision).** Each ranked question now shows
its rank as the large figure ("#1") with its rating in small type beside it, in the top card, the list and the
table; the "Top question" label over the first card is gone. The numbers themselves are unchanged. Effect on votes:
none expected beyond what the leaderboard already has; recorded because voters see it.

**25 November 2026: the rest of the launch audit's recommendations (owner decisions; built and merged the same day).**
- **A skipped pair that is later voted on counts as one trial.** PREREG §4 puts the swapped repeat at least 20
  trials after the first showing. Going back to vote on a skipped pair used to add two trials (the skip and the
  vote), so a repeat could come one real trial early. The skip is now left out of the count once the pair has a
  vote. `src/rating/pairs.ts` is unchanged; the Worker hands it the corrected count. One swapped repeat per batch
  stays (the owner weighed dropping it and kept it as the only check on rater consistency).
- **The adults board waits for three adult voters**, as a role's own board already did. Until then a voter who has
  20 votes is told the leaderboard opens once three people have voted, and nothing is marked as seen. A student whose
  own board is open before the adults board is shown the students' board.
- **The leaderboard's list has the full width and the charts come after it.** On a wide screen the list of #2 to #10
  sat in a narrow column beside the charts.
- **Head-to-head counts are sent already added up by group** (unit, year, question number, quote in the stem).
  The page used to receive one row per pair of questions, from which a reader could work out an unranked question's
  wins, or one voter's picks in a small pool.
- **The home page says whether voting has yet to open or has ended** when no round is open, and the voting page says
  so when another device answered a pair first (that first answer stands, as before).
Effect on votes: none expected from the last four; the first changes when a repeat can appear, by one trial, for a
voter who skipped a pair and went back to it. No frozen file, threshold, item or measure changes.

**25 November 2026: sign-up by email, with a role the voter chooses (owner decision; built and merged the same day).**
The pre-registration's owner decisions were "invite-only personal codes" with roles the owner assigns, and the site
stored no names or email addresses. From this change an adult can also join through a sign-up link the owner shares
(`/join#WORD`): they give an email address, optionally a name, and pick Judge, Coach, Teacher, Alumni or Other. The
address then works in the sign-in box on any device. Codes and invite links work as before, and students still join
only by a code from the owner, so no student address is stored (migration 0009; `src/worker/signup.ts`).
What this changes for anyone reading the data:
- **Identity is not verified.** The address is a username. The site sends no mail, so it never proves the address
  belongs to the person typing it. Anyone who knows a voter's address and the site can vote as them, and one person
  can sign up under several addresses. The owner accepted this for a round shared only with people he trusts. A wrong
  address counts toward the same ten-a-day limit as a wrong code.
- **Roles are self-declared** for these voters. The role boards and the pooled adults board rest on what people said
  they are. The owner can change a voter's role in `/admin`; votes already cast keep the role they were cast under.
- **Who can join** is whoever holds an open sign-up link. The owner can close a link; addresses already signed up
  keep working.
- **What is stored and where it goes:** the address and optional name are in `voters`, shown in `/admin`, the voters
  CSV and the full backup. They are not in the round's JSON export, the votes CSV, the audit log, or anything a
  voter's browser receives. `analysis/analyze.ts` sees the same fields as before.
No frozen file, threshold, item or measure changes.

**25 November 2026: two rules tightened after a review of the email sign-up, before it went live.** A voter whose
role the owner changes has votes under two roles; the three-voter rule for showing a board now counts people, so
such a voter is one person behind the adults board, not two. And a voter who signed up by email cannot be given the
Student role, because no address or name is kept for a student; a student gets a code.

**25 November 2026: the round "All questions" is open, and the owner votes in it (record).** The owner loaded the
corrected footnotes and opened the round at 21:13 UTC with the 36 launch questions in play; the item set froze then.
He signed up through his own sign-up link as "Judge 01" and cast 20 first-presentation votes between 21:14 and
21:50 UTC. They are real judgments and stay in the data. Email sign-up has no "my own code" tick, so at his request
("flag it") Claude set `is_owner = 1` on that voter through the D1 API at 21:53 UTC and added an `admin_audit` row
(`mark_owner`, actor `claude-d1-token`). Nothing else about the voter or the votes changed. The export carries the
flag per voter, so the "voters other than the owner" analysis (PREREG §8) can set all of his votes aside.

**25 November 2026 (late): the Start button sits higher, and sign-up asks for the email first (owner decisions).**
- **Home page.** On a first visit the Start button now follows the task (the hearing format, the criterion and how
  to answer) and comes before "What strong hearing questions do"; it used to come after that guidance. For a
  returning voter it sits directly under the count, above the leaderboard line. Effect: a new voter can start
  without scrolling past the guidance, so some may read less of it before their first batch.
- **Sign-up page.** The page asks for the email alone. An address that has signed up before is signed in at once,
  through the sign-up link as well as the sign-in box; only a new address is then asked for a role and an optional
  name. Nothing is stored for a new address until it gives a role. No change to what is kept or who sees it.
No frozen file, threshold, item or measure changes.

**25 November 2026 (late): new colours (owner decision).** The site's burgundy on warm stone gives way to the navy, white,
grey-blue and gold of the Nevada Center for Civic Engagement's mark, taken from the logo the owner supplied. Type,
layout and wording are unchanged, apart from the head-to-head chart's note (blue where the row's group won more, gold
where it lost more). Every text and control pairing was checked for contrast in day and night colours. Effect on
votes: none expected; recorded because voters see it, and because votes cast before about 22:20 UTC on 25 November
were cast on the old colours.

**25 November 2026 (late): no wait for other voters before a leaderboard shows (owner decision).** Earlier the same
day a board was shown only once three voters stood behind it, for a role's own board and then for the adults board
too. The owner removed the wait: a voter with 20 votes sees the adults board and their own role's board at once.
Effect: with one or two voters behind a board, each can work out the other's picks from it, which the owner accepted
among people he trusts; and the first voters see a board built from very few votes, though no question shows a rank
or rating before it has 10 comparisons. Votes cast after a voter opens a board are marked `after_board = 1` as
before. The owner's own first 20 votes were cast while the wait was on, so none of them is marked.

**26 November 2026: a judge may judge only some units (owner decision).** On the home page a voter can keep "All
questions" (the default) or choose "Only some units": any of Units 1 to 6, at State, Nationals or both. The choice
applies from the voter's next batch, and every batch records the choice it was drawn under (`batches.slice_json`,
migration 0010; also in `votes.csv` as `batch_slice`). In the staged round, a slice with fewer than 12 of its
questions in play, or with fewer than 10 new pairs left for that judge, brings the next questions of the slice into
play, six at a time, in the same balanced order as any group; they join for every voter. When the owner has
switched the round's growth off, nothing joins this way either; the judge gets what of the slice is in play. The leaderboard keeps the
round's ranks across all questions and offers a filter with the same boxes. Students may choose too.
Effects to keep in mind:
- **The single scale across units rests on mixed pairs.** A judge who keeps to some units adds nothing to where those
  units sit against the others. Study health now reports how many adult comparisons cross units and levels, and how
  many votes came from slices. The owner chose not to add a bridging pair to slice batches.
- **Recognition may rise.** Judges are likely to choose units they have coached or judged, and so to meet questions
  they know (PREREG §12).
- **The round grows unevenly.** A popular slice brings its questions into play ahead of the general order, and those
  questions start with few comparisons, so the automatic growth rule (every question in play at 12 adult comparisons)
  waits longer.
- The pairing and rating code is unchanged: it is handed the slice's questions, and the ratings are fitted on every
  question in play.
No frozen file, threshold or measure changes.

**26 November 2026: a judge can change the set mid-batch (owner decision).** The unit choice is renamed "Narrow your
set" and moved directly above the Start button, which now names the set. The voting page names the set with a Narrow
link. Applying a new set there, or changing it on the home page while a batch waits, ends the rest of that batch and
the next batch is drawn under the new set. The ended batch is marked `batches.ended_at` (migration 0011). Its
unanswered pairs are recorded as ended, not skipped: they count as neither votes nor skips, they may be offered to the
judge again, and an unanswered repeat in an ended batch does not count as issued. An answer sent later for one of
them, from a page still showing the old batch, is refused, so a pair offered again cannot be answered twice. Answers already given stay and count
as before. A batch ends only through a change of set; there is no other way to drop the rest of a batch.
Effects to keep in mind:
- **Batches can be shorter than ten pairs.** The pairing code still issues ten; a judge may answer fewer before
  changing the set. Study health reports how many batches ended this way and how many pairs they left unanswered.
- **A judge can steer away from pairs.** Ending a batch after seeing a pair is a way to avoid it, as a skip is. Because
  the only exit is a change of set, the cost of this is small; the counts above show whether it happens often.
No frozen file, threshold or measure changes.
