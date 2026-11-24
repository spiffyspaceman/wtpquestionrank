# Build brief: WTP Question Rank

Prepared 24 November 2026. This brief is for a new chat that will build the site. Nothing has been built yet.

## What it is

An invite-only website where people the owner invites compare two published We the People hearing questions side by side and pick the better one. From all the votes, the site keeps a chess-style (Elo) leaderboard.

- **Address:** `wtpquestionrank.spiffyspaceman.com`
- **Owner:** Sean, a federal defender in Nevada who also writes and judges WTP questions. He reads the prose, so write to him plainly.

## Hard boundaries

- **This is a separate project from the owner's private news reader** (`reader.spiffyspaceman.com`, GitHub `spiffyspaceman/reader`). Share no code, server, database or keys with it. Invited voters must have no path to it.
- **Leave the Reader's Vultr server and its repo alone.**
- **Spend no money without asking.** Stay on free tiers.
- **Before each outward step, ask the owner.** These steps are:
  - creating the GitHub repo;
  - connecting Cloudflare;
  - adding DNS or a Custom Domain;
  - creating secrets;
  - deploying.

## Decisions the owner has made

- **Voters:** invite-only, by role: judge, coach, alumni, student.
  - **Roles are recorded but not weighted.** Per-role rankings are wanted as an option.
- **Votes:** one vote per pair per voter.
  - No daily limit: voters keep going until they choose to stop.
  - Pairs are handed out in **batches** to avoid fatigue.
- **Questions:** only **published** questions are compared.
- **Leaderboard:** visible **only to voters**, possibly after a minimum number of votes, and to admins. **Never public.**
- **Privacy:**
  - No privacy notice and no analytics (no visitor tracking such as Google Analytics).
  - Therefore **store no names or emails** of voters. Some voters may be students.
- **Deploys:** automatic deploys preferred over a manual check.
- **TV:** no TV version, and none of the Reader's house rules apply here.

## Facts checked on 24 November 2026

