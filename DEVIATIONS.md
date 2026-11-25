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
