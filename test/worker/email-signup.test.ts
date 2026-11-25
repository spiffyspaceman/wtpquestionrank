// Sign-up by email with a self-chosen role (owner decision, 25 Nov 2026; migration 0009). The address is a username:
// it is not verified. It is kept for the owner and never shown to a voter or put in the analysis exports.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, call, getBatch, json, mockOutbound, openNewRound, quorum, sessionCookie, turnstileWill, voteN, voter } from "./helpers";

async function link(): Promise<{ id: string; word: string; link: string }> {
  return json(admin("/admin/api/join-links", { body: {} }));
}
const join = (word: string, over: Record<string, unknown> = {}, ip?: string) =>
  call("/api/join", { body: { word, email: "pat@example.org", role: "coach", turnstileToken: "tok", ...over }, ...(ip ? { ip } : {}) });
const row = (email: string) => env.DB.prepare("SELECT id, role, label, email, name, join_link_id, revoked_at FROM voters WHERE email = ?").bind(email).first<Record<string, string | null>>();

describe("email sign-up", () => {
  beforeEach(() => {
    mockOutbound();
    turnstileWill(true);
  });

  it("signs up an adult with an address, an optional name and a chosen role, and they can vote at once", async () => {
    const round = await openNewRound();
    const l = await link();
    expect(l.link).toBe(`https://wtpquestionrank.spiffyspaceman.com/join#${l.word}`);
    const r = await join(l.word, { email: "  Pat.Jones@Example.ORG ", name: "  Pat   Jones ", role: "coach" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, created: true });
    const cookie = sessionCookie(r);
    const v = await row("pat.jones@example.org");
    expect(v).toMatchObject({ role: "coach", email: "pat.jones@example.org", name: "Pat Jones", join_link_id: l.id, revoked_at: null });
    expect(v!.label).toMatch(/^Coach \d\d$/);
    expect(await json(call("/api/me", { cookie }))).toMatchObject({ role: "Coach", votes: 0 });
    await voteN(cookie, 3);
    const cast = await env.DB.prepare("SELECT role, count(*) AS n FROM votes WHERE round_id = ? AND voter_id = ? GROUP BY role").bind(round, v!.id).all();
    expect(cast.results).toEqual([{ role: "coach", n: 3 }]);
    // No name is fine.
    expect((await join(l.word, { email: "sam@example.org", role: "judge" })).status).toBe(200);
    expect((await row("sam@example.org"))!.name).toBeNull();
  });

  it("the sign-in box takes the address afterwards, whatever its case; an unknown address is refused and counted", async () => {
    await openNewRound();
    const l = await link();
    await join(l.word, { email: "lee@example.org", role: "teacher" });
    const back = await call("/api/redeem", { body: { code: " LEE@Example.org ", turnstileToken: "tok" } });
    expect(back.status).toBe(200);
    expect(await json(call("/api/me", { cookie: sessionCookie(back) }))).toMatchObject({ role: "Teacher" });

    const ip = "198.51.100.44";
    const before = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM attempts").first<{ n: number }>();
    const nope = await call("/api/redeem", { body: { code: "nobody@example.org", turnstileToken: "tok" }, ip });
    expect(nope.status).toBe(403);
    expect(await nope.json()).toMatchObject({ error: "unknown_email" });
    const after = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM attempts").first<{ n: number }>();
    expect(after!.n).toBe(before!.n + 1);
    // Ten wrong tries from one address in a day and the door shuts, for emails as for codes.
    for (let k = 0; k < 9; k++) await call("/api/redeem", { body: { code: `guess${k}@example.org`, turnstileToken: "tok" }, ip });
    expect((await call("/api/redeem", { body: { code: "lee@example.org", turnstileToken: "tok" }, ip })).status).toBe(429);
    // A failed Turnstile check stops an email sign-in like any other.
    turnstileWill(false);
    expect((await call("/api/redeem", { body: { code: "lee@example.org", turnstileToken: "tok" } })).status).toBe(403);
  });

  it("an address that signs up twice is one voter: the second time signs in and the role stays", async () => {
    const l = await link();
    await join(l.word, { email: "kit@example.org", role: "judge", name: "Kit" });
    const again = await join(l.word, { email: "KIT@example.org", role: "alumni", name: "Someone else" });
    expect(await again.json()).toEqual({ ok: true, created: false });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM voters WHERE email = 'kit@example.org'").first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await row("kit@example.org")).toMatchObject({ role: "judge", name: "Kit" });
    expect(await json(call("/api/me", { cookie: sessionCookie(again) }))).toMatchObject({ role: "Judge" });
  });

  it("refuses a wrong or closed link, a student, a bad address, a long name and a failed check", async () => {
    const l = await link();
    const wrong = await join("AAAA-BBBB-CCCC", { email: "a@example.org" }, "198.51.100.60");
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ error: "wrong_link" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM voters WHERE email = 'a@example.org'").first<{ n: number }>())!.n).toBe(0);

    // Students are given a code by the owner; the sign-up form does not take them.
    const student = await join(l.word, { email: "s@example.org", role: "student" });
    expect(student.status).toBe(400);
    expect(await student.json()).toMatchObject({ error: "bad_role" });
    for (const email of ["", "not-an-address", "a@b", "two@@example.org", "x@example..org", "a".repeat(250) + "@example.org", 7])
      expect((await join(l.word, { email })).status, String(email)).toBe(400);
    expect(await (await join(l.word, { email: "n@example.org", name: "x".repeat(61) })).json()).toMatchObject({ error: "bad_name" });
    expect((await join(l.word, { email: "n@example.org", role: undefined })).status).toBe(400);
    turnstileWill(false);
    expect(await (await join(l.word, { email: "n@example.org" })).json()).toMatchObject({ error: "turnstile_failed" });
    turnstileWill(true);
    expect(await row("n@example.org")).toBeNull();

    // Closed: nobody new, but someone who signed up before it closed still gets in.
    await join(l.word, { email: "early@example.org" });
    expect(await json(admin(`/admin/api/join-links/${l.id}/close`, { body: {} }))).toMatchObject({ ok: true });
    const late = await join(l.word, { email: "late@example.org" });
    expect(late.status).toBe(403);
    expect(await late.json()).toMatchObject({ error: "link_closed" });
    expect((await join(l.word, { email: "early@example.org" })).status).toBe(200);
    expect((await call("/api/redeem", { body: { code: "early@example.org", turnstileToken: "tok" } })).status).toBe(200);
  });

  it("a revoked address cannot sign in or sign up again", async () => {
    const l = await link();
    await join(l.word, { email: "gone@example.org" });
    const v = await row("gone@example.org");
    await admin("/admin/api/codes/revoke", { body: { label: v!.label } });
    expect(await (await call("/api/redeem", { body: { code: "gone@example.org", turnstileToken: "tok" } })).json()).toMatchObject({ error: "revoked" });
    expect(await (await join(l.word, { email: "gone@example.org" })).json()).toMatchObject({ error: "revoked" });
  });

  it("the address and name reach the owner's page, the voters CSV and the backup, and nothing a voter or the analysis sees", async () => {
    const round = await openNewRound();
    await quorum("other");
    const l = await link();
    const r = await join(l.word, { email: "private.person@example.org", name: "Private Person", role: "judge" });
    const cookie = sessionCookie(r);
    await voteN(cookie, 20);
    const secret = /private\.person|Private Person|example\.org/i;
    for (const path of ["/api/me", "/api/batch", "/api/leaderboard"]) expect(await (await call(path, { cookie })).text(), path).not.toMatch(secret);
    for (const path of [`/admin/api/rounds/${round}/export.json`, `/admin/api/rounds/${round}/export/votes.csv`, `/admin/api/rounds/${round}/export/reasons.csv`, `/admin/api/rounds/${round}/export-meta`, `/admin/api/rounds/${round}/export-votes`])
      expect(await (await admin(path)).text(), path).not.toMatch(secret);
    // The owner's views.
    const list = await json(admin("/admin/api/codes"));
    expect(list.voters.find((x: { email: string | null }) => x.email === "private.person@example.org")).toMatchObject({ name: "Private Person", role: "judge" });
    const csv = await (await admin(`/admin/api/rounds/${round}/export/voters.csv`)).text();
    expect(csv.split(/\r?\n/)[0]).toBe("label,role,revoked_at,email,name");
    expect(csv).toMatch(/Judge \d\d,judge,,private\.person@example\.org,Private Person/);
    const backup = await json(admin("/admin/api/backup/voters"));
    expect(backup.rows.find((x: { email: string | null }) => x.email === "private.person@example.org")).toMatchObject({ name: "Private Person", join_link_id: l.id });
    expect(JSON.stringify(backup.rows)).not.toMatch(/code_hash/);
    const links = await json(admin("/admin/api/backup/join_links"));
    expect(links.rows.some((x: { id: string }) => x.id === l.id)).toBe(true);
    expect(JSON.stringify(links.rows)).not.toMatch(/word_hash/);
    // A voter given a code has neither.
    const coded = await voter("coach");
    const c2 = await env.DB.prepare("SELECT email, name FROM voters WHERE label = ?").bind(coded.label).first();
    expect(c2).toEqual({ email: null, name: null });
  });

  it("the owner can list, show again and close sign-up links, and change a voter's role for later votes", async () => {
    const round = await openNewRound();
    const l = await link();
    const r = await join(l.word, { email: "mix@example.org", role: "other" });
    const cookie = sessionCookie(r);
    const v = await row("mix@example.org");
    await voteN(cookie, 2);
    const list = await json(admin("/admin/api/join-links"));
    expect(list.links.find((x: { id: string }) => x.id === l.id)).toMatchObject({ closed_at: null, n_signed_up: 1 });
    expect(JSON.stringify(list)).not.toContain(l.word);
    expect(await json(admin(`/admin/api/join-links/${l.id}/reveal`))).toMatchObject({ word: l.word, link: l.link });
    // Only the hash of a link's word is stored.
    const stored = await env.DB.prepare("SELECT word_hash FROM join_links WHERE id = ?").bind(l.id).first<{ word_hash: string }>();
    expect(stored!.word_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.word_hash).not.toContain(l.word);

    expect(await json(admin("/admin/api/voters/role", { body: { label: v!.label, role: "judge" } }))).toMatchObject({ ok: true, role: "judge" });
    expect(await json(call("/api/me", { cookie }))).toMatchObject({ role: "Judge" });
    await voteN(cookie, 3);
    const roles = await env.DB.prepare("SELECT role, count(*) AS n FROM votes WHERE round_id = ? AND voter_id = ? GROUP BY role ORDER BY role").bind(round, v!.id).all();
    expect(roles.results).toEqual([{ role: "judge", n: 3 }, { role: "other", n: 2 }]);
    expect((await admin("/admin/api/voters/role", { body: { label: v!.label, role: "wizard" } })).status).toBe(400);
    expect((await admin("/admin/api/voters/role", { body: { label: "Nobody 99", role: "judge" } })).status).toBe(404);
    const audit = await env.DB.prepare("SELECT action, detail_json FROM admin_audit WHERE action IN ('create_join_link', 'reveal_join_link', 'change_role') ORDER BY id DESC LIMIT 3").all<{ action: string; detail_json: string }>();
    expect(audit.results.map((a) => a.action).sort()).toEqual(["change_role", "create_join_link", "reveal_join_link"]);
    // The audit log names the label, never the address.
    expect(JSON.stringify(audit.results)).not.toContain("mix@example.org");
    // None of this is open to a voter.
    for (const [path, body] of [["/admin/api/join-links", {}], [`/admin/api/join-links/${l.id}/close`, {}], ["/admin/api/voters/role", { label: v!.label, role: "coach" }]] as const)
      expect((await call(path, { cookie, body })).status).toBe(403);
    expect((await call("/admin/api/join-links", { cookie })).status).toBe(403);
  });

  it("someone who signed up by email also has a personal code the owner can show, and it signs them in", async () => {
    const l = await link();
    await join(l.word, { email: "both@example.org", role: "alumni" });
    const v = await row("both@example.org");
    const shown = await json(admin(`/admin/api/codes/reveal?label=${encodeURIComponent(v!.label!)}`));
    const r = await call("/api/redeem", { body: { code: shown.code, turnstileToken: "tok" } });
    expect(r.status).toBe(200);
    expect(await json(call("/api/me", { cookie: sessionCookie(r) }))).toMatchObject({ role: "Alumni" });
  });

  it("two sign-ups at the same moment in the same role get different labels", async () => {
    const l = await link();
    let fired = false;
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!fired && sql.startsWith("INSERT INTO voters")) {
              fired = true;
              // The other sign-up lands between this one's choice of label and its insert.
              return new Proxy(stmt, {
                get(t, k) {
                  if (k === "bind")
                    return (...args: unknown[]) => {
                      const bound = t.bind(...args);
                      return new Proxy(bound, {
                        get(b, kk) {
                          if (kk === "run")
                            return async () => {
                              expect((await join(l.word, { email: "first@example.org", role: "teacher" })).status).toBe(200);
                              return b.run();
                            };
                          const v = Reflect.get(b, kk);
                          return typeof v === "function" ? v.bind(b) : v;
                        },
                      });
                    };
                  const v = Reflect.get(t, k);
                  return typeof v === "function" ? v.bind(t) : v;
                },
              });
            }
            return stmt;
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const second = await call("/api/join", { body: { word: l.word, email: "second@example.org", role: "teacher", turnstileToken: "tok" }, env: { DB } });
    expect(second.status).toBe(200);
    const a = await row("first@example.org"), b = await row("second@example.org");
    expect(a!.label).toMatch(/^Teacher \d\d$/);
    expect(b!.label).toMatch(/^Teacher \d\d$/);
    expect(a!.label).not.toBe(b!.label);
  });

  it("a voter whose role was changed is still one person behind the adults board", async () => {
    await openNewRound();
    const l = await link();
    const a = sessionCookie(await join(l.word, { email: "one@example.org", role: "judge" }));
    const b = sessionCookie(await join(l.word, { email: "two@example.org", role: "coach" }));
    await voteN(a, 20);
    await voteN(b, 1);
    expect(await (await call("/api/leaderboard", { cookie: a })).json()).toMatchObject({ error: "too_few_voters" });
    // The owner moves the first voter to coach, and they vote again: votes under two roles, still two people.
    const v = await row("one@example.org");
    await admin("/admin/api/voters/role", { body: { label: v!.label, role: "coach" } });
    await voteN(a, 1);
    const still = await call("/api/leaderboard", { cookie: a });
    expect(still.status).toBe(403);
    expect(await still.json()).toMatchObject({ error: "too_few_voters" });
    // A third person opens it.
    await voteN(sessionCookie(await join(l.word, { email: "three@example.org", role: "other" })), 1);
    expect((await call("/api/leaderboard", { cookie: a })).status).toBe(200);
  });

  it("a voter who signed up by email cannot be made a student; a voter with a code can", async () => {
    const l = await link();
    await join(l.word, { email: "adult@example.org", name: "An Adult", role: "other" });
    const v = await row("adult@example.org");
    const r = await admin("/admin/api/voters/role", { body: { label: v!.label, role: "student" } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "student_with_email" });
    expect(await row("adult@example.org")).toMatchObject({ role: "other", name: "An Adult" });
    // No student row holds an address or a name.
    const coded = await voter("coach");
    expect(await json(admin("/admin/api/voters/role", { body: { label: coded.label, role: "student" } }))).toMatchObject({ ok: true, role: "student" });
    const leak = await env.DB.prepare("SELECT count(*) AS n FROM voters WHERE role = 'student' AND (email IS NOT NULL OR name IS NOT NULL)").first<{ n: number }>();
    expect(leak!.n).toBe(0);
  });

  it("sign-up and sign-in have room for the longest check token; other voter requests keep the 2 KB cap", async () => {
    const l = await link();
    const long = { turnstileToken: "t".repeat(2048), email: `${"a".repeat(60)}@${"b".repeat(180)}.org`, name: "n".repeat(60) };
    const r = await join(l.word, long);
    expect(r.status).toBe(200);
    expect((await call("/api/redeem", { body: { code: long.email, turnstileToken: "t".repeat(2048) } })).status).toBe(200);
    expect((await join(l.word, { pad: "x".repeat(5000) })).status).toBe(413);
    expect((await call("/api/vote", { cookie: sessionCookie(r), body: { pairId: "x", pick: "L", pad: "x".repeat(3000) } })).status).toBe(413);
  });
});