**Domain and accounts**
- `spiffyspaceman.com` is an active Cloudflare zone (nameservers `aurora` and `zeus.ns.cloudflare.com`).
- The bare domain has **no A record and no website**, and `www` doesn't exist.
- Mail for the bare domain uses Cloudflare Email Routing (the Reader's newsletters). Don't touch the bare domain's MX records.
- `wtpquestionrank.spiffyspaceman.com` has **no DNS record**: it is free.
- GitHub account `spiffyspaceman` has two private repos, `reader` and `google-tv-launcher`. There is no website repo.
- **UNKNOWN:** the Cloudflare zone's plan, and the Vultr plan (irrelevant here).

**Cloudflare limits** (from Cloudflare's docs, read 24 November 2026)

| Service | Free tier | Over the limit |
|---|---|---|
| Workers | 100,000 requests a day; 10 ms CPU per request | Error 1027; never billed. Workers Paid is $5 a month minimum. |
| D1 | 5M rows read and 100k rows written a day; 500 MB per database; 5 GB per account; 10 databases | Queries fail; no bill |
| D1 Time Travel | Restore to any minute in the last 7 days (30 on Paid); always on | — |
| Turnstile | Free, unlimited challenges, up to 20 widgets. The docs don't say the site must be proxied. | — |
| Workers Custom Domains | Need an active Cloudflare zone; Cloudflare creates the DNS record. Can't be used on a hostname with an existing CNAME. | — |
| Workers Builds (Git) | Production branch deploys on push; other branches get preview URLs; 3,000 build minutes a month; 1 build at a time | — |

**Not verified:**
- whether the Workers Rate Limiting binding is on the Free plan (its docs don't say);
- the exact `wrangler d1 export` syntax;
- whether Cloudflare Access is free for one admin.

Check these before relying on them.

**Scale:** about 5,000 votes a month at roughly 7 row writes per vote is about 35,000 writes a month, against 100,000 a **day** allowed. The free tier is ample.

## Platform

- **Stack:** Cloudflare Workers + D1, in a **new private repo** (suggested `spiffyspaceman/wtpquestionrank`).
- **Language:** TypeScript.
- **Server:** **Hono** on Workers.
- **Pages:** a small page built with Vite and served as the Worker's static assets. A framework is optional; keep it light.
- **Address:** the Worker serves the subdomain as a Workers **Custom Domain**.
- **Tests:** Vitest. Cloudflare offers a Workers test pool, so the tests can run against a local D1.

## Data model (D1)

- `questions`: id, text, source (year, level, unit), published (boolean), active (boolean), created.
- `rounds`: id, name, state (`open` | `frozen` | `closed`), created; plus `round_questions` (round, question).
- `voters`: id, code_hash, role, label (neutral, e.g. "Judge 07"), created, revoked_at.
  - Real names stay on the owner's own list, off the site.
- **`votes`, append-only:** id, round, voter, question_a, question_b, winner, shown_left (which question was shown on the left), created.
  - **Never update or delete a row.**
  - A unique index on (round, voter, min(a, b), max(a, b)) enforces one vote per pair.
- `ratings`: (round, pool, question) → rating, games.
  - The pool is `all` or a role.
  - This is a cache that can always be rebuilt from `votes`.
- `attempts`, or similar: counts of wrong codes, for throttling.

## Behaviour

**Invite codes**
- One personal code per person, tagged with a role.
- The code is the person's login: redeeming it on another device restores the same voter.
- Codes are stored hashed and can be revoked; a revoked voter's votes can be excluded from the ratings.
- After redemption, a session lives in an httpOnly, Secure, SameSite cookie.

**Pairs and batches**
- Hand out N pairs at a time, never a pair the voter has already judged.
- Prefer questions with fewer comparisons and pairs whose ratings are close.
- Randomise which question is shown on the left.
- After each batch, the voter chooses "Keep going" or "Stop for now".

**Elo**
- Each vote updates the `all` pool and the voter's role pool in one transaction with the vote insert.
- Suggested start rating 1500 and K = 32; keep both in one config place.
- The admin can **rebuild every rating by replaying the vote log in time order**. Elo depends on order, so the replay must use vote time.

**Leaderboard**
- Shown to a voter after M votes.
- Tabs for "all" and each role, if the owner wants voters to see the per-role tabs.
- Admins always see it.
- It isn't indexed by search engines (`noindex`) and is never shown without a session.

**Frozen or closed rounds** accept no votes.

## Admin

- **Login:**
  - preferred: Cloudflare Access on `/admin` with a one-time PIN sent to the owner's email (check the free tier first);
  - otherwise: a long admin secret held as a Worker secret, exchanged for an admin session.
- **What it does:**
  - load published questions (paste or upload CSV/JSON) and choose them for a round;
  - create codes by role and revoke them;
  - view raw votes;
  - **export CSV and JSON**: raw votes, ratings by pool, voters (labels and roles only);
  - open, freeze or close a round. "Reset" means starting a new round; never delete votes;
  - rebuild ratings from the log.
- **Off-site copies:** Time Travel covers only 7 days on Free, so remind the owner to export periodically, or add a scheduled export to R2 later if wanted.

## Abuse controls

- Invite-only codes are the main control: every vote is tied to a revocable code.
- Turnstile on code redemption.
- Throttle wrong-code attempts (counted in D1, or with the Rate Limiting binding if it's confirmed on Free).
- The unique pair index blocks repeat votes. Small request bodies; check the Origin header on state-changing requests.

## Deploys

- Workers Builds connected to the repo: `main` deploys to production, and other branches get preview URLs.
- **The build command runs the tests first, so failing tests stop the deploy.** The owner prefers this to a manual check.
- Schema changes are numbered D1 migrations applied during the deploy. Never edit one that has shipped. Time Travel is the undo.
- Secrets (Turnstile secret, admin secret if used) go in Worker secrets, never in the repo.

## Accessibility and look

- Plain, readable and keyboard-usable, with good contrast in light and dark modes and support for reduced motion.
- The two questions sit side by side on wide screens and stack on phones, with large tap targets.
- No need to match the Reader's design.

## Open questions: ask the owner before building

Suggested defaults are in brackets.

1. Personal codes, one per person, or one shared code per role? [Personal. Shared codes can't enforce one vote per pair per person or revoke one person.]
2. Batch size N, and the votes M needed to unlock the leaderboard? [10 and 20]
3. Which published questions (years; state or national; units)? Compared only within the same unit or round, or across all of them? Where does the owner get the text?
4. Can a voter call a pair equal, or skip it? [Allow "skip". A tie counts as half a win if wanted.]
5. Admin login: Cloudflare Access with the owner's email, or an admin secret?
6. Show each question's source (year, level, unit) to voters, or the text only?
7. Per-role leaderboards visible to voters, or to admins only?

## Steps only the owner can take

1. Approve creating the GitHub repo.
2. In the Cloudflare dashboard, connect the repo to Workers Builds and approve the GitHub app.
3. Approve the Custom Domain `wtpquestionrank.spiffyspaceman.com`.
4. Create the Turnstile widget for that hostname, and enter its secret as a Worker secret themselves.
5. If chosen, set up Cloudflare Access for `/admin`.

## Done looks like

- An invited person redeems a code, judges batches of pairs, sees the leaderboard after M votes, and can't vote on the same pair twice.
- The admin loads questions, issues and revokes codes, runs rounds, rebuilds ratings and exports CSV/JSON.
- Tests pass, and a push to `main` deploys automatically. Nothing is public without a code.
