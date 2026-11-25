# Next steps (launch, BUILD_STEPS §10)

*Saved 24 November 2026. When the owner asks "what are the next steps", answer from this file and update it as
steps finish.*

## Where things stand

- Live at `https://wtpquestionrank.spiffyspaceman.com`. Pushes to `main` deploy through Workers Builds after the tests pass.
- D1 `wtpquestionrank` (id `de56eb48-…10dc`) has migration 0001 applied. It holds no items, rounds or codes yet.
- Turnstile, `CODE_PEPPER` and `TURNSTILE_SECRET` are set and verified on the live site.
- Cloudflare Access protects `/admin` (team `falling-mouse-d5eb.cloudflareaccess.com`, one-time PIN), and the Worker
  verifies the Access token itself.
- Still open from BUILD_STEPS §9: **step 6**, the owner checks the 24 added question texts in
  `items/launch_items_v1.json` against CCE's PDFs. Best done before the round opens.
- A Cloudflare API token "wtpquestionrank D1 setup" (D1 Edit plus Workers Scripts Read) is saved on the Claude
  environment "wtpquestionrank". It expires 2 December 2026. Delete it in My Profile > API Tokens once launch is done.

## Done on 25 November 2026

- Item set `state-launch-v1` loaded: 36 published questions; stored file hash equals the pre-registered
  `8cb28a9e…53510d0` (Claude checked in D1).
- `Round 1` created as a **draft** (not yet open, so the item set is not yet frozen).
- Test codes `Other 01` and `Other 02` created; their links were shared with Claude. No votes yet.
- From 25 Nov the admin Voters table has **Show link** for any active code (recomputed from `CODE_PEPPER`, audited;
  only the hash is stored). `Other 01` and `Other 02` were made before that and cannot be shown again; their links
  are in the chat with Claude, and they get revoked after the test anyway.
- Cloudflare's zone-wide automatic Web Analytics injects its beacon script into this site's pages. The site's CSP
  blocks it, so browsers never load it and nothing is sent. Owner decision: leave the zone setting as is and rely on
  the CSP (no exclusion rule).
- The live invite link fills the code and shows the Turnstile check. Turnstile does not pass a headless browser, so
  the test votes are the owner's to cast on a phone.

## Owner: now

1. **Check the 24 added question texts** against CCE's PDFs (BUILD_STEPS §9 step 6) before opening the round.
2. **Open Round 1** in `/admin` (Rounds > Open). The item set freezes.
3. **Test votes on your phone** with the two links:
   - `Other 01` link: judge 20 pairs (tick one close call, skip one); the Leaderboard link appears. Open it.
   - Same link on a laptop: you should land where the phone left off.
   - `Other 02` link: judge one batch of ten.

## Claude: after the test votes

5. Build the round export from D1 and run `analysis/analyze.ts` on it with the method A outputs in `llm-arm/`.

## Owner: finish

6. In `/admin`, select **Refresh intervals** and then **JSON** (it downloads in pages and saves one file). Upload the JSON to Claude, who compares it with the
   export from step 5.
7. **Revoke** `Other 01` and `Other 02`. Their sessions end, the caches rebuild and saved intervals are dropped.
8. Make the real codes by role, ticking **My own code** for the owner's. Download each CSV (label, role, code, link)
   and keep it with the list of names (any code can also be shown again later with **Show link**). Send each person their link; they tap it and are in. The typed code still
   works as a fallback.
9. As votes come in, select **Refresh intervals** now and then, and export the JSON at least weekly. Time Travel keeps
    only 7 days on Free, and the admin banner reminds you.
10. At freeze: export the JSON and run the analysis command in BUILD_STEPS §10 step 5.

## Later (owner decisions, 25 Nov 2026)

- **Round 2: every published WTP question.** After Round 1 freezes, Claude builds a full item set (State and National
  Finals, every cycle) from CCE's published PDFs and adds a one-click "Load" in admin, so no JSON file is needed.
  `items/corpus.csv` lists 420 questions (216 State, 204 NF) but holds scores only, not text. Round 1 stays the
  pre-registered 36.
- **Two quoted sources found but not yet confirmed**, so not linked on the leaderboard: John Adams to Richard Price,
  19 April 1790 (Founders Online, Adams/06-20-02-0188), and Paul Howe, "Eroding Norms and Democratic
  Deconsolidation," *Journal of Democracy* 28:4 (2017). Founders Online blocks automated readers, and the journal page
  shows only the opening. If the owner opens them and sees the quoted words, add them to `items/sources_v1.json`.
- Leaderboard unlock stays at 20 votes (pre-registered).

