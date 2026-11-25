# WTP Question Rank: notes for Claude

Invite-only site at `https://wtpquestionrank.spiffyspaceman.com` where invited voters pick the better of two published
We the People hearing questions. A Bradley–Terry fit turns votes into a private leaderboard, and the vote log feeds the
pre-registered study in `PREREG_Human_vs_LLM.md`. Owner: Sean. Write to him plainly; no emojis anywhere.

## Start here

- **"What are the next steps?"** Answer from `docs/NEXT_STEPS.md`, and keep it current as steps finish.
- **Why things are the way they are:** `README.md` (design, guards, Cloudflare facts checked 24 Nov 2026),
  `docs/BUILD_STEPS.md` and `docs/SPEC.md` (the plan), `docs/wtp-question-rank-build-brief.md` (original brief),
  `DEVIATIONS.md` (every change to the pre-registered design, with dates).

## Hard rules

- **Frozen files:** never edit `src/rating/rating.ts`, `src/rating/pairs.ts`, `src/rating/config.ts`,
  `analysis/analyze.ts`, `analysis/stats.ts`, `items/launch_items_v1.json` or `migrations/0001_init.sql`. The
  pre-registration hashes them and `test/node/frozen-hashes.test.ts` fails the build if a byte changes. If one truly
  must change: stop, tell the owner why, and log it in `DEVIATIONS.md` only after he agrees. Schema changes go in
  `migrations/0002_*.sql`.
- **What voters see while voting:** the stem, the bullets and, since 25 Nov 2026 (owner decision), the question's
  published footnotes with access dates removed. Never send question ids, cycle, unit, level, number or the CCE
  source line to the voting page. Votes are append-only; "reset" means a new round. A change to what
  voters see or when (unlock threshold, items, pairing) is a deviation: ask first, then log it.
- **Privacy (changed by the owner on 25 Nov 2026):** an adult may sign up by email. For those voters the site stores
  the address, an optional name and the role they chose (`voters.email`, `voters.name`; migration 0009). Those two
  fields go to `/admin`, the voters CSV and the full backup, and nowhere else: never to a voter's browser, the round
  JSON, the votes CSV or the audit log (which names labels). **Students never sign up by email:** store no name,
  email or free text about a student, never offer Student on the sign-up form, and never let a voter who has an
  address on file be given the Student role (the Worker refuses it). No phone numbers for anyone. The
  address is not verified and the site sends no email; do not add sending without the owner's yes. **One more
  exception (owner, 25 Nov 2026):** the "Other" reason may carry the voter's own explanation of a pick, at most 20 words, for every
  voter, students included. It lives only in `vote_other`, is shown only in admin and `reasons.csv`, and never on
  another voter's page (a voter sees their own note when they go Back within their current batch; owner, 25 Nov
  2026). No other free-text field without the owner's yes.
- **No analytics, no third-party scripts except Turnstile.** The CSP enforces it.
- **The news reader is off limits:** `reader.spiffyspaceman.com`, repo `spiffyspaceman/reader`, the Cloudflare Worker
  `reader-email` and its Vultr server. Don't read, fetch, touch or reuse any of it, even to compare.
- **Outward steps need the owner's yes first:** Cloudflare settings, DNS, secrets, or anything that changes production
  data. A push to `main` deploys (Workers Builds runs the tests first).
- **Sources:** never invent one. Link a source on the site only after opening the page and finding the quoted words.

## Owner decisions (in force)

