import { $, api, ApiError, el, fmtDate, say, show } from "./common";

interface Row {
  rank: number | null;
  rating: number;
  lo: number | null;
  hi: number | null;
  games: number;
  stem: string;
  bullets: string[];
}
interface Board {
  pool: string;
  pools: { id: string; name: string }[];
  round: { name: string; state: string };
  votes: number;
  intervalsAsOf: string | null;
  rows: Row[];
}

const msg = $("#msg");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function item(r: Row): HTMLLIElement {
  const range = r.lo !== null && r.hi !== null ? `${r.lo} to ${r.hi}` : "";
  return el(
    "li",
    {},
    r.rank === null ? null : el("div", { class: "rank" }, String(r.rank)),
    el(
      "details",
      { class: "text" },
      el("summary", {}, el("span", { class: "stem" }, r.stem), el("span", { class: "more" }, "More")),
      el("ul", {}, ...r.bullets.map((x) => el("li", {}, x))),
    ),
    el(
      "div",
      { class: "score" },
      el("strong", {}, String(r.rating)),
      el("span", {}, [plural(r.games, "comparison", "comparisons"), range].filter(Boolean).join(" · ")),
    ),
  );
}

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
}

void load();
