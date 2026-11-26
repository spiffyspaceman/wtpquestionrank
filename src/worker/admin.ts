// Admin API, mounted at /admin/api. Every route but /login requires the Access token (or the fallback cookie).
import { Hono, type Context } from "hono";
import { QUALITY, RATING, ROLES } from "../rating/config";
import { requireAdmin, adminSecretLogin } from "./access";
import { BUILTIN_SETS } from "./builtin-sets";
import { codeHash, inviteCode } from "./auth";
import { board, firstGroupStatements, growRound, openRounds, playItems, POOLS, rebuildPairCounts, ROLE_NAMES, roundItems, stageState } from "./data";
import type { AppEnv, RoundRow } from "./env";
import { correctionsCsv, exportMeta, reasonsCsv, roundExport, ratingsCsv, skipsCsv, votePage, votersCsv, votesCsv } from "./exports";
import { studyHealth } from "./health";
import { storedNotes } from "./notes";
import { joinWord, joinWordHash } from "./signup";
import { HELD, STAGE } from "./staging";
import { chunks, isUniqueViolation, nowIso, optInt, randomId, readJsonObject, sha256Hex } from "./util";

export const adminApi = new Hono<AppEnv>();

export const EXPORT_REMINDER_DAYS = 7;

async function audit(c: Context<AppEnv>, action: string, detail: unknown): Promise<void> {
  await c.env.DB.prepare("INSERT INTO admin_audit (at, actor, action, detail_json) VALUES (?, ?, ?, ?)")
    .bind(nowIso(), c.get("actor"), action, JSON.stringify(detail ?? {}))
    .run();
}

async function getRound(c: Context<AppEnv>): Promise<RoundRow | null> {
  return c.env.DB.prepare("SELECT * FROM rounds WHERE id = ?").bind(c.req.param("id")).first<RoundRow>();
}

// ---------- login (fallback only; refused whenever Access is configured) ----------

adminApi.post("/login", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!(await adminSecretLogin(c, body?.secret))) return c.json({ error: "not_admin" }, 403);
  return c.json({ ok: true });
});

adminApi.use("*", requireAdmin);

// ---------- status ----------

