import { $, api, ApiError, el, fmtDate, say, show } from "./common";

interface Row {
  rank: number | null;
  rating: number;
  lo: number | null;
  hi: number | null;
  games: number;
  stem: string;
  bullets: string[];
  about: { level: string; cycle: string; unit: number; question: number; sources: { label: string; url: string }[] };
}
interface Group {
  label: string;
  n: number;
  ranked: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}
interface Board {
  pool: string;
  pools: { id: string; name: string }[];
  round: { name: string; state: string };
  votes: number;
  intervalsAsOf: string | null;
  rows: Row[];
  groups: { units: Group[]; years: Group[] };
}

const msg = $("#msg");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const LEVELS: Record<string, string> = { State: "State", NF: "National Finals", NI: "National Invitational", Regional: "Regional" };

/** Year, unit, number and any quoted sources, behind an Info button (leaderboard only; never shown while voting). */
function about(r: Row): HTMLElement {
  const panel = el(
    "div",
    { class: "about", hidden: "" },
    el("p", {}, `${LEVELS[r.about.level] ?? r.about.level} hearing questions, ${r.about.cycle.replace("-", "–")}, Unit ${r.about.unit}, Question ${r.about.question}`),
    r.about.sources.length
      ? el(
          "p",
          {},
          "Quoted: ",
          ...r.about.sources.flatMap((s, i) => [i ? "; " : "", el("a", { href: s.url, rel: "noopener noreferrer", target: "_blank" }, s.label)]),
        )
      : null,
  );
  const btn = el("button", { type: "button", class: "link info", "aria-expanded": "false" }, "Info");
  btn.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  return el("div", { class: "about-wrap" }, btn, panel);
}

function item(r: Row): HTMLLIElement {
  const range = r.lo !== null && r.hi !== null ? `${r.lo} to ${r.hi}` : "";
  return el(
    "li",
    {},
    r.rank === null ? null : el("div", { class: "rank" }, String(r.rank)),
    el(
      "div",
      { class: "text" },
      el(
        "details",
        {},
        el("summary", {}, el("span", { class: "stem" }, r.stem), el("span", { class: "more" }, "More")),
        el("ul", {}, ...r.bullets.map((x) => el("li", {}, x))),
      ),
      about(r),
    ),
    el(
      "div",
      { class: "score" },
      el("strong", {}, String(r.rating)),
      el("span", {}, [plural(r.games, "comparison", "comparisons"), range].filter(Boolean).join(" · ")),
    ),
  );
}

// ---------- by unit and year: a dot plot (average of ranked questions, line = lowest to highest) ----------

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: (Node | string)[]) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
};
let current: Board | null = null;
let groupBy: "units" | "years" = "units";
let sortBy: "strength" | "order" = "strength";

function sorted(groups: Group[]): Group[] {
  if (sortBy === "order") return groups;
  return [...groups].sort((a, b) => (b.mean ?? -Infinity) - (a.mean ?? -Infinity));
}

