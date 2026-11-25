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
- **Pre-registered design:** while voting, voters see only stem and bullets. Never send question ids, cycle, unit,
  level, number or source to the voting page. Votes are append-only; "reset" means a new round. A change to what
  voters see or when (unlock threshold, items, pairing) is a deviation: ask first, then log it.
- **Privacy:** store no names, emails, phone numbers or free text about voters (some are students). Names stay on the
  owner's own list, keyed by label ("Judge 07"). The owner reconfirmed this on 25 Nov 2026.
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
| 25 Nov | Optional reason pills, up to two of nine fixed codes per vote, in `vote_reasons` (migration 0002), exported as `reasons.csv` (DEVIATIONS.md). Tapping a question card picks it. |
| 25 Nov | Admin "Study health": data gate, votes per day, reasons given, rater flags. Report only; no §7 measure (no repeat agreement) before the analysis. |

## Commands

```
npm ci                 # install (.npmrc sets legacy-peer-deps; npm 10 needs it)
npm test               # 118 tests: rating, analysis, hashes, Worker routes on local D1, end-to-end export
npm run typecheck
npm run build          # pages into dist/
NODE_USE_ENV_PROXY=1 node scripts/dev-local.mjs   # local site on :8787 (needs .dev.vars; see README)
```

## Where things live

- `src/worker/`: the Hono Worker. `voter.ts` (voting API), `admin.ts` (admin API), `data.ts` (rounds, caches,
  board), `access.ts`, `auth.ts`, `guards.ts`, `exports.ts` and `export-shape.ts` (must match `RoundExport`),
  `pools.ts`, `reasons.ts` (pill codes), `health.ts` and `gate.ts` (study health).
- `src/web/`: the pages (sign-in `index`, voter home `start`, vote, board, admin) and `styles.css`. Fonts in `src/web/public/fonts/`.
- `items/`: the frozen launch item file, `sources_v1.json` (confirmed quoted sources), `corpus.csv` (scores only).
- `test/worker/` (workerd, local D1) and `test/node/` (hashes, export shape, end-to-end with Miniflare).
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