| Date | Decision |
|---|---|
| 24 Nov | Test votes go in Round 1 itself with throwaway codes that are then revoked (the analysis excludes revoked codes). |
| 24 Nov | `server_ms` is time on each pair, not since the batch was issued (DEVIATIONS.md, clarification). |
| 24 Nov | Admin login is Cloudflare Access with a one-time PIN; the Worker verifies the Access token itself. |
| 25 Nov | Design: Schola (TeX Gyre Schola, self-hosted as "WTPQR Schola"), regular and italic only, no bold, no all-caps or small caps, minimal hint text. Colour: burgundy (oxblood on warm stone). |
| 25 Nov | No email or phone accounts. Sign-in is a personal code or a one-tap invite link (`/#CODE`); the owner assigns roles. |
| 25 Nov | Codes are derived from `CODE_PEPPER` and the voter id so admin can show them again; only the hash is stored. |
| 25 Nov | Cloudflare's zone-wide Web Analytics beacon is left in place; the site's CSP blocks it. |
| 25 Nov | Leaderboard (only) shows year, unit, number and confirmed sources, plus unit and year averages (DEVIATIONS.md). |
| 25 Nov | Leaderboard unlock stays at 20 votes. |
| 25 Nov | Every published WTP question becomes Round 2, after Round 1; Round 1 stays the pre-registered 36. |
| 25 Nov | After sign-in, voters land on `/start`: votes cast, unlock progress, start or continue a batch, hearing format, criterion, and judging guidance paraphrased from CCE's Toolkit without attribution (DEVIATIONS.md). |
| 25 Nov | Optional reason pills, up to two of nine fixed codes per vote, in `vote_reasons` (migration 0002), exported as `reasons.csv` (DEVIATIONS.md). Tapping a question card or its button chooses it; the other side fades, reasons appear, and Next sends the vote. |
| 25 Nov | "Other" pill (counts as one of the two reasons) with an optional explanation of at most 20 words, for every voter, in `vote_other` (migration 0003). The owner lifted the no-free-text rule for this field only. |
| 25 Nov | Back and Forward within the current batch; a changed answer is appended to `vote_corrections` (migration 0004) and counts everywhere through the views `votes_effective` and `vote_reasons_effective`. Read votes through those views, never `votes` directly, wherever the winner, close call or reasons matter. |
| 25 Nov | Reason pills are comparative ("Why is A better?"; "Forces a clearer position"); codes unchanged. |
| 25 Nov | Leaderboard: top question in full, #2–#10 beside an Explore panel (groups, any two variables, distribution, head-to-head), then a searchable, sortable, paged list. Tags read "2024-25 U4Q1". Per-question reason counts are shown to voters; Other notes never are. |
| 25 Nov | Admin "Study health": data gate, votes per day, reasons given, rater flags. Report only; no §7 measure (no repeat agreement) before the analysis. |
| 25 Nov | After the audit (`docs/AUDIT_2026-11-25.md`): a vote cast before the leaderboard cannot be changed once the voter has opened it (DEVIATIONS.md). |
| 25 Nov | Voters get a Sign out link on `/start`; sessions stay 90 days. |
| 25 Nov | The unchosen question keeps full-ink text after a pick; letter and number keys can be switched off on `/start`; four short status lines on the voting page and leaderboard (DEVIATIONS.md). |
| 25 Nov | Round 2 runs as six rounds, one per unit (about 70 questions each), with one linked fit offline. A single 420-question round needs far more CPU per batch than the Free plan allows. |
| 25 Nov (later) | **Supersedes the Round 2 rows above.** The owner wants every published question from the last 20 years (State and National Finals) open to voters now, and Round 1 dropped: it is frozen without reaching its gate when the first large round opens, so the pre-registered comparison reports no verdict (PREREG §9). Rounds of about 35 questions, one per unit and level, on the Free plan. Texts come from CCE's own published files only. |
| 25 Nov (later) | Several rounds are open at once and the site assigns each new batch to the open round with the fewest batches (migration 0005). Voters cannot choose a round and never see a round name outside the leaderboard. The unlock is 20 first votes over all rounds; `after_board` and the correction lock are per round (`round_board_seen`). Round 1 stays open until the first unit round is ready. |
| 25 Nov (latest) | **Supersedes "rounds of about 35" above.** Every question goes in one round ("All questions"), for one ranking on one scale, and the owner moves the Worker to the Workers Paid plan to carry it: a new batch costs about 0.2 s of CPU at 324 questions, 0.65 s at 540 and 2 s at 720 (Node timings), against 10 ms on Free. Do not open that round on the Free plan. Several-open-rounds support stays (Round 1 beside it until frozen). |
| 25 Nov (latest) | The "All questions" set is open-ended (migration 0006): later PDFs are transcribed and added to the same set and round, dated; a set only grows and loaded text never changes. The launch set can never be opened up. So the missing cycles do not block opening the round. |
| 25 Nov (latest) | The first round ("Round 1" in older notes, id `C5TW5gelpkQa`) is renamed **"Test"**. The big round is one standing round that keeps growing; voters never see its name while it is the only round with a board, so close (not freeze) "Test" when the big round opens. Admin can rename any round. |
| 25 Nov (latest) | Each question shows its published footnotes (voting page and leaderboard): marker in the text, note under the bullets, "accessed <date>" left out. A web address is a link only if `items/links.json` says the page opened; dead ones are replaced (only by a page opened and found to hold the quoted words) or dropped; unchecked ones are plain text unless marked `"link": true` (the owner chose that on 25 Nov for the 52 addresses on sites that refuse automated readers). Stored in `questions.notes_json` (migration 0007), which may be corrected after loading; stem and bullets may not. |
| 25 Nov (latest) | A night switch sits in the masthead of every page (a sliding switch labelled "Night"; on means night colours). The choice is kept in the browser only (`wtpqr-theme`); with none, the page follows the device. `/theme.js` (in `src/web/public/`) sets it before the page paints; the CSP allows it as a same-origin script. |
| 25 Nov (later) | Question texts come from CCE's PDFs through `items/transcribe.py` (owner uploads the files, or his text extracts of them; where a PDF's text layer is faulty the fix is made by eye from the page image and listed in `items/corrections.json`); the full set in `items/rounds/all.json` is bundled into the Worker and loaded from admin. Never serve it as a static file. |
| 25 Nov | Admin gets a full backup (every table but caches, sessions, attempts and code hashes), an invitation tracker in the Voters table, and a gate forecast in Study health (counts only). |
| 25 Nov | Method A2: re-run the LLM judges with the human arm's guidance and reasons, as a registered addendum. `PREREG_Addendum_A2.md`, approved and hashed 25 Nov (DEVIATIONS.md); A2 is secondary and never enters the verdict. It ran 25 Nov (`llm-arm/out-a2/`); all 30 judges stay, with a 26-judge fit (`out-a2-without4/`) reported beside it. |

