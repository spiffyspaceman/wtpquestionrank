// analysis/first_group.ts: the slice of a staged round's export that covers its first group of questions.
import { describe, expect, it } from "vitest";
import type { RoundExport } from "../../analysis/analyze";
import { firstGroup } from "../../analysis/first_group";

const vote = (id: number, voter: string, l: string, r: string, at: string) => ({
  id, round_id: "R", voter_id: voter, role: "judge", left_q: l, right_q: r, winner_q: l, close_call: 0, is_repeat: 0, after_board: 0, created_at: at,
});
const full: RoundExport = {
  round: { id: "R", name: "All questions" },
  voters: [
    { id: "v1", role: "judge", label: "Judge 01", is_owner: 0, revoked_at: null, board_seen_at: null },
    { id: "v2", role: "coach", label: "Coach 01", is_owner: 0, revoked_at: null, board_seen_at: null },
    { id: "v3", role: "judge", label: "Judge 02", is_owner: 0, revoked_at: null, board_seen_at: null },
  ],
  votes: [
    vote(1, "v1", "a", "b", "2026-11-26T10:00:00.000Z"),
    vote(2, "v1", "b", "c", "2026-11-26T11:00:00.000Z"),
    vote(3, "v2", "a", "c", "2026-11-27T09:00:00.000Z"), // after the second group joined
    vote(4, "v2", "a", "x", "2026-11-27T09:05:00.000Z"), // x is not in the first group
    vote(5, "v3", "x", "y", "2026-11-27T09:06:00.000Z"),
  ],
  skips: [
    { voter_id: "v2", item_lo: "a", item_hi: "b", is_repeat: 0 },
    { voter_id: "v3", item_lo: "x", item_hi: "y", is_repeat: 0 },
  ],
};
const group = new Set(["a", "b", "c"]);
const inPlay = [
  { round_id: "R", question_id: "a", joined_at: "2026-11-26T09:00:00.000Z" },
  { round_id: "R", question_id: "x", joined_at: "2026-11-27T08:00:00.000Z" },
  { round_id: "R", question_id: "y", joined_at: "2026-11-27T08:00:00.000Z" },
  { round_id: "other", question_id: "z", joined_at: "2026-11-25T00:00:00.000Z" },
];

describe("first group of a staged round", () => {
  it("keeps votes among the group's questions cast before the next group joined, and the voters who cast them", () => {
    const r = firstGroup(full, group, inPlay);
    expect(r.cutoff).toBe("2026-11-27T08:00:00.000Z");
    expect(r.export.votes.map((v) => v.id)).toEqual([1, 2]);
    expect(r.export.skips).toEqual([{ voter_id: "v2", item_lo: "a", item_hi: "b", is_repeat: 0 }]);
    expect(r.export.voters.map((u) => u.id)).toEqual(["v1", "v2"]);
    expect(r.kept).toEqual({ votes: 2, skips: 1, voters: 2 });
    expect(r.dropped).toEqual({ otherQuestions: 2, afterCutoff: 1 });
    expect(r.export.round).toEqual(full.round);
  });

  it("without a record of when questions joined, keeps every vote among the group's questions", () => {
    const r = firstGroup(full, group, null);
    expect(r.cutoff).toBeNull();
    expect(r.export.votes.map((v) => v.id)).toEqual([1, 2, 3]);
  });
});
