// The Worker's export key lists must match the analysis script's input types exactly (compile time) and in order
// (run time). The Worker keeps its own copies because analysis/analyze.ts imports node:fs.
import { describe, expect, it } from "vitest";
import type { ExportSkip, ExportVote, ExportVoter, RoundExport } from "../../analysis/analyze";
import {
  EXPORT_SKIP_KEYS,
  EXPORT_VOTE_KEYS,
  EXPORT_VOTER_KEYS,
  type RoundExport as WorkerRoundExport,
} from "../../src/worker/export-shape";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const voterKeys: Exact<(typeof EXPORT_VOTER_KEYS)[number], keyof ExportVoter> = true;
const voteKeys: Exact<(typeof EXPORT_VOTE_KEYS)[number], keyof ExportVote> = true;
const skipKeys: Exact<(typeof EXPORT_SKIP_KEYS)[number], keyof ExportSkip> = true;
const topKeys: Exact<keyof WorkerRoundExport, keyof RoundExport> = true;
const roundKeys: Exact<keyof WorkerRoundExport["round"], keyof RoundExport["round"]> = true;

describe("export shape", () => {
  it("covers every field of RoundExport and nothing else", () => {
    expect([voterKeys, voteKeys, skipKeys, topKeys, roundKeys]).toEqual([true, true, true, true, true]);
    expect(new Set(EXPORT_VOTE_KEYS).size).toBe(13);
    expect(new Set(EXPORT_VOTER_KEYS).size).toBe(6);
    expect(new Set(EXPORT_SKIP_KEYS).size).toBe(4);
  });
});
