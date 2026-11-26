// Voter API. Question ids never leave the server: pairs go out as an opaque pair id with "L" and "R" sides.
import { Hono, type Context } from "hono";
import { POOLED_ROLES, QUALITY } from "../rating/config";
import { pairKey, selectBatch, type PairingState } from "../rating/pairs";
import { fitBTCounts, makeRng } from "../rating/rating";
import {
  attemptKey,
  codeHash,
  createSession,
  endSession,
  inviteCode,
  MAX_WRONG_CODES_PER_DAY,
  recordWrongCode,
  requireVoter,
  wrongCodeCount,
} from "./auth";
import {
  board,
  boardFloor,
  boardRounds,
  boardSeen,
  firstVoteCount,
  growIfSettled,
  openRounds,
  pairCounts,
  pairCountUpserts,
  playItems,
  ROLE_NAMES,
  slicePlay,
  roundItems,
  roundsByNeed,
  tieKey,
  visiblePools,
} from "./data";
import type { AppEnv, RoundRow, VoterRow } from "./env";
import sourcesFile from "../../items/sources_v1.json";
import { poolsForRole } from "./pools";
import { cleanEmail, cleanName, EMAIL_MAX, joinWordHash, looksLikeEmail, nextLabel, SIGNUP_ROLES } from "./signup";
import { HELD } from "./staging";
import { parseSlice, sliceJson, storedSlice, type Slice } from "./slice";
import { shownNotes, type ShownNote } from "./notes";
import { MAX_REASONS, parseOther, parseReasons, type ReasonCode } from "./reasons";
import { verifyTurnstile } from "./turnstile";
import { chunks, isUniqueViolation, nowIso, optInt, randomId, randomSeed, readJsonObject } from "./util";

export const voterApi = new Hono<AppEnv>();

const MAX_CLIENT_MS = 6 * 3600 * 1000;

interface QuestionText {
  stem: string;
  bullets: string[];
  /** Published footnote markers, [part, offset, mark], and the footnotes (owner decision, 25 Nov 2026). */
  marks: [number, number, string][];
  notes: ShownNote[];
}

async function questionRows(db: D1Database, ids: string[]) {
  if (!ids.length) return [];
  type Q = { id: string; stem: string; bullets_json: string; level: string; cycle: string; unit: number; qnum: number; notes_json: string | null };
  const out: Q[] = [];
  // In chunks: D1 allows 100 bound parameters per query, and a leaderboard can list more questions than that.
  for (const part of chunks([...new Set(ids)])) {
    const r = await db
      .prepare(`SELECT id, stem, bullets_json, level, cycle, unit, qnum, notes_json FROM questions WHERE id IN (${part.map(() => "?").join(",")})`)
      .bind(...part)
      .all<Q>();
    out.push(...r.results);
  }
  return out;
}

/** What a voter sees while judging: the stem, the bullets and the published footnotes. Never ids, cycle, unit or level. */
async function questionTexts(db: D1Database, ids: string[]): Promise<Map<string, QuestionText>> {
  return new Map((await questionRows(db, ids)).map((q) => [q.id, { stem: q.stem, bullets: JSON.parse(q.bullets_json), ...shownNotes(q.notes_json) }]));
}

// ---------- config and redeem (no session) ----------

// Whether each secret is set (never its value), so the owner can tell why sign-in is closed.
voterApi.get("/config", (c) =>
  c.json({
    turnstileSitekey: c.env.TURNSTILE_SITEKEY,
    configured: { codePepper: Boolean(c.env.CODE_PEPPER), turnstileSecret: Boolean(c.env.TURNSTILE_SECRET) },
  }),
);

voterApi.post("/redeem", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const code = body?.code;
  const token = body?.turnstileToken;
  if (typeof code !== "string" || code.length > EMAIL_MAX || typeof token !== "string") return c.json({ error: "bad_request" }, 400);
  // The sign-in box takes an invite code or, for someone who signed up by email, that address (migration 0009).
  const byEmail = looksLikeEmail(code);
  if (!byEmail && code.length > 40) return c.json({ error: "bad_request" }, 400);
  if (!c.env.CODE_PEPPER || !c.env.TURNSTILE_SECRET) return c.json({ error: "not_configured" }, 503);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const key = await attemptKey(c.env, ip);
  if ((await wrongCodeCount(c.env.DB, key)) >= MAX_WRONG_CODES_PER_DAY)
    return c.json({ error: "too_many_attempts", message: "Too many wrong codes today. Try again tomorrow." }, 429);

  if (!(await verifyTurnstile(c.env, token, ip === "unknown" ? undefined : ip)))
    return c.json({ error: "turnstile_failed", message: "The check did not pass. Reload the page and try again." }, 403);

  const email = byEmail ? cleanEmail(code) : null;
  const voter = byEmail
    ? email
      ? await c.env.DB.prepare("SELECT id, revoked_at FROM voters WHERE email = ?").bind(email).first<{ id: string; revoked_at: string | null }>()
      : null
    : await c.env.DB.prepare("SELECT id, revoked_at FROM voters WHERE code_hash = ?")
        .bind(await codeHash(c.env, code))
        .first<{ id: string; revoked_at: string | null }>();
  if (!voter) {
    // A wrong address counts like a wrong code, so addresses cannot be tried one after another.
    await recordWrongCode(c.env.DB, key);
    return byEmail
      ? c.json({ error: "unknown_email", message: "That email has not signed up. Open the sign-up link you were sent." }, 403)
      : c.json({ error: "wrong_code", message: "That code was not recognized." }, 403);
  }
  if (voter.revoked_at) return c.json({ error: "revoked", message: byEmail ? "This email is no longer active." : "This code is no longer active." }, 403);
  await createSession(c, voter.id);
  return c.json({ ok: true });
});

/**
 * Sign up through the owner's sign-up link: an email address, an optional name and a role (owner decision,
 * 25 Nov 2026; migration 0009). An address that has already signed up is simply signed in; its role does not change.
 */
