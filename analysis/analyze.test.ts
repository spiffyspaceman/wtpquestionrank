// End-to-end smoke test of the analysis script on simulated data, using the real item file and LLM design.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeRng, sigmoid } from "../src/rating/rating";
import { analyze, type RoundExport } from "./analyze";

const root = path.resolve(__dirname, "..");
const itemsPath = path.join(root, "items/launch_items_v1.json");
const designPath = path.join(root, "llm-arm/design.json");
const items: { id: string }[] = JSON.parse(fs.readFileSync(itemsPath, "utf8")).items;
const ids = items.map((i) => i.id);

function normal(rng: () => number) {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

function simulateRound(truth: Map<string, number>, seed: number): RoundExport {
  const rng = makeRng(seed);
  const roles = ["judge", "judge", "coach", "coach", "alumni", "teacher", "other", "student"];
  const voters = Array.from({ length: 32 }, (_, k) => ({
    id: `v${k}`, label: `Voter ${k}`, role: roles[k % roles.length], is_owner: k === 0 ? 1 : 0, revoked_at: k === 31 ? "2026-12-01" : null,
  }));
  const votes: RoundExport["votes"] = [];
  let id = 1;
  for (const v of voters) {
    const own = new Map(ids.map((x) => [x, truth.get(x)! + 0.4 * normal(rng)]));
    const done: { l: string; r: string; w: string }[] = [];
    const seen = new Set<string>();
    const n = v.id === "v5" ? 60 : 45;
    while (done.length < n) {
      const a = ids[Math.floor(rng() * ids.length)], b = ids[Math.floor(rng() * ids.length)];
      const key = [a, b].sort().join("|");
      if (a === b || seen.has(key)) continue;
      seen.add(key);
      // v5 always picks the left question, quickly: should be flagged.
      const w = v.id === "v5" ? a : rng() < sigmoid(own.get(a)! - own.get(b)! + 0.1) ? a : b;
      done.push({ l: a, r: b, w });
      votes.push({ id: id++, round_id: "r1", voter_id: v.id, role: v.role, left_q: a, right_q: b, winner_q: w, close_call: rng() < 0.2 ? 1 : 0, is_repeat: 0, after_board: done.length > 20 ? 1 : 0, client_ms: v.id === "v5" ? 4000 : 30000 + 30000 * rng(), server_ms: v.id === "v5" ? 5000 : 32000 + 30000 * rng(), created_at: "2026-12-01T00:00:00Z" });
    }
    for (const d of done.slice(0, 3)) {
      const w = rng() < 0.8 ? d.w : d.w === d.l ? d.r : d.l;
      votes.push({ id: id++, round_id: "r1", voter_id: v.id, role: v.role, left_q: d.r, right_q: d.l, winner_q: w, close_call: 0, is_repeat: 1, after_board: 1, client_ms: 30000, server_ms: 31000, created_at: "2026-12-02T00:00:00Z" });
    }
  }
  return { round: { id: "r1" }, voters, votes, skips: [] };
}

function simulateLLM(dir: string, llmTruth: Map<string, number>, seed: number) {
  const rng = makeRng(seed);
  const design = JSON.parse(fs.readFileSync(designPath, "utf8"));
  fs.mkdirSync(dir, { recursive: true });
  for (const j of design.judges) {
    const pairs = j.pairs.map((p: { n: number; first: string; second: string }) => {
      const a = llmTruth.get(j.labels[p.first])!, b = llmTruth.get(j.labels[p.second])!;
      return { ...p, winner: rng() < sigmoid(2 * (a - b)) ? p.first : p.second, reason: "sim" };
    });
    fs.writeFileSync(path.join(dir, `${j.token}.json`), JSON.stringify({ token: j.token, pairs }));
  }
}

describe("analysis script (simulated round)", () => {
  const rng = makeRng(42);
  const truth = new Map(ids.map((x) => [x, 1.2 * normal(rng)]));

  it("validates an LLM that tracks the human ranking, and flags a one-sided rater", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtpqr-"));
    fs.writeFileSync(path.join(tmp, "round.json"), JSON.stringify(simulateRound(truth, 1)));
    simulateLLM(path.join(tmp, "llm"), truth, 2);
    const r = analyze({ exportPath: path.join(tmp, "round.json"), itemsPath, llmDesignPath: designPath, llmOutDir: path.join(tmp, "llm"), outDir: path.join(tmp, "out"), reps: 100, seed: 1 });
    expect(r.gate.passed).toBe(true);
    expect(r.verdict.startsWith("VALIDATED")).toBe(true);
    expect((r.primary as { spearman: number }).spearman).toBeGreaterThan(0.8);
    expect(r.raters.find((x) => x.voter === "v5")!.flags).toContain("one_side");
    expect(r.raters.find((x) => x.voter === "v5")!.flags).toContain("too_fast");
    expect(r.counts.revokedExcluded).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp, "out", "report.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "out", "leaderboard_adults.csv"))).toBe(true);
  });

  it("does not validate an LLM whose ranking is unrelated to the humans'", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtpqr-"));
    fs.writeFileSync(path.join(tmp, "round.json"), JSON.stringify(simulateRound(truth, 3)));
    const r2 = makeRng(77);
    simulateLLM(path.join(tmp, "llm"), new Map(ids.map((x) => [x, 1.2 * normal(r2)])), 4);
    const r = analyze({ exportPath: path.join(tmp, "round.json"), itemsPath, llmDesignPath: designPath, llmOutDir: path.join(tmp, "llm"), outDir: path.join(tmp, "out"), reps: 100, seed: 1 });
    expect(r.verdict.startsWith("VALIDATED")).toBe(false);
  });
});
