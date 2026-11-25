// Migrations against a database that already holds rows, shaped like production's on 25 Nov 2026 (a closed round on
// the launch set, an open round, a draft round on the open-ended full set, voters with codes). The route tests only
// ever apply migrations to an empty database.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(import.meta.dirname, "../../migrations");
// node:sqlite is new in Node 22; without it this test has nothing to run on and says so by being skipped.
const sqlite = await import("node:sqlite").catch(() => null);

describe.skipIf(!sqlite)("migration 0008 on a populated database", () => {
  it("marks only a draft round on an open-ended set as staged, and fixes staging once a round has opened", () => {
    const db = new sqlite!.DatabaseSync(":memory:");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0008_staged_rounds.sql");
    for (const f of files.filter((f) => f < "0008")) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    db.exec(`
      INSERT INTO item_sets (id, name, version, display_mode, file_sha256, created_at, frozen_at, open_ended) VALUES
        ('state-launch-v1', 'launch', 1, 'full_text', 'x', 't', 't', 0), ('all-questions-v1', 'all', 1, 'full_text', 'y', 't', NULL, 1);
      INSERT INTO rounds (id, name, item_set_id, state, created_at, opened_at, closed_at) VALUES
        ('closed', 'Test', 'state-launch-v1', 'closed', 't', 't', 't'),
        ('open', 'Running', 'all-questions-v1', 'open', 't', 't', NULL),
        ('draftLaunch', 'Draft on the launch set', 'state-launch-v1', 'draft', 't', NULL, NULL),
        ('draftFull', 'All questions', 'all-questions-v1', 'draft', 't', NULL, NULL);`);
    db.exec(fs.readFileSync(path.join(dir, "0008_staged_rounds.sql"), "utf8"));
    const rows = db.prepare("SELECT id, staged, auto_grow FROM rounds ORDER BY id").all() as { id: string; staged: number; auto_grow: number }[];
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { id: "closed", staged: 0, auto_grow: 0 },
      { id: "draftFull", staged: 1, auto_grow: 1 },
      { id: "draftLaunch", staged: 0, auto_grow: 0 },
      { id: "open", staged: 0, auto_grow: 0 },
    ]);
    // An opened round's staging cannot change; a draft's can; growing by itself can change at any time.
    expect(() => db.exec("UPDATE rounds SET staged = 1 WHERE id = 'open'")).toThrow(/fixed once/);
    expect(() => db.exec("UPDATE rounds SET staged = 1 WHERE id = 'closed'")).toThrow(/fixed once/);
    db.exec("UPDATE rounds SET staged = 0, auto_grow = 0 WHERE id = 'draftFull'");
    db.exec("UPDATE rounds SET auto_grow = 1 WHERE id = 'open'");
    // Questions in play are append-only.
    db.exec("INSERT INTO questions (id, level, cycle, unit, qnum, published, stem, bullets_json, source, text_sha256, created_at) VALUES ('q1', 'State', '2020-21', 1, 1, 1, 's', '[]', 'src', 'h', 't')");
    db.exec("INSERT INTO round_in_play (round_id, question_id, joined_at) VALUES ('open', 'q1', 't')");
    expect(() => db.exec("DELETE FROM round_in_play")).toThrow(/append-only/);
    expect(() => db.exec("UPDATE round_in_play SET joined_at = 'x'")).toThrow(/append-only/);
    db.close();
  });
});

describe.skipIf(!sqlite)("migration 0009 on a populated database", () => {
  it("leaves voters who were given codes without an address, and allows one voter per address", () => {
    const db = new sqlite!.DatabaseSync(":memory:");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0009_email_signup.sql");
    for (const f of files.filter((f) => f < "0009")) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    db.exec(`INSERT INTO voters (id, code_hash, role, label, is_owner, created_at) VALUES
      ('v1', 'h1', 'judge', 'Judge 01', 0, 't'), ('v2', 'h2', 'student', 'Student 01', 0, 't');`);
    db.exec(fs.readFileSync(path.join(dir, "0009_email_signup.sql"), "utf8"));
    const rows = db.prepare("SELECT id, email, name, join_link_id FROM voters ORDER BY id").all() as Record<string, unknown>[];
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { id: "v1", email: null, name: null, join_link_id: null },
      { id: "v2", email: null, name: null, join_link_id: null },
    ]);
    // Many voters without an address; one voter per address.
    db.exec("INSERT INTO voters (id, code_hash, role, label, is_owner, created_at, email, name) VALUES ('v3', 'h3', 'coach', 'Coach 01', 0, 't', 'a@example.org', 'A')");
    expect(() => db.exec("INSERT INTO voters (id, code_hash, role, label, is_owner, created_at, email) VALUES ('v4', 'h4', 'coach', 'Coach 02', 0, 't', 'a@example.org')")).toThrow(/UNIQUE/);
    db.exec("INSERT INTO join_links (id, word_hash, created_at) VALUES ('l1', 'w1', 't')");
    expect(() => db.exec("INSERT INTO join_links (id, word_hash, created_at) VALUES ('l2', 'w1', 't')")).toThrow(/UNIQUE/);
    db.close();
  });
});