voterApi.post("/join", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const word = body?.word;
  const token = body?.turnstileToken;
  if (typeof word !== "string" || word.length > 40 || typeof token !== "string") return c.json({ error: "bad_request" }, 400);
  const email = cleanEmail(body?.email);
  if (!email) return c.json({ error: "bad_email", message: "Enter your email address." }, 400);
  const name = cleanName(body?.name);
  if (name === false) return c.json({ error: "bad_name", message: "Keep the name to 60 characters." }, 400);
  // The page asks for the email alone first, and for a role only when the address is new (owner decision,
  // 25 Nov 2026). So a request may come without a role; one that names a role must name an adult role.
  const role = body?.role === undefined || body?.role === null || body?.role === "" ? null : body.role;
  if (role !== null && (typeof role !== "string" || !(SIGNUP_ROLES as readonly string[]).includes(role)))
    return c.json({ error: "bad_role", message: "Choose the role that fits you best." }, 400);
  if (!c.env.CODE_PEPPER || !c.env.TURNSTILE_SECRET) return c.json({ error: "not_configured" }, 503);

  const db = c.env.DB;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const key = await attemptKey(c.env, ip);
  if ((await wrongCodeCount(db, key)) >= MAX_WRONG_CODES_PER_DAY)
    return c.json({ error: "too_many_attempts", message: "Too many attempts today. Try again tomorrow." }, 429);
  if (!(await verifyTurnstile(c.env, token, ip === "unknown" ? undefined : ip)))
    return c.json({ error: "turnstile_failed", message: "The check did not pass. Reload the page and try again." }, 403);

  const link = await db.prepare("SELECT id, closed_at FROM join_links WHERE word_hash = ?").bind(await joinWordHash(c.env, word)).first<{ id: string; closed_at: string | null }>();
  if (!link) {
    await recordWrongCode(db, key);
    return c.json({ error: "wrong_link", message: "This sign-up link was not recognized. Ask for the link again." }, 403);
  }
  const known = async () => db.prepare("SELECT id, revoked_at FROM voters WHERE email = ?").bind(email).first<{ id: string; revoked_at: string | null }>();
  let voter = await known();
  // A closed link takes no new sign-ups; someone who signed up before it closed still gets in.
  if (!voter && link.closed_at) return c.json({ error: "link_closed", message: "This sign-up link is closed. Ask for a new one." }, 403);
  // A new address with no role yet: nothing is stored and nobody is signed in; the page now asks for the rest.
  if (!voter && role === null) return c.json({ ok: true, needProfile: true });
  let created = false;
  for (let attempt = 0; !voter; attempt++) {
    const id = randomId();
    try {
      await db
        .prepare("INSERT INTO voters (id, code_hash, role, label, is_owner, created_at, email, name, join_link_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)")
        .bind(id, await codeHash(c.env, await inviteCode(c.env, id)), role, await nextLabel(db, role!), nowIso(), email, name, link.id)
        .run();
      voter = { id, revoked_at: null };
      created = true;
    } catch (e) {
      // Two sign-ups at once took the same label, or this address signed up a moment ago in another tab.
      if (!isUniqueViolation(e) || attempt >= 3) throw e;
      voter = await known();
    }
  }
  if (voter.revoked_at) return c.json({ error: "revoked", message: "This email is no longer active." }, 403);
  await createSession(c, voter.id);
  return c.json({ ok: true, created });
});

/**
 * What this voter judges: {all: true}, or {units: [...], levels: ["State" | "NF", ...]} (owner decision, 26 Nov 2026;
 * migration 0010). It applies from the voter's next batch; a batch already started finishes as it was.
 */
voterApi.post("/slice", requireVoter(), async (c) => {
  const slice = parseSlice(await readJsonObject(c.req.raw));
  if (slice === false) return c.json({ error: "bad_slice", message: "Choose at least one unit and one level." }, 400);
  const db = c.env.DB;
  const voter = c.get("voter");
  const changed = sliceJson(slice) !== sliceJson(storedSlice(voter.slice_json));
  // A new set ends the rest of a batch that is waiting, so the next batch follows the new set at once (owner
  // decision, 26 Nov 2026; migration 0011). Answers already given stay; the unanswered pairs are neither votes nor
  // skips. An unchanged set ends nothing: a judge cannot discard pairs without narrowing.
  const waiting = changed ? await unfinishedPairs(db, voter.id) : null;
  const end = waiting?.batchId && waiting.pairs.length ? waiting.batchId : null;
  await db.batch([
    db.prepare("UPDATE voters SET slice_json = ? WHERE id = ?").bind(sliceJson(slice), voter.id),
    ...(end ? [db.prepare("UPDATE batches SET ended_at = ? WHERE id = ? AND ended_at IS NULL").bind(nowIso(), end)] : []),
  ]);
  return c.json({ ok: true, slice, changed, ended: end ? waiting!.pairs.length : 0 });
});

