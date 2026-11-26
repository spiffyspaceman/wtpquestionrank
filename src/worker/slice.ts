// What a judge chooses to judge (owner decision, 26 Nov 2026; migration 0010): all questions, or only some units, at
// State, Nationals or both. No Workers types here, so the pages can import it too.

export const SLICE_UNITS = [1, 2, 3, 4, 5, 6] as const;
export const SLICE_LEVELS = ["State", "NF"] as const;
export type SliceLevel = (typeof SLICE_LEVELS)[number];
export const LEVEL_NAMES: Record<SliceLevel, string> = { State: "State", NF: "Nationals" };

export interface Slice {
  units: number[];
  levels: SliceLevel[];
}

/**
 * How a staged round serves a slice: it keeps at least MIN_IN_PLAY of the slice's questions in play, and when the
 * judge has fewer than MIN_FRESH new pairs left among them, the next STEP questions of the slice join the round.
 */
export const SLICE_PLAY = { MIN_IN_PLAY: 12, MIN_FRESH: 10, STEP: 6 } as const;

/** A whole choice: every unit and both levels is the same as no choice. */
function normal(units: number[], levels: SliceLevel[]): Slice | null {
  const u = [...new Set(units)].sort((a, b) => a - b);
  const l = SLICE_LEVELS.filter((x) => levels.includes(x));
  return u.length === SLICE_UNITS.length && l.length === SLICE_LEVELS.length ? null : { units: u, levels: l };
}

/** A choice sent by a page: null for all questions, false when it is malformed or empty. */
export function parseSlice(v: unknown): Slice | null | false {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.all === true) return null;
  const { units, levels } = o;
  if (!Array.isArray(units) || !Array.isArray(levels) || units.length > 12 || levels.length > 4) return false;
  if (!units.every((x) => typeof x === "number" && (SLICE_UNITS as readonly number[]).includes(x))) return false;
  if (!levels.every((x) => typeof x === "string" && (SLICE_LEVELS as readonly string[]).includes(x))) return false;
  if (!units.length || !levels.length) return false;
  return normal(units as number[], levels as SliceLevel[]);
}

/** A stored choice; anything unreadable counts as all questions. */
export function storedSlice(json: string | null | undefined): Slice | null {
  if (!json) return null;
  try {
    const v = parseSlice(JSON.parse(json));
    return v === false ? null : v;
  } catch {
    return null;
  }
}

export const sliceJson = (s: Slice | null): string | null => (s ? JSON.stringify({ units: s.units, levels: s.levels }) : null);

/** True when a question of this unit and level is in the slice (every question is in "all questions"). */
export function inSlice(s: Slice | null, q: { unit: number; level: string }): boolean {
  return !s || (s.units.includes(q.unit) && (s.levels as string[]).includes(q.level));
}

/** "Units 4 and 5, Nationals only"; "All questions" for none. */
export function sliceLabel(s: Slice | null): string {
  if (!s) return "All questions";
  const u = s.units;
  const units =
    u.length === SLICE_UNITS.length
      ? "All units"
      : u.length === 1
        ? `Unit ${u[0]}`
        : `Units ${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
  const levels = s.levels.length === SLICE_LEVELS.length ? "State and Nationals" : `${LEVEL_NAMES[s.levels[0]]} only`;
  return `${units}, ${levels}`;
}
