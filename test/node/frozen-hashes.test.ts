// The pre-registration (PREREG_Human_vs_LLM.md §2 and §6) hashes these files. Any edit fails the build.
// If one truly must change: stop, get the owner's agreement, log it in DEVIATIONS.md, then update this list.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

export const FROZEN: Record<string, string> = {
  "src/rating/rating.ts": "cbc24b38af27f7b490f3268aa0fa2fafadde40072287e3668f03b4c0e5bf2d6d",
  "src/rating/pairs.ts": "4c427cb91676bea4a007b9f7c014f5a6f12bbe96d63a094885d134dafae34f30",
  "src/rating/config.ts": "6c5e6e78bf125f00dc8fe9bee1491299776b59567020297db84bf87d9f259678",
  "analysis/analyze.ts": "8e22fd63a0aeac6986155dbf03ffdba7bbaa4c6f4b2d211461a96f1a986e3009",
  "analysis/stats.ts": "d75c07883254d8a1dd4ed56ace7c39e268a45b52d09c733e67077262a05b4873",
  "items/launch_items_v1.json": "8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0",
};

describe("frozen files", () => {
  for (const [file, want] of Object.entries(FROZEN)) {
    it(`${file} matches its pre-registered SHA-256`, () => {
      const got = createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
      expect(got).toBe(want);
    });
  }

  it("the shipped migration 0001 has not changed", () => {
    // Not pre-registered, but never edited after it ships: add 0002_*.sql instead.
    const got = createHash("sha256").update(fs.readFileSync(path.join(root, "migrations/0001_init.sql"))).digest("hex");
    expect(got).toBe(MIGRATION_0001_SHA256);
  });
});

export const MIGRATION_0001_SHA256 = "5336890c99863abf897514ed01a70019366e6e4cef781c232c2f51df53d66f5e";