adminApi.get("/status", async (c) => {
  const db = c.env.DB;
  const rounds = await db
    .prepare(
      `SELECT r.*, (SELECT count(*) FROM votes v WHERE v.round_id = r.id) AS n_votes,
              (SELECT count(DISTINCT voter_id) FROM votes v WHERE v.round_id = r.id) AS n_voters,
              (SELECT count(*) FROM round_in_play p WHERE p.round_id = r.id) AS n_in_play,
              (SELECT count(*) FROM item_set_items i WHERE i.item_set_id = r.item_set_id) AS n_items
         FROM rounds r ORDER BY r.created_at DESC`,
    )
    .all();
  const itemSets = await db
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM item_set_items i WHERE i.item_set_id = s.id) AS n_items
         FROM item_sets s ORDER BY s.created_at DESC`,
    )
    .all();
  const lastExport = await db
    .prepare("SELECT MAX(at) AS at FROM admin_audit WHERE action IN ('export_json', 'export_votes_csv', 'export_backup')")
    .first<{ at: string | null }>();
  const anyVotes = await db.prepare("SELECT count(*) AS n FROM votes").first<{ n: number }>();
  const ageDays = lastExport?.at ? (Date.now() - Date.parse(lastExport.at)) / 86_400_000 : Infinity;
  // A staged round can reach every question of its set except those held back; count them as the round's total.
  for (const r of rounds.results as unknown as (RoundRow & { n_items: number })[])
    if (r.staged) r.n_items = (await stageState(db, r)).total;
  return c.json({
    actor: c.get("actor"),
    rounds: rounds.results,
    itemSets: itemSets.results,
    lastExportAt: lastExport?.at ?? null,
    exportOverdue: (anyVotes?.n ?? 0) > 0 && ageDays > EXPORT_REMINDER_DAYS,
    roles: ROLES.map((r) => ({ id: r, name: ROLE_NAMES[r] })),
    pools: POOLS,
    stage: STAGE,
  });
});

// ---------- items ----------

interface ItemIn {
  id: string;
  val_id?: string | null;
  level: string;
  cycle: string;
  unit: number;
  q: number;
  published: unknown;
  stem: string;
  bullets: string[];
  source: string;
  source_url?: string | null;
  /** Published footnotes: where each marker stands, and the notes (migration 0007). Optional. */
  marks?: unknown;
  notes?: unknown;
}

/** text_sha256 = SHA-256 of JSON.stringify([stem, bullets]) as loaded. */
export const questionTextHash = (stem: string, bullets: string[]) => sha256Hex(JSON.stringify([stem, bullets]));

/** Load an item file: the checks, the writes and the audit row. Returns the JSON answer and its status. */
/** Statements per database batch when loading items. Small on purpose: production D1 refused one batch of 1,300. */
const WRITE_CHUNK = 40;
/** Stands in for a set's file hash while its load is under way. */
const LOADING = "loading";

async function loadItemFile(c: Context<AppEnv>, bytes: ArrayBuffer | Uint8Array): Promise<[Record<string, unknown>, 200 | 400 | 409 | 500]> {
  const db = c.env.DB;
  const fileSha = await sha256Hex(bytes);
  let file: { item_set?: unknown; version?: unknown; items?: unknown };
  try {
    file = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [{ error: "bad_json" }, 400];
  }
  if (typeof file.item_set !== "string" || !/^[a-z0-9-]{1,40}$/.test(file.item_set))
    return [{ error: "bad_item_set", message: "item_set must be a short lower-case id." }, 400];
  if (typeof file.version !== "number" || !Number.isInteger(file.version) || file.version < 1)
    return [{ error: "bad_version" }, 400];
  if (!Array.isArray(file.items) || file.items.length < 2) return [{ error: "no_items" }, 400];
  const items = file.items as ItemIn[];

  const unpublished = items.filter((i) => i?.published !== true).map((i) => i?.id ?? "?");
  if (unpublished.length)
    return [{ error: "unpublished", message: "Every item must have published: true.", ids: unpublished }, 400];
  const bad = items.filter(
    (i) =>
      typeof i.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(i.id) ||
      !["State", "NF", "NI", "Regional"].includes(i.level) ||
      typeof i.cycle !== "string" ||
      !Number.isInteger(i.unit) ||
      i.unit < 1 ||
      i.unit > 6 ||
      !Number.isInteger(i.q) ||
      i.q < 1 ||
      i.q > 9 ||
      typeof i.stem !== "string" ||
      !i.stem.trim() ||
      !Array.isArray(i.bullets) ||
      !i.bullets.every((b) => typeof b === "string") ||
      typeof i.source !== "string",
  );
  if (bad.length) return [{ error: "bad_items", ids: bad.map((i) => i?.id ?? "?") }, 400];
  if (new Set(items.map((i) => i.id)).size !== items.length) return [{ error: "duplicate_ids" }, 400];

  const setId = `${file.item_set}-v${file.version}`;
  const openEnded = (file as { open_ended?: unknown }).open_ended === true;
  const existing = await db
    .prepare("SELECT file_sha256, open_ended FROM item_sets WHERE id = ?")
    .bind(setId)
    .first<{ file_sha256: string; open_ended: number }>();
  let have: Set<string> | null = null;
  // A set whose load stopped part-way (see LOADING below) is carried on, whether or not it is open-ended.
  const resumed = existing?.file_sha256 === LOADING;
  if (existing) {
    if (existing.file_sha256 === fileSha) return [{ ok: true, itemSet: setId, fileSha256: fileSha, already: true }, 200];
    if (!existing.open_ended && !resumed) return [{ error: "item_set_exists", message: `${setId} is already loaded from a different file.` }, 409];
    // An open-ended set takes a newer file that holds everything it already has, plus more (migration 0006).
    have = new Set(await roundItems(db, setId));
    const ids = new Set(items.map((i) => i.id));
    const gone = [...have].filter((id) => !ids.has(id));
    if (gone.length)
      return [{ error: "items_removed", message: "The file leaves out questions the set already holds. A set only grows.", ids: gone }, 409];
  }

  const hashes = await Promise.all(items.map((i) => questionTextHash(i.stem, i.bullets)));
  // Footnotes, checked for shape. A file that says nothing about notes leaves a stored question's notes alone.
  const noteJson = items.map((i) => (i.marks === undefined && i.notes === undefined ? undefined : storedNotes(i.marks, i.notes, [i.stem.length, ...i.bullets.map((b) => b.length)])));
  const badNotes = items.filter((_, k) => noteJson[k] === null).map((i) => i.id);
  if (badNotes.length) return [{ error: "bad_notes", message: "A footnote or its marker is malformed.", ids: badNotes }, 400];
  // Notes are display material and may be filled in or corrected for a question already loaded (its text may not).
  const noteUpdates = items.flatMap((i, k) =>
    noteJson[k] === undefined
      ? []
      : [db.prepare("UPDATE questions SET notes_json = ?1 WHERE id = ?2 AND COALESCE(notes_json, '') <> ?1").bind(noteJson[k] as string, i.id)],
  );
  // In chunks: D1 allows 100 bound parameters per query, and an item file can hold more questions than that.
  const loadedHash = new Map<string, string>();
  for (const part of chunks(items.map((i) => i.id))) {
    const loaded = await db
      .prepare(`SELECT id, text_sha256 FROM questions WHERE id IN (${part.map(() => "?").join(",")})`)
      .bind(...part)
      .all<{ id: string; text_sha256: string }>();
    for (const q of loaded.results) loadedHash.set(q.id, q.text_sha256);
  }
  const conflicts = items.filter((i, k) => loadedHash.has(i.id) && loadedHash.get(i.id) !== hashes[k]).map((i) => i.id);
  if (conflicts.length)
    return [{ error: "text_conflict", message: "A loaded question has different text. Give the corrected text a new id.", ids: conflicts }, 409];

  // The writes go out in small batches, each safe to repeat, so a large file never rides on one oversized
  // transaction and a load that stops part-way can simply be run again. Until the last step the set carries the
  // marker LOADING in place of its file hash; a set found in that state is resumed, not refused.
  const now = nowIso();
  const fresh = !existing || resumed;
  const members = have ?? new Set<string>();
  const added = items.filter((i) => !members.has(i.id));
  const inChunks = async (stmts: D1PreparedStatement[]) => {
    for (const part of chunks(stmts, WRITE_CHUNK)) await db.batch(part);
  };
  try {
    if (!existing)
      await db
        .prepare("INSERT INTO item_sets (id, name, version, display_mode, file_sha256, created_at, open_ended) VALUES (?, ?, ?, 'full_text', ?, ?, ?)")
        .bind(setId, file.item_set, file.version, LOADING, now, openEnded ? 1 : 0)
        .run();
    await inChunks(
      items.map((i, k) =>
        db
          .prepare(
            `INSERT INTO questions (id, level, cycle, unit, qnum, published, stem, bullets_json, source, source_url,
                                    text_sha256, val_id, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          )
          .bind(i.id, i.level, i.cycle, i.unit, i.q, i.stem, JSON.stringify(i.bullets), i.source, i.source_url ?? null, hashes[k], i.val_id ?? null, now),
      ),
    );
    // Questions that join a set already in use are dated; those of a first load are not.
    await inChunks(
      added.map((i) =>
        db.prepare("INSERT OR IGNORE INTO item_set_items (item_set_id, question_id, added_at) VALUES (?, ?, ?)").bind(setId, i.id, fresh ? null : now),
      ),
    );
    // Questions added to a set whose staged round is already running come into play at once (owner decision,
    // 25 Nov 2026: later questions join the running round and are paired first until they catch up).
    if (!fresh)
      await inChunks(
        added.filter((i) => !HELD.has(i.id)).map((i) =>
          db
            .prepare(
              `INSERT OR IGNORE INTO round_in_play (round_id, question_id, joined_at)
               SELECT r.id, ?1, ?2 FROM rounds r WHERE r.item_set_id = ?3 AND r.staged = 1 AND r.state = 'open'`,
            )
            .bind(i.id, now, setId),
        ),
      );
    await inChunks(noteUpdates);
    await db.prepare("UPDATE item_sets SET file_sha256 = ? WHERE id = ?").bind(fileSha, setId).run();
  } catch (e) {
    console.error(e);
    // Admin only: say what the database said, and that pressing the button again carries on from here.
    return [{ error: "db_error", message: `The load stopped part-way: ${String((e as Error)?.message ?? e).slice(0, 300)}. Nothing is lost; run it again to carry on.` }, 500];
  }
  if (fresh) {
    await audit(c, "load_items", { itemSet: setId, fileSha256: fileSha, n: items.length, ...(resumed ? { resumed: true } : {}) });
    return [{ ok: true, itemSet: setId, fileSha256: fileSha, n: items.length }, 200];
  }
  await audit(c, "add_items", { itemSet: setId, fileSha256: fileSha, was: existing!.file_sha256, added: added.map((x) => x.id) });
  return [{ ok: true, itemSet: setId, fileSha256: fileSha, n: items.length, added: added.length }, 200];
}

