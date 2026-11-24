# WTP Question Rank: build steps for the website sessions

*24 November 2026. Read with `SPEC.md` (what to build) and the original build brief (hard boundaries, platform,
Cloudflare limits). Where this file and the brief differ, this file is newer.*

**Build the site as a Hono Worker on D1 with a small Vite front end, reuse the tested rating module as is, and stop
for the owner's approval at each of the five outward steps the brief lists.**

## 0. What this package already contains

| Path | What it is | Status |
|---|---|---|
| `src/rating/rating.ts` | Bradley–Terry fit, Elo-scale transform, rater bootstrap, role-deviation model | 14 tests pass |
| `src/rating/pairs.ts` | Batch pair selection | 10 tests pass |
| `src/rating/config.ts` | Every tunable constant | pre-registered; do not change without logging a deviation |
| `migrations/0001_init.sql` | D1 schema | checked in local SQLite by `migrations/test/check_schema.py` |
| `items/launch_items_v1.json` | 36 published State questions | load as item set `state-launch-v1` |
| `analysis/analyze.ts` | Round analysis and the pre-registered comparison | 2 end-to-end tests pass |
| `llm-arm/` | Method A design, packets, records and summary | run complete, 3,780 judgments |
| `PREREG_Human_vs_LLM.md` | Pre-registration | hashed and filed in the WTP project before any vote |

Copy `src/rating/`, `migrations/`, `items/` and `analysis/` into the new repo unchanged. The Worker imports
`src/rating/*` directly; the admin page imports the same files for the bootstrap. One copy of the math, two callers.

## 1. Ask the owner, then create the repo

Outward step 1. Ask before creating private repo `spiffyspaceman/wtpquestionrank`. Nothing from `spiffyspaceman/reader`.

## 2. Scaffold

1. `package.json` scripts: `test` (vitest: unit tests plus the Workers pool tests), `build` (vite build), `typecheck`.
2. `wrangler.jsonc`: one Worker, `main: src/worker/index.ts`, static assets from `dist/`, D1 binding `DB`,
   `migrations_dir: migrations`, `workers_dev: false`. Variables: `PROD_HOST = wtpquestionrank.spiffyspaceman.com`,
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. Secrets (owner enters them, step 9): `CODE_PEPPER`, `TURNSTILE_SECRET`,
   optionally `ADMIN_SECRET`.
3. Tests: Vitest with Cloudflare's Workers pool so route tests run against a local D1 with the migrations applied.

## 3. Voter API (all JSON; POST bodies under 2 KB; POST requires `Origin` = `https://PROD_HOST`)

| Route | Does |
|---|---|
| `POST /api/redeem` `{code, turnstileToken}` | Verify Turnstile server-side. Count a wrong code in `attempts` (key = SHA-256 of a daily salt plus `CF-Connecting-IP`; stop at 10 a day). Look up `HMAC-SHA256(CODE_PEPPER, normalized code)`. Refuse revoked codes. Create a session; set the `__Host-` cookie. |
| `GET /api/me` | Role label, votes so far, whether the board is unlocked. Never the voter id. |
| `GET /api/batch` | Return the voter's unfinished batch, or build one: read the open round's items, the `all` pool's `pair_counts`, fit with `fitBTCounts`, build `PairingState` from the voter's votes and skips, call `selectBatch` with a fresh random seed, and insert `batches` and `batch_pairs`. Send each pair as `{pairId, left: {stem, bullets}, right: {stem, bullets}}`. Never send question ids: they encode cycle and unit. |
| `POST /api/vote` `{pairId, pick: "L"\|"R", closeCall, clientMs}` | Check the pair belongs to this voter's batch, the round is open, and the voter is not revoked. Compute the winner, `server_ms = now - issued_at`, `after_board`. In one `db.batch`: insert the vote; if it is not a repeat, upsert `pair_counts` for pool `all`, for the voter's role, and for `adults` when the role is an adult role. A unique-index failure means a double submit: return the current state, not an error. |
| `POST /api/skip` `{pairId, clientMs}` | Insert into `skips`. |
| `GET /api/leaderboard?pool=` | Session required and 20 first votes (or admin). Pools allowed: `adults` and the voter's own role. Set `board_seen_at` the first time. Return live point ratings from `pair_counts` (`fitBTCounts`) plus the latest `rating_snapshots` intervals and their date. Show a rank only at 10 or more games. Header `X-Robots-Tag: noindex`. |

Pages: home (code entry with Turnstile), vote (two cards side by side, stacked under 720 px, 48 px tap targets,
keyboard: arrows, C, S), batch end ("Keep going" / "Stop for now"), leaderboard. Light and dark, reduced motion
respected, visible focus. Every page `<meta name="robots" content="noindex">`.

## 4. Admin

