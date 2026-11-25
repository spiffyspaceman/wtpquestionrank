// A question's published footnotes, made ready to show (owner decisions, 25 Nov 2026):
//   * as CCE printed them, with the "accessed <date>" phrase left out, since the date gives away the question's year;
//   * a web address is a link only if it was checked and the page opened (items/links.json, built by
//     items/check_links.py); a dead address is replaced by a checked replacement or dropped; an address that could not
//     be checked is plain text, unless the owner chose to link it anyway ("link": true in items/links.json).
import linksFile from "../../items/links.json";

interface LinkRecord {
  status: "ok" | "dead" | "unchecked";
  replacement?: string;
  /** An unchecked address the owner chose to link anyway (a site that refuses automated readers). */
  link?: boolean;
}
const LINKS = linksFile as unknown as Record<string, LinkRecord>;

export interface StoredNotes {
  marks: [number, number, string][];
  notes: { mark: string; text: string }[];
}
/** A footnote as sent to the pages: text pieces, each with a link target or null. */
export interface ShownNote {
  mark: string;
  parts: [string, string | null][];
}
export interface ShownNotes {
  marks: [number, number, string][];
  notes: ShownNote[];
}

const ACCESSED = /,?\s*\(?\b(?:accessed|last modified)\s+[A-Z][a-z]+\.? \d{1,2}, \d{4}\)?/g;
const URL_RE = /https?:\/\/\S+/g;
/**
 * A note that is not a source: CCE's line naming the sponsor of a National Finals "special question" and its award.
 * It is not shown, nor its marker, because it gives away the question's level (owner decision, 25 Nov 2026).
 */
const NOT_A_SOURCE = /^This question is sponsored by\b/i;

/** The address without the punctuation that ends the sentence it sits in. */
function splitUrl(raw: string): [string, string] {
  const m = /[.,;)”]+$/.exec(raw);
  return m ? [raw.slice(0, m.index), m[0]] : [raw, ""];
}

export function shownNote(text: string, links: Record<string, LinkRecord> = LINKS): [string, string | null][] {
  // Taking the access date out can leave the comma that followed it standing after a closing quote (“Title,”, https…).
  const t = text.replace(ACCESSED, "").replace(/([,.]”),(?=\s)/g, "$1");
  const parts: [string, string | null][] = [];
  let last = 0;
  const push = (s: string, href: string | null = null) => {
    if (!s) return;
    const prev = parts[parts.length - 1];
    if (prev && prev[1] === null && href === null) prev[0] += s;
    else parts.push([s, href]);
  };
  for (const m of t.matchAll(URL_RE)) {
    const [url, tail] = splitUrl(m[0]);
    const rec = links[url];
    push(t.slice(last, m.index));
    if (rec?.status === "ok" || (rec?.status === "unchecked" && rec.link === true)) push(url, url);
    else if (rec?.status === "dead" && rec.replacement) push(rec.replacement, rec.replacement);
    else if (rec?.status === "dead") {
      // Dropped: also the comma and space that led up to it.
      const prev = parts[parts.length - 1];
      if (prev && prev[1] === null) prev[0] = prev[0].replace(/[,;:]?\s*$/, "");
    } else push(url);
    push(tail);
    last = m.index + m[0].length;
  }
  push(t.slice(last));
  // A footnote that ended with a dropped address still ends with a full stop.
  const end = parts[parts.length - 1];
  if (end && end[1] === null && !/[.?!”)]$/.test(end[0].trimEnd())) end[0] = end[0].trimEnd() + ".";
  // A title left at the very end by a dropped address closes with its full stop inside the quote, not “Title,”.
  if (end && end[1] === null) end[0] = end[0].replace(/,”\.?$/, ".”");
  return parts;
}

/** Parse a stored notes_json; anything malformed or missing reads as no notes. */
export function shownNotes(json: string | null | undefined): ShownNotes {
  if (!json) return { marks: [], notes: [] };
  try {
    const v = JSON.parse(json) as StoredNotes;
    const notes = (v.notes ?? []).filter((n) => !NOT_A_SOURCE.test(n.text.trim()));
    const shown = new Set(notes.map((n) => n.mark));
    return {
      marks: (v.marks ?? []).filter((m) => Array.isArray(m) && m.length === 3 && shown.has(m[2])),
      notes: notes.map((n) => ({ mark: n.mark, parts: shownNote(n.text) })),
    };
  } catch {
    return { marks: [], notes: [] };
  }
}

/** Check the notes of an item file entry. Returns the JSON to store, or null when the shape is wrong. */
export function storedNotes(marks: unknown, notes: unknown, partLengths: number[]): string | null {
  const m = marks === undefined ? [] : marks;
  const n = notes === undefined ? [] : notes;
  if (!Array.isArray(m) || !Array.isArray(n) || n.length > 6 || m.length > 8) return null;
  for (const x of n as { mark?: unknown; text?: unknown }[])
    if (typeof x?.mark !== "string" || !/^(\*{1,3}|†|‡)$/.test(x.mark) || typeof x.text !== "string" || !x.text.trim() || x.text.length > 1200) return null;
  const have = new Set((n as { mark: string }[]).map((x) => x.mark));
  for (const x of m as unknown[]) {
    if (!Array.isArray(x) || x.length !== 3) return null;
    const [part, off, mark] = x as [unknown, unknown, unknown];
    if (!Number.isInteger(part) || !Number.isInteger(off) || typeof mark !== "string" || !have.has(mark)) return null;
    if ((part as number) < 0 || (part as number) >= partLengths.length || (off as number) < 1 || (off as number) > partLengths[part as number]) return null;
  }
  return JSON.stringify({ marks: m, notes: (n as { mark: string; text: string }[]).map((x) => ({ mark: x.mark, text: x.text })) });
}
