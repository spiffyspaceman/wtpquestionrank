# WTP Question Rank

An invite-only site where invited voters pick the better of two published We the People hearing questions. A
Bradley–Terry fit turns the votes into a private chess-scale leaderboard. The vote log feeds the pre-registered
comparison in `PREREG_Human_vs_LLM.md`.

- **Address:** `wtpquestionrank.spiffyspaceman.com` (Workers Custom Domain).
- **Stack:** one Cloudflare Worker (Hono) on D1, static pages built with Vite, tests in Vitest.
- **Plan documents:** `docs/BUILD_STEPS.md` (what to build; wins over the brief), `docs/SPEC.md`,
  `docs/wtp-question-rank-build-brief.md`.

## Frozen files

The pre-registration hashes these files. `test/node/frozen-hashes.test.ts` fails the build if any byte changes.
A change needs the owner's agreement and an entry in `DEVIATIONS.md` first.

| File | SHA-256 |
|---|---|
| `src/rating/rating.ts` | `cbc24b38af27f7b490f3268aa0fa2fafadde40072287e3668f03b4c0e5bf2d6d` |
| `src/rating/pairs.ts` | `4c427cb91676bea4a007b9f7c014f5a6f12bbe96d63a094885d134dafae34f30` |
| `src/rating/config.ts` | `6c5e6e78bf125f00dc8fe9bee1491299776b59567020297db84bf87d9f259678` |
| `analysis/analyze.ts` | `8e22fd63a0aeac6986155dbf03ffdba7bbaa4c6f4b2d211461a96f1a986e3009` |
| `analysis/stats.ts` | `d75c07883254d8a1dd4ed56ace7c39e268a45b52d09c733e67077262a05b4873` |
| `items/launch_items_v1.json` | `8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0` |

`migrations/0001_init.sql` is pinned the same way. Schema changes go in `migrations/0002_*.sql`.

## Commands

| Command | Does |
|---|---|
| `npm ci` | Install. `.npmrc` sets `legacy-peer-deps` because npm 10 crashes resolving the Vitest peer set otherwise. |
| `npm test` | All tests: the shipped rating and analysis tests, the hash check, route tests in workerd against a local D1, and an end-to-end run that exports a scripted round and passes it through `analyze()`. |
| `npm run typecheck` | TypeScript for the Node code, the Worker, the pages and the Worker tests. |
| `npm run build` | Build the pages into `dist/`. |
| `npm run dev` | Build, then `wrangler dev` with a local D1. |
| `node scripts/dev-local.mjs` | Like `wrangler dev`, but the Worker's outbound fetches go through Node (for sandboxes where only Node can reach the internet). |

Local development reads secrets from `.dev.vars` (never committed). Example:

```
PROD_HOST=localhost:8787
TURNSTILE_SITEKEY=1x00000000000000000000AA
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
CODE_PEPPER=<64 random hex characters>
ADMIN_SECRET=<a long random string>
ACCESS_TEAM_DOMAIN=
ACCESS_AUD=
```

The two empty `ACCESS_*` lines switch off Cloudflare Access locally so `ADMIN_SECRET` works; production keeps the values in
`wrangler.jsonc`.

The two Turnstile values are Cloudflare's always-pass test keys. Apply migrations locally with
`npx wrangler d1 migrations apply wtpquestionrank --local`.

## How it works

**Voter API** (`/api`, JSON, production host only, POST bodies under 2 KB, POST needs `Origin: https://PROD_HOST`):

- `POST /api/redeem`. Checks Turnstile (success, and that the token was solved on `PROD_HOST`), throttles wrong codes, looks up `HMAC-SHA256(CODE_PEPPER, code)` and sets the
  session cookie.
  - The throttle is 10 a day per SHA-256 of a daily salt and the client IP.
  - The cookie is `__Host-wtpqr`: HttpOnly, Secure, SameSite=Lax, 90 days.
- `GET /api/me`, `GET /api/batch`, `POST /api/vote`, `POST /api/skip`, `GET /api/leaderboard?pool=`.
- Pairs go to the browser as an opaque pair id with "L" and "R" sides. Question ids, cycle, unit and source never
  leave the server.

**Admin** (`/admin`, `/admin/api/*`):

- **Login.** Cloudflare Access protects these paths. The Worker also verifies the `Cf-Access-Jwt-Assertion` token on
  every request: RS256 signature against the team's certs, `iss`, `aud`, `exp`, `nbf`. It logs the token's `sub` in
  `admin_audit`, never the email. `ADMIN_SECRET` works only while Access is not configured.
- **Items.** Upload an item file. The Worker rejects any item without `published: true`. It stores the file's
  SHA-256 and `text_sha256 = SHA-256(JSON.stringify([stem, bullets]))` per question.
- **Rounds.** Draft, open, frozen, closed. Only one round is open at a time. The item set freezes when its first
  round opens.