| 25 Nov (audit) | **The full round opens in stages** (migration 0008, `src/worker/staging.ts`), because the owner expects fewer than 25 voters: the 36 launch questions first, then 24 at a time in a balanced shuffled order, whenever every question in play has 12 adult comparisons. One round, one scale; the frozen pairing code is handed the questions in play. The owner can stop the automatic growth or add a group by hand in admin; a question in play never leaves. The leaderboard lists only questions in play. |
| 25 Nov (audit) | An unranked question (under 10 comparisons) shows its comparison count only; the Worker sends no rating, range or win count for it. |
| 25 Nov (audit) | A role's own board appears once three voters in that role have voted in the round; the adults board always shows. |
| 25 Nov (audit) | On a first visit `/start` puts the task and guidance before the Start button; returning voters see the count first. |
| 25 Nov (audit) | State 2019-20 U1Q1 is held out of play (`HELD` in `staging.ts`): its second bullet was cut off in transcription. The corrected text goes in under a new id when the owner sends the PDF page. |
| 25 Nov (audit) | Footnotes: the "sponsored by" line of a special question and its marker are not shown; one address loses its download stamp. Both gave away level or year. |
| 25 Nov (audit) | The leaderboard leads with rank: "#1" is the large figure and the rating sits beside it in small type (top card, list and table). |
| 25 Nov (audit) | A skipped pair later voted on is one trial toward the 20-trial repeat gap. One swapped repeat per batch stays. |
| 25 Nov (audit) | The adults board, like a role board, waits for three voters in the round; a voter with no open board is told so and nothing is marked seen. |
| 25 Nov (audit) | Leaderboard layout: the list of #2 to #10 has the full width and the Explore charts follow it. Head-to-head counts go to the page added up by group, never per pair of questions. |
| 25 Nov (evening) | **Supersedes "No email or phone accounts" and owner-assigned roles, for adults.** Sign-up by email through a sign-up link the owner makes in admin (`/join#WORD`; `src/worker/signup.ts`, migration 0009): address, optional name, and a self-chosen role (Judge, Coach, Teacher, Alumni, Other). No verification: the address is a username and the sign-in box takes a code or an email. The role is fixed once chosen; the owner can change it in admin. Students keep codes. Addresses appear in admin, the voters CSV and the backup only (DEVIATIONS.md). |

## Commands

```
npm ci                 # install (.npmrc sets legacy-peer-deps; npm 10 needs it)
npm test               # 209 tests: rating, analysis, hashes, Worker routes on local D1, end-to-end export
npm run typecheck
npm run build          # typecheck, then pages into dist/ (so the deploy cannot ship a type error)
npm run test:ui        # browser smoke test, 63 checks on a throwaway database (needs Playwright; not part of npm test or the deploy)
npm run premerge       # all of the above in order; run it before merging anything that touches src/web
NODE_USE_ENV_PROXY=1 node scripts/dev-local.mjs   # local site on :8787 (needs .dev.vars; see README)
```

## Where things live

- `src/worker/`: the Hono Worker. `voter.ts` (voting API), `admin.ts` (admin API), `data.ts` (rounds, caches,
  board), `access.ts`, `auth.ts`, `guards.ts`, `exports.ts` and `export-shape.ts` (must match `RoundExport`),
  `pools.ts`, `reasons.ts` (pill codes), `health.ts` and `gate.ts` (study health), `staging.ts` (which questions
  are in play in a staged round, and which are held back), `signup.ts` (email sign-up and sign-up links).
