// Voter API. Question ids never leave the server: pairs go out as an opaque pair id with "L" and "R" sides.
import { Hono } from "hono";
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
import { verifyTurnstile } from "./turnstile";
import { isUniqueViolation, nowIso, optInt, randomId, randomSeed, readJsonObject } from "./util";

export const voterApi = new Hono<AppEnv>();

const MAX_CLIENT_MS = 6 * 3600 * 1000;

interface QuestionText {
  stem: string;
  bullets: string[];
}

async function questionTexts(db: D1Database, ids: string[]): Promise<Map<string, QuestionText>> {
  const out = new Map<string, QuestionText>();
  if (!ids.length) return out;
  const uniq = [...new Set(ids)];
  const r = await db
    .prepare(`SELECT id, stem, bullets_json FROM questions WHERE id IN (${uniq.map(() => "?").join(",")})`)
    .bind(...uniq)
    .all<{ id: string; stem: string; bullets_json: string }>();
  for (const q of r.results) out.set(q.id, { stem: q.stem, bullets: JSON.parse(q.bullets_json) });
  return out;
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
  return {
    role: ROLE_NAMES[voter.role] ?? voter.role,
    votes,
    unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES,
    unlocked: votes >= QUALITY.LEADERBOARD_UNLOCK_VOTES,
    round: round ? { name: round.name, state: round.state } : null,
  };
}

voterApi.get("/me", requireVoter(), async (c) => {
  return c.json(await meState(c.env.DB, c.get("voter"), await currentRound(c.env.DB)));
});

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

  let { size, pairs } = await unfinishedPairs(db, round, voter.id);
  if (!pairs.length) {
    const seed = randomSeed();
    const issued = selectBatch(await pairingState(db, round, voter.id), makeRng(seed));
    if (!issued.length) return c.json({ done: true, pairs: [], size: 0 });
    const batchId = randomId();
    const now = nowIso();
    const rows = issued.map((p) => ({ id: randomId(), left_q: p.left, right_q: p.right, p }));
    await db.batch([
      db.prepare("INSERT INTO batches (id, round_id, voter_id, seed, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        batchId,
        round.id,
        voter.id,
        seed,
        now,
      ),
      ...rows.map((r, i) =>
        db
          .prepare(
            `INSERT INTO batch_pairs (id, batch_id, position, left_q, right_q, is_repeat, reason, issued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(r.id, batchId, i, r.left_q, r.right_q, r.p.isRepeat ? 1 : 0, r.p.reason, now),
      ),
    ]);
    size = rows.length;
    pairs = rows;
  }
  const text = await questionTexts(db, pairs.flatMap((p) => [p.left_q, p.right_q]));
  return c.json({
    done: false,
    size,
    pairs: pairs.map((p) => ({ pairId: p.id, left: text.get(p.left_q), right: text.get(p.right_q) })),
  });
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

voterApi.post("/vote", requireVoter(), async (c) => {
  const db = c.env.DB;
  const voter = c.get("voter");
  const body = await readJsonObject(c.req.raw);
  if (!body || (body.pick !== "L" && body.pick !== "R")) return c.json({ error: "bad_request" }, 400);
  const closeCall = body.closeCall === true ? 1 : 0;
  const clientMs = optInt(body.clientMs, 0, MAX_CLIENT_MS);
  const found = await pairFor(db, body.pairId, voter.id);
  if ("error" in found) return c.json({ error: found.error }, PAIR_ERRORS[found.error!]);
  const { pair: p, lo, hi } = found;
  if (found.answered) return c.json({ ok: true, duplicate: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });

  const nowMs = Date.now();
  const winner = body.pick === "L" ? p.left_q : p.right_q;
  const stmts = [
    db
      .prepare(
        `INSERT INTO votes (batch_pair_id, round_id, item_set_id, voter_id, role, left_q, right_q, item_lo, item_hi,
                            winner_q, close_call, is_repeat, after_board, client_ms, server_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        closeCall,
        p.is_repeat,
        voter.board_seen_at ? 1 : 0,
        clientMs,
        await serverMs(db, p, nowMs),
        new Date(nowMs).toISOString(),
      ),
    // Repeats measure consistency only; they never feed the ratings.
    ...(p.is_repeat ? [] : pairCountUpserts(db, p.round_id, voter.role, p.left_q, p.right_q, winner === p.left_q)),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // A double submit lost the race. Nothing was written; report the current state.
    return c.json({ ok: true, duplicate: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });
  }
  return c.json({ ok: true, ...(await afterAnswer(db, voter, p.round_id, p.batch_id)) });
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const text = await questionTexts(db, rows.map((r) => r.id));
  return c.json({
    pool,
    pools: pools.map((p) => ({ id: p, name: p === "adults" ? "All adults" : ROLE_NAMES[p] ?? p })),
    round: { name: round.name, state: round.state },
    votes: fit.nVotes,
    intervalsAsOf: snapshot?.computed_at ?? null,
    rows: rows.map((r) => ({
      rank: r.rank,
      rating: Math.round(r.rating),
      lo: r.lo === null ? null : Math.round(r.lo),
      hi: r.hi === null ? null : Math.round(r.hi),
      games: r.games,
      ...text.get(r.id)!,
    })),
  });
});

