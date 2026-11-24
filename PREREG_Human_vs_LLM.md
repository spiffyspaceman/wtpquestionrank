# Pre-registration: WTP Question Rank human votes vs the LLM rankings

*Written 24 November 2026, before any vote on the site exists and before any LLM judge has seen the 36 launch
items. Sequel to `claude/Scoring_Audit_2026-11-24.md` (recommendation 4) and
`claude/Validation_Prereg_2026-11-24.md`. Owner decisions recorded 24 November 2026: 36 published State items
(the 12 validation items plus 24 drawn at random); invite-only personal codes; roles judge, coach, alumni, teacher,
other and student; students get their own board and are not pooled; leaderboard visible only to voters after 20
votes and to admins; forced choice with a close-call flag, a skip button and one swapped repeat per batch; method A
re-run on all 36 items before votes open.*

## 1. Question

Does same-session pairwise ranking by isolated LLM judges (method A) reproduce the ranking that experienced WTP
adults produce when they compare the same published questions, well enough to stand in for them when ranking
questions? And how far does the current absolute rubric (method B) track the same adults on the 12 items it scored?

## 2. Items

`items/launch_items_v1.json`, SHA-256 `8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0`.
36 published CCE State questions from cycles 2015-16 to 2024-25: the 12 items of the A/B validation (i00–i11,
texts copied verbatim from the "Hearing Question A/B" page) plus 4 per unit drawn by `items/draw.py` (frame: every
State row of `WTP_Scored_Corpus.csv` in those cycles, minus the 12; seed 1124). Voters and LLM judges see only the
stem and the two bullets. Cycle, unit, level, number and source are hidden.

## 3. The judgment (identical for people and method A)

"Which is the better hearing question: the one that more clearly lets a panel separate a strong, well-prepared team
from a weak one, across a 4-minute opening and 6–10 minutes of follow-up?" Forced choice. People may also flag a
close call or skip a pair.

## 4. Human data

- **Source:** the first round on `wtpquestionrank.spiffyspaceman.com` that uses item set `state-launch-v1`.
- **Design:** batches of 10 pairs. Pair choice follows `src/rating/pairs.ts` with the constants in
  `src/rating/config.ts` as hashed below: warm-up balancing until every item has 6 comparisons, then 30% uniformly
  random pairs and 70% drawn in proportion to an information score. One swapped repeat per batch, at least 20 trials
  after the first showing. Sides random.
- **Unit of analysis:** first-presentation votes. Repeat votes measure consistency only. Skips are not votes.
- **Pools:** *adults* = judge, coach, alumni, teacher, other. Students are analysed separately.
- **Exclusions in the primary analysis:** revoked codes only. Flagged raters (median time under 20 s, or one side
  85% or more, each over 20 or more votes) stay in; §8 reports the result without them.

## 5. LLM data (method A, 36 items)

- **Design:** `llm-arm/design.json`, SHA-256 `813b272a5b93ab70c623431998f7ffae7c144586b3b9c1caeebe5db3739496dc`,
  built by `llm-arm/make_design.py` (SHA-256 `1d74cc4b…f91d`, seed 20261124). All 630 pairs, five blocks of 126,
  six isolated judges per block, three judges seeing each pair in each order. Each judge gets its own random labels
  (Q01–Q36) and pair order. The label key stays in `design.json`, out of the packets.
- **Judges:** one isolated subagent per packet, model and effort logged in the records file. Packet text is in
  `llm-arm/packets/`; its hash is in `design.json`.
- **Combination:** one Bradley–Terry fit over all 3,780 judgments (each judge a rater), with a left-side term.
- **Not used for the primary test:** the earlier method A records in `claude/Validation_Machine_Records_2026-11-24.jsonl`.
  They label items per judge (QA–QL) and the project holds no key from labels to items. If the key is found, §7.4 adds
  a cross-session check; it is not reconstructed from the judges' reasons.
- **Timing:** method A runs before the round opens. Its ratings are not shown on the site or to any voter.

## 6. Code

Every statistic below is computed by `analysis/analyze.ts` on the admin's full JSON export. Hashes at registration:

| file | SHA-256 |
|---|---|
| `src/rating/rating.ts` | `cbc24b38af27f7b490f3268aa0fa2fafadde40072287e3668f03b4c0e5bf2d6d` |
| `src/rating/pairs.ts` | `4c427cb91676bea4a007b9f7c014f5a6f12bbe96d63a094885d134dafae34f30` |
| `src/rating/config.ts` | `6c5e6e78bf125f00dc8fe9bee1491299776b59567020297db84bf87d9f259678` |
| `analysis/analyze.ts` | `8e22fd63a0aeac6986155dbf03ffdba7bbaa4c6f4b2d211461a96f1a986e3009` |
| `analysis/stats.ts` | `d75c07883254d8a1dd4ed56ace7c39e268a45b52d09c733e67077262a05b4873` |

