# WTP Question Rank: one-page spec

*24 November 2026. Supersedes the build brief where they differ; the differences are listed at the end.*

**WTP Question Rank is an invite-only site where WTP adults and students pick the better of two published State
hearing questions, a batch Bradley–Terry fit turns their votes into a chess-scale leaderboard that only voters and the
admin can see, and the vote log is kept clean enough to test the owner's LLM ranking method.**

## 1. Voters get in with a personal code and leave no personal data

- One code per person, tagged with a role: judge, coach, alumni, teacher, other, student. The code is the login on any device.
- The site stores only a hash of the code (HMAC with a secret pepper), the role, and a neutral label ("Judge 07"). Real names stay on the owner's own list. No emails, no analytics, no free text from voters.
- Redemption sits behind Turnstile and a wrong-code throttle (10 per hashed client key per UTC day, counted in D1).
- A session is a random token in a `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, 90 days.

## 2. Voting is a batch of ten pairs, judged on one criterion

- Every pair page shows the criterion: "Which is the better hearing question: the one that more clearly lets a panel separate a strong, well-prepared team from a weak one, across a 4-minute opening and 6–10 minutes of follow-up?"
- Two questions side by side (stacked on phones), full stem and bullets. Cycle, unit, level, number and question ids never reach the browser; the client sees only an opaque pair id and "left" or "right".
- Controls: pick left, pick right, a close-call checkbox, Skip. Keyboard: left and right arrows, C, S.
- Each batch holds 9 new pairs and, once the voter has 20 trials behind them, 1 earlier pair with sides swapped. After each batch: "Keep going" or "Stop for now". No daily cap.
- The server records time on pair (issue time to vote time) and the browser's own timing.

## 3. Ratings come from one fit over the whole log, never from vote order

- Bradley–Terry with a left-side term and a weak Normal prior on each item, fit by Newton's method over ordered-pair counts. Shown as 1000 + 400 × log10-odds, so the average item is 1000 and a 400-point gap means 10-to-1 odds.
- The Worker refits point ratings on demand from the `pair_counts` cache (about 2 ms in Node for 36 items and 5,000 votes). No online Elo: the exact refit is cheap enough that a provisional order-dependent number adds nothing.
- 95% intervals come from a 1,000-rep bootstrap that resamples raters, run in the admin's browser with the same module and saved as a snapshot. The board shows the snapshot date.
- An item shows a rank only after 10 comparisons in that pool.

## 4. The leaderboard is private and lags a voter's own votes

- Unlocks after 20 first-presentation votes. Voters see the adults' pooled board and their own role's board; admins see every board. Students vote and get their own board but are not in the pooled one.
- `noindex`, never served without a session. The site records when each voter first opened it, and every later vote carries `after_board = 1`.

## 5. Pairs are chosen to balance first, then to inform

Warm-up balances counts until every item has 6 comparisons. After that, 30% of new pairs are uniformly random and 70% are drawn in proportion to p(1 − p) × (se² + se²), so close and uncertain pairs come up more often without collapsing onto nearest neighbours. No voter sees a pair twice except the one planned repeat. Sides are random.

## 6. The admin runs rounds and owns the data

- Login: Cloudflare Access with a one-time PIN to the owner's email (free up to 50 users), with the Worker verifying the Access token itself.
- Load an item file (published questions only; the database rejects anything else), freeze it into a versioned item set, open, freeze or close a round. "Reset" means a new round. Votes are never edited or deleted.
- Create codes by role (shown once, downloadable as CSV), revoke a code, view raw votes, refresh intervals, rebuild caches from the log, export CSV and JSON. The full JSON export is the analysis script's input.

## 7. Quality is measured, not assumed

Swapped repeats measure each rater's consistency. The analysis flags raters whose median time is under 20 seconds or who pick one side 85% of the time or more, over 20 or more votes. Flags are reported; they do not silently drop votes.

## 8. Validation against the LLM ranking is pre-registered

`PREREG_Human_vs_LLM.md` fixes the items, the LLM design, the code hashes, the measures and the decision rule before the first vote. Method A (36 items, 30 isolated judges) runs before the round opens; its ratings never appear on the site.

## Where this spec departs from the brief

| Brief | Spec | Why |
|---|---|---|
| Online Elo, K = 32, updated per vote | Batch Bradley–Terry refit | Order-independent, and cheap enough to refit on demand |
| Roles judge, coach, alumni, student | Adds teacher and other; students not pooled | Owner decision, 24 Nov 2026 |
| One vote per pair per voter | One first vote plus at most one swapped repeat | Repeats measure consistency; the unique index includes `is_repeat` |
| Skip optional | Forced choice + close-call flag + Skip | Owner decision |
| Leaderboard per-role tabs open question | Voters: pooled adults + own role; admins: all | Default chosen; easy to change |
| Admin login open question | Cloudflare Access, Worker verifies the JWT | Access is free up to 50 users |
| Question source shown? | Hidden from voters | Owner requirement |