// Sign out on this device: the session row goes and the cookie is cleared. Other devices stay signed in.
voterApi.post("/signout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

// ---------- session required ----------

async function meState(db: D1Database, voter: VoterRow) {
  const votes = await firstVoteCount(db, voter.id);
  const isOpen = (await openRounds(db)).length > 0;
  // With no round open: has voting yet to open (a round is waiting as a draft), or has it ended?
  const waiting = isOpen ? null : await db.prepare("SELECT 1 FROM rounds WHERE state = 'draft' LIMIT 1").first();
  // A batch left part-way (closed tab, other device): how much of it is still waiting, so the home page can offer it.
  const open = isOpen ? await unfinishedPairs(db, voter.id) : null;
  return {
    role: ROLE_NAMES[voter.role] ?? voter.role,
    votes,
    unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES,
    unlocked: votes >= QUALITY.LEADERBOARD_UNLOCK_VOTES,
    // No round names here: the site chooses the round for each batch, and a name would tell a voter the unit.
    open: isOpen,
    ended: !isOpen && !waiting,
    // What this voter chose to judge (migration 0010): null for all questions.
    slice: storedSlice(voter.slice_json),
    batch: open && open.pairs.length ? { size: open.size, remaining: open.pairs.length } : null,
  };
}

voterApi.get("/me", requireVoter(), async (c) => {
  return c.json(await meState(c.env.DB, c.get("voter")));
});

/** True when the voter (?3) has an issued pair, in any open round, with neither a vote nor a skip. */
const UNANSWERED_SQL = `SELECT 1 FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id
    JOIN rounds r ON r.id = b.round_id AND r.state = 'open'
  WHERE b.voter_id = ?3 AND b.ended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.round_id = b.round_id AND v.voter_id = ?3
                    AND v.item_lo = MIN(bp.left_q, bp.right_q) AND v.item_hi = MAX(bp.left_q, bp.right_q) AND v.is_repeat = bp.is_repeat)
    AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.round_id = b.round_id AND s.voter_id = ?3
                    AND s.item_lo = MIN(bp.left_q, bp.right_q) AND s.item_hi = MAX(bp.left_q, bp.right_q) AND s.is_repeat = bp.is_repeat)`;

/** Pairs of the voter's latest batch, in any open round, that have neither a vote nor a skip yet. */
async function unfinishedPairs(db: D1Database, voterId: string) {
  const batch = await db
    .prepare(
      `SELECT b.id, b.round_id FROM batches b JOIN rounds r ON r.id = b.round_id AND r.state = 'open'
        WHERE b.voter_id = ? AND b.ended_at IS NULL ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1`,
    )
    .bind(voterId)
    .first<{ id: string; round_id: string }>();
  if (!batch) return { batchId: null, size: 0, pairs: [] as BatchPair[] };
  const size = await db.prepare("SELECT count(*) AS n FROM batch_pairs WHERE batch_id = ?").bind(batch.id).first<{ n: number }>();
  const r = await db
    .prepare(
      `SELECT bp.id, bp.left_q, bp.right_q FROM batch_pairs bp
        WHERE bp.batch_id = ?1
          AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.round_id = ?2 AND v.voter_id = ?3
                          AND v.item_lo = MIN(bp.left_q, bp.right_q) AND v.item_hi = MAX(bp.left_q, bp.right_q)
                          AND v.is_repeat = bp.is_repeat)
          AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.round_id = ?2 AND s.voter_id = ?3
                          AND s.item_lo = MIN(bp.left_q, bp.right_q) AND s.item_hi = MAX(bp.left_q, bp.right_q)
                          AND s.is_repeat = bp.is_repeat)
        ORDER BY bp.position`,
    )
    .bind(batch.id, batch.round_id, voterId)
    .all<BatchPair>();
  return { batchId: batch.id, size: size?.n ?? 0, pairs: r.results };
}

interface BatchPair {
  id: string;
  left_q: string;
  right_q: string;
}

/** Everything selectBatch needs about the pool and this voter. */
async function pairingState(db: D1Database, round: RoundRow, voterId: string, slice: Slice | null): Promise<PairingState> {
  const votes = await db
    .prepare("SELECT left_q, right_q, is_repeat, created_at, id FROM votes WHERE round_id = ? AND voter_id = ?")
    .bind(round.id, voterId)
    .all<{ left_q: string; right_q: string; is_repeat: number; created_at: string; id: number }>();
  const skipped = await db
    .prepare("SELECT item_lo, item_hi, is_repeat, created_at, id FROM skips WHERE round_id = ? AND voter_id = ?")
    .bind(round.id, voterId)
    .all<{ item_lo: string; item_hi: string; is_repeat: number; created_at: string; id: number }>();
  // A pair that was skipped and then voted on (by going back within the batch) is one trial, the vote: counting
  // the skip as well brought the swapped repeat one trial early (owner decision, 25 Nov 2026; DEVIATIONS.md).
  const votedFirst = new Set(votes.results.filter((v) => v.is_repeat !== 1).map((v) => pairKey(v.left_q, v.right_q)));
  const skips = { results: skipped.results.filter((s) => s.is_repeat === 1 || !votedFirst.has(pairKey(s.item_lo, s.item_hi))) };
  const repeatsIssued = await db
    .prepare(
      // A repeat left unanswered in a batch the voter ended was never shown as a repeat: it may come again.
      `SELECT bp.left_q, bp.right_q FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id
        WHERE b.round_id = ? AND b.voter_id = ? AND bp.is_repeat = 1
          AND (b.ended_at IS NULL OR EXISTS (SELECT 1 FROM votes v WHERE v.batch_pair_id = bp.id)
               OR EXISTS (SELECT 1 FROM skips s WHERE s.batch_pair_id = bp.id))`,
    )
    .bind(round.id, voterId)
    .all<{ left_q: string; right_q: string }>();

  // Trials are votes and skips, repeats included, in the order they happened.
  type Trial = { at: string; kind: 0 | 1; id: number; left?: string; right?: string; repeat: boolean; key: string };
  const trials: Trial[] = [
    ...votes.results.map((v) => ({
      at: v.created_at,
      kind: 0 as const,
      id: v.id,
      left: v.left_q,
      right: v.right_q,
      repeat: v.is_repeat === 1,
      key: pairKey(v.left_q, v.right_q),
    })),
    ...skips.results.map((s) => ({ at: s.created_at, kind: 1 as const, id: s.id, repeat: false, key: pairKey(s.item_lo, s.item_hi) })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind - b.kind || a.id - b.id));

  const done = new Set(trials.map((t) => t.key));
  // In a staged round, pairs come only from the questions in play (migration 0008), and for a judge who chose some
  // units, only from those (migration 0010; the slice is kept supplied). The ratings are fitted on every question in
  // play, so a slice is placed on the round's one scale.
  const fresh = (ids: string[]) => {
    let n = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!done.has(pairKey(ids[i], ids[j]))) n++;
    return n;
  };
  const items = await slicePlay(db, round, slice, fresh);
  const all = slice ? await playItems(db, round) : items;
  const fit = fitBTCounts(all, await pairCounts(db, round.id, "all"));

  const history: PairingState["history"] = [];
  trials.forEach((t, i) => {
    // Only voted first presentations can be repeated: a repeat needs a first answer to compare with.
    if (t.kind === 0 && !t.repeat) history.push({ trial: i + 1, left: t.left!, right: t.right! });
  });
  return {
    items,
    beta: new Map(all.map((id, i) => [id, fit.beta[i]])),
    se: new Map(all.map((id, i) => [id, fit.se[i]])),
    games: new Map(all.map((id, i) => [id, fit.games[i]])),
    done,
    history,
    repeated: new Set(repeatsIssued.results.map((r) => pairKey(r.left_q, r.right_q))),
    trials: trials.length,
  };
}