Bootstrap: 1,000 replicates, seed 20261124, resampling raters with all their votes.

## 7. Measures

1. **Primary.** Spearman's ρ between the adult pool's Bradley–Terry strengths and method A's, over the 36 items,
   with a 95% percentile interval from the rater bootstrap (method A held fixed).
2. **Vote-level.** Share of adult first-presentation votes whose winner method A rates higher, against the human
   ceiling: the share whose winner the other adults rate higher (leave one rater out). Report the difference with a
   rater-bootstrap 95% interval.
3. **Method B, 12 items (secondary, descriptive).** Item score = mean over scorers of (S-T + Q-T)/2 under the
   State norms in `wtp_score.py` (struct 49.93/10.48; qual 23.64/5.36), from the arm B rows of the validation
   records. Spearman with the adult pool on the 12 items; same for method A restricted to the 12.
4. **Sean's A/B picks (secondary, if exported).** Share of his 66 first picks that the adult pool's ratings agree
   with, and that method A agrees with; his repeat consistency.
5. **Reliability.** Human split-half by rater (200 random splits, median, Spearman–Brown); method A split-half
   (judges); share of swapped repeats answered the same way. Scale separation reliability is reported but not relied
   on, because adaptive pairing inflates it.
6. **Roles.** Spearman between each pair of role boards on items with 10 or more comparisons in both; the extended
   model's role-by-item departures with |z| ≥ 2.
7. **Calibration map (descriptive).** Least-squares line from method A log-odds to adult log-odds, for converting
   future LLM rankings to the human scale.
8. **Disattenuated ρ (descriptive).** ρ divided by the square root of the product of the two Spearman–Brown
   reliabilities. It can exceed 1.

## 8. Sensitivity analyses (reported, never used for the verdict)

ρ with method A when the adult votes are restricted to: raters not flagged; voters other than the owner; votes cast
before the voter first opened the leaderboard; votes not flagged as close calls; judges and coaches only. Also ρ for
students alone.

## 9. When the analysis runs

When the owner freezes the round, or earlier once both gate conditions hold. The owner may watch the human
leaderboard and data-quality numbers during the round but does not compute any measure in §7 until then.

**Data gate:** at least 15 adult raters with 20 or more first-presentation votes each, and at least 30 adult
first-presentation comparisons for every item. If the gate fails at round close, every number is reported as
descriptive and no verdict is given.

## 10. Decision rule

- **Validated for ranking** if ρ ≥ 0.70, the lower 95% bound ≥ 0.50, and method A's vote-level agreement is no more
  than 0.05 below the human ceiling. Then same-session pairwise LLM ranking may stand in for an adult panel when
  ranking published-style questions, and the calibration map in §7.7 may be used.
- **Partly validated** if ρ ≥ 0.50 but either other condition fails. Then method A may screen drafts, but rankings
  that matter get human comparison.
- **Not validated** if ρ < 0.50. Then method A does not track the adults, and the criteria and prompt need revisiting
  before either LLM method is relied on.

The 0.70 floor matches the validation pre-registration. Every measure is reported whichever way the rule lands.

## 11. Deviations

Any change to the items, design, code or thresholds after this file is hashed is a deviation. It is logged with its
date and reason in `claude/WTPQR_Deviations.md`, and the analysis is reported under both the registered and the
changed procedure.

## 12. Limitations stated in advance

- **The raters are not a random sample.** They are people the owner invites. Judges and coaches who know the owner
  may share his views.
- **Recognition.** Many voters have prepared or judged some of these questions. Hiding cycle and unit cannot stop
  recall. A question a voter coached may draw loyalty either way.
- **Adaptive pairing.** Which pairs a voter sees depends on earlier votes. The Bradley–Terry fit stays valid, but the
  design is not balanced, and close pairs are over-sampled.
- **Leaderboard exposure.** Voters see the board after 20 votes, which can pull later votes toward it. §8 reports
  the pre-board result.
- **One model family, one session.** Method A's ranking is one session's. The audit's open question, whether
  pairwise ranks reproduce across sessions and model versions, is not answered here.
- **The judge instructions were rewritten.** The pilot P2 instructions were not kept in the project, so method A here
  uses new instructions built to the description in the validation pre-registration.
- **The adults' judgment is the standard by design.** It is not ground truth about which questions produce better
  hearings.
