// Admin page. Runs the rater bootstrap in this browser with the same rating module the Worker uses.
import { RATING } from "../rating/config";
import { buildRoundExport, votesCsvFrom, type ExportVoteRow } from "../worker/export-shape";
import { POOLS, poolsForRole } from "../worker/pools";
import { REASONS } from "../worker/reasons";
import { bootstrapBT, fitBT, type Vote } from "../rating/rating";
import { $, api, ApiError, el, fmtDate, say, show } from "./common";

const BOOT_SEED = 20261124; // PREREG_Human_vs_LLM.md §6
const PREREG_ITEM_SHA = "8cb28a9e4f2ef1f5a4f687e6e25d78b1f7d95faf431ef04d240efb2fb53510d0";

interface Round {
  id: string;
  name: string;
  item_set_id: string;
  state: string;
  created_at: string;
  opened_at: string | null;
  frozen_at: string | null;
  closed_at: string | null;
  n_votes: number;
  n_voters: number;
}
interface ItemSet {
  id: string;
  name: string;
  version: number;
  file_sha256: string;
  created_at: string;
  frozen_at: string | null;
  n_items: number;
}
interface Status {
  actor: string;
  rounds: Round[];
  itemSets: ItemSet[];
  lastExportAt: string | null;
  exportOverdue: boolean;
  roles: { id: string; name: string }[];
  pools: string[];
}

const msg = $("#msg");
let status: Status;
let votesPage = 0;
let lastCodes: { label: string; role: string; code: string }[] = [];

function options(select: HTMLSelectElement, opts: [string, string][], keep = true): void {
  const prev = select.value;
  select.replaceChildren(...opts.map(([v, t]) => el("option", { value: v }, t)));
  if (keep && opts.some(([v]) => v === prev)) select.value = prev;
}

function table(t: HTMLTableElement, head: string[], rows: (string | number | Node | null)[][], numeric: number[] = []): void {
  t.replaceChildren(
    el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", numeric.includes(i) ? { class: "num" } : {}, h)))),
    el(
      "tbody",
      {},
      ...rows.map((r) =>
        el("tr", {}, ...r.map((c, i) => el("td", numeric.includes(i) ? { class: "num" } : {}, c === null ? "" : c instanceof Node ? c : String(c)))),
      ),
    ),
  );
}