voterApi.get("/batch", requireVoter(), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  if (!(await openRounds(db)).length) return c.json({ error: "no_open_round", message: "Voting is closed right now." }, 409);

  let { batchId, pairs } = await unfinishedPairs(db, voter.id);
  if (!pairs.length) {
    batchId = null;
    // The new batch goes to the open round with the fewest batches so far; a round this voter has finished is passed over.
    for (const round of await roundsByNeed(db)) {
      await growIfSettled(db, round);
      const seed = randomSeed();
      const slice = storedSlice(voter.slice_json);
      const issued = selectBatch(await pairingState(db, round, voter.id, slice), makeRng(seed));
      if (!issued.length) continue;
      const newBatchId = randomId();
      const now = nowIso();
      const rows = issued.map((p) => ({ id: randomId(), left_q: p.left, right_q: p.right, p }));
      // Two requests at once (double tap, two devices) must not both create a batch. The insert happens only if the
      // voter still has no unanswered pair; D1 runs each batch as one transaction, so the second request sees the first.
      const res = await db.batch([
        db
          .prepare(
            `INSERT INTO batches (id, round_id, voter_id, seed, created_at, slice_json)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (${UNANSWERED_SQL})
                AND EXISTS (SELECT 1 FROM rounds WHERE id = ?2 AND state = 'open')`,
          )
          .bind(newBatchId, round.id, voter.id, seed, now, sliceJson(slice)),
        ...rows.map((r, i) =>
          db
            .prepare(
              `INSERT INTO batch_pairs (id, batch_id, position, left_q, right_q, is_repeat, reason, issued_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM batches WHERE id = ?2)`,
            )
            .bind(r.id, newBatchId, i, r.left_q, r.right_q, r.p.isRepeat ? 1 : 0, r.p.reason, now),
        ),
      ]);
      if (res[0].meta.changes === 1) batchId = newBatchId;
      else {
        // Another request won (serve its batch), or this round closed a moment ago (try the next open round).
        const now2 = await unfinishedPairs(db, voter.id);
        if (!now2.pairs.length) continue;
        batchId = now2.batchId;
      }
      break;
    }
    if (!batchId) {
      // No batch: either this voter has judged every pair, or the round closed while the batch was being chosen.
      if (!(await openRounds(db)).length) return c.json({ error: "no_open_round", message: "Voting is closed right now." }, 409);
      return c.json({ done: true, pairs: [], size: 0 });
    }
  }
  // The whole batch, answered pairs included, so the voter can go back and change an answer.
  // Two reads: the pairs, then their current answers through the view. One query joining the pairs to the view made
  // SQLite build the view over every vote on the site for each request (launch audit, 25 Nov 2026).
  const issuedPairs = await db
    .prepare(
      `SELECT bp.id, bp.left_q, bp.right_q, EXISTS (SELECT 1 FROM skips s WHERE s.batch_pair_id = bp.id) AS skipped
         FROM batch_pairs bp WHERE bp.batch_id = ? ORDER BY bp.position`,
    )
    .bind(batchId)
    .all<{ id: string; left_q: string; right_q: string; skipped: number }>();
  type Answered = { id: number; batch_pair_id: string; winner_q: string; close_call: number };
  const answers: Answered[] = issuedPairs.results.length
    ? (
        await db
          .prepare(`SELECT id, batch_pair_id, winner_q, close_call FROM votes_effective WHERE batch_pair_id IN (${issuedPairs.results.map(() => "?").join(",")})`)
          .bind(...issuedPairs.results.map((p) => p.id))
          .all<Answered>()
      ).results
    : [];
  const answerOf = new Map(answers.map((a) => [a.batch_pair_id, a]));
  const all = {
    results: issuedPairs.results.map((p) => {
      const a = answerOf.get(p.id);
      return { ...p, vote_id: a?.id ?? null, winner_q: a?.winner_q ?? null, close_call: a?.close_call ?? null };
    }),
  };
  const text = await questionTexts(db, all.results.flatMap((p) => [p.left_q, p.right_q]));
  const why = await currentReasons(db, all.results.flatMap((p) => (p.vote_id === null ? [] : [p.vote_id])));
  const out = all.results.map((p) => {
    let answer: Record<string, unknown> | null = null;
    if (p.vote_id !== null) {
      const w = why.get(p.vote_id);
      answer = { pick: p.winner_q === p.left_q ? "L" : "R", closeCall: p.close_call === 1, reasons: w?.reasons ?? [], other: w?.other ?? null };
    } else if (p.skipped) answer = { skipped: true };
    return { pairId: p.id, left: text.get(p.left_q), right: text.get(p.right_q), answer };
  });
  const start = out.findIndex((p) => p.answer === null);
  return c.json({ done: false, size: out.length, start: start < 0 ? out.length : start, pairs: out });
});

interface PairContext {
  id: string;
  batch_id: string;
  left_q: string;
  right_q: string;
  is_repeat: number;
  issued_at: string;
  voter_id: string;
  round_id: string;
  item_set_id: string;
  state: string;
  set_aside: number;
}