function renderGroups(): void {
  if (!current) return;
  const groups = sorted(current.groups[groupBy]);
  const withData = groups.filter((g) => g.mean !== null);
  const chart = $("#chart");
  if (!withData.length) {
    chart.replaceChildren(el("p", { class: "muted" }, "No unit or year has a ranked question yet."));
  } else {
    // Drawn at the container's real width so text stays at its stated size on phones.
    const W = Math.max(300, Math.round(chart.clientWidth || 640));
    const narrow = W < 520;
    const rowH = 30, top = 22, left = narrow ? 70 : 92, right = narrow ? 62 : 150;
    const lo = Math.min(1000, ...withData.map((g) => g.min!)), hi = Math.max(1000, ...withData.map((g) => g.max!));
    const x0 = Math.floor((lo - 25) / 100) * 100, x1 = Math.ceil((hi + 25) / 100) * 100;
    const x = (v: number) => left + ((v - x0) / (x1 - x0)) * (W - left - right);
    const H = top + rowH * groups.length + 6;
    const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Average rating of ranked questions by ${groupBy === "units" ? "unit" : "year"}` });
    const step = (x1 - x0) / 100 > (narrow ? 4 : 8) ? 200 : 100;
    for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step)
      plot.append(svg("text", { x: x(t), y: 12, class: "tick", "text-anchor": "middle" }, String(t)));
    plot.append(svg("line", { x1: x(1000), x2: x(1000), y1: 16, y2: H - 4, class: "ref" }));
    groups.forEach((g, i) => {
      const y = top + rowH * i + rowH / 2;
      const row = svg("g", { class: "grow" });
      row.append(svg("text", { x: left - 10, y: y + 5, class: "glabel", "text-anchor": "end" }, g.label.replace("-", "–")));
      if (g.mean === null) {
        row.append(svg("text", { x: left, y: y + 5, class: "gnote" }, `not ranked yet (${g.n})`));
      } else {
        if (g.max! > g.min!) row.append(svg("line", { x1: x(g.min!), x2: x(g.max!), y1: y, y2: y, class: "span" }));
        row.append(svg("circle", { cx: x(g.mean), cy: y, r: 6, class: "dot" }));
        row.append(svg("text", { x: W - right + 12, y: y + 5, class: "gvalue" }, narrow ? String(g.mean) : `${g.mean}  ·  ${g.ranked} of ${g.n} ranked`));
        row.append(svg("title", {}, `${g.label}: average ${g.mean} over ${g.ranked} ranked of ${g.n} questions (lowest ${g.min}, highest ${g.max})`));
      }
      plot.append(row);
    });
    chart.replaceChildren(plot);
  }
  const t = $<HTMLTableElement>("#groupTable");
  t.replaceChildren(
    el("thead", {}, el("tr", {}, ...[groupBy === "units" ? "Unit" : "Year", "Average", "Lowest", "Highest", "Ranked", "Questions"].map((h) => el("th", {}, h)))),
    el(
      "tbody",
      {},
      ...groups.map((g) =>
        el("tr", {}, ...[g.label.replace("-", "–"), g.mean ?? "", g.min ?? "", g.max ?? "", g.ranked, g.n].map((v, i) => el("td", i ? { class: "num" } : {}, String(v)))),
      ),
    ),
  );
  for (const [id, on] of [["byUnit", groupBy === "units"], ["byYear", groupBy === "years"], ["sortStrength", sortBy === "strength"], ["sortOrder", sortBy === "order"]] as const)
    $(`#${id}`).setAttribute("aria-pressed", String(on));
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderGroups, 150);
});
$("#byUnit").addEventListener("click", () => ((groupBy = "units"), renderGroups()));
$("#byYear").addEventListener("click", () => ((groupBy = "years"), renderGroups()));
$("#sortStrength").addEventListener("click", () => ((sortBy = "strength"), renderGroups()));
$("#sortOrder").addEventListener("click", () => ((sortBy = "order"), renderGroups()));

async function load(pool?: string): Promise<void> {
  let b: Board;
  try {
    b = await api<Board>("/api/leaderboard" + (pool ? `?pool=${encodeURIComponent(pool)}` : ""));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return location.replace("/");
    if (err instanceof ApiError && err.body.error === "locked")
      return say(msg, `The leaderboard opens after ${err.body.unlockAt} votes. You have ${err.body.votes} so far.`, "warn");
    return say(msg, "Could not load the leaderboard. Try again.", "error");
  }
  show($("#content"));
  $("#intervals").textContent = b.intervalsAsOf
    ? `Ranges are 95% intervals from ${fmtDate(b.intervalsAsOf)}.`
    : "";
  $("#tabs").replaceChildren(
    ...b.pools.map((p) => {
      const btn = el("button", { type: "button", "aria-pressed": String(p.id === b.pool) }, p.name);
      btn.addEventListener("click", () => void load(p.id));
      return btn;
    }),
  );
  $("#summary").textContent = plural(b.votes, "vote", "votes");
  const ranked = b.rows.filter((r) => r.rank !== null);
  const unranked = b.rows.filter((r) => r.rank === null);
  $("#rows").replaceChildren(...ranked.map(item));
  show($("#noneRanked"), ranked.length === 0);
  $("#unrankedRows").replaceChildren(...unranked.map(item));
  show($("#unrankedH"), unranked.length > 0);
  current = b;
  renderGroups();
}

void load();
