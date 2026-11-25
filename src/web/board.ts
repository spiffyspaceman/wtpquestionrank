// Leaderboard: the top question, the top 10, adjustable charts, and a searchable, sortable list of every question.
// Everything after the one fetch runs in this browser; nothing the viewer does is sent back.
import { RATING } from "../rating/config";
import { OTHER_LABEL, REASONS } from "../worker/reasons";
import { $, api, ApiError, el, fmtDate, footnotes, marked, say, show, type Marks, type ShownNote } from "./common";

interface Row {
  rank: number | null;
  /** Null until the question is ranked: a rating from a handful of comparisons is mostly chance, so it is not sent. */
  rating: number | null;
  lo: number | null;
  hi: number | null;
  games: number;
  wins: number | null;
  reasons: { code: string; n: number }[];
  stem: string;
  bullets: string[];
  marks?: Marks;
  notes?: ShownNote[];
  about: { level: string; cycle: string; unit: number; question: number; sources: { label: string; url: string }[] };
}
interface Board {
  pool: string;
  pools: { id: string; name: string }[];
  round: { id: string; name: string; state: string };
  /** A round that opens its questions in groups: how many are in play (the rows) out of how many in all. */
  staged: { inPlay: number; total: number } | null;
  /** Boards the viewer may see that still wait for enough voters behind them. */
  waiting: { name: string; need: number }[];
  /** Every round with a board, when there is more than one. */
  rounds: { id: string; name: string }[];
  votes: number;
  intervalsAsOf: string | null;
  rows: Row[];
  /** Head-to-head counts by group, per grouping: how often a question of group a beat one of group b. */
  h2h: Record<string, { a: string; b: string; aw: number; n: number }[]>;
}

const msg = $("#msg");
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const REASON_LABEL = new Map<string, string>([...REASONS.map((r) => [r.code, r.label] as [string, string]), ["other", OTHER_LABEL]]);

/** "2024-25 U4Q1"; other levels add theirs: "2024-25 NF U4Q1". */
function tag(r: Row): string {
  return `${r.about.cycle}${r.about.level === "State" ? "" : " " + r.about.level} U${r.about.unit}Q${r.about.question}`;
}

let rows: Row[] = [];
let board: Board | null = null;

// ---------- per-viewer settings (a convenience only; the page works without storage) ----------

