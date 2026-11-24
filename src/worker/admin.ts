// Admin API, mounted at /admin/api. Every route but /login requires the Access token (or the fallback cookie).
import { Hono, type Context } from "hono";
import { RATING, ROLES } from "../rating/config";
import { requireAdmin, adminSecretLogin } from "./access";
import { codeHash, generateCode } from "./auth";
import { board, POOLS, rebuildPairCounts, ROLE_NAMES, roundItems } from "./data";
import type { AppEnv, RoundRow } from "./env";
import { roundExport, ratingsCsv, skipsCsv, votersCsv, votesCsv } from "./exports";
import { isUniqueViolation, nowIso, optInt, randomId, readJsonObject, sha256Hex } from "./util";

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
              (SELECT count(DISTINCT voter_id) FROM votes v WHERE v.round_id = r.id) AS n_voters
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
    .prepare("SELECT MAX(at) AS at FROM admin_audit WHERE action LIKE 'export%'")
    .first<{ at: string | null }>();
  const anyVotes = await db.prepare("SELECT count(*) AS n FROM votes").first<{ n: number }>();
  const ageDays = lastExport?.at ? (Date.now() - Date.parse(lastExport.at)) / 86_400_000 : Infinity;
  return c.json({
    actor: c.get("actor"),
    rounds: rounds.results,
    itemSets: itemSets.results,
    lastExportAt: lastExport?.at ?? null,
    exportOverdue: (anyVotes?.n ?? 0) > 0 && ageDays > EXPORT_REMINDER_DAYS,
    roles: ROLES.map((r) => ({ id: r, name: ROLE_NAMES[r] })),
    pools: POOLS,
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
}

/** text_sha256 = SHA-256 of JSON.stringify([stem, bullets]) as loaded. */
export const questionTextHash = (stem: string, bullets: string[]) => sha256Hex(JSON.stringify([stem, bullets]));

adminApi.post("/items", async (c) => {
  const db = c.env.DB;
  const bytes = await c.req.arrayBuffer();
  const fileSha = await sha256Hex(bytes);
  let file: { item_set?: unknown; version?: unknown; items?: unknown };
  try {
    file = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  if (typeof file.item_set !== "string" || !/^[a-z0-9-]{1,40}$/.test(file.item_set))
    return c.json({ error: "bad_item_set", message: "item_set must be a short lower-case id." }, 400);
  if (typeof file.version !== "number" || !Number.isInteger(file.version) || file.version < 1)
    return c.json({ error: "bad_version" }, 400);
  if (!Array.isArray(file.items) || file.items.length < 2) return c.json({ error: "no_items" }, 400);
  const items = file.items as ItemIn[];

  const unpublished = items.filter((i) => i?.published !== true).map((i) => i?.id ?? "?");
  if (unpublished.length)
    return c.json({ error: "unpublished", message: "Every item must have published: true.", ids: unpublished }, 400);
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
  if (bad.length) return c.json({ error: "bad_items", ids: bad.map((i) => i?.id ?? "?") }, 400);
  if (new Set(items.map((i) => i.id)).size !== items.length) return c.json({ error: "duplicate_ids" }, 400);

  const setId = `${file.item_set}-v${file.version}`;
  const existing = await db.prepare("SELECT file_sha256 FROM item_sets WHERE id = ?").bind(setId).first<{ file_sha256: string }>();
  if (existing) {
    if (existing.file_sha256 === fileSha) return c.json({ ok: true, itemSet: setId, fileSha256: fileSha, already: true });
    return c.json({ error: "item_set_exists", message: `${setId} is already loaded from a different file.` }, 409);
  }

  const hashes = await Promise.all(items.map((i) => questionTextHash(i.stem, i.bullets)));
  const conflicts: string[] = [];
  for (let k = 0; k < items.length; k++) {
    const q = await db.prepare("SELECT text_sha256 FROM questions WHERE id = ?").bind(items[k].id).first<{ text_sha256: string }>();
    if (q && q.text_sha256 !== hashes[k]) conflicts.push(items[k].id);
  }
  if (conflicts.length)
    return c.json({ error: "text_conflict", message: "A loaded question has different text. Give the corrected text a new id.", ids: conflicts }, 409);

  const now = nowIso();
  await db.batch([
    ...items.map((i, k) =>
      db
        .prepare(
          `INSERT INTO questions (id, level, cycle, unit, qnum, published, stem, bullets_json, source, source_url,
                                  text_sha256, val_id, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .bind(i.id, i.level, i.cycle, i.unit, i.q, i.stem, JSON.stringify(i.bullets), i.source, i.source_url ?? null, hashes[k], i.val_id ?? null, now),
    ),
    db
      .prepare("INSERT INTO item_sets (id, name, version, display_mode, file_sha256, created_at) VALUES (?, ?, ?, 'full_text', ?, ?)")
      .bind(setId, file.item_set, file.version, fileSha, now),
    ...items.map((i) => db.prepare("INSERT INTO item_set_items (item_set_id, question_id) VALUES (?, ?)").bind(setId, i.id)),
  ]);
  await audit(c, "load_items", { itemSet: setId, fileSha256: fileSha, n: items.length });
  return c.json({ ok: true, itemSet: setId, fileSha256: fileSha, n: items.length });
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
  const now = nowIso();
  const stmts = [db.prepare(`UPDATE rounds SET state = ?, ${t.col} = ? WHERE id = ? AND state = ?`).bind(t.to, now, round.id, round.state)];
  // The item set freezes when its first round opens.
  if (t.to === "open")
    stmts.push(db.prepare("UPDATE item_sets SET frozen_at = ? WHERE id = ? AND frozen_at IS NULL").bind(now, round.item_set_id));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "another_round_open", message: "Another round is open. Freeze or close it first." }, 409);
    throw e;
  }
  await audit(c, `${c.req.param("action")}_round`, { id: round.id });
  return c.json({ ok: true, state: t.to });
});

adminApi.post("/rounds/:id/rebuild", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  await rebuildPairCounts(c.env.DB, round.id);
  await audit(c, "rebuild_caches", { id: round.id });
  return c.json({ ok: true });
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
       FROM votes v JOIN voters u ON u.id = v.voter_id
      WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL ORDER BY v.id`,
  )
    .bind(round.id)
    .all();
  return c.json({ items: await roundItems(c.env.DB, round.item_set_id), votes: votes.results, rating: RATING });
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
  const r = await c.env.DB.prepare(
    `SELECT u.label, u.role, u.is_owner, u.created_at, u.revoked_at, u.board_seen_at,
            (SELECT count(*) FROM votes v WHERE v.voter_id = u.id) AS n_votes
       FROM voters u ORDER BY u.role, u.label`,
  ).all();
  return c.json({ voters: r.results });
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
  const labels = await db.prepare("SELECT label FROM voters WHERE label LIKE ?").bind(`${name} %`).all<{ label: string }>();
  let next = 1 + Math.max(0, ...labels.results.map((l) => Number(l.label.slice(name.length + 1)) || 0));
  const now = nowIso();
  const out: { label: string; role: string; code: string }[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (let k = 0; k < count; k++) {
    const code = generateCode();
    const label = `${name} ${String(next++).padStart(2, "0")}`;
    out.push({ label, role, code });
    stmts.push(
      db
        .prepare("INSERT INTO voters (id, code_hash, role, label, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(randomId(), await codeHash(c.env, code), role, label, owner ? 1 : 0, now),
    );
  }
  await db.batch(stmts);
  await audit(c, "create_codes", { role, count, owner, labels: out.map((o) => o.label) });
  return c.json({ ok: true, codes: out });
});

adminApi.post("/codes/revoke", async (c) => {
  const db = c.env.DB;
  const body = await readJsonObject(c.req.raw);
  const label = body?.label;
  if (typeof label !== "string" || label.length > 40) return c.json({ error: "bad_request" }, 400);
  const v = await db.prepare("SELECT id, revoked_at FROM voters WHERE label = ?").bind(label).first<{ id: string; revoked_at: string | null }>();
  if (!v) return c.json({ error: "unknown_label" }, 404);
  if (v.revoked_at) return c.json({ ok: true, already: true });
  await db.batch([
    db.prepare("UPDATE voters SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), v.id),
    db.prepare("DELETE FROM sessions WHERE voter_id = ?").bind(v.id),
  ]);
  // Take the revoked voter's votes out of the caches now, rather than waiting for a manual rebuild.
  const rounds = await db.prepare("SELECT DISTINCT round_id FROM votes WHERE voter_id = ?").bind(v.id).all<{ round_id: string }>();
  for (const r of rounds.results) await rebuildPairCounts(db, r.round_id);
  await audit(c, "revoke_code", { label, rebuilt: rounds.results.map((r) => r.round_id) });
  return c.json({ ok: true });
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
            v.after_board, v.client_ms, v.server_ms
       FROM votes v JOIN voters u ON u.id = v.voter_id ${sqlWhere} ORDER BY v.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...args, size, page * size)
    .all();
  const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM votes v JOIN voters u ON u.id = v.voter_id ${sqlWhere}`)
    .bind(...args)
    .first<{ n: number }>();
  return c.json({ page, size, total: total?.n ?? 0, votes: rows.results });
});

// ---------- exports ----------

adminApi.get("/rounds/:id/export.json", async (c) => {
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const body = JSON.stringify(await roundExport(c.env.DB, round), null, 1);
  await audit(c, "export_json", { id: round.id, sha256: await sha256Hex(body) });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="wtpqr-round-${round.id}.json"`,
    },
  });
});

adminApi.get("/rounds/:id/export/:file", async (c) => {
  const m = /^(votes|skips|ratings|voters)\.csv$/.exec(c.req.param("file"));
  if (!m) return c.json({ error: "not_found" }, 404);
  const round = await getRound(c);
  if (!round) return c.json({ error: "unknown_round" }, 404);
  const kind = m[1];
  const db = c.env.DB;
  const csv =
    kind === "votes" ? await votesCsv(db, round) : kind === "skips" ? await skipsCsv(db, round) : kind === "ratings" ? await ratingsCsv(db, round) : await votersCsv(db);
  await audit(c, `export_${kind}_csv`, { id: round.id });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="wtpqr-${kind}-${round.id}.csv"`,
    },
  });
});
