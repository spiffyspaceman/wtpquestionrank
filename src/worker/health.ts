// Study health for the admin page: the pre-registered data gate, votes per day, reasons given, and rater quality
// flags. Report only: nothing here changes what voters see or what the analysis counts. PREREG §9 lets the owner watch
// data-quality numbers during the round but no §7 measure, so nothing here compares votes with each other or with the
// LLM (no repeat agreement, no split-half, no correlation).
import { POOLED_ROLES, QUALITY } from "../rating/config";
import { playItems } from "./data";
import type { RoundRow } from "./env";
import { GATE } from "./gate";


function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ADULT_SQL = POOLED_ROLES.map((r) => `'${r}'`).join(",");

export async function studyHealth(db: D1Database, round: RoundRow) {
  // First-presentation votes of live (not revoked) voters: what the primary analysis counts.
  const first = await db
    .prepare(
      `SELECT v.voter_id, u.label, v.role, v.server_ms, v.client_ms, v.close_call, (v.winner_q = v.left_q) AS left_win
         FROM votes_effective v JOIN voters u ON u.id = v.voter_id
        WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL`,
    )
    .bind(round.id)
    .all<{ voter_id: string; label: string; role: string; server_ms: number | null; client_ms: number | null; close_call: number; left_win: number }>();

  const skips = await db
    .prepare("SELECT voter_id, count(*) AS n FROM skips WHERE round_id = ? GROUP BY voter_id")
    .bind(round.id)
    .all<{ voter_id: string; n: number }>();

  // Adult comparisons per item, from the adults cache (first presentations, revoked voters excluded).
  // In a staged round the gate and the forecast count the questions in play.
  const items = await playItems(db, round);
  const games = new Map(items.map((id) => [id, 0]));
  const pc = await db
    .prepare("SELECT left_q, right_q, n FROM pair_counts WHERE round_id = ? AND pool = 'adults'")
    .bind(round.id)
    .all<{ left_q: string; right_q: string; n: number }>();
  for (const r of pc.results) {
    games.set(r.left_q, (games.get(r.left_q) ?? 0) + r.n);
    games.set(r.right_q, (games.get(r.right_q) ?? 0) + r.n);
  }
  const perItem = [...games.values()];
  // Items still short of the gate, fewest comparisons first. Each adult vote adds one comparison to two items, so the
  // votes still needed are at least half the total shortfall, and at least the largest single shortfall.
  const short = [...games.entries()]
    .filter(([, n]) => n < GATE.MIN_ADULT_GAMES_PER_ITEM)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const shortfall = short.reduce((s, [, n]) => s + (GATE.MIN_ADULT_GAMES_PER_ITEM - n), 0);
  const votesNeeded = short.length ? Math.max(Math.ceil(shortfall / 2), GATE.MIN_ADULT_GAMES_PER_ITEM - short[0][1]) : 0;

  const byVoter = new Map<string, { label: string; role: string; ms: number[]; left: number; n: number; close: number }>();
  for (const v of first.results) {
    const g = byVoter.get(v.voter_id) ?? { label: v.label, role: v.role, ms: [], left: 0, n: 0, close: 0 };
    g.n++;
    g.left += v.left_win ? 1 : 0;
    g.close += v.close_call ? 1 : 0;
    const ms = v.server_ms ?? v.client_ms;
    if (typeof ms === "number") g.ms.push(ms);
    byVoter.set(v.voter_id, g);
  }
  const sk = new Map(skips.results.map((r) => [r.voter_id, r.n]));
  const adult = new Set<string>(POOLED_ROLES);

  const raters = [...byVoter.entries()]
    .map(([id, g]) => {
      const med = median(g.ms);
      const leftShare = g.left / g.n;
      const enough = g.n >= QUALITY.MIN_VOTES_FOR_FLAGS;
      const flags: string[] = [];
      if (enough && med !== null && med < QUALITY.TOO_FAST_MEDIAN_MS) flags.push("too_fast");
      if (enough && Math.max(leftShare, 1 - leftShare) >= QUALITY.SIDE_SHARE_FLAG) flags.push("one_side");
      return {
        label: g.label,
        role: g.role,
        votes: g.n,
        medianMs: med,
        leftShare,
        closeCallShare: g.close / g.n,
        skips: sk.get(id) ?? 0,
        flags,
      };
    })
    .sort((a, b) => b.votes - a.votes || (a.label < b.label ? -1 : 1));

  const countedAdultRaters = raters.filter((r) => adult.has(r.role) && r.votes >= GATE.MIN_VOTES_PER_COUNTED_RATER).length;
  const minAdultGamesPerItem = perItem.length ? Math.min(...perItem) : 0;

  const perDay = await db
    .prepare(
      `SELECT substr(v.created_at, 1, 10) AS day, count(*) AS votes, count(DISTINCT v.voter_id) AS voters,
              sum(v.role IN (${ADULT_SQL})) AS adult_votes
         FROM votes v JOIN voters u ON u.id = v.voter_id
        WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL
        GROUP BY day ORDER BY day`,
    )
    .bind(round.id)
    .all<{ day: string; votes: number; voters: number; adult_votes: number }>();

  const ALL_REASONS = "vote_reasons_effective";
  const LIVE_FIRST = `JOIN votes v ON v.id = x.vote_id JOIN voters u ON u.id = v.voter_id
        WHERE v.round_id = ? AND v.is_repeat = 0 AND u.revoked_at IS NULL`;
  const reasons = await db
    .prepare(`SELECT x.reason, count(*) AS n FROM ${ALL_REASONS} x ${LIVE_FIRST} GROUP BY x.reason ORDER BY n DESC, x.reason`)
    .bind(round.id)
    .all<{ reason: string; n: number }>();
  const withReason = await db
    .prepare(`SELECT count(DISTINCT x.vote_id) AS n FROM ${ALL_REASONS} x ${LIVE_FIRST}`)
    .bind(round.id)
    .first<{ n: number }>();
  // The newest "Other" explanations, for the owner only.
  const notes = await db
    .prepare(
      `SELECT v.created_at, u.label, u.role, x.note FROM vote_reasons_effective x ${LIVE_FIRST}
          AND x.reason = 'other' AND x.note <> '' ORDER BY v.id DESC LIMIT 50`,
    )
    .bind(round.id)
    .all<{ created_at: string; label: string; role: string; note: string }>();

  const corrected = await db
    .prepare(
      `SELECT count(*) AS votes, (SELECT count(*) FROM vote_corrections c JOIN votes w ON w.id = c.vote_id WHERE w.round_id = ?1) AS rows
         FROM votes_effective v WHERE v.round_id = ?1 AND v.correction_id IS NOT NULL AND v.winner_q <> v.original_winner_q`,
    )
    .bind(round.id)
    .first<{ votes: number; rows: number }>();

  // Pace: adult first votes per day over the last seven days that had any, today included.
  const recent = perDay.results.slice(-7);
  const adultPerDay = recent.length ? recent.reduce((s, d) => s + d.adult_votes, 0) / recent.length : 0;
  const ratersShort = Math.max(0, GATE.MIN_ADULT_RATERS - countedAdultRaters);
  const adultsUnder = raters.filter((r) => adult.has(r.role) && r.votes < GATE.MIN_VOTES_PER_COUNTED_RATER);

  return {
    forecast: {
      // Counts only (PREREG §9 allows watching data-quality numbers): how far the gate is, and how fast votes come.
      itemsShort: short.slice(0, 12).map(([id, n]) => ({ id, games: n })),
      adultVotesNeeded: votesNeeded,
      adultVotesPerDay: Math.round(adultPerDay * 10) / 10,
      daysAtThisPace: votesNeeded === 0 ? 0 : adultPerDay > 0 ? Math.ceil(votesNeeded / adultPerDay) : null,
      ratersShort,
      adultsUnderThreshold: adultsUnder.length,
      adultVotesToThreshold: adultsUnder.reduce((s, r) => s + (GATE.MIN_VOTES_PER_COUNTED_RATER - r.votes), 0),
    },
    round: { id: round.id, name: round.name, state: round.state, itemSetId: round.item_set_id, staged: round.staged === 1 },
    corrections: { rows: corrected?.rows ?? 0, winnerChanged: corrected?.votes ?? 0 },
    gate: {
      ...GATE,
      countedAdultRaters,
      minAdultGamesPerItem,
      itemsBelow: perItem.filter((n) => n < GATE.MIN_ADULT_GAMES_PER_ITEM).length,
      items: perItem.length,
      adultVotes: first.results.filter((v) => adult.has(v.role)).length,
      passed: countedAdultRaters >= GATE.MIN_ADULT_RATERS && minAdultGamesPerItem >= GATE.MIN_ADULT_GAMES_PER_ITEM,
    },
    flagRules: {
      minVotes: QUALITY.MIN_VOTES_FOR_FLAGS,
      tooFastMedianMs: QUALITY.TOO_FAST_MEDIAN_MS,
      sideShare: QUALITY.SIDE_SHARE_FLAG,
    },
    perDay: perDay.results,
    reasons: { votesWithReason: withReason?.n ?? 0, votes: first.results.length, counts: reasons.results, notes: notes.results },
    raters,
  };
}