const KEY = "wtpqr-board-v1";
const settings: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
})();
function save(k: string, v: string): void {
  settings[k] = v;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

// ---------- question text and details ----------

function sourcesLine(r: Row): HTMLElement | null {
  if (!r.about.sources.length) return null;
  return el(
    "p",
    { class: "meta" },
    "Quoted: ",
    ...r.about.sources.flatMap((s, i) => [i ? "; " : "", el("a", { href: s.url, rel: "noopener noreferrer", target: "_blank" }, s.label)]),
  );
}

function reasonsLine(r: Row): HTMLElement | null {
  if (!r.reasons.length) return null;
  return el(
    "p",
    { class: "meta" },
    "Why voters picked it: ",
    r.reasons.map((x) => `${REASON_LABEL.get(x.code) ?? x.code} (${x.n})`).join("; "),
  );
}

const RANK_AT = RATING.MIN_GAMES_RANKED;
/** A ranked question's rating; charts and averages only ever see ranked questions. */
const rating = (r: Row) => r.rating ?? RATING.ELO_BASE;

function statLine(r: Row): string {
  if (r.rank === null) return `${r.games} of ${RANK_AT} comparisons; ranked at ${RANK_AT}`;
  const parts = [count(r.games, "comparison", "comparisons")];
  if (r.games && r.wins !== null) parts.push(`won ${pct(r.wins / r.games)}`);
  if (r.lo !== null && r.hi !== null) parts.push(`range ${r.lo} to ${r.hi}`);
  return parts.join(", ");
}

function detail(r: Row): HTMLElement {
  return el(
    "div",
    { class: "detail" },
    el("ul", {}, ...r.bullets.map((b, k) => el("li", {}, ...marked(b, k + 1, r.marks)))),
    footnotes(r.notes),
    // The separately confirmed sources are shown only where the question carries no footnote of its own.
    r.notes?.length ? null : sourcesLine(r),
    reasonsLine(r),
  );
}

function renderTop(): void {
  const ranked = rows.filter((r) => r.rank !== null);
  const t = ranked[0];
  show($("#topSection"), Boolean(t));
  if (t) {
    $("#top").replaceChildren(
      el(
        "article",
        { class: "hero-card" },
        // The rank leads; the rating is the small figure under it (owner decision, 25 Nov 2026).
        el("div", { class: "score big" }, el("strong", {}, `#${t.rank}`), el("span", { class: "rating" }, `rating ${rating(t)}`), el("span", {}, statLine(t))),
        el("div", { class: "body" }, el("p", { class: "tag" }, tag(t)), el("p", { class: "stem" }, ...marked(t.stem, 0, t.marks)), detail(t)),
      ),
    );
  }
  // #1 is the card above; the list carries on from #2 to #10.
  $("#top10").replaceChildren(
    ...ranked.slice(1, 10).map((r) =>
      el(
        "li",
        {},
        el(
          "div",
          { class: "score" },
          el("strong", {}, `#${r.rank}`),
          el("span", { class: "rating" }, `rating ${rating(r)}`),
          r.games && r.wins !== null ? el("span", { class: "won" }, `won ${pct(r.wins / r.games)}`) : null,
        ),
        el(
          "div",
          { class: "body" },
          el("p", { class: "tag" }, tag(r)),
          el(
            "details",
            {},
            el("summary", {}, el("span", { class: "stem" }, r.stem), el("span", { class: "more" }, "More")),
            detail(r),
            el("p", { class: "meta" }, statLine(r)),
          ),
        ),
      ),
    ),
  );
  // Nothing ranked yet: say how far along the questions are, and leave the charts out until there is something to chart.
  const furthest = rows.reduce((m, r) => Math.max(m, r.games), 0);
  $("#noneRanked").textContent = `No question is ranked yet. A question is ranked after ${RANK_AT} comparisons; the furthest along has ${furthest}.`;
  show($("#noneRanked"), ranked.length === 0);
  show($("#top10H"), ranked.length !== 1);
  show($("#explore"), ranked.length > 0);
}

// ---------- variables and groupings for the charts ----------

interface Variable {
  label: string;
  get: (r: Row) => number | null;
  fmt?: (v: number) => string;
  discrete?: boolean;
}
const yearOf = (r: Row) => Number(r.about.cycle.slice(0, 4)) + 1;
const cycleOf = (y: number) => `${y - 1}-${String(y).slice(2)}`;
const VARS: Record<string, Variable> = {
  rating: { label: "Rating", get: (r) => r.rating },
  games: { label: "Comparisons", get: (r) => r.games },
  winShare: { label: "Win share", get: (r) => (r.games && r.wins !== null ? r.wins / r.games : null), fmt: pct },
  width: { label: "Interval width", get: (r) => (r.lo !== null && r.hi !== null ? r.hi - r.lo : null) },
  year: { label: "Year", get: yearOf, fmt: cycleOf, discrete: true },
  unit: { label: "Unit", get: (r) => r.about.unit, discrete: true },
  qnum: { label: "Question number", get: (r) => r.about.question, discrete: true },
  stemWords: { label: "Words in stem", get: (r) => words(r.stem) },
  allWords: { label: "Words in stem and bullets", get: (r) => words(r.stem) + r.bullets.reduce((s, b) => s + words(b), 0) },
  quote: { label: "Quote in stem (1 = yes)", get: (r) => (/[“"]/.test(r.stem) ? 1 : 0), discrete: true },
  reasons: { label: "Reasons given when it won", get: (r) => r.reasons.reduce((s, x) => s + x.n, 0) },
};

interface Grouping {
  label: string;
  key: (r: Row) => string;
  order: (r: Row) => number | string;
}
const GROUPS: Record<string, Grouping> = {
  unit: { label: "Unit", key: (r) => `Unit ${r.about.unit}`, order: (r) => r.about.unit },
  year: { label: "Year", key: (r) => r.about.cycle, order: (r) => r.about.cycle },
  qnum: { label: "Question number", key: (r) => `Question ${r.about.question}`, order: (r) => r.about.question },
  quote: { label: "Quote in stem", key: (r) => (/[“"]/.test(r.stem) ? "Quote in stem" : "No quote"), order: (r) => (/[“"]/.test(r.stem) ? 0 : 1) },
  reason: {
    label: "Most-given reason",
    key: (r) => (r.reasons[0] ? REASON_LABEL.get(r.reasons[0].code) ?? r.reasons[0].code : "No reasons yet"),
    order: (r) => (r.reasons[0] ? REASON_LABEL.get(r.reasons[0].code) ?? "" : "~"),
  },
};

function grouped(list: Row[], g: Grouping): { label: string; order: number | string; rows: Row[] }[] {
  const m = new Map<string, { label: string; order: number | string; rows: Row[] }>();
  for (const r of list) {
    const k = g.key(r);
    const e = m.get(k) ?? { label: k, order: g.order(r), rows: [] };
    e.rows.push(r);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

// ---------- SVG and controls ----------

const SVGNS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tagName: K, attrs: Record<string, string | number>, ...kids: (Node | string)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tagName);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (hi <= lo) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

function select(id: string, label: string, opts: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const s = el("select", { id }, ...opts.map(([v, t]) => el("option", { value: v }, t)));
  s.value = opts.some(([v]) => v === value) ? value : opts[0][0];
  s.addEventListener("change", () => onChange(s.value));
  return el("div", { class: "control" }, el("label", { for: id }, label), s);
}

function checkbox(id: string, label: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const c = el("input", { type: "checkbox", id });
  c.checked = on;
  c.addEventListener("change", () => onChange(c.checked));
  return el("label", { class: "check", for: id }, c, " " + label);
}

function setting(k: string, dflt: string): string {
  return settings[k] ?? dflt;
}
function rerender(k: string): (v: string | boolean) => void {
  return (v) => {
    save(k, String(v));
    renderChart();
  };
}

function chartTable(head: string[], body: (string | number)[][], numeric: number[] = []): void {
  $("#chartTable").replaceChildren(
    el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", numeric.includes(i) ? { class: "num" } : {}, h)))),
    el("tbody", {}, ...body.map((r) => el("tr", {}, ...r.map((c, i) => el("td", numeric.includes(i) ? { class: "num" } : {}, String(c)))))),
  );
  show($("#chartTableWrap"), body.length > 0);
}

function chartWidth(): number {
  return Math.max(300, Math.round($("#chart").clientWidth || 640));
}

/** Rows for the charts: ranked questions only. An unranked question has no rating to chart. */
function pool(): Row[] {
  return rows.filter((r) => r.rank !== null);
}

// ---------- chart 1: groups ----------

const MEASURES: Record<string, { label: string; of: (rs: Row[]) => number | null; pct?: boolean }> = {
  mean: { label: "Average rating", of: (rs) => (rs.length ? Math.round(rs.reduce((s, r) => s + rating(r), 0) / rs.length) : null) },
  median: {
    label: "Median rating",
    of: (rs) => {
      if (!rs.length) return null;
      const s = rs.map(rating).sort((a, b) => a - b);
      const m = s.length >> 1;
      return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    },
  },
  max: { label: "Best rating", of: (rs) => (rs.length ? Math.max(...rs.map(rating)) : null) },
  min: { label: "Lowest rating", of: (rs) => (rs.length ? Math.min(...rs.map(rating)) : null) },
  top10: { label: "Share in the top 10", of: (rs) => (rs.length ? rs.filter((r) => r.rank !== null && r.rank <= 10).length / rs.length : null), pct: true },
};

function renderGroups(): void {
  const by = setting("g.by", "unit"), measure = setting("g.measure", "mean"), sort = setting("g.sort", "value");
  $("#controls").replaceChildren(
    select("cBy", "Group by", Object.entries(GROUPS).map(([k, g]) => [k, g.label]), by, rerender("g.by")),
    select("cMeasure", "Measure", Object.entries(MEASURES).map(([k, m]) => [k, m.label]), measure, rerender("g.measure")),
    select("cSort", "Order", [["value", "Highest first"], ["natural", "In order"]], sort, rerender("g.sort")),
  );
  const M = MEASURES[measure] ?? MEASURES.mean;
  const gs = grouped(pool(), GROUPS[by] ?? GROUPS.unit).map((g) => ({
    ...g,
    value: M.of(g.rows),
    lo: g.rows.length ? Math.min(...g.rows.map(rating)) : null,
    hi: g.rows.length ? Math.max(...g.rows.map(rating)) : null,
  }));
  if (sort === "value") gs.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const chart = $("#chart");
  if (!gs.length) {
    chart.replaceChildren(el("p", { class: "muted" }, "No question is ranked yet."));
    chartTable([], []);
    return;
  }
  const W = chartWidth(), narrow = W < 560;
  const labelW = Math.min(narrow ? 120 : 220, Math.max(70, ...gs.map((g) => g.label.length * 7.2)));
  const rowH = 32, top = 24, left = labelW + 12, right = narrow ? 52 : 76;
  const isPct = Boolean(M.pct);
  const vals = gs.flatMap((g) => (isPct ? [g.value ?? 0] : [g.lo ?? 1000, g.hi ?? 1000, g.value ?? 1000]));
  const x0 = isPct ? 0 : Math.min(1000, ...vals) - 20, x1 = isPct ? Math.max(0.1, ...vals) : Math.max(1000, ...vals) + 20;
  const x = (v: number) => left + ((v - x0) / (x1 - x0 || 1)) * (W - left - right);
  const H = top + rowH * gs.length + 8;
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${M.label} by ${GROUPS[by]?.label ?? by}` });
  for (const t of niceTicks(x0, x1, narrow ? 4 : 7)) {
    plot.append(svg("line", { x1: x(t), x2: x(t), y1: 16, y2: H - 4, class: "grid" }));
    plot.append(svg("text", { x: x(t), y: 12, class: "tick", "text-anchor": "middle" }, isPct ? pct(t) : String(t)));
  }
  if (!isPct) plot.append(svg("line", { x1: x(1000), x2: x(1000), y1: 16, y2: H - 4, class: "ref" }));
  gs.forEach((g, i) => {
    const y = top + rowH * i + rowH / 2;
    const tip = `${g.label}: ${M.label.toLowerCase()} ${g.value === null ? "none" : isPct ? pct(g.value) : g.value}; ${count(g.rows.length, "question", "questions")}${isPct ? "" : `, ratings ${g.lo} to ${g.hi}`}`;
    const row = svg("g", { class: "grow", "data-tip": tip, tabindex: 0 });
    row.append(svg("rect", { x: 0, y: y - rowH / 2, width: W, height: rowH, class: "hit" }));
    row.append(svg("text", { x: left - 10, y: y + 5, class: "glabel", "text-anchor": "end" }, g.label));
    if (isPct) {
      row.append(svg("rect", { x: x(0), y: y - 7, width: Math.max(2, x(g.value ?? 0) - x(0)), height: 14, rx: 3, class: "bar" }));
    } else if (g.lo !== null && g.hi !== null && g.hi > g.lo) {
      row.append(svg("line", { x1: x(g.lo), x2: x(g.hi), y1: y, y2: y, class: "span" }));
    }
    if (g.value !== null && !isPct) row.append(svg("circle", { cx: x(g.value), cy: y, r: 6, class: "dot" }));
    row.append(svg("text", { x: W - right + 10, y: y + 5, class: "gvalue" }, g.value === null ? "" : isPct ? pct(g.value) : String(g.value)));
    plot.append(row);
  });
  chart.replaceChildren(plot);
  $("#chartNote").textContent = isPct ? "" : "Dot: the measure. Line: lowest to highest rating in the group. Dashed line: 1000, the average question.";
  chartTable(
    [GROUPS[by]?.label ?? "Group", M.label, "Lowest", "Highest", "Questions"],
    gs.map((g) => [g.label, g.value === null ? "" : isPct ? pct(g.value) : g.value, g.lo ?? "", g.hi ?? "", g.rows.length]),
    [1, 2, 3, 4],
  );
}

// ---------- chart 2: any two variables ----------

function renderScatter(): void {
  const xv = setting("s.x", "games"), yv = setting("s.y", "rating"), hl = setting("s.hl", "none"), hv = setting("s.hv", "");
  const varOpts = Object.entries(VARS).map(([k, v]) => [k, v.label] as [string, string]);
  const hlGroup = GROUPS[hl];
  const groupValues = hlGroup ? grouped(rows, hlGroup).map((g) => [g.label, g.label] as [string, string]) : [];
  const trend = setting("s.trend", "true") === "true";
  $("#controls").replaceChildren(
    select("cX", "Across (X)", varOpts, xv, rerender("s.x")),
    select("cY", "Up (Y)", varOpts, yv, rerender("s.y")),
    select("cHl", "Highlight", [["none", "Nothing"], ...Object.entries(GROUPS).map(([k, g]) => [k, g.label] as [string, string])], hl, (v) => {
      save("s.hv", "");
      rerender("s.hl")(v);
    }),
    ...(hlGroup ? [select("cHv", hlGroup.label, groupValues, hv, rerender("s.hv"))] : []),
    checkbox("cTrend", "Trend line", trend, (v) => rerender("s.trend")(v)),
  );
  const X = VARS[xv] ?? VARS.games, Y = VARS[yv] ?? VARS.rating;
  const chosen = hlGroup ? hv || groupValues[0]?.[0] || "" : "";
  const pts = pool()
    .map((r) => ({ r, x: X.get(r), y: Y.get(r), on: hlGroup ? hlGroup.key(r) === chosen : true }))
    .filter((p): p is { r: Row; x: number; y: number; on: boolean } => p.x !== null && p.y !== null);
  const chart = $("#chart");
  if (!pts.length) {
    chart.replaceChildren(el("p", { class: "muted" }, "Nothing to plot yet."));
    chartTable([], []);
    return;
  }
  const W = chartWidth(), H = Math.round(Math.min(460, Math.max(280, W * 0.6)));
  const m = { l: 56, r: 16, t: 14, b: 44 };
  const pad = (lo: number, hi: number) => (hi > lo ? [lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.06] : [lo - 1, hi + 1]);
  const [x0, x1] = pad(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)));
  const [y0, y1] = pad(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)));
  const sx = (v: number) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = (v: number) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  // Discrete variables put many questions on one spot: spread them a little, the same way each time.
  const jitter = (r: Row, k: number) => (((rows.indexOf(r) * 2654435761 + k * 97) >>> 0) % 1000) / 1000 - 0.5;
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${Y.label} against ${X.label}` });
  for (const t of niceTicks(x0, x1, W < 560 ? 4 : 7)) {
    plot.append(svg("line", { x1: sx(t), x2: sx(t), y1: m.t, y2: H - m.b, class: "grid" }));
    plot.append(svg("text", { x: sx(t), y: H - m.b + 16, class: "tick", "text-anchor": "middle" }, X.fmt ? X.fmt(t) : String(t)));
  }
  for (const t of niceTicks(y0, y1, 5)) {
    plot.append(svg("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), class: "grid" }));
    plot.append(svg("text", { x: m.l - 8, y: sy(t) + 4, class: "tick", "text-anchor": "end" }, Y.fmt ? Y.fmt(t) : String(t)));
  }
  plot.append(svg("text", { x: (m.l + W - m.r) / 2, y: H - 8, class: "axis", "text-anchor": "middle" }, X.label));
  plot.append(svg("text", { x: 14, y: (m.t + H - m.b) / 2, class: "axis", "text-anchor": "middle", transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})` }, Y.label));

  // Least-squares line and Pearson r over the points shown.
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0), syy = pts.reduce((s, p) => s + (p.y - my) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
  if (trend && sxx && n >= 3) {
    const b = sxy / sxx, a = my - b * mx;
    plot.append(svg("line", { x1: sx(x0), y1: sy(a + b * x0), x2: sx(x1), y2: sy(a + b * x1), class: "trend" }));
  }
  const xStep = (sx(x1) - sx(x0)) / Math.max(1, x1 - x0), yStep = (sy(y0) - sy(y1)) / Math.max(1, y1 - y0);
  const ordered = [...pts].sort((a, b) => Number(a.on) - Number(b.on)); // highlighted points drawn last, on top
  for (const p of ordered) {
    const cx = sx(p.x) + (X.discrete ? jitter(p.r, 1) * Math.min(28, xStep * 0.5) : 0);
    const cy = sy(p.y) - (Y.discrete ? jitter(p.r, 2) * Math.min(28, yStep * 0.5) : 0);
    const tip = `${tag(p.r)}: ${X.label} ${X.fmt ? X.fmt(p.x) : p.x}, ${Y.label} ${Y.fmt ? Y.fmt(p.y) : p.y}. ${p.r.stem.slice(0, 110)}${p.r.stem.length > 110 ? "…" : ""}`;
    plot.append(svg("circle", { cx, cy, r: p.on ? 6 : 5, class: p.on ? "pt" : "pt off", "data-tip": tip, tabindex: 0 }));
  }
  chart.replaceChildren(plot);
  $("#chartNote").textContent =
    `${count(n, "question", "questions")}.` +
    (Number.isFinite(r) ? ` Correlation r = ${r.toFixed(2)} (from -1 to 1; 0 means no straight-line relation).` : "") +
    (hlGroup ? ` Highlighted: ${chosen}.` : "");
  chartTable(
    ["Question", X.label, Y.label],
    [...pts].sort((a, b) => b.y - a.y).map((p) => [tag(p.r), X.fmt ? X.fmt(p.x) : p.x, Y.fmt ? Y.fmt(p.y) : p.y]),
    [1, 2],
  );
}

// ---------- chart 3: distribution ----------

function renderDist(): void {
  const v = setting("d.var", "rating"), split = setting("d.split", "none"), bins = Number(setting("d.bins", "10"));
  $("#controls").replaceChildren(
    select("cVar", "Variable", Object.entries(VARS).filter(([, x]) => !x.discrete).map(([k, x]) => [k, x.label]), v, rerender("d.var")),
    select("cBins", "Bars", [["6", "6"], ["10", "10"], ["16", "16"]], String(bins), rerender("d.bins")),
    select("cSplit", "Split by", [["none", "Nothing"], ...Object.entries(GROUPS).map(([k, g]) => [k, g.label] as [string, string])], split, rerender("d.split")),
  );
  const V = VARS[v] ?? VARS.rating;
  const all = pool().map((r) => ({ r, x: V.get(r) })).filter((p): p is { r: Row; x: number } => p.x !== null);
  const chart = $("#chart");
  if (!all.length) {
    chart.replaceChildren(el("p", { class: "muted" }, "Nothing to show yet."));
    chartTable([], []);
    return;
  }
  const lo = Math.min(...all.map((p) => p.x)), hi = Math.max(...all.map((p) => p.x));
  const width = hi > lo ? (hi - lo) / bins : 1;
  const binOf = (x: number) => Math.min(bins - 1, Math.floor((x - lo) / width));
  const label = (i: number) => {
    const a = lo + i * width, b = a + width;
    const f = (z: number) => (V.fmt ? V.fmt(z) : String(Math.round(z * 10) / 10));
    return `${f(a)} to ${f(b)}`;
  };
  const G = GROUPS[split];
  const panels = G ? grouped(all.map((p) => p.r), G).map((g) => ({ label: g.label, rows: g.rows })) : [{ label: "", rows: all.map((p) => p.r) }];
  const counts = panels.map((p) => {
    const c = new Array(bins).fill(0);
    for (const r of p.rows) c[binOf(V.get(r)!)]++;
    return c;
  });
  const peak = Math.max(1, ...counts.flat());
  const W = chartWidth();
  const panelH = G ? 74 : 220, gap = G ? 10 : 0, m = { l: G ? Math.min(150, W * 0.28) : 40, r: 10, t: 8, b: 34 };
  const H = m.t + panels.length * (panelH + gap) + m.b;
  const bw = (W - m.l - m.r) / bins;
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Distribution of ${V.label}` });
  panels.forEach((p, k) => {
    const top = m.t + k * (panelH + gap), base = top + panelH;
    plot.append(svg("line", { x1: m.l, x2: W - m.r, y1: base, y2: base, class: "axisline" }));
    if (G) plot.append(svg("text", { x: m.l - 8, y: top + panelH / 2 + 4, class: "glabel", "text-anchor": "end" }, p.label));
    counts[k].forEach((c, i) => {
      if (!c) return;
      const h = (c / peak) * (panelH - 6);
      plot.append(
        svg("rect", {
          x: m.l + i * bw + 1,
          y: base - h,
          width: Math.max(1, bw - 2),
          height: h,
          rx: 2,
          class: "bar",
          "data-tip": `${p.label ? p.label + ", " : ""}${V.label} ${label(i)}: ${count(c, "question", "questions")}`,
          tabindex: 0,
        }),
      );
    });
  });
  for (const t of niceTicks(lo, hi, W < 560 ? 4 : 6)) {
    const xx = m.l + ((t - lo) / (width * bins || 1)) * (W - m.l - m.r);
    plot.append(svg("text", { x: xx, y: H - m.b + 16, class: "tick", "text-anchor": "middle" }, V.fmt ? V.fmt(t) : String(t)));
  }
  plot.append(svg("text", { x: (m.l + W - m.r) / 2, y: H - 4, class: "axis", "text-anchor": "middle" }, V.label));
  chart.replaceChildren(plot);
  $("#chartNote").textContent = `${count(all.length, "question", "questions")}. Bar height: number of questions.`;
  chartTable(
    [...(G ? [G.label] : []), V.label, "Questions"],
    panels.flatMap((p, k) => counts[k].map((c, i) => [...(G ? [p.label] : []), label(i), c] as (string | number)[]).filter((row) => Number(row[row.length - 1]) > 0)),
    [G ? 2 : 1],
  );
}

// ---------- chart 4: head to head ----------

function renderH2H(): void {
  const by = setting("h.by", "unit");
  $("#controls").replaceChildren(
    select("cH", "Compare", Object.entries(GROUPS).filter(([k]) => k !== "reason").map(([k, g]) => [k, g.label]), by, rerender("h.by")),
  );
  const G = GROUPS[by] ?? GROUPS.unit;
  // Every question in play counts here, ranked or not: the cells are plain win counts between groups, which the
  // server has already added up (nothing per question is sent).
  const gs = grouped(rows, G);
  const of = new Map(gs.map((g, gi) => [g.label, gi]));
  const k = gs.length;
  const wins = Array.from({ length: k }, () => new Array(k).fill(0));
  const games = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const cell of board?.h2h[GROUPS[by] ? by : "unit"] ?? []) {
    const a = of.get(cell.a), b = of.get(cell.b);
    if (a === undefined || b === undefined || a === b) continue;
    wins[a][b] += cell.aw;
    wins[b][a] += cell.n - cell.aw;
    games[a][b] += cell.n;
    games[b][a] += cell.n;
  }
  const chart = $("#chart");
  const head = el("tr", {}, el("th", { scope: "col" }, `${G.label} (row) beat`), ...gs.map((g) => el("th", { scope: "col", class: "num" }, g.label)), el("th", { scope: "col", class: "num" }, "All others"));
  const body = gs.map((g, a) => {
    const tw = wins[a].reduce((s, x) => s + x, 0), tg = games[a].reduce((s, x) => s + x, 0);
    return el(
      "tr",
      {},
      el("th", { scope: "row" }, g.label),
      ...gs.map((h, b) => {
        if (a === b) return el("td", { class: "num na" }, "");
        return heatCell(games[a][b] ? wins[a][b] / games[a][b] : null, games[a][b], `${g.label} beat ${h.label}`);
      }),
      heatCell(tg ? tw / tg : null, tg, `${g.label} beat every other group`),
    );
  });
  chart.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "heat" }, el("thead", {}, head), el("tbody", {}, ...body))));
  $("#chartNote").textContent =
    "Each cell: how often a question from the row's group beat one from the column's group, with the number of comparisons. Burgundy: the row won more; blue: it lost more.";
  show($("#chartTableWrap"), false);
}