function button(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", { type: "button", ...(cls ? { class: cls } : {}) }, text);
  b.addEventListener("click", onClick);
  return b;
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function act(fn: () => Promise<unknown>, okText?: string): Promise<void> {
  say(msg, "");
  try {
    await fn();
    if (okText) say(msg, okText, "ok");
  } catch (err) {
    say(msg, err instanceof ApiError ? err.message : String(err), "error");
  }
  await refresh();
}

// ---------- rounds ----------

function roundActions(r: Round): Node {
  const wrap = el("div");
  const group = (label: string, ...items: Node[]) =>
    el("div", { class: "btn-group" }, el("span", { class: "label" }, label), el("div", { class: "btns" }, ...items));
  const confirmAct = (verb: string, path: string, warn: string) =>
    button(verb, () => {
      if (confirm(`${verb} "${r.name}"? ${warn}`)) void act(() => api(path, { body: {} }), `${verb}: done.`);
    });
  const state: Node[] = [];
  if (r.state === "draft") state.push(confirmAct("Open", `/admin/api/rounds/${r.id}/open`, "Voters can vote as soon as it opens, and its item set freezes."));
  if (r.state === "open") state.push(confirmAct("Freeze", `/admin/api/rounds/${r.id}/freeze`, "No more votes will be accepted."));
  if (r.state === "open" || r.state === "frozen") state.push(confirmAct("Close", `/admin/api/rounds/${r.id}/close`, "Voters will no longer see it."));
  if (state.length) wrap.append(group("Round", ...state));
  if (r.state !== "draft") {
    wrap.append(
      group(
        "Ratings",
        button("Refresh intervals", () => void refreshIntervals(r)),
        button("Rebuild caches", () => void act(() => api(`/admin/api/rounds/${r.id}/rebuild`, { body: {} }), "Caches rebuilt from the vote log.")),
      ),
      group(
        "Export",
        button("JSON", () => void pagedExport(r, "json")),
        button("votes CSV", () => void pagedExport(r, "votes")),
        ...["skips", "reasons", "corrections", "ratings", "voters"].map((k) => el("a", { class: "button", href: `/admin/api/rounds/${r.id}/export/${k}.csv` }, `${k} CSV`)),
      ),
    );
  }
  return wrap;
}

/**
 * JSON (the analysis input) and votes CSV are fetched in pages of at most 2,000 votes and joined here, so no single
 * request's work grows with the round (Workers Free allows 10 ms of CPU per request).
 */
async function pagedExport(r: Round, kind: "json" | "votes"): Promise<void> {
  say(msg, "Exporting...");
  try {
    const votes: ExportVoteRow[] = [];
    let after = 0;
    for (;;) {
      const page = await api<{ votes: ExportVoteRow[]; next: number | null }>(`/admin/api/rounds/${r.id}/export-votes?after=${after}`);
      votes.push(...page.votes);
      if (page.next === null) break;
      after = page.next;
    }
    // Voters and skips come last, so a voter whose first vote landed while the pages were being read is in the list.
    const meta = await api<Parameters<typeof buildRoundExport>[0]>(`/admin/api/rounds/${r.id}/export-meta?kind=${kind}`);
    if (kind === "json") download(`wtpqr-round-${r.id}.json`, JSON.stringify(buildRoundExport(meta, votes)), "application/json");
    else download(`wtpqr-votes-${r.id}.csv`, votesCsvFrom(votes), "text/csv");
    say(msg, `Exported ${votes.length} votes.`, "ok");
    await refresh();
  } catch (err) {
    say(msg, err instanceof ApiError ? err.message : String(err), "error");
  }
}

/** 1,000-rep rater bootstrap per pool, in this browser, then saved as snapshots. */
async function refreshIntervals(r: Round): Promise<void> {
  const out = $("#bootMsg");
  say(out, "Downloading votes...");
  try {
    const input = await api<{ items: string[]; votes: { id: number; l: string; r: string; w: string; rater: string; role: string }[] }>(
      `/admin/api/rounds/${r.id}/bootstrap-input`,
    );
    const all: (Vote & { id: number })[] = input.votes.map((v) => ({ id: v.id, left: v.l, right: v.r, winner: v.w, rater: v.rater, role: v.role }));
    const snapshots = [];
    const t0 = performance.now();
    for (const pool of POOLS) {
      const votes = all.filter((v) => poolsForRole(v.role!).includes(pool));
      if (!votes.length) continue;
      say(out, `Bootstrapping ${pool} (${votes.length} votes)...`);
      await new Promise((res) => setTimeout(res, 0)); // let the message paint
      const fit = fitBT(input.items, votes);
      const boot = bootstrapBT(input.items, votes, { reps: RATING.BOOTSTRAP_REPS, seed: BOOT_SEED, unit: "rater" });
      snapshots.push({
        pool,
        n_votes: votes.length,
        n_raters: new Set(votes.map((v) => v.rater)).size,
        last_vote_id: Math.max(...votes.map((v) => v.id)),
        config: { RATING, reps: RATING.BOOTSTRAP_REPS, seed: BOOT_SEED, unit: "rater" },
        payload: {
          ids: input.items,
          rating: fit.rating,
          ratingLo: boot.ratingLo,
          ratingHi: boot.ratingHi,
          rankLo: boot.rankLo,
          rankHi: boot.rankHi,
          games: fit.games,
        },
      });
    }
    if (!snapshots.length) return say(out, "No votes yet.", "warn");
    await api(`/admin/api/rounds/${r.id}/snapshots`, { body: { snapshots } });
    say(out, `Intervals saved for ${snapshots.length} pools in ${((performance.now() - t0) / 1000).toFixed(1)} s.`, "ok");
  } catch (err) {
    say(out, err instanceof ApiError ? err.message : String(err), "error");
  }
}

// ---------- full backup ----------

/** Every table that is not a cache or a credential, read a page at a time and saved as one JSON file. */
async function fullBackup(): Promise<void> {
  say(msg, "Backing up...");
  try {
    const head = await api<{ exportedAt: string; migrations: string[]; tables: { name: string; rows: number }[] }>("/admin/api/backup");
    const tables: Record<string, unknown[]> = {};
    for (const t of head.tables) {
      const rows: unknown[] = [];
      let after = 0;
      for (;;) {
        const page = await api<{ rows: unknown[]; next: number | null }>(`/admin/api/backup/${t.name}?after=${after}`);
        rows.push(...page.rows);
        if (page.next === null) break;
        after = page.next;
      }
      tables[t.name] = rows;
      say(msg, `Backing up... ${t.name}`);
    }
    download(`wtpqr-backup-${head.exportedAt.slice(0, 10)}.json`, JSON.stringify({ exportedAt: head.exportedAt, migrations: head.migrations, tables }), "application/json");
    const total = Object.values(tables).reduce((s, r) => s + r.length, 0);
    say(msg, `Backup saved: ${total} rows in ${head.tables.length} tables.`, "ok");
    await refresh();
  } catch (err) {
    say(msg, err instanceof ApiError ? err.message : String(err), "error");
  }
}
$("#backupBtn").addEventListener("click", () => void fullBackup());

// ---------- codes ----------

/** One-tap invite link: the code rides after "#", which browsers never send to the server. */
const inviteLink = (code: string) => `${location.origin}/#${code}`;

function copyButton(text: string): HTMLButtonElement {
  const b = button("Copy link", () => {
    void navigator.clipboard.writeText(text).then(
      () => (b.textContent = "Copied"),
      () => (b.textContent = "Copy failed"),
    );
  });
  return b;
}

function renderCodes(): void {
  show($("#newCodesOut"), lastCodes.length > 0);
  table(
    $<HTMLTableElement>("#codesTable"),
    ["Label", "Role", "Code", "Invite link", ""],
    lastCodes.map((c) => [c.label, c.role, el("span", { class: "mono" }, c.code), el("span", { class: "mono" }, inviteLink(c.code)), copyButton(inviteLink(c.code))]),
  );
}

/** "Show link" fetches the voter's code (recomputed server-side, audited) and shows it with a copy button. */
function revealCell(label: string): HTMLElement {
  const cell = el("div");
  cell.append(
    button("Show link", async () => {
      try {
        const r = await api<{ code: string }>(`/admin/api/codes/reveal?label=${encodeURIComponent(label)}`);
        cell.replaceChildren(el("span", { class: "mono" }, r.code), el("br"), el("span", { class: "mono" }, inviteLink(r.code)), el("br"), copyButton(inviteLink(r.code)));
      } catch (err) {
        cell.replaceChildren(el("span", { class: "muted" }, err instanceof ApiError ? err.message : String(err)));
      }
    }),
  );
  return cell;
}

let voters: Record<string, any>[] = [];
let tracker: { round: { id: string; name: string } | null; unlockAt: number } = { round: null, unlockAt: 20 };

async function loadVoters(): Promise<void> {
  const r = await api<{ voters: Record<string, any>[]; round: { id: string; name: string } | null; unlockAt: number }>("/admin/api/codes");
  voters = r.voters;
  tracker = { round: r.round, unlockAt: r.unlockAt };
  renderVoters();
}

const dayOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");

/** Newest codes first (server order). Search matches label, role, status or issue date, case-insensitive. */
function renderVoters(): void {
  const q = $<HTMLInputElement>("#voterSearch").value.trim().toLowerCase();
  const status = (v: Record<string, any>) => (v.revoked_at ? "revoked" : "active") + (v.is_owner ? " owner" : "");
  const shown = q
    ? voters.filter((v) => [v.label, v.role, status(v), fmtDate(v.created_at)].join(" ").toLowerCase().includes(q))
    : voters;
  $("#voterCount").textContent = q ? `${shown.length} of ${voters.length}` : `${voters.length} codes`;
  // Who still needs a nudge: codes not used yet, and voters short of the leaderboard (and data gate) threshold.
  const live = voters.filter((v) => !v.revoked_at);
  const used = live.filter((v) => v.signed_in_at || v.n_votes > 0).length;
  const reached = live.filter((v) => v.round_votes >= tracker.unlockAt).length;
  $("#trackerLine").textContent = tracker.round
    ? `${tracker.round.name}: ${used} of ${live.length} live codes used; ${reached} at ${tracker.unlockAt} or more votes. "To ${tracker.unlockAt}" counts first showings in this round.`
    : `${used} of ${live.length} live codes used.`;
  const toGo = (v: Record<string, any>) => (v.revoked_at || !tracker.round ? "" : Math.max(0, tracker.unlockAt - v.round_votes));
  table(
    $<HTMLTableElement>("#voters"),
    ["Label", "Role", "Issued", "Owner", "Signed in", "Votes", `To ${tracker.unlockAt}`, "Last vote", "Board seen", "Revoked", "Invite", ""],
    shown.map((v) => [
      v.label,
      v.role,
      fmtDate(v.created_at),
      v.is_owner ? "yes" : "",
      v.signed_in_at ? dayOf(v.signed_in_at) : v.n_votes > 0 ? "yes" : "not yet",
      v.n_votes,
      toGo(v),
      dayOf(v.last_vote_at),
      v.board_seen_at ? fmtDate(v.board_seen_at) : "",
      v.revoked_at ? fmtDate(v.revoked_at) : "",
      v.revoked_at ? null : revealCell(v.label),
      v.revoked_at
        ? null
        : button("Revoke", () => {
            if (confirm(`Revoke ${v.label}? Their code stops working and their votes leave the ratings. The votes stay in the log.`))
              void act(() => api("/admin/api/codes/revoke", { body: { label: v.label } }), `${v.label} revoked; caches rebuilt.`);
          }),
    ]),
    [5, 6],
  );
}

$("#voterSearch").addEventListener("input", renderVoters);

// ---------- study health (report only) ----------

interface Health {
  forecast: {
    itemsShort: { id: string; games: number }[];
    adultVotesNeeded: number;
    adultVotesPerDay: number;
    daysAtThisPace: number | null;
    ratersShort: number;
    adultsUnderThreshold: number;
    adultVotesToThreshold: number;
  };
  corrections: { rows: number; winnerChanged: number };
  gate: {
    MIN_ADULT_RATERS: number;
    MIN_VOTES_PER_COUNTED_RATER: number;
    MIN_ADULT_GAMES_PER_ITEM: number;
    countedAdultRaters: number;
    minAdultGamesPerItem: number;
    itemsBelow: number;
    items: number;
    adultVotes: number;
    passed: boolean;
  };
  flagRules: { minVotes: number; tooFastMedianMs: number; sideShare: number };
  perDay: { day: string; votes: number; voters: number; adult_votes: number }[];
  reasons: {
    votesWithReason: number;
    votes: number;
    counts: { reason: string; n: number }[];
    notes: { created_at: string; label: string; role: string; note: string }[];
  };
  raters: {
    label: string;
    role: string;
    votes: number;
    medianMs: number | null;
    leftShare: number;
    closeCallShare: number;
    skips: number;
    flags: string[];
  }[];
}

const REASON_LABEL = new Map<string, string>([...REASONS.map((r) => [r.code, r.label] as [string, string]), ["other", "Other"]]);
const FLAG_TEXT: Record<string, string> = { too_fast: "Fast", one_side: "One side" };
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Width set through the DOM, not a style attribute: the CSP (style-src 'self') blocks inline styles. */
function dayBar(share: number): HTMLElement {
  const b = el("span", { class: "daybar" });
  b.style.width = `${share * 100}%`;
  return b;
}

function meter(id: string, value: number, max: number): void {
  const bar = $<HTMLProgressElement>(id);
  bar.max = max;
  bar.value = Math.min(value, max);
}

async function loadHealth(): Promise<void> {
  const round = $<HTMLSelectElement>("#healthRound").value;
  if (!round) return show($("#health"), false);
  const h = await api<Health>(`/admin/api/rounds/${round}/health`);
  const g = h.gate;
  $("#gateLine").textContent = g.passed
    ? "The data gate is met: the analysis may run (PREREG §9)."
    : `The data gate is not met yet (PREREG §9). ${g.adultVotes} adult first-presentation votes so far.`;
  $("#gateRaters").textContent = `Adult raters with ${g.MIN_VOTES_PER_COUNTED_RATER}+ votes: ${g.countedAdultRaters} of ${g.MIN_ADULT_RATERS}`;
  meter("#gateRatersBar", g.countedAdultRaters, g.MIN_ADULT_RATERS);
  $("#gateItems").textContent =
    `Fewest adult comparisons on any item: ${g.minAdultGamesPerItem} of ${g.MIN_ADULT_GAMES_PER_ITEM}` +
    (g.itemsBelow ? ` (${g.itemsBelow} of ${g.items} items short)` : "");
  meter("#gateItemsBar", g.minAdultGamesPerItem, g.MIN_ADULT_GAMES_PER_ITEM);

  const fc = h.forecast;
  const parts: string[] = [];
  if (fc.adultVotesNeeded) {
    const when =
      fc.daysAtThisPace === null
        ? "no adult votes yet to set a pace"
        : `about ${fc.daysAtThisPace} ${fc.daysAtThisPace === 1 ? "day" : "days"} at ${fc.adultVotesPerDay} adult votes a day`;
    parts.push(`Items: at least ${fc.adultVotesNeeded} more adult votes needed, if they fall on the short items (${when}).`);
  }
  if (fc.ratersShort)
    parts.push(
      `Raters: ${fc.ratersShort} more needed at ${g.MIN_VOTES_PER_COUNTED_RATER} votes; ${fc.adultsUnderThreshold} adults have started and are ` +
        `${fc.adultVotesToThreshold} votes short between them.`,
    );
  $("#forecastLine").textContent = parts.join(" ");
  table($<HTMLTableElement>("#shortItems"), ["Question", "Adult comparisons"], fc.itemsShort.map((x) => [el("span", { class: "mono" }, x.id), x.games]), [1]);
  show($("#shortWrap"), fc.itemsShort.length > 0);

  const peak = Math.max(1, ...h.perDay.map((d) => d.votes));
  table(
    $<HTMLTableElement>("#perDay"),
    ["Day (UTC)", "Votes", "Adult", "Voters", ""],
    h.perDay.map((d) => [d.day, d.votes, d.adult_votes, d.voters, dayBar(d.votes / peak)]),
    [1, 2, 3],
  );

  const r = h.reasons;
  $("#correctionsLine").textContent = h.corrections.rows
    ? `Answers changed by going back: ${h.corrections.rows}, of which ${h.corrections.winnerChanged} now have a different winner.`
    : "No answers changed by going back.";
  $("#reasonsLine").textContent = r.votes
    ? `${r.votesWithReason} of ${r.votes} first-presentation votes (${pct(r.votesWithReason / r.votes)}) carry at least one reason.`
    : "No votes yet.";
  const given = r.counts.reduce((s, x) => s + x.n, 0);
  table(
    $<HTMLTableElement>("#reasonCounts"),
    ["Reason", "Times given", "Share"],
    r.counts.map((x) => [REASON_LABEL.get(x.reason) ?? x.reason, x.n, pct(x.n / given)]),
    [1, 2],
  );

  table(
    $<HTMLTableElement>("#otherNotes"),
    ["Time", "Voter", "Role", "Other reason"],
    r.notes.map((x) => [fmtDate(x.created_at), x.label, x.role, x.note]),
  );
  show($("#otherNotesWrap"), r.notes.length > 0);

  const f = h.flagRules;
  $("#flagRules").textContent =
    `Live codes, first presentations. Flags (report only): median time under ${f.tooFastMedianMs / 1000} s, or one side ` +
    `${pct(f.sideShare)} or more, over ${f.minVotes} or more votes. Flagged raters stay in the primary analysis.`;
  table(
    $<HTMLTableElement>("#raters"),
    ["Voter", "Role", "Votes", "Median s", "Left", "Close calls", "Skips", "Flags"],
    h.raters.map((x) => [
      x.label,
      x.role,
      x.votes,
      x.medianMs === null ? "" : (x.medianMs / 1000).toFixed(0),
      pct(x.leftShare),
      pct(x.closeCallShare),
      x.skips,
      x.flags.map((k) => FLAG_TEXT[k] ?? k).join(", "),
    ]),
    [2, 3, 4, 5, 6],
  );
  show($("#health"));
}

$("#healthForm").addEventListener("submit", (e) => {
  e.preventDefault();
  void loadHealth().catch((err) => say(msg, err instanceof ApiError ? err.message : String(err), "error"));
});

// ---------- board and raw votes ----------

async function loadBoard(): Promise<void> {
  const round = $<HTMLSelectElement>("#boardRound").value;
  const pool = $<HTMLSelectElement>("#boardPool").value;
  if (!round) return;
  const b = await api<{ votes: number; left: number; intervalsAsOf: string | null; rows: Record<string, any>[] }>(
    `/admin/api/rounds/${round}/board?pool=${pool}`,
  );
  $("#boardInfo").textContent =
    `${b.votes} first-presentation votes. Left-side effect ${b.left.toFixed(3)} log-odds. ` +
    (b.intervalsAsOf ? `Intervals as of ${fmtDate(b.intervalsAsOf)}.` : "No intervals yet: use Refresh intervals.");
  table(
    $<HTMLTableElement>("#board"),
    ["Rank", "Question", "Rating", "Low", "High", "Games", "Wins"],
    b.rows.map((r) => [r.rank ?? "", el("span", { class: "mono" }, r.id), r.rating.toFixed(0), r.lo?.toFixed(0) ?? "", r.hi?.toFixed(0) ?? "", r.games, r.wins]),
    [0, 2, 3, 4, 5, 6],
  );
}

async function loadVotes(): Promise<void> {
  const q = new URLSearchParams();
  const round = $<HTMLSelectElement>("#vRound").value;
  const role = $<HTMLSelectElement>("#vRole").value;
  const label = $<HTMLInputElement>("#vLabel").value.trim();
  const repeat = $<HTMLSelectElement>("#vRepeat").value;
  if (round) q.set("round", round);
  if (role) q.set("role", role);
  if (label) q.set("label", label);
  if (repeat) q.set("repeat", repeat);
  q.set("page", String(votesPage));
  const r = await api<{ page: number; size: number; total: number; votes: Record<string, any>[] }>(`/admin/api/votes?${q}`);
  const from = r.total ? r.page * r.size + 1 : 0;
  $("#votesInfo").textContent = `${r.total} votes; showing ${from} to ${Math.min(r.total, (r.page + 1) * r.size)}, newest first.`;
  $<HTMLButtonElement>("#prev").disabled = r.page === 0;
  $<HTMLButtonElement>("#next").disabled = (r.page + 1) * r.size >= r.total;
  table(
    $<HTMLTableElement>("#votes"),
    ["#", "Time", "Voter", "Role", "Left", "Right", "Winner", "Close", "Repeat", "After board", "Changed", "Client s", "Server s"],
    r.votes.map((v) => [
      v.id,
      fmtDate(v.created_at),
      v.label,
      v.role,
      el("span", { class: "mono" }, v.left_q),
      el("span", { class: "mono" }, v.right_q),
      v.winner_q === v.left_q ? "Left" : "Right",
      v.close_call ? "yes" : "",
      v.is_repeat ? "yes" : "",
      v.after_board ? "yes" : "",
      v.corrected ? "yes" : "",
      v.client_ms === null ? "" : (v.client_ms / 1000).toFixed(0),
      v.server_ms === null ? "" : (v.server_ms / 1000).toFixed(0),
    ]),
    [0, 11, 12],
  );
}

// ---------- page ----------

async function refresh(): Promise<void> {
  status = await api<Status>("/admin/api/status");
  $("#actor").textContent = `Signed in as ${status.actor}`;
  const banner = $("#exportBanner");
  banner.textContent = status.lastExportAt
    ? `The last export was ${fmtDate(status.lastExportAt)}. D1 Time Travel keeps only 7 days on the Free plan: export the round now.`
    : "No export yet. D1 Time Travel keeps only 7 days on the Free plan: export the round regularly.";
  show(banner, status.exportOverdue);

  table(
    $<HTMLTableElement>("#rounds"),
    ["Round", "Item set", "State", "Votes", "Voters", "Opened", "Actions"],
    status.rounds.map((r) => [r.name, r.item_set_id, r.state, r.n_votes, r.n_voters, fmtDate(r.opened_at), roundActions(r)]),
    [3, 4],
  );
  options($<HTMLSelectElement>("#roundSet"), status.itemSets.map((s) => [s.id, `${s.id} (${s.n_items} items)`]));
  const roundOpts: [string, string][] = status.rounds.filter((r) => r.state !== "draft").map((r) => [r.id, `${r.name} (${r.state})`]);
  options($<HTMLSelectElement>("#boardRound"), roundOpts);
  options($<HTMLSelectElement>("#healthRound"), roundOpts);
  options($<HTMLSelectElement>("#vRound"), [["", "All rounds"], ...roundOpts]);
  options($<HTMLSelectElement>("#boardPool"), status.pools.map((p) => [p, p]));
  options($<HTMLSelectElement>("#codeRole"), status.roles.map((r) => [r.id, r.name]));
  options($<HTMLSelectElement>("#vRole"), [["", "All roles"], ...status.roles.map((r) => [r.id, r.name] as [string, string])]);
  table(
    $<HTMLTableElement>("#itemSets"),
    ["Item set", "Items", "File SHA-256", "Loaded", "Frozen"],
    status.itemSets.map((s) => [
      s.id,
      s.n_items,
      el(
        "span",
        {},
        el("span", { class: "mono" }, s.file_sha256),
        el("br"),
        el("span", { class: "muted" }, s.file_sha256 === PREREG_ITEM_SHA ? "Matches the pre-registered launch file." : "Not the pre-registered launch file."),
      ),
      fmtDate(s.created_at),
      s.frozen_at ? fmtDate(s.frozen_at) : "",
    ]),
    [1],
  );
  await loadVoters();
  await loadVotes();
  await loadHealth();
}

$("#newRound").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("#roundName").value.trim();
  const itemSetId = $<HTMLSelectElement>("#roundSet").value;
  if (!name || !itemSetId) return say(msg, "Give the round a name and pick an item set.", "error");
  void act(() => api("/admin/api/rounds", { body: { name, itemSetId } }), "Round created as a draft.");
});

