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

## Owner: admin clicks (about 5 minutes)

1. **Items.** On GitHub, open `items/launch_items_v1.json` and use **Download raw file**; don't copy and paste. In
   `/admin` under **Items**, choose the file and select **Load**. Expect "It matches the pre-registered hash"
   (`8cb28a9e…53510d0`).
2. **Round.** Under **Rounds**, create `Round 1` on `state-launch-v1 (36 items)` as a draft, then select **Open**. The
   item set freezes when the round opens. Test votes go in Round 1 itself; the test codes are revoked afterward, and
   the analysis excludes revoked codes (owner decision, 24 Nov 2026).
3. **Test codes.** Under **Codes**: role **Other**, How many **2**, **My own code** unticked, **Create codes**. Paste
   the two codes to Claude. They are throwaway.

## Claude: checks, test votes, analysis

4. Check in D1, read-only: the item set hash equals the pre-registered one, there are 36 items, Round 1 is open and
   the item set is frozen.
5. Vote on the live site with a headless browser:
   - `Other 01`: 20 votes plus a skip and a close call, so the leaderboard unlocks; then resume on a second "device".
   - `Other 02`: one batch.
   - If Turnstile refuses the headless browser, the owner casts these on a phone instead.
6. Build the round export from D1 and run `analysis/analyze.ts` on it with the method A outputs in `llm-arm/`.

## Owner: finish

7. In `/admin`, select **Refresh intervals** and then **JSON**. Upload the JSON to Claude, who compares it with the
   export from step 6.
8. **Revoke** `Other 01` and `Other 02`. Their sessions end, the caches rebuild and saved intervals are dropped.
9. Make the real codes by role, ticking **My own code** for the owner's. Download each CSV and keep it with the
   list of names. Hand out the codes.
10. As votes come in, select **Refresh intervals** now and then, and export the JSON at least weekly. Time Travel keeps
    only 7 days on Free, and the admin banner reminds you.
11. At freeze: export the JSON and run the analysis command in BUILD_STEPS §10 step 5.