function heatCell(share: number | null, n: number, what: string): HTMLElement {
  const td = el("td", { class: "num heatcell", "data-tip": share === null ? `${what}: no comparisons yet` : `${what} ${pct(share)} of ${count(n, "time", "times")}`, tabindex: "0" });
  if (share === null) {
    td.textContent = "";
    return td;
  }
  td.append(el("span", { class: "v" }, pct(share)), el("span", { class: "n" }, String(n)));
  // Diverging: blue below 50%, burgundy above, grey at even. Strength grows with distance from 50% and with n.
  const d = Math.min(1, Math.abs(share - 0.5) * 2) * Math.min(1, n / 10);
  const mix = Math.round(d * 85);
  td.style.background = `color-mix(in oklab, var(${share >= 0.5 ? "--div-pos" : "--div-neg"}) ${mix}%, var(--div-mid))`;
  if (mix > 62) td.classList.add("strong");
  return td;
}

// ---------- chart tabs and tooltips ----------

const CHARTS: Record<string, () => void> = { groups: renderGroups, scatter: renderScatter, dist: renderDist, h2h: renderH2H };
function renderChart(): void {
  const which = CHARTS[setting("chart", "groups")] ? setting("chart", "groups") : "groups";
  for (const k of Object.keys(CHARTS)) $(`#tab-${k}`).setAttribute("aria-selected", String(k === which));
  $("#chartNote").textContent = "";
  hideTip();
  CHARTS[which]();
}
for (const k of Object.keys(CHARTS))
  $(`#tab-${k}`).addEventListener("click", () => {
    save("chart", k);
    renderChart();
  });