adminApi.post("/items", async (c) => {
  const [body, status] = await loadItemFile(c, await c.req.arrayBuffer());
  return c.json(body, status);
});

// ---------- the unit sets that ship with the site (owner decision, 25 Nov 2026) ----------

/** The sets, with whether each is loaded and has a round yet. */
adminApi.get("/builtin-sets", async (c) => {
  const sets = await c.env.DB.prepare(
    "SELECT s.id, s.file_sha256, (SELECT count(*) FROM item_set_items i WHERE i.item_set_id = s.id) AS n FROM item_sets s",
  ).all<{ id: string; file_sha256: string; n: number }>();
  const storedSha = new Map(sets.results.map((x) => [x.id, x.file_sha256]));
  const bundledSha = await Promise.all(BUILTIN_SETS.map((b) => sha256Hex(new TextEncoder().encode(JSON.stringify(b.file)))));
  const rounds = await c.env.DB.prepare("SELECT item_set_id, state FROM rounds").all<{ item_set_id: string; state: string }>();
  const loaded = new Set(sets.results.map((x) => x.id));
  const held = new Map(sets.results.map((x) => [x.id, x.n]));
  return c.json({
    sets: BUILTIN_SETS.map((b, k) => ({
      // False when the site holds an older build of the file: the same questions, but corrected footnotes (which may
      // be updated after loading) have not been loaded yet.
      current: storedSha.get(b.id) === bundledSha[k],
      id: b.id,
      roundName: b.roundName,
      questions: b.questions,
      cycles: b.cycles,
      loaded: loaded.has(b.id),
      // Questions in the bundled file that the loaded set does not hold yet (an open-ended set can take them).
      toAdd: loaded.has(b.id) ? b.questions - (held.get(b.id) ?? 0) : 0,
      rounds: rounds.results.filter((r) => r.item_set_id === b.id).map((r) => r.state),
    })),
  });
});

/**
 * Load one set and make its round as a draft, if neither exists yet. One set per request, so the work of a request
 * does not grow with the number of sets. Opening a round stays a separate, confirmed step.
 */
