// The voter list shows the newest batch of codes first, and each batch in label order.
import { beforeEach, describe, expect, it } from "vitest";
import { json, makeCodes, mockOutbound, admin } from "./helpers";

describe("voter list order", () => {
  beforeEach(() => mockOutbound());

  it("lists the newest batch first, labels in number order within a batch", async () => {
    await makeCodes("judge", 3);
    await new Promise((r) => setTimeout(r, 5));
    await makeCodes("coach", 2);
    await new Promise((r) => setTimeout(r, 5));
    await makeCodes("judge", 2);
    const labels = (await json(admin("/admin/api/codes"))).voters.map((v: { label: string }) => v.label);
    expect(labels).toEqual(["Judge 04", "Judge 05", "Coach 01", "Coach 02", "Judge 01", "Judge 02", "Judge 03"]);
  });

  it("orders Judge 10 after Judge 09, not after Judge 01", async () => {
    await makeCodes("other", 11);
    const labels = (await json(admin("/admin/api/codes"))).voters.map((v: { label: string }) => v.label).filter((l: string) => l.startsWith("Other"));
    expect(labels.slice(8, 11)).toEqual(["Other 09", "Other 10", "Other 11"]);
  });
});