/** Look up a pair for this voter. Returns an error response tag when it may not be answered. */
async function pairFor(db: D1Database, pairId: unknown, voterId: string) {
  if (typeof pairId !== "string" || pairId.length > 64) return { error: "bad_request" as const };
  const p = await db
    .prepare(
      `SELECT bp.id, bp.batch_id, bp.left_q, bp.right_q, bp.is_repeat, bp.issued_at,
              b.voter_id, b.round_id, r.item_set_id, r.state,
              b.ended_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.batch_pair_id = bp.id)
                AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.batch_pair_id = bp.id) AS set_aside
         FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id JOIN rounds r ON r.id = b.round_id
        WHERE bp.id = ?`,
    )
    .bind(pairId)
    .first<PairContext>();
  if (!p || p.voter_id !== voterId) return { error: "unknown_pair" as const };
  if (p.state !== "open") return { error: "round_not_open" as const };
  // A pair left unanswered when a change of set ended its batch is closed: it may come back in a later batch, and an
  // answer sent from a page still showing the old batch would otherwise count for both copies.
  if (p.set_aside) return { error: "batch_ended" as const };
  const lo = p.left_q < p.right_q ? p.left_q : p.right_q;
  const hi = p.left_q < p.right_q ? p.right_q : p.left_q;
  const answered = await db
    .prepare(
      `SELECT 1 FROM votes WHERE round_id = ?1 AND voter_id = ?2 AND item_lo = ?3 AND item_hi = ?4 AND is_repeat = ?5
       UNION ALL
       SELECT 1 FROM skips WHERE round_id = ?1 AND voter_id = ?2 AND item_lo = ?3 AND item_hi = ?4 AND is_repeat = ?5
       LIMIT 1`,
    )
    .bind(p.round_id, voterId, lo, hi, p.is_repeat)
    .first();
  return { pair: p, lo, hi, answered: Boolean(answered) };
}

const PAIR_ERRORS = { bad_request: 400, unknown_pair: 404, round_not_open: 409, batch_ended: 409 } as const;

/**
 * Time on pair as the server sees it: from the later of the batch's issue time and this voter's last answer
 * in the same batch, to now.
 */
async function serverMs(db: D1Database, p: PairContext, nowMs: number): Promise<number> {
  const r = await db
    .prepare(
      `SELECT MAX(t) AS last FROM (
         SELECT v.created_at AS t FROM votes v JOIN batch_pairs bp ON bp.id = v.batch_pair_id WHERE bp.batch_id = ?1
         UNION ALL
         SELECT s.created_at AS t FROM skips s JOIN batch_pairs bp ON bp.id = s.batch_pair_id WHERE bp.batch_id = ?1)`,
    )
    .bind(p.batch_id)
    .first<{ last: string | null }>();
  const start = Math.max(Date.parse(p.issued_at), r?.last ? Date.parse(r.last) : 0);
  return Math.max(0, nowMs - start);
}

async function afterAnswer(db: D1Database, voter: VoterRow, _roundId: string, batchId: string) {
  const votes = await firstVoteCount(db, voter.id);
  const left = await db
    .prepare(
      `SELECT count(*) AS n FROM batch_pairs bp WHERE bp.batch_id = ?
         AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.batch_pair_id = bp.id)
         AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.batch_pair_id = bp.id)`,
    )
    .bind(batchId)
    .first<{ n: number }>();
  return {
    votes,
    unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES,
    unlocked: votes >= QUALITY.LEADERBOARD_UNLOCK_VOTES,
    remaining: left?.n ?? 0,
  };
}

interface Answer {
  pick: "L" | "R";
  closeCall: 0 | 1;
  reasons: ReasonCode[];
  other: { chosen: boolean; note: string };
  clientMs: number | null;
}

/** A vote or correction body, or null when it is malformed. At most MAX_REASONS reasons, "Other" included. */
function parseAnswer(body: Record<string, unknown> | null): Answer | null {
  if (!body || (body.pick !== "L" && body.pick !== "R")) return null;
  const reasons = parseReasons(body.reasons);
  const other = parseOther(body.other);
  if (!reasons || !other || reasons.length + (other.chosen ? 1 : 0) > MAX_REASONS) return null;
  return { pick: body.pick, closeCall: body.closeCall === true ? 1 : 0, reasons, other, clientMs: optInt(body.clientMs, 0, MAX_CLIENT_MS) };
}

/** The round (?3) is open and the voter (?4) is not revoked: the conditions of a vote insert, for its companion statements. */
const STILL_OPEN = `EXISTS (SELECT 1 FROM rounds WHERE id = ?3 AND state = 'open') AND EXISTS (SELECT 1 FROM voters WHERE id = ?4 AND revoked_at IS NULL)`;

type Found = Extract<Awaited<ReturnType<typeof pairFor>>, { pair: PairContext }>;

/** Write a first answer for a pair: the vote, its reasons and the cache, in one D1 batch. */
async function insertVote(c: Context<AppEnv>, voter: VoterRow, found: Found, a: Answer): Promise<Response> {
  const db = c.env.DB;
  const { pair: p, lo, hi } = found;
  const nowMs = Date.now();
  const winner = a.pick === "L" ? p.left_q : p.right_q;
  const stmts = [
    db
      .prepare(
        `INSERT INTO votes (batch_pair_id, round_id, item_set_id, voter_id, role, left_q, right_q, item_lo, item_hi,
                            winner_q, close_call, is_repeat, after_board, client_ms, server_ms, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                EXISTS (SELECT 1 FROM round_board_seen WHERE voter_id = ?4 AND round_id = ?2), ?13, ?14, ?15
          WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?2 AND state = 'open')
            AND EXISTS (SELECT 1 FROM voters WHERE id = ?4 AND revoked_at IS NULL)`,
      )
      .bind(
        p.id,
        p.round_id,
        p.item_set_id,
        voter.id,
        voter.role,
        p.left_q,
        p.right_q,
        lo,
        hi,
        winner,
        a.closeCall,
        p.is_repeat,
        a.clientMs,
        await serverMs(db, p, nowMs),
        new Date(nowMs).toISOString(),
      ),
    // Optional reasons, written only if the vote above was. They repeat the vote's own conditions: if the insert
    // above is refused (the round closed or the code was revoked a moment ago) while a vote for this pair from
    // another request already stands, these must not attach themselves to that vote.
    ...a.reasons.map((r) =>
      db.prepare(`INSERT INTO vote_reasons (vote_id, reason) SELECT id, ?2 FROM votes WHERE batch_pair_id = ?1 AND ${STILL_OPEN}`).bind(p.id, r, p.round_id, voter.id),
    ),
    ...(a.other.chosen
      ? [db.prepare(`INSERT INTO vote_other (vote_id, note) SELECT id, ?2 FROM votes WHERE batch_pair_id = ?1 AND ${STILL_OPEN}`).bind(p.id, a.other.note, p.round_id, voter.id)]
      : []),
    // Repeats measure consistency only; they never feed the ratings.
    ...(p.is_repeat ? [] : pairCountUpserts(db, p.round_id, voter.role, p.left_q, p.right_q, winner === p.left_q, p.id, voter.id)),
  ];
  try {
    const res = await db.batch(stmts);
    // The round froze or the code was revoked between the checks above and this write: nothing was written.
    if (res[0].meta.changes === 0) return c.json({ error: "round_not_open" }, 409);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // A double submit lost the race. Nothing was written; report the current state.
    return c.json({ ok: true, duplicate: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });
  }
  return c.json({ ok: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });
}