adminApi.post("/builtin-sets/:id", async (c) => {
  const set = BUILTIN_SETS.find((b) => b.id === c.req.param("id"));
  if (!set) return c.json({ error: "not_found" }, 404);
  const [body, status] = await loadItemFile(c, new TextEncoder().encode(JSON.stringify(set.file)));
  if (status !== 200) return c.json(body, status);
  let roundId: string | null = null;
  if (!(await c.env.DB.prepare("SELECT 1 FROM rounds WHERE item_set_id = ?").bind(set.id).first())) {
    roundId = randomId(9);
    // The full set opens in stages and grows by itself (owner decision, 25 Nov 2026; migration 0008).
    await c.env.DB.prepare("INSERT INTO rounds (id, name, item_set_id, state, created_at, staged, auto_grow) VALUES (?, ?, ?, 'draft', ?, 1, 1)")
      .bind(roundId, set.roundName, set.id, nowIso())
      .run();
    await audit(c, "create_round", { id: roundId, name: set.roundName, itemSetId: set.id, staged: true, autoGrow: true });
  }
  return c.json({ ...body, roundCreated: roundId });
});

adminApi.get("/item-sets/:id/items", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT q.id, q.val_id, q.level, q.cycle, q.unit, q.qnum, q.stem, q.bullets_json, q.source, q.text_sha256
       FROM item_set_items i JOIN questions q ON q.id = i.question_id WHERE i.item_set_id = ? ORDER BY q.id`,
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ items: r.results });
});

// ---------- rounds ----------

adminApi.post("/rounds", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const itemSetId = body?.itemSetId;
  if (!name || name.length > 80 || typeof itemSetId !== "string") return c.json({ error: "bad_request" }, 400);
  const set = await c.env.DB.prepare("SELECT id FROM item_sets WHERE id = ?").bind(itemSetId).first();
  if (!set) return c.json({ error: "unknown_item_set" }, 404);
  const id = randomId(9);
  await c.env.DB.prepare("INSERT INTO rounds (id, name, item_set_id, state, created_at) VALUES (?, ?, ?, 'draft', ?)")
    .bind(id, name, itemSetId, nowIso())
    .run();
  await audit(c, "create_round", { id, name, itemSetId });
  return c.json({ ok: true, id });
});

const TRANSITIONS: Record<string, { from: string[]; to: string; col: string }> = {
  open: { from: ["draft"], to: "open", col: "opened_at" },
  freeze: { from: ["open"], to: "frozen", col: "frozen_at" },
  close: { from: ["open", "frozen"], to: "closed", col: "closed_at" },
};

adminApi.post("/rounds/:id/:action{open|freeze|close}", async (c) => {
  const db = c.env.DB;
  const t = TRANSITIONS[c.req.param("action")];
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  if (!t.from.includes(round.state)) return c.json({ error: "bad_state", message: `The round is ${round.state}.` }, 409);
  // A set whose load stopped part-way must be finished first: opening would freeze it half-loaded.
  if (t.to === "open") {
    const set = await db.prepare("SELECT file_sha256 FROM item_sets WHERE id = ?").bind(round.item_set_id).first<{ file_sha256: string }>();
    if (set?.file_sha256 === LOADING)
      return c.json({ error: "set_loading", message: "This round's question set did not finish loading. Load it again, then open the round." }, 409);
  }
  const now = nowIso();
  const stmts = [db.prepare(`UPDATE rounds SET state = ?, ${t.col} = ? WHERE id = ? AND state = ?`).bind(t.to, now, round.id, round.state)];
  // The item set freezes when its first round opens, and a staged round's first group of questions comes into play.
  if (t.to === "open") {
    stmts.push(db.prepare("UPDATE item_sets SET frozen_at = ? WHERE id = ? AND frozen_at IS NULL").bind(now, round.item_set_id));
    stmts.push(...(await firstGroupStatements(db, round, now)));
  }
  // Several rounds may be open at once (migration 0005); each new batch goes to the one with the fewest batches.
  await db.batch(stmts);
  await audit(c, `${c.req.param("action")}_round`, { id: round.id });
  return c.json({ ok: true, state: t.to });
});

/**
 * Staging (migration 0008). `staged` can change only while the round is a draft; `autoGrow` at any time. In a staged
 * round the questions come into play in groups, so that a few voters still fill a leaderboard.
 */
adminApi.post("/rounds/:id/staging", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const body = await readJsonObject(c.req.raw);
  const staged = typeof body?.staged === "boolean" ? (body.staged ? 1 : 0) : round.staged;
  const autoGrow = typeof body?.autoGrow === "boolean" ? (body.autoGrow ? 1 : 0) : round.auto_grow;
  if (staged !== round.staged && round.state !== "draft")
    return c.json({ error: "bad_state", message: "Staging is fixed once a round has opened." }, 409);
  await c.env.DB.prepare("UPDATE rounds SET staged = ?, auto_grow = ? WHERE id = ?").bind(staged, staged ? autoGrow : 0, round.id).run();
  await audit(c, "set_staging", { id: round.id, staged: staged === 1, autoGrow: staged === 1 && autoGrow === 1 });
  return c.json({ ok: true, staged: staged === 1, autoGrow: staged === 1 && autoGrow === 1 });
});

/** Add the next group of questions to an open staged round now, whether or not the ones in play have settled. */
adminApi.post("/rounds/:id/grow", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  if (!round.staged || round.state !== "open") return c.json({ error: "bad_state", message: "Only an open staged round can take more questions." }, 409);
  const added = await growRound(c.env.DB, round);
  await audit(c, "grow_round", { id: round.id, added });
  const st = await stageState(c.env.DB, round);
  return c.json({ ok: true, added: added.length, inPlay: st.inPlay.size, total: st.total });
});

/** How a staged round stands, for the admin page. */
adminApi.get("/rounds/:id/staging", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const st = await stageState(c.env.DB, round);
  return c.json({ staged: round.staged === 1, autoGrow: round.auto_grow === 1, inPlay: st.inPlay.size, total: st.total, fewestAdultGames: st.fewest, settledAt: STAGE.SETTLED_ADULT_GAMES, step: STAGE.STEP });
});

/** Rename a round. The name is a label for the owner; voters see it only in the leaderboard's round picker. */
adminApi.post("/rounds/:id/rename", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const body = await readJsonObject(c.req.raw);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return c.json({ error: "bad_request" }, 400);
  await c.env.DB.prepare("UPDATE rounds SET name = ? WHERE id = ?").bind(name, round.id).run();
  await audit(c, "rename_round", { id: round.id, was: round.name, name });
  return c.json({ ok: true, name });
});

adminApi.post("/rounds/:id/rebuild", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const rowsWritten = await rebuildPairCounts(c.env.DB, round.id);
  await audit(c, "rebuild_caches", { id: round.id, rowsWritten });
  return c.json({ ok: true, rowsWritten });
});

adminApi.get("/rounds/:id/board", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const pool = c.req.query("pool") ?? "adults";
  if (!(POOLS as readonly string[]).includes(pool)) return c.json({ error: "bad_pool" }, 400);
  const { fit, rows, snapshot } = await (await board(c.env.DB, round))(pool);
  return c.json({ pool, votes: fit.nVotes, left: fit.left, intervalsAsOf: snapshot?.computed_at ?? null, rows });
});

/** First-presentation votes of voters not revoked, for the in-browser bootstrap. */
adminApi.get("/rounds/:id/bootstrap-input", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const votes = await c.env.DB.prepare(
    `SELECT v.id, v.left_q AS l, v.right_q AS r, v.winner_q AS w, v.voter_id AS rater, v.role
       FROM votes_effective v JOIN voters u ON u.id = v.voter_id
      WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL ORDER BY v.id`,
  )
    .bind(round.id)
    .all();
  return c.json({ items: await playItems(c.env.DB, round), votes: votes.results, rating: RATING });
});

adminApi.post("/rounds/:id/snapshots", async (c) => {
  const db = c.env.DB;
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const body = await readJsonObject(c.req.raw);
  const snaps = body?.snapshots;
  if (!Array.isArray(snaps) || !snaps.length || snaps.length > POOLS.length) return c.json({ error: "bad_request" }, 400);
  const items = new Set(await roundItems(db, round.item_set_id));
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const s of snaps as Record<string, unknown>[]) {
    const p = s.payload as Record<string, unknown[]> | undefined;
    const ok =
      typeof s.pool === "string" &&
      (POOLS as readonly string[]).includes(s.pool) &&
      p &&
      Array.isArray(p.ids) &&
      p.ids.every((id) => typeof id === "string" && items.has(id)) &&
      ["rating", "ratingLo", "ratingHi"].every((k) => Array.isArray(p[k]) && p[k].length === p.ids.length);
    if (!ok) return c.json({ error: "bad_snapshot", pool: s.pool ?? null }, 400);
    stmts.push(
      db
        .prepare(
          `INSERT INTO rating_snapshots (round_id, pool, computed_at, n_votes, n_raters, last_vote_id, config_json, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          round.id,
          s.pool,
          now,
          optInt(s.n_votes, 0, 1e9) ?? 0,
          optInt(s.n_raters, 0, 1e9) ?? 0,
          optInt(s.last_vote_id, 0, 1e12) ?? 0,
          JSON.stringify(s.config ?? {}),
          JSON.stringify(p),
        ),
    );
  }
  await db.batch(stmts);
  await audit(c, "refresh_intervals", { id: round.id, pools: (snaps as { pool: string }[]).map((s) => s.pool) });
  return c.json({ ok: true, computedAt: now });
});