$("#newCodes").addEventListener("submit", (e) => {
  e.preventDefault();
  const role = $<HTMLSelectElement>("#codeRole").value;
  const count = Number($<HTMLInputElement>("#codeCount").value);
  const owner = $<HTMLInputElement>("#codeOwner").checked;
  void act(async () => {
    const r = await api<{ codes: typeof lastCodes }>("/admin/api/codes", { body: { role, count, owner } });
    lastCodes = r.codes;
    renderCodes();
  }, "Codes created. They are shown once.");
});

$("#codesCsv").addEventListener("click", () => {
  const lines = ["label,role,code,link", ...lastCodes.map((c) => `${c.label},${c.role},${c.code},${inviteLink(c.code)}`)];
  download(`wtpqr-codes-${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\r\n") + "\r\n", "text/csv");
});

$("#boardForm").addEventListener("submit", (e) => {
  e.preventDefault();
  void loadBoard().catch((err) => say(msg, String(err), "error"));
});

$("#votesForm").addEventListener("submit", (e) => {
  e.preventDefault();
  votesPage = 0;
  void loadVotes();
});
$("#prev").addEventListener("click", () => ((votesPage = Math.max(0, votesPage - 1)), void loadVotes()));
$("#next").addEventListener("click", () => ((votesPage += 1), void loadVotes()));

$("#itemsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const file = $<HTMLInputElement>("#itemsFile").files?.[0];
  const out = $("#itemsMsg");
  if (!file) return say(out, "Choose an item file first.", "error");
  void (async () => {
    try {
      const r = await api<{ itemSet: string; fileSha256: string; n?: number; already?: boolean }>("/admin/api/items", {
        raw: await file.arrayBuffer(),
      });
      const match = r.fileSha256 === PREREG_ITEM_SHA ? "It matches the pre-registered hash." : "It does not match the pre-registered launch file.";
      say(out, `${r.already ? "Already loaded" : "Loaded"} ${r.itemSet}. File SHA-256 ${r.fileSha256}. ${match}`, "ok");
      await refresh();
    } catch (err) {
      const ids = err instanceof ApiError && Array.isArray(err.body.ids) ? ` Items: ${(err.body.ids as string[]).join(", ")}` : "";
      say(out, (err instanceof ApiError ? err.message : String(err)) + ids, "error");
    }
  })();
});

$("#loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    try {
      await api("/admin/api/login", { body: { secret: $<HTMLInputElement>("#secret").value } });
      $<HTMLInputElement>("#secret").value = "";
      await init();
    } catch {
      say(msg, "That did not work.", "error");
    }
  })();
});

async function init(): Promise<void> {
  try {
    await refresh();
    show($("#login"), false);
    show($("#app"));
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      show($("#app"), false);
      show($("#login"));
      return;
    }
    say(msg, String(err), "error");
  }
}

void init();
