// The transcriber (items/transcribe.py) must reproduce the 36 launch texts, which were fixed before it existed.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../..");
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

describe("transcribed items", () => {
  it("hold every launch question with the same stem and bullets, character for character", () => {
    const all = new Map<string, { stem: string; bullets: string[] }>(read("items/transcribed.json").map((i: { id: string }) => [i.id, i]));
    const launch = read("items/launch_items_v1.json").items as { id: string; stem: string; bullets: string[] }[];
    expect(launch).toHaveLength(36);
    for (const it of launch) {
      expect(all.get(it.id)?.stem, it.id).toBe(it.stem);
      expect(all.get(it.id)?.bullets, it.id).toEqual(it.bullets);
    }
  });

  it("every by-eye correction is in the text, and none of the text it replaced remains", () => {
    const all = new Map<string, { stem: string; bullets: string[] }>(read("items/transcribed.json").map((i: { id: string }) => [i.id, i]));
    const fixes = read("items/corrections.json") as { id: string; find: string; replace: string }[];
    expect(fixes.length).toBeGreaterThan(0);
    for (const f of fixes) {
      const text = [all.get(f.id)!.stem, ...all.get(f.id)!.bullets].join(" || ");
      expect(text.includes(f.replace), `${f.id}: ${f.replace}`).toBe(true);
      expect(text.includes(f.find), `${f.id}: ${f.find}`).toBe(false);
    }
  });

  it("the full set is exactly the transcribed questions", () => {
    const all = read("items/transcribed.json") as { id: string }[];
    const ids = (read("items/rounds/all.json").items as { id: string }[]).map((i) => i.id);
    expect(ids.sort()).toEqual(all.map((i) => i.id).sort());
  });
});