// ---------- codes ----------

adminApi.get("/codes", async (c) => {
  // With each code, how far its holder has got: whether the code has been used, first-presentation votes over every
  // round (the leaderboard opens at 20 of them), and the last vote. Nothing new is stored: signed_in_at is the oldest
  // session still on file (sessions lapse after 90 days and end on sign-out, so it can be later than the first use).
  const r = await c.env.DB.prepare(
    `SELECT u.label, u.role, u.is_owner, u.created_at, u.revoked_at, u.board_seen_at, u.email, u.name, u.slice_json, COALESCE(c.n, 0) AS n_votes,
            COALESCE(c.first_votes, 0) AS round_votes, c.last_vote_at,
            (SELECT MIN(s.created_at) FROM sessions s WHERE s.voter_id = u.id) AS signed_in_at
       FROM voters u
       LEFT JOIN (SELECT voter_id, count(*) AS n, MAX(created_at) AS last_vote_at, SUM(is_repeat = 0) AS first_votes
                    FROM votes GROUP BY voter_id) c ON c.voter_id = u.id
      ORDER BY u.created_at DESC, CAST(substr(u.label, instr(u.label, ' ') + 1) AS INTEGER), u.label`,
  ).all();
  return c.json({ voters: r.results, openRounds: (await openRounds(c.env.DB)).length, unlockAt: QUALITY.LEADERBOARD_UNLOCK_VOTES });
});

