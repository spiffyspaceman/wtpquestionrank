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