- `src/web/`: the pages (sign-in `index`, sign-up `join`, voter home `start`, vote, board, admin) and `styles.css`. Fonts in `src/web/public/fonts/`.
- `items/`: the frozen launch item file, `sources_v1.json` (confirmed quoted sources), `corpus.csv` (scores only),
  `transcribe.py` and `transcribed.json` (every question transcribed from CCE's PDFs; the PDFs themselves are not in
  the repo), `build_round_sets.py` and `rounds/all.json` (every question in one item file, bundled by
  `src/worker/builtin-sets.ts`), `corrections.json` (fixes made by eye against page images), `check_links.py` and
  `links.json` (which footnote links were checked; read by `src/worker/notes.ts`).
- `test/worker/` (workerd, local D1) and `test/node/` (hashes, export shape, end-to-end with Miniflare). In a test, a
  voter sees a board only once three voters stand behind it: `quorum()` in `test/worker/helpers.ts` adds two.
- `analysis/first_group.ts` (not frozen): cuts a staged round's export down to the votes among the 36 launch
  questions cast before the second group joined, for an exploratory run of `analyze.ts` beside method A and A2.
- Production: Cloudflare Worker `wtpquestionrank`, D1 database `wtpquestionrank` (id in `wrangler.jsonc`), secrets
  `CODE_PEPPER` and `TURNSTILE_SECRET` (values never in the repo). Never change `CODE_PEPPER` mid-round: every code
  and link would stop working.

## Traps already hit

- Worker secrets must be added under **Settings > Variables and Secrets** as type **Secret**, not under Build
  variables and not as Text (a deploy wipes Text values).
- Founders Online blocks automated readers; verify founders' documents through *The Founders' Constitution*
  (press-pubs.uchicago.edu) or Avalon instead.
- Local D1 state is keyed by the database id; after an id change, re-run
  `npx wrangler d1 migrations apply wtpquestionrank --local`.
- Turnstile does not pass a headless browser on the live site; live test votes are the owner's to cast.
- D1 allows 100 bound parameters per query: send id lists through `chunks()` in `src/worker/util.ts`. Local D1
  now enforces this too (a 101-parameter query failed with "too many SQL variables", checked 25 Nov 2026). It still
  does not enforce a batch size, so the test helper `call()` refuses any `db.batch()` over 100 statements.
- Production D1 refused the first full-set load, which sent about 1,300 statements in one `db.batch()`; local D1
  took it. The item loader now writes in batches of 40 that are each safe to repeat, and a set whose load stopped
  part-way (file hash `loading`) is resumed by running the load again. Keep database batches small.
- This environment's network reaches only a few hosts, and requests to widen it have been refused by the service.
  `items/check_links.py` marks a link "unchecked" when the host is refused; never read that as "dead". A plain-http
  request to a refused host can come back 403 or 404 from the proxy itself.
- Adding questions: put the new PDF (or text extract) with the others, run `items/transcribe.py` on all of them,
  then `items/build_round_sets.py` and `items/check_links.py`, run the tests, merge; the owner then presses **Load or
  update the full question set** in admin. The uploaded PDFs live outside the repo and are gone when a session ends,
  so the owner sends them again or `transcribed.json` is extended from the new file alone.
- A footnote correction changes `items/rounds/all.json` but adds no question, so admin shows "corrected footnotes to
  load"; the owner presses the same Load button. Footnotes may change after loading; stems and bullets may not.
- Tests in one file share a database (rounds and sets made by an earlier test are still there). Close other rounds
  first, and never assume a set's round is new.
- `.dev.vars` is read by `npm run test:ui` as it stands: a `PROD_HOST` on another port makes that script fail.
- A string written through a shell heredoc loses `\u0000`-style escapes (they arrive as raw control characters and
  the file no longer compiles). Reuse `cleanNote()` from `reasons.ts` for cleaning typed text; do not retype its
  pattern.
- A link pasted into a tab already on that page changes only the part after `#`, which does not reload it; the
  sign-in and sign-up pages reload on `hashchange` for that reason.
- No test may assert on wall-clock time with a tight bound: a 50 ms bound in `src/rating/rating.test.ts` failed about
  one run in five on a busy machine and would have blocked a deploy. Pipe test output through `grep` or `tail` only
  with `set -o pipefail`, or a failing run looks like a passing one.
- Always Use HTTPS is a zone-wide setting, so it also changes `reader.spiffyspaceman.com`. It is the owner's to flip;
  the Worker redirects http itself.
