// The topic labels (owner decision, 26 Nov 2026): one for every question in the full set, short and plain.
import { describe, expect, it } from "vitest";
import all from "../../items/rounds/all.json";
import { ALL_SUMMARIES } from "../../src/worker/summaries";

const ids = (all as { items: { id: string }[] }).items.map((i) => i.id);

describe("topic labels", () => {
  it("every question in the full set has one, and none is left over", () => {
    expect(ids.filter((id) => !ALL_SUMMARIES[id])).toEqual([]);
    expect(Object.keys(ALL_SUMMARIES).filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("each is a plain label of at most five words: no question mark, closing period, colon or dash", () => {
    const bad = Object.entries(ALL_SUMMARIES).filter(
      ([, s]) => s.trim() !== s || !s || s.split(/\s+/).length > 5 || /[?:;!—–]|\.$/.test(s) || s[0] !== s[0].toUpperCase(),
    );
    expect(bad).toEqual([]);
  });
});