adminApi.post("/codes", async (c) => {
  const db = c.env.DB;
  const body = await readJsonObject(c.req.raw);
  const role = body?.role;
  const count = optInt(body?.count, 1, 200);
  const owner = body?.owner === true;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role) || !count) return c.json({ error: "bad_request" }, 400);
  if (!c.env.CODE_PEPPER) return c.json({ error: "not_configured", message: "CODE_PEPPER is not set." }, 503);
  const name = ROLE_NAMES[role];
  const now = nowIso();
  let out: { label: string; role: string; code: string }[] = [];
  // Two requests at the same moment can choose the same labels; the loser reads the labels again and retries.
  for (let attempt = 0; ; attempt++) {
    const labels = await db.prepare("SELECT label FROM voters WHERE label LIKE ?").bind(`${name} %`).all<{ label: string }>();
    let next = 1 + Math.max(0, ...labels.results.map((l) => Number(l.label.slice(name.length + 1)) || 0));
    out = [];
    const stmts: D1PreparedStatement[] = [];
    for (let k = 0; k < count; k++) {
      const id = randomId();
      const code = await inviteCode(c.env, id);
      const label = `${name} ${String(next++).padStart(2, "0")}`;
      out.push({ label, role, code });
      stmts.push(
        db
          .prepare("INSERT INTO voters (id, code_hash, role, label, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(id, await codeHash(c.env, code), role, label, owner ? 1 : 0, now),
      );
    }
    try {
      // In batches of at most 50, each one transaction: production D1 refuses very large batches.
      for (const part of chunks(stmts, 50)) await db.batch(part);
      break;
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 3 || count > 50) throw e;
    }
  }
  await audit(c, "create_codes", { role, count, owner, labels: out.map((o) => o.label) });
  return c.json({ ok: true, codes: out });
});

/**
 * Show a voter's code again. The code is recomputed from CODE_PEPPER and the voter id, and checked against the stored
 * hash; codes made before this feature were random and cannot be recovered. Each reveal is audited (label only).
 */
adminApi.get("/codes/reveal", async (c) => {
  const label = c.req.query("label");
  if (!label || label.length > 40) return c.json({ error: "bad_request" }, 400);
  if (!c.env.CODE_PEPPER) return c.json({ error: "not_configured" }, 503);
  const v = await c.env.DB.prepare("SELECT id, code_hash, revoked_at FROM voters WHERE label = ?")
    .bind(label)
    .first<{ id: string; code_hash: string; revoked_at: string | null }>();
  if (!v) return c.json({ error: "unknown_label" }, 404);
  if (v.revoked_at) return c.json({ error: "revoked", message: `${label} is revoked.` }, 409);
  const code = await inviteCode(c.env, v.id);
  if ((await codeHash(c.env, code)) !== v.code_hash)
    return c.json({ error: "not_recoverable", message: `${label} was made before codes could be shown again. Revoke it and make a new one.` }, 409);
  await audit(c, "reveal_code", { label });
  return c.json({ label, code });
});

/**
 * Change a voter's role (for someone who chose the wrong one at sign-up). Votes already cast keep the role they were
 * cast under; later votes take the new one. Audited by label.
 */
adminApi.post("/voters/role", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const label = body?.label;
  const role = body?.role;
  if (typeof label !== "string" || label.length > 40 || typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return c.json({ error: "bad_request" }, 400);
  const v = await c.env.DB.prepare("SELECT id, role, email FROM voters WHERE label = ?").bind(label).first<{ id: string; role: string; email: string | null }>();
  if (!v) return c.json({ error: "unknown_label" }, 404);
  if (v.role === role) return c.json({ ok: true, unchanged: true });
  // No address or name is kept for a student, so a voter who signed up by email cannot be made one. A student
  // gets a code instead.
  if (role === "student" && v.email !== null)
    return c.json({ error: "student_with_email", message: `${label} signed up by email, and no email is kept for a student. Revoke ${label} and give the student a code.` }, 409);
  await c.env.DB.prepare("UPDATE voters SET role = ? WHERE id = ?").bind(role, v.id).run();
  await audit(c, "change_role", { label, was: v.role, role });
  return c.json({ ok: true, role });
});

// ---------- sign-up links (email sign-up; migration 0009) ----------