voterApi.post("/vote", requireVoter(), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  const body = await readJsonObject(c.req.raw);
  const a = parseAnswer(body);
  if (!a) return c.json({ error: "bad_request" }, 400);
  const found = await pairFor(db, body!.pairId, voter.id);
  if ("error" in found) return c.json({ error: found.error }, PAIR_ERRORS[found.error!]);
  if (found.answered) return c.json({ ok: true, duplicate: true, ...(await afterAnswer(db, voter, found.pair.round_id, found.pair.batch_id)) });
  return insertVote(c, voter, found, a);
});

/** The voter's newest batch, in any round: the only one whose answers can still be changed. */
async function latestBatchId(db: D1Database, voterId: string): Promise<string | null> {
  const b = await db
    .prepare("SELECT id FROM batches WHERE voter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(voterId)
    .first<{ id: string }>();
  return b?.id ?? null;
}

interface EffectiveVote {
  id: number;
  after_board: number;
  role: string;
  left_q: string;
  right_q: string;
  winner_q: string;
  close_call: number;
  is_repeat: number;
}

/** A vote's current reasons (the newest correction's, or its own). */
async function currentReasons(db: D1Database, voteIds: number[]) {
  const out = new Map<number, { reasons: string[]; other: string | null }>();
  if (!voteIds.length) return out;
  const r = await db
    .prepare(`SELECT vote_id, reason, note FROM vote_reasons_effective WHERE vote_id IN (${voteIds.map(() => "?").join(",")}) ORDER BY reason`)
    .bind(...voteIds)
    .all<{ vote_id: number; reason: string; note: string | null }>();
  for (const x of r.results) {
    const g = out.get(x.vote_id) ?? { reasons: [], other: null };
    if (x.reason === "other") g.other = x.note ?? "";
    else g.reasons.push(x.reason);
    out.set(x.vote_id, g);
  }
  return out;
}

/**
 * Change an answer in the voter's current batch (owner decision, 25 Nov 2026; DEVIATIONS.md). A voted pair gets a
 * correction row, appended, never an edit; the cache moves by the change in the winner. A skipped or unanswered pair
 * gets an ordinary first vote. Sending the answer the pair already has changes nothing.
 */
voterApi.post("/correct", requireVoter(), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  const body = await readJsonObject(c.req.raw);
  const a = parseAnswer(body);
  if (!a) return c.json({ error: "bad_request" }, 400);
  const found = await pairFor(db, body!.pairId, voter.id);
  if ("error" in found) return c.json({ error: found.error }, PAIR_ERRORS[found.error!]);
  const p = found.pair;
  if ((await latestBatchId(db, voter.id)) !== p.batch_id)
    return c.json({ error: "batch_closed", message: "That batch is finished; its answers can no longer change." }, 409);

  const v = await db
    .prepare("SELECT id, after_board, role, left_q, right_q, winner_q, close_call, is_repeat FROM votes_effective WHERE batch_pair_id = ?")
    .bind(p.id)
    .first<EffectiveVote>();
  if (!v) return insertVote(c, voter, found, a);
  // A vote cast before the voter first opened this round's leaderboard keeps its answer once they have opened it, so the
  // pre-registered "before the leaderboard" votes (PREREG §8) hold only answers given before it. Owner decision,
  // 25 Nov 2026 (DEVIATIONS.md).
  if (v.after_board === 0 && (await boardSeen(db, voter.id, p.round_id)))
    return c.json({ error: "board_seen", message: "You have opened the leaderboard, so answers from before it can no longer change." }, 409);

  const winner = a.pick === "L" ? v.left_q : v.right_q;
  const now = (await currentReasons(db, [v.id])).get(v.id) ?? { reasons: [], other: null };
  const same =
    winner === v.winner_q &&
    a.closeCall === v.close_call &&
    [...a.reasons].sort().join() === [...now.reasons].sort().join() &&
    (a.other.chosen ? a.other.note : null) === now.other;
  if (same) return c.json({ ok: true, unchanged: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });

  // Every statement carries the same condition, so in one transaction they all apply or none does.
  // The last line repeats the leaderboard rule above inside the transaction, in case the board was opened meanwhile.
  const OPEN = `EXISTS (SELECT 1 FROM rounds WHERE id = ?2 AND state = 'open') AND EXISTS (SELECT 1 FROM voters WHERE id = ?3 AND revoked_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM votes w JOIN round_board_seen s ON s.voter_id = w.voter_id AND s.round_id = w.round_id
                     WHERE w.id = ?1 AND w.after_board = 0)`;
  const token = randomId();
  const stmts: D1PreparedStatement[] = [];
  // The cache moves first, by (new winner is left) - (current winner is left), read inside the transaction. It is
  // sent even when the winner looks unchanged: another correction of the same vote (a second device) may land between
  // the read above and this write, and then the difference is not zero.
  if (!v.is_repeat)
    for (const pool of poolsForRole(v.role))
      stmts.push(
        db
          .prepare(
            `UPDATE pair_counts
                SET left_wins = left_wins + (?6 - (SELECT CASE WHEN winner_q = left_q THEN 1 ELSE 0 END FROM votes_effective WHERE id = ?1))
              WHERE round_id = ?2 AND pool = ?4 AND left_q = ?5 AND right_q = ?7 AND ${OPEN}`,
          )
          .bind(v.id, p.round_id, voter.id, pool, v.left_q, winner === v.left_q ? 1 : 0, v.right_q),
      );
  const at = stmts.length;
  stmts.push(
    db
      .prepare(
        `INSERT INTO vote_corrections (token, vote_id, winner_q, close_call, client_ms, created_at)
         SELECT ?4, ?1, ?5, ?6, ?7, ?8 WHERE ${OPEN}`,
      )
      .bind(v.id, p.round_id, voter.id, token, winner, a.closeCall, a.clientMs, nowIso()),
    ...a.reasons.map((r) =>
      db.prepare("INSERT INTO correction_reasons (correction_id, reason) SELECT id, ?2 FROM vote_corrections WHERE token = ?1").bind(token, r),
    ),
    ...(a.other.chosen
      ? [db.prepare("INSERT INTO correction_other (correction_id, note) SELECT id, ?2 FROM vote_corrections WHERE token = ?1").bind(token, a.other.note)]
      : []),
  );
  const res = await db.batch(stmts);
  if (res[at].meta.changes === 0) return c.json({ error: "round_not_open" }, 409);
  return c.json({ ok: true, corrected: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });
});