- **Codes.**
  - Create codes by role, with labels like "Judge 01" and an owner flag.
  - Each code also comes as a one-tap invite link, `https://PROD_HOST/#CODE`. The part after `#` never reaches the
    server; the home page reads it, clears it from the address bar before Turnstile loads, and signs in once the check
    passes (one automatic attempt only). The role is still set by the owner, and nothing new is stored.
  - Codes are computed as `HMAC-SHA256(CODE_PEPPER, "invite:" + voter id)`, so the admin page can show any code and
    link again (**Show link** in the Voters table, audited by label). The database still stores only
    `HMAC(CODE_PEPPER, code)`; without the pepper, nothing in it yields a code. Codes made before 25 Nov 2026 were
    random and cannot be shown again.
  - Revoke by label. Revoking ends the voter's sessions and rebuilds the caches at once.
- **Raw votes.** Paged, filtered by role, label and repeat.
- **Refresh intervals.** The admin's browser runs `bootstrapBT` (1,000 reps, seed 20261124, rater resampling) and
  saves a snapshot for each pool.
- **Rebuild caches.** Recomputes `pair_counts` from `votes` (first presentations, revoked voters excluded).
- **Exports.**
  - JSON in exactly the `RoundExport` shape of `analysis/analyze.ts`. The admin page fetches JSON and votes CSV in pages
    of at most 2,000 votes and joins them in the browser, so no request's work grows with the round (Workers Free:
    10 ms CPU per request). A test checks that the stitched files equal the one-shot routes byte for byte.
  - CSV of votes, skips, ratings and voters (voters: label, role and revoked date only).
  - A banner appears when no export is newer than 7 days.

**Guards:**
- **Host guard.** `/api` and `/admin` return 404 on any host but `PROD_HOST`.
- **Branch previews.** The `previews` block in `wrangler.jsonc` is empty, so previews get no D1 and no secrets.
- **No other URLs.** `workers_dev` and `preview_urls` are off.
- **Headers.** Every response carries a CSP limited to self plus `challenges.cloudflare.com`, plus `X-Robots-Tag:
  noindex`.

**Time on pair (`server_ms`).** BUILD_STEPS writes `server_ms = now - issued_at`, where `issued_at` is the time the
whole batch was sent. The Worker measures from the later of `issued_at` and the voter's previous answer in the same
batch. Each pair then gets its own time, which is what SPEC §2 ("time on pair") and the 20-second flag in
`analysis/analyze.ts` need. A batch resumed after a break carries the break on its next pair.

## Cloudflare facts checked on 24 November 2026 (BUILD_STEPS §8)

Each fact below comes from Cloudflare's docs, read that day.

1. **Triggers and partial unique indexes: confirmed in remote D1.**
   - The docs say D1 "is compatible with most SQLite's SQL convention"
     ([SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)). They do not mention triggers.
   - On 24 November 2026, `wrangler d1 migrations apply --remote` ran all 32 statements of `0001_init.sql` on the
     production database. `sqlite_schema` there lists every table, all nine triggers and
     `CREATE UNIQUE INDEX rounds_one_open ON rounds(state) WHERE state = 'open'`.
   - That the triggers fire is tested in local D1 (same SQLite engine): `test/worker/schema.test.ts`.
2. **`db.batch()` is one transaction.** "Batched statements are SQL transactions. If a statement in the sequence fails,
   then an error is returned for that specific statement, and it aborts or rolls back the entire sequence."
   ([D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/))
3. **Branch previews do not share production bindings, which corrects BUILD_STEPS.**
   - Workers Builds now runs `npx wrangler preview` on non-production branches.
   - "Previews do not inherit production settings"
     ([Previews](https://developers.cloudflare.com/workers/previews/),
     [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
   - Version URLs do run "against your production resources"
     ([Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)). That is why
     `preview_urls` is false and the host guard stays.
4. **The token Workers Builds creates has no D1 permission.** It gets "Account Settings (read), Workers Scripts
   (edit), Workers KV Storage (edit), Workers R2 Storage (edit)", plus Workers Routes, User Details and Memberships
   ([Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)). The owner adds D1
   Edit to that token (My Profile > API Tokens) or picks a token with D1 Edit. UNVERIFIED until the first build.
5. **`wrangler d1 export` syntax:** `npx wrangler d1 export <NAME> --output <OUTPUT>`.
   - Flags: `--remote`/`--local`, `--table`, `--no-schema`, `--no-data`, `--skip-confirmation`.
   - "A running export will block other database requests."
     ([D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/),
     [Import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/))
6. **The Workers Rate Limiting binding on Free is UNVERIFIED.**
   [Its page](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) does not say. The design
   uses the D1 `attempts` table instead.

Also checked that day:
- **Time Travel:** "7 days on the Workers Free plan".
- **Workers Builds on Free:** 3,000 build minutes a month, 1 concurrent build, 20-minute timeout.
- **Custom Domains:** "Cloudflare will create DNS records ... on your behalf". They cannot sit on a hostname with an
  existing CNAME.
- **Automatic provisioning:** wrangler can create a D1 database at deploy, but it writes the id back to the config
  file, which a Workers Builds run would not commit. So the database is created once by hand, and its id goes in
  `wrangler.jsonc`.

## Deploys

- **Build command:** `npm ci && npm test && npm run build`. A failing test stops the deploy.
- **Deploy command:** `npx wrangler d1 migrations apply wtpquestionrank --remote && npx wrangler deploy`.
- **Branches:** `main` deploys to production. Preview builds of other branches get no bindings.
