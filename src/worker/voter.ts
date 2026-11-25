// Voter API. Question ids never leave the server: pairs go out as an opaque pair id with "L" and "R" sides.
import { Hono, type Context } from "hono";
import { QUALITY } from "../rating/config";
import { pairKey, selectBatch, type PairingState } from "../rating/pairs";
import { fitBTCounts, makeRng } from "../rating/rating";
import {
  attemptKey,
  codeHash,
  createSession,
  MAX_WRONG_CODES_PER_DAY,
  recordWrongCode,
  requireVoter,
  wrongCodeCount,
} from "./auth";
import {
  board,
  currentRound,
  firstVoteCount,
  openRound,
  pairCounts,
  pairCountUpserts,
  ROLE_NAMES,
  roundItems,
  visiblePools,
} from "./data";
import type { AppEnv, RoundRow, VoterRow } from "./env";
import sourcesFile from "../../items/sources_v1.json";
import { poolsForRole } from "./pools";
import { MAX_REASONS, parseOther, parseReasons, type ReasonCode } from "./reasons";
import { verifyTurnstile } from "./turnstile";
import { isUniqueViolation, nowIso, optInt, randomId, randomSeed, readJsonObject } from "./util";

export const voterApi = new Hono<AppEnv>();

const MAX_CLIENT_MS = 6 * 3600 * 1000;

interface QuestionText {
  stem: string;
  bullets: string[];
}

async function questionRows(db: D1Database, ids: string[]) {
  if (!ids.length) return [];
  const uniq = [...new Set(ids)];
  const r = await db
    .prepare(`SELECT id, stem, bullets_json, level, cycle, unit, qnum FROM questions WHERE id IN (${uniq.map(() => "?").join(",")})`)
    .bind(...uniq)
    .all<{ id: string; stem: string; bullets_json: string; level: string; cycle: string; unit: number; qnum: number }>();
  return r.results;
}

/** Stem and bullets only: what a voter sees while judging. */
async function questionTexts(db: D1Database, ids: string[]): Promise<Map<string, QuestionText>> {
  return new Map((await questionRows(db, ids)).map((q) => [q.id, { stem: q.stem, bullets: JSON.parse(q.bullets_json) }]));
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
  if (typeof code !== "string" || code.length > 40 || typeof token !== "string")
    return c.json({ error: "bad_request" }, 400);
  if (!c.env.CODE_PEPPER || !c.env.TURNSTILE_SECRET) return c.json({ error: "not_configured" }, 503);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const key = await attemptKey(c.env, ip);
  if ((await wrongCodeCount(c.env.DB, key)) >= MAX_WRONG_CODES_PER_DAY)
    return c.json({ error: "too_many_attempts", message: "Too many wrong codes today. Try again tomorrow." }, 429);

  if (!(await verifyTurnstile(c.env, token, ip === "unknown" ? undefined : ip)))
    return c.json({ error: "turnstile_failed", message: "The check did not pass. Reload the page and try again." }, 403);

  const voter = await c.env.DB.prepare("SELECT id, revoked_at FROM voters WHERE code_hash = ?")
    .bind(await codeHash(c.env, code))
    .first<{ id: string; revoked_at: string | null }>();
  if (!voter) {
    await recordWrongCode(c.env.DB, key);
    return c.json({ error: "wrong_code", message: "That code was not recognized." }, 403);
  }
  if (voter.revoked_at) return c.json({ error: "revoked", message: "This code is no longer active." }, 403);
  await createSession(c, voter.id);
  return c.json({ ok: true });
});

// ---------- session required ----------

async function meState(db: D1Database, voter: VoterRow, round: RoundRow | null) {
  const votes = round ? await firstVoteCount(db, round.id, voter.id) : 0;
  // A batch left part-way (closed tab, other device): how much of it is still waiting, so the home page can offer it.
  const open = round?.state === "open" ? await unfinishedPairs(db, round, voter.id) : null;
  return {
    role: ROLE_NAMES[voter.role] ?? voter.role,
    votes,
    unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES,
    unlocked: votes >= QUALITY.LEADERBOARD_UNLOCK_VOTES,
    round: round ? { name: round.name, state: round.state } : null,
    batch: open && open.pairs.length ? { size: open.size, remaining: open.pairs.length } : null,
  };
}

