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
    ? `Ranges show 95% intervals as of ${fmtDate(b.intervalsAsOf)}; the ratings themselves are current.`
    : "";
  $("#tabs").replaceChildren(
    ...b.pools.map((p) => {
      const btn = el("button", { type: "button", "aria-pressed": String(p.id === b.pool) }, p.name);
      btn.addEventListener("click", () => void load(p.id));
      return btn;
    }),
  );
  $("#summary").textContent = `${b.round.name}: ${b.votes} votes in this board.`;
  $("#rows").replaceChildren(
    ...b.rows.map((r) => {
      const range = r.lo !== null && r.hi !== null ? ` (range ${r.lo} to ${r.hi})` : "";
      return el(
        "li",
        {},
        el("div", { class: r.rank === null ? "rank unranked" : "rank" }, r.rank === null ? "Unranked" : `#${r.rank}`),
        el(
          "div",
          {},
          el("p", {}, r.stem),
          el("p", { class: "meta" }, `Rating ${r.rating}${range}, ${r.games} ${r.games === 1 ? "comparison" : "comparisons"}`),
          el("details", {}, el("summary", {}, "Bullets"), el("ul", {}, ...r.bullets.map((x) => el("li", {}, x)))),
        ),
      );
    }),
  );
}

void load();