const tip = $("#tip");
function showTip(target: Element): void {
  const text = target.getAttribute("data-tip");
  if (!text) return;
  tip.textContent = text;
  show(tip);
  const box = $("#explore").getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const left = Math.min(Math.max(8, t.left - box.left + t.width / 2 - 140), box.width - 288);
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${t.top - box.top - tip.offsetHeight - 8 < 0 ? t.bottom - box.top + 8 : t.top - box.top - tip.offsetHeight - 8}px`;
}
function hideTip(): void {
  show(tip, false);
}
const tipTarget = (e: Event) => (e.target instanceof Element ? e.target.closest("[data-tip]") : null);
$("#panel").addEventListener("pointerover", (e) => {
  const t = tipTarget(e);
  if (t) showTip(t);
});
$("#panel").addEventListener("pointerout", (e) => {
  if (tipTarget(e)) hideTip();
});
$("#panel").addEventListener("focusin", (e) => {
  const t = tipTarget(e);
  if (t) showTip(t);
});
$("#panel").addEventListener("focusout", hideTip);
$("#panel").addEventListener("click", (e) => {
  const t = tipTarget(e);
  if (t) showTip(t);
});

let resizeTimer = 0;
let lastW = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (chartWidth() !== lastW) (lastW = chartWidth()), renderChart();
  }, 150);
});

// ---------- all questions: search, filter, sort, page ----------

const PAGE = 15;
let page = 0;
let sortKey = "rank";
let sortDir: 1 | -1 = 1;
const open = new Set<Row>();

const COLS: { key: string; label: string; cls?: string; get: (r: Row) => number | string }[] = [
  { key: "rank", label: "Rank", cls: "num", get: (r) => r.rank ?? Infinity },
  { key: "rating", label: "Rating", cls: "num", get: (r) => r.rating ?? -Infinity },
  { key: "tag", label: "Question", get: (r) => `${r.about.cycle} ${r.about.unit} ${r.about.question}` },
  { key: "games", label: "Comparisons", cls: "num wide", get: (r) => r.games },
  { key: "won", label: "Won", cls: "num wide", get: (r) => (r.games && r.wins !== null ? r.wins / r.games : -1) },
];

function filtered(): Row[] {
  const q = ($<HTMLInputElement>("#q").value ?? "").trim().toLowerCase();
  const unit = $<HTMLSelectElement>("#fUnit").value, year = $<HTMLSelectElement>("#fYear").value;
  const rankedOnly = $<HTMLInputElement>("#fRanked").checked;
  const terms = q.split(/\s+/).filter(Boolean);
  const out = rows.filter((r) => {
    if (unit && String(r.about.unit) !== unit) return false;
    if (year && r.about.cycle !== year) return false;
    if (rankedOnly && r.rank === null) return false;
    if (!terms.length) return true;
    const hay = [tag(r), r.stem, ...r.bullets, ...r.about.sources.map((s) => s.label)].join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const col = COLS.find((c) => c.key === sortKey) ?? COLS[0];
  return out.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    // Ties: by rating, and among unranked questions the one nearest a rank first.
    return c * sortDir || (b.rating ?? -Infinity) - (a.rating ?? -Infinity) || b.games - a.games;
  });
}

function renderAll(): void {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(page, pages - 1);
  const shown = list.slice(page * PAGE, page * PAGE + PAGE);
  $("#allCount").textContent = `${count(list.length, "question", "questions")}${list.length === rows.length ? "" : ` of ${rows.length}`}.`;
  $("#pageInfo").textContent = `Page ${page + 1} of ${pages}`;
  $<HTMLButtonElement>("#prevPage").disabled = page === 0;
  $<HTMLButtonElement>("#nextPage").disabled = page >= pages - 1;
  const head = el(
    "tr",
    {},
    ...COLS.map((c) => {
      const b = el("button", { type: "button", class: "sort" }, c.label, el("span", { class: "dir", "aria-hidden": "true" }, sortKey === c.key ? (sortDir === 1 ? " ↑" : " ↓") : ""));
      b.addEventListener("click", () => {
        if (sortKey === c.key) sortDir = sortDir === 1 ? -1 : 1;
        else (sortKey = c.key), (sortDir = c.key === "rank" || c.key === "tag" ? 1 : -1);
        page = 0;
        renderAll();
      });
      return el("th", { scope: "col", class: c.cls ?? "", "aria-sort": sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none" }, b);
    }),
  );
  const body: HTMLElement[] = [];
  for (const r of shown) {
    const isOpen = open.has(r);
    const toggle = el("button", { type: "button", class: "rowtoggle", "aria-expanded": String(isOpen) }, el("span", { class: "tag" }, tag(r)), el("span", { class: "stem1" }, r.stem));
    toggle.addEventListener("click", () => {
      if (open.has(r)) open.delete(r);
      else open.add(r);
      renderAll();
    });
    body.push(
      el(
        "tr",
        { class: isOpen ? "open" : "" },
        el("td", { class: "num rankcell" }, r.rank === null ? "" : `#${r.rank}`),
        // An unranked question shows how far it is from a rank, not a rating.
        el("td", { class: "num muted" }, r.rating === null ? `${r.games} of ${RANK_AT}` : String(r.rating)),
        el("td", { class: "q" }, toggle),
        el("td", { class: "num wide" }, String(r.games)),
        el("td", { class: "num wide" }, r.games && r.wins !== null ? pct(r.wins / r.games) : ""),
      ),
    );
    if (isOpen)
      body.push(
        el(
          "tr",
          { class: "detailrow" },
          el("td", { colspan: String(COLS.length) }, el("p", { class: "stem" }, ...marked(r.stem, 0, r.marks)), detail(r), el("p", { class: "meta muted" }, statLine(r))),
        ),
      );
  }
  $("#all").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
}