1. **Login.** Cloudflare Access on `PROD_HOST/admin*` with one-time PIN to the owner's email. The Worker also
   verifies the `Cf-Access-Jwt-Assertion` header (signature against the team's certs, `aud`, expiry) on every
   `/admin` request, so a preview URL or a missed route cannot bypass Access. Log the token's `sub`, not the email,
   in `admin_audit`. Fallback only if Access is not set up: `ADMIN_SECRET` exchanged for a short admin session.
2. **Items.** Upload an item file. Reject any item without `published: true`. Store `text_sha256` per question and
   the file's SHA-256 on the item set. The item set freezes when its first round opens.
3. **Rounds.** Create (draft), open, freeze, close. One open round at a time (enforced by index).
4. **Codes.** Create N codes for a role with labels "Judge 01", "Judge 02" and so on, plus an "owner" checkbox for
   the owner's own code. Show codes once and offer a CSV download (label, role, code). Store only the hash.
   Revoke by label.
5. **Raw votes.** Paged table, filterable by role, voter label and repeat.
6. **Refresh intervals.** In the admin browser: download the round's first-presentation votes per pool, run
   `bootstrapBT` (1,000 reps, rater resampling), POST the result to `rating_snapshots`. About 2 seconds for 36 items.
7. **Rebuild caches.** Recompute `pair_counts` from `votes` in time order, excluding revoked voters and repeats.
8. **Exports.** CSV: votes, skips, latest ratings per pool, voters (label, role, revoked date only). JSON: the full
   round in exactly the `RoundExport` shape in `analysis/analyze.ts` (`round`, `voters`, `votes`, `skips`). That JSON
   is the analysis script's input.
9. **Reminder.** A banner when the last export is more than 7 days old (Time Travel keeps 7 days on Free).

## 5. Guards

- **Host guard.** If `Host` is not `PROD_HOST`, return 404 for `/api/*` and `/admin/*`. Preview builds then serve
  static pages only and cannot touch production data.
- Cookie `__Host-wtpqr`, HttpOnly, Secure, SameSite=Lax. No third-party scripts except Turnstile.
- `Content-Security-Policy` limited to self plus `challenges.cloudflare.com`.

## 6. Tests that must exist before the first deploy

1. The 26 tests shipped here.
2. Migrations apply cleanly to a local D1; the append-only triggers reject UPDATE and DELETE on `votes`.
3. Redeem: right code works; wrong code counts; the 11th wrong code in a day is refused; revoked code refused.
4. A batch never contains question ids, cycle or unit.
5. Vote: double submit is harmless; a pair from another voter's batch is refused; a vote in a frozen round is refused;
   `pair_counts` matches a rebuild from `votes` after a scripted session of 50 votes.
6. Leaderboard: 404 without a session; locked under 20 votes; never shows a pool the voter may not see.
7. Admin: request without a valid Access token is refused; host guard returns 404 on a non-production host.
8. Export JSON passes through `analyze()` without error (reuse `analysis/analyze.test.ts`).

## 7. Deploys (Workers Builds)

- Build command: `npm ci && npm test && npm run build`. A failing test stops the deploy.
- Deploy command: `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
- `main` deploys to production; other branches get preview URLs, which the host guard keeps away from data.

## 8. Facts to check before relying on them

Each item below is unverified as of 24 November 2026. Check each against Cloudflare's current docs and record the result in the repo README.

- D1 accepts `CREATE TRIGGER` and partial unique indexes in migrations. Local SQLite accepts both; D1 has not been
  tested here.
- `db.batch()` runs as one transaction and rolls back if any statement fails. A secondary source quotes Cloudflare's
  D1 docs saying so; read the docs page itself.
- Preview versions from Workers Builds share production bindings (hence the host guard).
- Workers Builds' deploy token may apply D1 migrations, or the owner must add an API token as a build secret.
- `wrangler d1 export` syntax (the brief flagged it).
- The Workers Rate Limiting binding on Free. The design uses the D1 `attempts` table instead, so this no longer
  matters for launch.

Checked 24 November 2026: Cloudflare Access is free for up to 50 users on the Zero Trust Free plan.

## 9. Steps only the owner takes (each is an outward step: ask first)

1. Approve creating the repo.
2. Connect the repo to Workers Builds in the Cloudflare dashboard.
3. Approve the Custom Domain `wtpquestionrank.spiffyspaceman.com`. Touch no other DNS record.
4. Create the Turnstile widget for that hostname and enter `TURNSTILE_SECRET`. Enter `CODE_PEPPER` (32 random bytes)
   and keep a copy offline: losing it invalidates every code.
5. Create the Access application for `/admin*` with a one-time-PIN policy for the owner's email.
6. Check the 24 added question texts in `items/launch_items_v1.json` against CCE's PDFs. They were transcribed from
   the project's PDF extracts; the 12 validation texts come verbatim from the A/B page.

## 10. Launch order

1. Deploy with the round in draft. Load `items/launch_items_v1.json` as item set `state-launch-v1`.
2. Confirm the item file's SHA-256 is `8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0`, the
   hash the pre-registration names.
3. Owner makes test codes, votes a full batch on a phone and a laptop, checks the export runs through the analysis,
   then revokes the test codes and runs "Rebuild caches". The analysis excludes revoked voters.
4. Owner makes real codes and opens the round.
5. At freeze: export JSON, run `npx tsx analysis/analyze.ts --export round.json --items items/launch_items_v1.json
   --llm-design <dir>/design.json --llm-out <dir>/out --method-b Validation_Machine_Records_2026-11-24.jsonl`,
   where `<dir>` comes from `python3 llm-arm/expand_compact.py MethodA36_Compact_2026-11-24.jsonl <dir>` if the full
   `llm-arm/` folder is not at hand.
