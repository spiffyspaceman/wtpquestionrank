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
    type Item = { stem: string; bullets: string[]; marks: [number, number, string][]; notes: { mark: string; text: string }[] };
    const all = new Map<string, Item>(read("items/transcribed.json").map((i: { id: string }) => [i.id, i]));
    const fixes = read("items/corrections.json") as { id: string; find?: string; replace?: string; note?: string; stem_marks?: { mark: string; after: string }[] }[];
    expect(fixes.length).toBeGreaterThan(0);
    for (const f of fixes) {
      const it = all.get(f.id)!;
      if (f.stem_marks) {
        // The marker stands right after the words named.
        for (const m of f.stem_marks) {
          const at = it.stem.indexOf(m.after) + m.after.length;
          expect(it.marks.some((x) => x[0] === 0 && x[1] === at && x[2] === m.mark), `${f.id}: ${m.after}`).toBe(true);
        }
        continue;
      }
      const text = f.note ? it.notes.filter((n) => n.mark === f.note).map((n) => n.text).join(" || ") : [it.stem, ...it.bullets].join(" || ");
      expect(text.includes(f.replace!), `${f.id}: ${f.replace}`).toBe(true);
      expect(text.includes(f.find!), `${f.id}: ${f.find}`).toBe(false);
    }
  });

  it("every footnote marker sits inside its text, after a word or a closing mark, and points to a footnote", () => {
    type Item = { id: string; stem: string; bullets: string[]; marks: [number, number, string][]; notes: { mark: string; text: string }[] };
    const all = read("items/transcribed.json") as Item[];
    let notes = 0;
    for (const it of all) {
      const parts = [it.stem, ...it.bullets];
      const have = new Set(it.notes.map((n) => n.mark));
      notes += it.notes.length;
      for (const [p, at, mark] of it.marks) {
        expect(at > 0 && at <= parts[p].length, it.id).toBe(true);
        expect(/[”’"\w.,?!)]$/.test(parts[p].slice(0, at)), `${it.id}: ${parts[p].slice(at - 12, at)}`).toBe(true);
        expect(have.has(mark), it.id).toBe(true);
      }
      for (const n of it.notes) expect(n.text.length > 8 && !/\s{2,}|^\s|\s$/.test(n.text), `${it.id}: ${n.text.slice(0, 40)}`).toBe(true);
      // The stem and bullets themselves carry no marker: they are hashed and shown to voters as plain text.
      expect(/[*†‡]/.test(parts.join(" ")), it.id).toBe(false);
    }
    expect(notes).toBeGreaterThan(300);
  });

  it("the full set is exactly the transcribed questions", () => {
    const all = read("items/transcribed.json") as { id: string }[];
    const ids = (read("items/rounds/all.json").items as { id: string }[]).map((i) => i.id);
    expect(ids.sort()).toEqual(all.map((i) => i.id).sort());
  });
});