voterApi.post("/skip", requireVoter(), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  const body = await readJsonObject(c.req.raw);
  if (!body) return c.json({ error: "bad_request" }, 400);
  const found = await pairFor(db, body.pairId, voter.id);
  if ("error" in found) return c.json({ error: found.error }, PAIR_ERRORS[found.error!]);
  const { pair: p, lo, hi } = found;
  if (!found.answered) {
    try {
      await db
        .prepare(
          `INSERT INTO skips (batch_pair_id, round_id, voter_id, item_lo, item_hi, is_repeat, client_ms, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
            WHERE EXISTS (SELECT 1 FROM rounds WHERE id = ?2 AND state = 'open')
              AND EXISTS (SELECT 1 FROM voters WHERE id = ?3 AND revoked_at IS NULL)`,
        )
        .bind(p.id, p.round_id, voter.id, lo, hi, p.is_repeat, optInt(body.clientMs, 0, MAX_CLIENT_MS), nowIso())
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return c.json({ ok: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });
});

// ---------- leaderboard: 404 without a session ----------

const SOURCES = (sourcesFile as { sources: Record<string, { label: string; url: string }[]> }).sources;

/** The groupings of the head-to-head chart. The labels are the ones the leaderboard page gives its groups. */
const H2H_GROUPS: Record<string, (q: { unit: number; cycle: string; qnum: number; stem: string }) => string> = {
  unit: (q) => `Unit ${q.unit}`,
  year: (q) => q.cycle,
  qnum: (q) => `Question ${q.qnum}`,
  quote: (q) => (/[“"]/.test(q.stem) ? "Quote in stem" : "No quote"),
};

interface GroupRow {
  rank: number | null;
  rating: number | null;
}

/**
 * Average rating per unit or year over ranked questions only (10+ comparisons), so an unplayed question's starting
 * 1000 cannot pull an average. `n` counts every question in the group; `ranked` those that count.
 */
function groupBy<T extends GroupRow>(rows: T[], label: (r: T) => string, order: (r: T) => string | number) {
  const groups = new Map<string, { label: string; order: string | number; n: number; ratings: number[] }>();
  for (const r of rows) {
    const k = label(r);
    const g = groups.get(k) ?? { label: k, order: order(r), n: 0, ratings: [] };
    g.n++;
    if (r.rank !== null && r.rating !== null) g.ratings.push(r.rating);
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map((g) => ({
      label: g.label,
      n: g.n,
      ranked: g.ratings.length,
      mean: g.ratings.length ? Math.round(g.ratings.reduce((s, x) => s + x, 0) / g.ratings.length) : null,
      min: g.ratings.length ? Math.min(...g.ratings) : null,
      max: g.ratings.length ? Math.max(...g.ratings) : null,
    }));
}

voterApi.get("/leaderboard", requireVoter(404), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  const rounds = await boardRounds(db);
  if (!rounds.length) return c.json({ error: "no_round" }, 404);
  const votes = await firstVoteCount(db, voter.id);
  if (votes < QUALITY.LEADERBOARD_UNLOCK_VOTES)
    return c.json({ error: "locked", votes, unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES }, 403);
  const pools = visiblePools(voter.role);
  const asked = c.req.query("pool");
  if (asked !== undefined && !(pools as string[]).includes(asked)) return c.json({ error: "pool_not_allowed" }, 403);

  // Which round's board: the one asked for, or else the round this voter has judged most.
  let round = rounds.find((r) => r.id === c.req.query("round"));
  if (!round) {
    const mine = await db
      .prepare("SELECT round_id FROM votes WHERE voter_id = ? AND is_repeat = 0 GROUP BY round_id ORDER BY count(*) DESC")
      .bind(voter.id)
      .all<{ round_id: string }>();
    round = mine.results.map((m) => rounds.find((r) => r.id === m.round_id)).find(Boolean) ?? rounds[0];
  }

  // Every board the voter may see is shown at once (owner decision, late 25 Nov 2026). A wait for a minimum number
  // of voters behind a board can be switched back on with BOARD_MIN_VOTERS: with one or two voters, each can work
  // out the other's picks from it, which the owner accepted among people he trusts.
  const floor = boardFloor(c.env.BOARD_MIN_VOTERS);
  const who = floor
    ? (
        await db
          .prepare(
            `SELECT DISTINCT v.role, v.voter_id FROM votes v JOIN voters u ON u.id = v.voter_id
              WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL`,
          )
          .bind(round.id)
          .all<{ role: string; voter_id: string }>()
      ).results
    : [];
  // People, not rows: a voter whose role the owner changed has votes under two roles and is still one person
  // behind the adults board.
  const votersIn = (p: string) => new Set(who.filter((w) => (p === "adults" ? (POOLED_ROLES as readonly string[]).includes(w.role) : w.role === p)).map((w) => w.voter_id)).size;
  const openPools = floor ? pools.filter((p) => votersIn(p) >= floor) : [...pools];
  const poolName = (p: string) => (p === "adults" ? "All adults" : ROLE_NAMES[p] ?? p);
  const waitingFor = pools.filter((p) => !openPools.includes(p)).map((p) => ({ name: poolName(p), need: floor }));
  // No board yet: nothing is shown, so nothing is marked as seen.
  if (!openPools.length) return c.json({ error: "too_few_voters", need: floor }, 403);
  if (asked !== undefined && !openPools.includes(asked as (typeof pools)[number])) return c.json({ error: "pool_too_small", need: floor }, 403);
  const pool: string = asked ?? openPools[0];

  // Seen, round by round: later votes in this round carry after_board = 1 (migration 0005).
  const seenAt = nowIso();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO round_board_seen (voter_id, round_id, seen_at) VALUES (?, ?, ?)").bind(voter.id, round.id, seenAt),
    db.prepare("UPDATE voters SET board_seen_at = ? WHERE id = ? AND board_seen_at IS NULL").bind(seenAt, voter.id),
  ]);

  const { fit, rows: byRating, snapshot } = await (await board(db, round))(pool);
  // Ranked questions in rank order, then the unranked ones by comparisons so far. An unranked question's rating is
  // not sent, so its place in the list must not follow that rating either.
  const rows = [
    ...byRating.filter((r) => r.rank !== null),
    ...byRating.filter((r) => r.rank === null).sort((a, b) => b.games - a.games || tieKey(a.id) - tieKey(b.id)),
  ];
  const index = new Map(rows.map((r, i) => [r.id, i]));


  // Reasons voters gave when each question won, in this pool (owner decision, 25 Nov 2026). Codes only: an Other
  // note is counted as "other" and its words are never sent.
  const roles = pool === "all" ? null : pool === "adults" ? [...POOLED_ROLES] : [pool];
  const why = await db
    .prepare(
      `SELECT v.winner_q AS q, x.reason, count(*) AS n
         FROM vote_reasons_effective x JOIN votes_effective v ON v.id = x.vote_id JOIN voters u ON u.id = v.voter_id
        WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL
          ${roles ? `AND v.role IN (${roles.map(() => "?").join(",")})` : ""}
        GROUP BY v.winner_q, x.reason`,
    )
    .bind(round.id, ...(roles ?? []))
    .all<{ q: string; reason: string; n: number }>();
  const reasonsBy = new Map<string, { code: string; n: number }[]>();
  for (const w of why.results) reasonsBy.set(w.q, [...(reasonsBy.get(w.q) ?? []), { code: w.reason, n: w.n }]);
  // The leaderboard (never the voting page) also shows each question's level, year, unit, number and quoted sources.
  // Owner decision, 25 Nov 2026; logged in DEVIATIONS.md. Question ids still never leave the server.
  const meta = new Map((await questionRows(db, rows.map((r) => r.id))).map((q) => [q.id, q]));

  // Head-to-head counts for the browser's chart, already added up by group (unit, year, question number, quote in
  // the stem): how often a question of group a beat one of group b. Nothing per question is sent, so the counts
  // cannot be traced back to a question that is not ranked yet, or to one voter's picks.
  const h2h: Record<string, Map<string, { a: string; b: string; aw: number; n: number }>> = {};
  const counts = await pairCounts(db, round.id, pool);
  for (const [dim, label] of Object.entries(H2H_GROUPS)) {
    const cells = (h2h[dim] = new Map());
    for (const pc of counts) {
      const l = meta.get(pc.left), r = meta.get(pc.right);
      if (!l || !r) continue;
      let a = label(l), b = label(r), aw = pc.leftWins;
      if (a === b) continue;
      if (a > b) [a, b, aw] = [b, a, pc.n - pc.leftWins];
      const cur = cells.get(a + "\u0000" + b) ?? { a, b, aw: 0, n: 0 };
      cur.aw += aw;
      cur.n += pc.n;
      cells.set(a + "\u0000" + b, cur);
    }
  }
  const out = rows.map((r) => {
    const q = meta.get(r.id)!;
    // A question with fewer than ten comparisons has no rank, and its rating so far is mostly chance: the page gets
    // its comparison count only (owner decision, 25 Nov 2026).
    const ranked = r.rank !== null;
    return {
      rank: r.rank,
      rating: ranked ? Math.round(r.rating) : null,
      lo: !ranked || r.lo === null ? null : Math.round(r.lo),
      hi: !ranked || r.hi === null ? null : Math.round(r.hi),
      games: r.games,
      wins: ranked ? r.wins : null,
      reasons: (reasonsBy.get(r.id) ?? []).sort((a, b) => b.n - a.n || (a.code < b.code ? -1 : 1)),
      stem: q.stem,
      bullets: JSON.parse(q.bullets_json) as string[],
      ...shownNotes(q.notes_json),
      about: { level: q.level, cycle: q.cycle, unit: q.unit, question: q.qnum, sources: SOURCES[r.id] ?? [] },
    };
  });
  return c.json({
    pool,
    pools: openPools.map((p) => ({ id: p, name: poolName(p) })),
    // Boards this voter may see that are still waiting for voters.
    waiting: waitingFor,
    // The viewer's own choice of units and level, offered as a filter on the page (never applied by the server).
    slice: storedSlice(voter.slice_json),
    round: { id: round.id, name: round.name, state: round.state },
    // A staged round: how many of its questions are in play so far (the rows), out of how many in all.
    staged: round.staged ? { inPlay: rows.length, total: (await roundItems(db, round.item_set_id)).filter((id) => !HELD.has(id) || index.has(id)).length } : null,
    rounds: rounds.map((r) => ({ id: r.id, name: r.name })),
    votes: fit.nVotes,
    intervalsAsOf: snapshot?.computed_at ?? null,
    rows: out,
    h2h: Object.fromEntries(Object.entries(h2h).map(([dim, cells]) => [dim, [...cells.values()]])),
    groups: { units: groupBy(out, (r) => `Unit ${r.about.unit}`, (r) => r.about.unit), years: groupBy(out, (r) => r.about.cycle, (r) => r.about.cycle) },
  });
});