voterApi.get("/me", requireVoter(), async (c) => {
  return c.json(await meState(c.env.DB, c.get("voter"), await currentRound(c.env.DB)));
});

/** True when the voter (?3) has an issued pair in round ?2 with neither a vote nor a skip. */
const UNANSWERED_SQL = `SELECT 1 FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id
  WHERE b.round_id = ?2 AND b.voter_id = ?3
    AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.round_id = ?2 AND v.voter_id = ?3
                    AND v.item_lo = MIN(bp.left_q, bp.right_q) AND v.item_hi = MAX(bp.left_q, bp.right_q) AND v.is_repeat = bp.is_repeat)
    AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.round_id = ?2 AND s.voter_id = ?3
                    AND s.item_lo = MIN(bp.left_q, bp.right_q) AND s.item_hi = MAX(bp.left_q, bp.right_q) AND s.is_repeat = bp.is_repeat)`;

/** Pairs of the voter's latest batch that have neither a vote nor a skip yet. */
async function unfinishedPairs(db: D1Database, round: RoundRow, voterId: string) {
  const batch = await db
    .prepare("SELECT id FROM batches WHERE round_id = ? AND voter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(round.id, voterId)
    .first<{ id: string }>();
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
    .bind(batch.id, round.id, voterId)
    .all<BatchPair>();
  return { batchId: batch.id, size: size?.n ?? 0, pairs: r.results };
}

interface BatchPair {
  id: string;
  left_q: string;
  right_q: string;
}

/** Everything selectBatch needs about the pool and this voter. */
async function pairingState(db: D1Database, round: RoundRow, voterId: string): Promise<PairingState> {
  const items = await roundItems(db, round.item_set_id);
  const fit = fitBTCounts(items, await pairCounts(db, round.id, "all"));
  const votes = await db
    .prepare("SELECT left_q, right_q, is_repeat, created_at, id FROM votes WHERE round_id = ? AND voter_id = ?")
    .bind(round.id, voterId)
    .all<{ left_q: string; right_q: string; is_repeat: number; created_at: string; id: number }>();
  const skips = await db
    .prepare("SELECT item_lo, item_hi, created_at, id FROM skips WHERE round_id = ? AND voter_id = ?")
    .bind(round.id, voterId)
    .all<{ item_lo: string; item_hi: string; created_at: string; id: number }>();
  const repeatsIssued = await db
    .prepare(
      `SELECT bp.left_q, bp.right_q FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id
        WHERE b.round_id = ? AND b.voter_id = ? AND bp.is_repeat = 1`,
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

  const history: PairingState["history"] = [];
  trials.forEach((t, i) => {
    // Only voted first presentations can be repeated: a repeat needs a first answer to compare with.
    if (t.kind === 0 && !t.repeat) history.push({ trial: i + 1, left: t.left!, right: t.right! });
  });
  return {
    items,
    beta: new Map(items.map((id, i) => [id, fit.beta[i]])),
    se: new Map(items.map((id, i) => [id, fit.se[i]])),
    games: new Map(items.map((id, i) => [id, fit.games[i]])),
    done: new Set(trials.map((t) => t.key)),
    history,
    repeated: new Set(repeatsIssued.results.map((r) => pairKey(r.left_q, r.right_q))),
    trials: trials.length,
  };
}

voterApi.get("/batch", requireVoter(), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  const round = await openRound(db);
  if (!round) return c.json({ error: "no_open_round", message: "Voting is closed right now." }, 409);

  let { batchId, pairs } = await unfinishedPairs(db, round, voter.id);
  if (!pairs.length) {
    const seed = randomSeed();
    const issued = selectBatch(await pairingState(db, round, voter.id), makeRng(seed));
    if (!issued.length) return c.json({ done: true, pairs: [], size: 0 });
    const newBatchId = randomId();
    const now = nowIso();
    const rows = issued.map((p) => ({ id: randomId(), left_q: p.left, right_q: p.right, p }));
    // Two requests at once (double tap, two devices) must not both create a batch. The insert happens only if the
    // voter still has no unanswered pair; D1 runs each batch as one transaction, so the second request sees the first.
    const res = await db.batch([
      db
        .prepare(
          `INSERT INTO batches (id, round_id, voter_id, seed, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (${UNANSWERED_SQL})`,
        )
        .bind(newBatchId, round.id, voter.id, seed, now),
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
    else ({ batchId } = await unfinishedPairs(db, round, voter.id)); // another request won; serve its batch
  }
  // The whole batch, answered pairs included, so the voter can go back and change an answer.
  const all = await db
    .prepare(
      `SELECT bp.id, bp.left_q, bp.right_q, e.id AS vote_id, e.winner_q, e.close_call,
              EXISTS (SELECT 1 FROM skips s WHERE s.batch_pair_id = bp.id) AS skipped
         FROM batch_pairs bp LEFT JOIN votes_effective e ON e.batch_pair_id = bp.id
        WHERE bp.batch_id = ? ORDER BY bp.position`,
    )
    .bind(batchId)
    .all<{ id: string; left_q: string; right_q: string; vote_id: number | null; winner_q: string | null; close_call: number | null; skipped: number }>();
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
}

/** Look up a pair for this voter. Returns an error response tag when it may not be answered. */
async function pairFor(db: D1Database, pairId: unknown, voterId: string) {
  if (typeof pairId !== "string" || pairId.length > 64) return { error: "bad_request" as const };
  const p = await db
    .prepare(
      `SELECT bp.id, bp.batch_id, bp.left_q, bp.right_q, bp.is_repeat, bp.issued_at,
              b.voter_id, b.round_id, r.item_set_id, r.state
         FROM batch_pairs bp JOIN batches b ON b.id = bp.batch_id JOIN rounds r ON r.id = b.round_id
        WHERE bp.id = ?`,
    )
    .bind(pairId)
    .first<PairContext>();
  if (!p || p.voter_id !== voterId) return { error: "unknown_pair" as const };
  if (p.state !== "open") return { error: "round_not_open" as const };
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

const PAIR_ERRORS = { bad_request: 400, unknown_pair: 404, round_not_open: 409 } as const;

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

async function afterAnswer(db: D1Database, voter: VoterRow, roundId: string, batchId: string) {
  const votes = await firstVoteCount(db, roundId, voter.id);
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
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
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
        voter.board_seen_at ? 1 : 0,
        a.clientMs,
        await serverMs(db, p, nowMs),
        new Date(nowMs).toISOString(),
      ),
    // Optional reasons, written only if the vote above was.
    ...a.reasons.map((r) =>
      db.prepare("INSERT INTO vote_reasons (vote_id, reason) SELECT id, ?2 FROM votes WHERE batch_pair_id = ?1").bind(p.id, r),
    ),
    ...(a.other.chosen
      ? [db.prepare("INSERT INTO vote_other (vote_id, note) SELECT id, ?2 FROM votes WHERE batch_pair_id = ?1").bind(p.id, a.other.note)]
      : []),
    // Repeats measure consistency only; they never feed the ratings.
    ...(p.is_repeat ? [] : pairCountUpserts(db, p.round_id, voter.role, p.left_q, p.right_q, winner === p.left_q, p.id)),
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

/** The voter's newest batch in the round: the only one whose answers can still be changed. */
async function latestBatchId(db: D1Database, roundId: string, voterId: string): Promise<string | null> {
  const b = await db
    .prepare("SELECT id FROM batches WHERE round_id = ? AND voter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(roundId, voterId)
    .first<{ id: string }>();
  return b?.id ?? null;
}

interface EffectiveVote {
  id: number;
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
  if ((await latestBatchId(db, p.round_id, voter.id)) !== p.batch_id)
    return c.json({ error: "batch_closed", message: "That batch is finished; its answers can no longer change." }, 409);

  const v = await db
    .prepare("SELECT id, role, left_q, right_q, winner_q, close_call, is_repeat FROM votes_effective WHERE batch_pair_id = ?")
    .bind(p.id)
    .first<EffectiveVote>();
  if (!v) return insertVote(c, voter, found, a);

  const winner = a.pick === "L" ? v.left_q : v.right_q;
  const now = (await currentReasons(db, [v.id])).get(v.id) ?? { reasons: [], other: null };
  const same =
    winner === v.winner_q &&
    a.closeCall === v.close_call &&
    [...a.reasons].sort().join() === [...now.reasons].sort().join() &&
    (a.other.chosen ? a.other.note : null) === now.other;
  if (same) return c.json({ ok: true, unchanged: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });

  // Every statement carries the same condition, so in one transaction they all apply or none does.
  const OPEN = `EXISTS (SELECT 1 FROM rounds WHERE id = ?2 AND state = 'open') AND EXISTS (SELECT 1 FROM voters WHERE id = ?3 AND revoked_at IS NULL)`;
  const token = randomId();
  const stmts: D1PreparedStatement[] = [];
  // The cache moves first, by (new winner is left) - (current winner is left), read inside the transaction.
  if (!v.is_repeat && winner !== v.winner_q)
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

interface GroupRow {
  rank: number | null;
  rating: number;
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
    if (r.rank !== null) g.ratings.push(r.rating);
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
  const round = await currentRound(db);
  if (!round) return c.json({ error: "no_round" }, 404);
  const votes = await firstVoteCount(db, round.id, voter.id);
  if (votes < QUALITY.LEADERBOARD_UNLOCK_VOTES)
    return c.json({ error: "locked", votes, unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES }, 403);
  const pools = visiblePools(voter.role);
  const pool = c.req.query("pool") ?? "adults";
  if (!(pools as string[]).includes(pool)) return c.json({ error: "pool_not_allowed" }, 403);

  if (!voter.board_seen_at)
    await db.prepare("UPDATE voters SET board_seen_at = ? WHERE id = ? AND board_seen_at IS NULL").bind(nowIso(), voter.id).run();

  const { fit, rows, snapshot } = await (await board(db, round))(pool);
  // The leaderboard (never the voting page) also shows each question's level, year, unit, number and quoted sources.
  // Owner decision, 25 Nov 2026; logged in DEVIATIONS.md. Question ids still never leave the server.
  const meta = new Map((await questionRows(db, rows.map((r) => r.id))).map((q) => [q.id, q]));
  const out = rows.map((r) => {
    const q = meta.get(r.id)!;
    return {
      rank: r.rank,
      rating: Math.round(r.rating),
      lo: r.lo === null ? null : Math.round(r.lo),
      hi: r.hi === null ? null : Math.round(r.hi),
      games: r.games,
      stem: q.stem,
      bullets: JSON.parse(q.bullets_json) as string[],
      about: { level: q.level, cycle: q.cycle, unit: q.unit, question: q.qnum, sources: SOURCES[r.id] ?? [] },
    };
  });
  return c.json({
    pool,
    pools: pools.map((p) => ({ id: p, name: p === "adults" ? "All adults" : ROLE_NAMES[p] ?? p })),
    round: { name: round.name, state: round.state },
    votes: fit.nVotes,
    intervalsAsOf: snapshot?.computed_at ?? null,
    rows: out,
    groups: { units: groupBy(out, (r) => `Unit ${r.about.unit}`, (r) => r.about.unit), years: groupBy(out, (r) => r.about.cycle, (r) => r.about.cycle) },
  });
});