/** The links, newest first, with how many voters signed up through each. Words are shown only on request. */
adminApi.get("/join-links", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT l.id, l.created_at, l.closed_at, (SELECT count(*) FROM voters u WHERE u.join_link_id = l.id) AS n_signed_up
       FROM join_links l ORDER BY l.created_at DESC, l.id`,
  ).all();
  return c.json({ links: r.results });
});

const joinUrl = (c: Context<AppEnv>, word: string) => `https://${c.env.PROD_HOST}/join#${word}`;

/** Make a sign-up link. Anyone who opens it can sign up with an email address until it is closed. */
adminApi.post("/join-links", async (c) => {
  if (!c.env.CODE_PEPPER) return c.json({ error: "not_configured", message: "CODE_PEPPER is not set." }, 503);
  const id = randomId(9);
  const word = await joinWord(c.env, id);
  await c.env.DB.prepare("INSERT INTO join_links (id, word_hash, created_at) VALUES (?, ?, ?)").bind(id, await joinWordHash(c.env, word), nowIso()).run();
  await audit(c, "create_join_link", { id });
  return c.json({ ok: true, id, word, link: joinUrl(c, word) });
});

/** Show a sign-up link again (recomputed from CODE_PEPPER and the link's id, and checked against the stored hash). */
adminApi.get("/join-links/:id/reveal", async (c) => {
  if (!c.env.CODE_PEPPER) return c.json({ error: "not_configured" }, 503);
  const l = await c.env.DB.prepare("SELECT id, word_hash FROM join_links WHERE id = ?").bind(c.req.param("id")).first<{ id: string; word_hash: string }>();
  if (!l) return c.json({ error: "not_found" }, 404);
  const word = await joinWord(c.env, l.id);
  if ((await joinWordHash(c.env, word)) !== l.word_hash) return c.json({ error: "not_recoverable" }, 409);
  await audit(c, "reveal_join_link", { id: l.id });
  return c.json({ id: l.id, word, link: joinUrl(c, word) });
});

/** Close a sign-up link: it takes no new sign-ups. Addresses already signed up keep working. */
adminApi.post("/join-links/:id/close", async (c) => {
  const l = await c.env.DB.prepare("SELECT id, closed_at FROM join_links WHERE id = ?").bind(c.req.param("id")).first<{ id: string; closed_at: string | null }>();
  if (!l) return c.json({ error: "not_found" }, 404);
  if (l.closed_at) return c.json({ ok: true, already: true });
  await c.env.DB.prepare("UPDATE join_links SET closed_at = ? WHERE id = ? AND closed_at IS NULL").bind(nowIso(), l.id).run();
  await audit(c, "close_join_link", { id: l.id });
  return c.json({ ok: true });
});

adminApi.post("/codes/revoke", async (c) => {
  const db = c.env.DB;
  const body = await readJsonObject(c.req.raw);
  const label = body?.label;
  if (typeof label !== "string" || label.length > 40) return c.json({ error: "bad_request" }, 400);
  const v = await db.prepare("SELECT id, revoked_at FROM voters WHERE label = ?").bind(label).first<{ id: string; revoked_at: string | null }>();
  if (!v) return c.json({ error: "unknown_label" }, 404);
  // Safe to repeat: revoking a code that is already revoked runs the cache rebuild again. If an earlier revoke
  // stopped after the first step (a database error), pressing Revoke again finishes it.
  const already = Boolean(v.revoked_at);
  await db.batch([
    db.prepare("UPDATE voters SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), v.id),
    db.prepare("DELETE FROM sessions WHERE voter_id = ?").bind(v.id),
  ]);
  // Take the revoked voter's votes out of the caches now, rather than waiting for a manual rebuild.
  const rounds = await db.prepare("SELECT DISTINCT round_id FROM votes WHERE voter_id = ?").bind(v.id).all<{ round_id: string }>();
  let rowsWritten = 0;
  for (const r of rounds.results) {
    const n = await rebuildPairCounts(db, r.round_id);
    rowsWritten += n;
    // Saved intervals included this voter's votes. They are a cache: drop them until the next refresh.
    if (!already || n > 0) await db.prepare("DELETE FROM rating_snapshots WHERE round_id = ?").bind(r.round_id).run();
  }
  if (!already || rowsWritten > 0) await audit(c, "revoke_code", { label, rebuilt: rounds.results.map((r) => r.round_id), ...(already ? { repaired: true } : {}) });
  return c.json({ ok: true, ...(already ? { already: true } : {}) });
});

// ---------- study health (report only) ----------

adminApi.get("/rounds/:id/health", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  return c.json(await studyHealth(c.env.DB, round));
});

// ---------- raw votes ----------

adminApi.get("/votes", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.round) (where.push("v.round_id = ?"), args.push(q.round));
  if (q.role) (where.push("v.role = ?"), args.push(q.role));
  if (q.label) (where.push("u.label = ?"), args.push(q.label));
  if (q.repeat === "0" || q.repeat === "1") (where.push("v.is_repeat = ?"), args.push(Number(q.repeat)));
  const page = Math.max(0, Number(q.page) || 0);
  const size = 50;
  const sqlWhere = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await c.env.DB.prepare(
    `SELECT v.id, v.created_at, u.label, v.role, v.left_q, v.right_q, v.winner_q, v.close_call, v.is_repeat,
            v.after_board, v.client_ms, v.server_ms, v.correction_id IS NOT NULL AS corrected
       FROM votes_effective v JOIN voters u ON u.id = v.voter_id ${sqlWhere} ORDER BY v.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...args, size, page * size)
    .all();
  const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM votes v JOIN voters u ON u.id = v.voter_id ${sqlWhere}`)
    .bind(...args)
    .first<{ n: number }>();
  return c.json({ page, size, total: total?.n ?? 0, votes: rows.results });
});

