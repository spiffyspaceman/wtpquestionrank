// How a published footnote is shown (src/worker/notes.ts; owner decisions, 25 Nov 2026).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shownNote, shownNotes, storedNotes } from "../../src/worker/notes";

const text = (parts: [string, string | null][]) => parts.map((p) => p[0]).join("");
const links = (parts: [string, string | null][]) => parts.filter((p) => p[1]).map((p) => p[1]);
const U = "https://avalon.law.yale.edu/18th_century/fed09.asp";

describe("footnotes as shown", () => {
  it("leaves out the access date and nothing else", () => {
    const src = `Alexander Hamilton, The Federalist Papers: No. 9, The Avalon Project, Yale Law School, accessed August 19, 2019, ${U}.`;
    const p = shownNote(src, { [U]: { status: "ok" } });
    expect(text(p)).toBe(`Alexander Hamilton, The Federalist Papers: No. 9, The Avalon Project, Yale Law School, ${U}.`);
    expect(text(shownNote("A report (accessed January 27, 2017).", {}))).toBe("A report.");
    expect(text(shownNote("Founders Online, National Archives, last modified June 13, 2018, http://x.org/a.", {}))).toBe("Founders Online, National Archives, http://x.org/a.");
    // A date that is part of the citation stays.
    expect(text(shownNote("Independent Journal, January 23, 1788, No. 9.", {}))).toBe("Independent Journal, January 23, 1788, No. 9.");
  });

  it("links an address only when it was checked and opened; the full stop after it is not part of the link", () => {
    expect(links(shownNote(`See ${U}.`, { [U]: { status: "ok" } }))).toEqual([U]);
    expect(links(shownNote(`See ${U}.`, { [U]: { status: "unchecked" } }))).toEqual([]);
    expect(text(shownNote(`See ${U}.`, { [U]: { status: "unchecked" } }))).toBe(`See ${U}.`);
    expect(links(shownNote(`See ${U}.`, {}))).toEqual([]);
  });

  it("drops a dead address, or shows its checked replacement", () => {
    expect(text(shownNote(`Lee H. Hamilton, “Ways,” Dallas Morning News, March 19, 2014, ${U}.`, { [U]: { status: "dead" } }))).toBe(
      "Lee H. Hamilton, “Ways,” Dallas Morning News, March 19, 2014.",
    );
    const p = shownNote(`A speech, ${U}.`, { [U]: { status: "dead", replacement: "https://example.org/new" } });
    expect(text(p)).toBe("A speech, https://example.org/new.");
    expect(links(p)).toEqual(["https://example.org/new"]);
  });

  it("reads stored notes, and treats anything missing or broken as no notes", () => {
    expect(shownNotes(null)).toEqual({ marks: [], notes: [] });
    expect(shownNotes("{oops")).toEqual({ marks: [], notes: [] });
    const s = shownNotes(JSON.stringify({ marks: [[0, 5, "*"]], notes: [{ mark: "*", text: "Federalist 22:14." }] }));
    expect(s).toEqual({ marks: [[0, 5, "*"]], notes: [{ mark: "*", parts: [["Federalist 22:14.", null]] }] });
  });

  it("refuses malformed notes in an item file", () => {
    const ok = storedNotes([[0, 5, "*"]], [{ mark: "*", text: "A note." }], [10, 8, 8]);
    expect(JSON.parse(ok!)).toEqual({ marks: [[0, 5, "*"]], notes: [{ mark: "*", text: "A note." }] });
    expect(storedNotes([[0, 50, "*"]], [{ mark: "*", text: "A note." }], [10, 8, 8])).toBeNull(); // past the end
    expect(storedNotes([[0, 5, "**"]], [{ mark: "*", text: "A note." }], [10, 8, 8])).toBeNull(); // no such footnote
    expect(storedNotes([], [{ mark: "<b>", text: "A note." }], [10, 8, 8])).toBeNull();
    expect(storedNotes([], [{ mark: "*", text: "" }], [10, 8, 8])).toBeNull();
    expect(storedNotes(undefined, undefined, [10])).toBe(JSON.stringify({ marks: [], notes: [] }));
  });

  it("no footnote in the full set shows an access date, and every link shown was checked", () => {
    const root = path.join(import.meta.dirname, "../..");
    const items = JSON.parse(fs.readFileSync(path.join(root, "items/rounds/all.json"), "utf8")).items as { id: string; notes: { text: string }[] }[];
    const status = JSON.parse(fs.readFileSync(path.join(root, "items/links.json"), "utf8")) as Record<string, { status: string }>;
    let linked = 0;
    for (const it of items)
      for (const n of it.notes) {
        const p = shownNote(n.text);
        expect(/accessed|last modified/i.test(text(p)), `${it.id}: ${text(p)}`).toBe(false);
        for (const href of links(p)) {
          expect(status[href!]?.status, href!).toBe("ok");
          linked++;
        }
      }
    expect(linked).toBeGreaterThan(0);
  });
});