for (const id of ["#q", "#fUnit", "#fYear", "#fRanked"])
  $(id).addEventListener(id === "#q" ? "input" : "change", () => {
    page = 0;
    renderAll();
  });
$("#prevPage").addEventListener("click", () => ((page = Math.max(0, page - 1)), renderAll()));
$("#nextPage").addEventListener("click", () => ((page += 1), renderAll()));

function fillFilters(): void {
  const units = [...new Set(rows.map((r) => r.about.unit))].sort((a, b) => a - b);
  const years = [...new Set(rows.map((r) => r.about.cycle))].sort();
  const keep = (s: HTMLSelectElement, opts: [string, string][]) => {
    const v = s.value;
    s.replaceChildren(...opts.map(([a, b]) => el("option", { value: a }, b)));
    if (opts.some(([a]) => a === v)) s.value = v;
  };
  keep($<HTMLSelectElement>("#fUnit"), [["", "All"], ...units.map((u) => [String(u), `Unit ${u}`] as [string, string])]);
  keep($<HTMLSelectElement>("#fYear"), [["", "All"], ...years.map((y) => [y, y] as [string, string])]);
}

// ---------- load ----------

async function load(p?: string, round?: string): Promise<void> {
  if ($("#content").hidden) say(msg, "Loading the leaderboard");
  let b: Board;
  try {
    const q = new URLSearchParams();
    if (p) q.set("pool", p);
    const r = round ?? board?.round.id;
    if (r) q.set("round", r);
    b = await api<Board>("/api/leaderboard" + (q.size ? `?${q}` : ""));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return location.replace("/");
    // The board asked for is not open in this round (too few voters behind it): show whichever one is.
    if (err instanceof ApiError && err.body.error === "pool_too_small" && p) return load(undefined, round);
    if (err instanceof ApiError && err.body.error === "too_few_voters") {
      show($("#content"), false);
      return say(msg, `The leaderboard opens once ${err.body.need} people have voted. Check back soon.`, "warn");
    }
    if (err instanceof ApiError && err.body.error === "locked")
      return say(msg, `The leaderboard opens after ${err.body.unlockAt} votes. You have ${err.body.votes} so far.`, "warn");
    return say(msg, "Could not load the leaderboard. Try again.", "error");
  }
  say(msg, "");
  board = b;
  rows = b.rows;
  open.clear();
  show($("#content"));
  $("#intervals").textContent = b.intervalsAsOf ? `Ranges are 95% intervals from ${fmtDate(b.intervalsAsOf)}.` : "";
  $("#tabs").replaceChildren(
    ...b.pools.map((x) => {
      const btn = el("button", { type: "button", "aria-pressed": String(x.id === b.pool) }, x.name);
      btn.addEventListener("click", () => void load(x.id));
      return btn;
    }),
  );
  // One board only: no tabs to choose between, and a line saying when the viewer's own role gets its board.
  show($("#tabs"), b.pools.length > 1);
  $("#roleNote").textContent = b.waiting
    .map((w) => (w.name === "All adults" ? `The All adults board opens once ${w.need} adults have voted.` : `A board for your own role (${w.name}) opens once ${w.need} people in it have voted.`))
    .join(" ");
  show($("#roleNote"), b.waiting.length > 0);
  // With several rounds, a picker; the pool chosen stays the same across rounds.
  const sel = $<HTMLSelectElement>("#roundSel");
  sel.replaceChildren(...b.rounds.map((x) => el("option", { value: x.id }, x.name)));
  sel.value = b.round.id;
  show($("#roundPick"), b.rounds.length > 1);
  const ranked = rows.filter((r) => r.rank !== null).length;
  $("#summary").textContent = b.staged && b.staged.inPlay < b.staged.total
    ? `${count(b.votes, "vote", "votes")}. ${b.staged.inPlay} of ${b.staged.total} questions are in play and ${ranked} ${ranked === 1 ? "is" : "are"} ranked. More join as these settle.`
    : `${count(b.votes, "vote", "votes")}. ${count(rows.length, "question", "questions")}, ${ranked} ranked.`;
  renderTop();
  fillFilters();
  renderAll();
  lastW = chartWidth();
  renderChart();
}

$("#roundSel").addEventListener("change", () => void load(board?.pool, $<HTMLSelectElement>("#roundSel").value));

void load();