// ---------- exports ----------

export const EXPORT_PAGE_MAX = 2000;

/** Paged export, part 1: round, voters and skips. Audited as the export (kind=json or kind=votes). */
adminApi.get("/rounds/:id/export-meta", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const kind = c.req.query("kind") === "votes" ? "export_votes_csv" : "export_json";
  const meta = await exportMeta(c.env.DB, round);
  await audit(c, kind, { id: round.id, paged: true });
  return c.json(meta);
});

/** Paged export, part 2: votes after `after`, at most EXPORT_PAGE_MAX per request so no request grows with the round. */
adminApi.get("/rounds/:id/export-votes", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const after = Math.max(0, Number(c.req.query("after")) || 0);
  const limit = Math.min(EXPORT_PAGE_MAX, Math.max(1, Number(c.req.query("limit")) || EXPORT_PAGE_MAX));
  return c.json(await votePage(c.env.DB, round, after, limit));
});

// ---------- full backup: every table that is not a cache or a credential ----------

/**
 * Tables in the backup, with the columns sent. Left out on purpose: sessions and attempts (hashes of live cookies and
 * of client addresses), voters.code_hash (a credential), and the caches pair_counts and rating_snapshots, which
 * rebuild from the log.
 */
export const BACKUP_TABLES: Record<string, string> = {
  item_sets: "*",
  questions: "*",
  item_set_items: "*",
  rounds: "*",
  voters: "id, role, label, is_owner, created_at, revoked_at, board_seen_at, email, name, join_link_id, slice_json",
  batches: "*",
  batch_pairs: "*",
  votes: "*",
  skips: "*",
  vote_reasons: "*",
  vote_other: "*",
  vote_corrections: "*",
  correction_reasons: "*",
  correction_other: "*",
  admin_audit: "*",
  round_board_seen: "*",
  round_in_play: "*",
  // Without word_hash: like a code's hash, it is a credential. A link's word is recomputed from CODE_PEPPER.
  join_links: "id, created_at, closed_at",
};
export const BACKUP_PAGE_MAX = 1000;

/** Start of a backup: the table list with row counts. Audited as the backup. */
adminApi.get("/backup", async (c) => {
  const names = Object.keys(BACKUP_TABLES);
  // Audited first, so the backup's own audit row is counted and included.
  await audit(c, "export_backup", { tables: names.length });
  const counts = await c.env.DB.batch(names.map((t) => c.env.DB.prepare(`SELECT count(*) AS n FROM ${t}`)));
  const tables = names.map((t, i) => ({ name: t, rows: (counts[i].results[0] as { n: number }).n }));
  const migrations = await c.env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>().then(
    (r) => r.results.map((m) => m.name),
    () => [] as string[],
  );
  return c.json({ exportedAt: nowIso(), migrations, tables, pageMax: BACKUP_PAGE_MAX });
});

/** One page of one table, in rowid order, at most BACKUP_PAGE_MAX rows, so no request grows with the data. */
adminApi.get("/backup/:table", async (c) => {
  const t = c.req.param("table");
  const cols = BACKUP_TABLES[t];
  if (!cols) return c.json({ error: "not_found" }, 404);
  const after = Math.max(0, Number(c.req.query("after")) || 0);
  const r = await c.env.DB.prepare(`SELECT rowid AS _rowid, ${cols} FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
    .bind(after, BACKUP_PAGE_MAX)
    .all<Record<string, unknown>>();
  const rows = r.results;
  const next = rows.length === BACKUP_PAGE_MAX ? (rows[rows.length - 1]._rowid as number) : null;
  return c.json({ table: t, rows: rows.map(({ _rowid, ...row }) => row), next });
});

adminApi.get("/rounds/:id/export.json", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const body = JSON.stringify(await roundExport(c.env.DB, round));
  await audit(c, "export_json", { id: round.id, sha256: await sha256Hex(body) });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="wtpqr-round-${round.id}.json"`,
    },
  });
});

adminApi.get("/rounds/:id/export/:file", async (c) => {
  const m = /^(votes|skips|ratings|voters|reasons|corrections)\.csv$/.exec(c.req.param("file"));
  if (!m) return c.json({ error: "not_found" }, 404);
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const kind = m[1];
  const db = c.env.DB;
  const makers: Record<string, (db: D1Database, round: RoundRow) => Promise<string>> = {
    votes: votesCsv,
    skips: skipsCsv,
    ratings: ratingsCsv,
    reasons: reasonsCsv,
    corrections: correctionsCsv,
    voters: (d) => votersCsv(d),
  };
  const csv = await makers[kind](db, round);
  await audit(c, `export_${kind}_csv`, { id: round.id });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="wtpqr-${kind}-${round.id}.csv"`,
    },
  });
});
