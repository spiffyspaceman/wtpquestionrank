// A staged round: its questions come into play in groups (owner decision, 25 Nov 2026; migration 0008).
// The pairing code (src/rating/pairs.ts, frozen) is unchanged: it is simply handed the questions in play.
//   * First group: the 36 pre-registered launch questions, when the round's set holds them (they carry the LLM
//     rankings of methods A and A2, and their texts were checked twice). Otherwise the first FIRST by the rule below.
//   * Later groups: STEP questions at a time, in a fixed shuffled order that keeps the questions in play even across
//     the six units and across State and National Finals (owner decision: "balanced shuffle").
//   * A group joins when every question in play has SETTLED_ADULT_GAMES first-presentation comparisons from adults
//     (the pool the main leaderboard shows; a question is ranked at 10), if the round grows by itself.
import launchFile from "../../items/launch_items_v1.json";

export const STAGE = { FIRST: 36, STEP: 24, SETTLED_ADULT_GAMES: 12 } as const;

const LAUNCH_IDS: ReadonlySet<string> = new Set((launchFile as { items: { id: string }[] }).items.map((i) => i.id));

export interface StageItem {
  id: string;
  level: string;
  unit: number;
}

/** FNV-1a of a salted id: a fixed order with no relation to the id's own sort order (which encodes cycle and unit). */
function playKey(id: string): number {
  let h = 0x811c9dc5;
  for (const ch of "wtpqr-play:" + id) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

const stratum = (i: StageItem) => `${i.level}|${i.unit}`;

/**
 * The next `n` questions to join, given every question of the set and the ids already in play. Each pick goes to the
 * level-and-unit group with the fewest questions in play so far; within a group, in the fixed shuffled order. The
 * result depends only on the set and on what is in play, so two requests at once choose the same questions.
 */
export function nextGroup(all: readonly StageItem[], inPlay: ReadonlySet<string>, n: number): string[] {
  const count = new Map<string, number>();
  const waiting = new Map<string, StageItem[]>();
  for (const i of all) {
    const s = stratum(i);
    if (inPlay.has(i.id)) count.set(s, (count.get(s) ?? 0) + 1);
    else waiting.set(s, [...(waiting.get(s) ?? []), i]);
  }
  for (const list of waiting.values()) list.sort((a, b) => playKey(a.id) - playKey(b.id) || (a.id < b.id ? -1 : 1));
  const out: string[] = [];
  while (out.length < n) {
    let best: string | null = null;
    for (const [s, list] of waiting) {
      if (!list.length) continue;
      if (best === null) best = s;
      else {
        const d = (count.get(s) ?? 0) - (count.get(best) ?? 0);
        if (d < 0 || (d === 0 && playKey(list[0].id) < playKey(waiting.get(best)![0].id))) best = s;
      }
    }
    if (best === null) break;
    out.push(waiting.get(best)!.shift()!.id);
    count.set(best, (count.get(best) ?? 0) + 1);
  }
  return out;
}

/** The questions in play when a staged round opens. */
export function firstGroup(all: readonly StageItem[]): string[] {
  const launch = all.filter((i) => LAUNCH_IDS.has(i.id)).map((i) => i.id);
  // The launch questions go first only when the set holds every one of them.
  const first = launch.length === LAUNCH_IDS.size ? launch : [];
  return [...first, ...nextGroup(all, new Set(first), Math.max(0, STAGE.FIRST - first.length))];
}
