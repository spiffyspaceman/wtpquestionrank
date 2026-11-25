// The admin study health panel repeats the pre-registered data gate. It must match analysis/analyze.ts.
import { describe, expect, it } from "vitest";
import { PREREG } from "../../analysis/analyze";
import { GATE } from "../../src/worker/gate";

describe("study health gate", () => {
  it("uses the same numbers as the analysis", () => {
    expect(GATE).toEqual({
      MIN_ADULT_RATERS: PREREG.MIN_ADULT_RATERS,
      MIN_VOTES_PER_COUNTED_RATER: PREREG.MIN_VOTES_PER_COUNTED_RATER,
      MIN_ADULT_GAMES_PER_ITEM: PREREG.MIN_ADULT_GAMES_PER_ITEM,
    });
  });
});
