# Addendum to PREREG_Human_vs_LLM.md: method A2, the LLM judges with the human arm's guidance

*Drafted 25 November 2026 by Claude at the owner's request. The owner approved it the same day ("run A2"), after
answering the three points in §7. This file was hashed, and the hash logged in `DEVIATIONS.md`, before any A2 judge
saw a packet.*

## 1. Why

PREREG §3 says the judgment is identical for people and method A. It no longer is. Since 25 November 2026 a human
voter reads a list of what strong hearing questions do before voting (`/start`) and is offered nine named reasons at
the moment of each choice (`DEVIATIONS.md`, entries of 25 November). The method A judges saw neither. A gap between
the adults and method A can therefore come from the instructions and not from the method. A2 gives a fresh set of
LLM judges the same two additions, so the write-up can report the adults against both.

## 2. What A2 is

- **Design:** the registered one. `llm-arm/design.json` (SHA-256 `813b272a…496dc`, unchanged) supplies the same 30
  judges, the same labels for each judge, and the same 126 pairs in the same order. Only the instructions differ.
- **Packets:** `llm-arm/packets-a2/`, built by `llm-arm/make_addendum_packets.py` from the registered packets, each
  checked against its registered hash first. Each A2 packet differs from its method A packet in three places:
  1. a section "What strong hearing questions do", word for word as `/start` shows it (the script fails if the two
     differ);
  2. rule 5: the judge may name up to two of the nine reasons, by code, with the labels voters see; the 20-word
     reason in the judge's own words stays;
  3. the output path (`llm-arm/out-a2/`) and a `reasons` list on each pair.
- **Packet hashes:** `llm-arm/design_a2_hashes.json`.
- **Judges:** one isolated subagent per packet, new sessions, the same model and effort as the method A run
  (`claude-opus-5-5`, default effort); both are logged in the records file.
- **Combination:** one Bradley–Terry fit over all 3,780 judgments with a left-side term, as §5.
- **Timing:** A2 runs before any §7 measure is computed on the human votes. Its ratings are not shown on the site or
  to any voter.

## 3. What A2 does not match

A2 closes the gap in instructions only. A human voter can still tick Close call, skip, go back within a batch, and
see the leaderboard after 20 votes; an A2 judge cannot. The human votes cast before the leaderboard (§8) are the
closest match to A2.

## 4. Measures (all secondary; none enters the verdict)

Computed by the frozen `analysis/analyze.ts`, run a second time with `--llm-out llm-arm/out-a2` and the same
`--llm-design`. No code changes.

1. Spearman's ρ between the adult pool and A2 over the 36 items, with the same rater-bootstrap interval as §7.1.
2. A2's vote-level agreement with the adults against the human ceiling, as §7.2.
3. Both of the above on the adults' pre-leaderboard votes only.
4. Spearman's ρ between method A and A2 over the 36 items. This mixes two things, the change in instructions and
   ordinary session-to-session variation, and cannot separate them.
5. Descriptive: how often each of the nine reasons is named by A2 judges and by adult voters.

## 5. Decision rule

Unchanged. The verdict in §10 is read from the registered method A run alone. A2 is reported beside it, whichever
way it lands. One reading is fixed in advance: if A2's ρ with the adults is higher than method A's by 0.10 or more,
the write-up says the instructions account for part of any human–LLM gap; if the two are within 0.10, it says they
do not appear to.

## 6. Limits stated in advance

- A2 is one more session of one model family. A difference between A and A2 smaller than the spread between two
  sessions under the same instructions means nothing, and that spread is not measured here.
- If the method A model is no longer offered, A2 also differs in model version.
- A2 was added after the round opened and after 20 test votes existed (all from the owner's test code, to be
  revoked). No §7 measure had been computed.

## 7. Owner's answers, 25 November 2026

1. The margin in §5 is 0.10.
2. A2 judges get no close-call flag. A2 changes the instructions and the reasons only.
3. Model and effort: the same as the method A run, read from `llm-arm/MethodA36_Records_2026-11-24.jsonl`:
   `claude-opus-5-5`, one isolated general-purpose subagent per packet, default effort. If that model is not offered
   when A2 runs, the run stops and the owner is asked.

The owner gave the go-ahead on this file as a whole on 25 November 2026.
