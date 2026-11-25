import { REASONS, MAX_REASONS, type ReasonCode } from "../worker/reasons";
import { $, api, ApiError, CRITERION, el, say, show } from "./common";

interface Side {
  stem: string;
  bullets: string[];
}
interface Pair {
  pairId: string;
  left: Side;
  right: Side;
}
interface Batch {
  done: boolean;
  size: number;
  pairs: Pair[];
}
interface Me {
  role: string;
  votes: number;
  unlockAt: number;
  unlocked: boolean;
  round: { name: string; state: string } | null;
}
interface AfterAnswer {
  votes: number;
  unlockAt: number;
  unlocked: boolean;
  remaining: number;
}

const msg = $("#msg");
const judge = $("#judge");
const between = $("#between");
const pickL = $<HTMLButtonElement>("#pickL");
const pickR = $<HTMLButtonElement>("#pickR");
const skipBtn = $<HTMLButtonElement>("#skip");
const closeBox = $<HTMLInputElement>("#close");

let queue: Pair[] = [];
let size = 0;
let shownAt = 0;
let busy = false;
let me: Me;
const chosen = new Set<ReasonCode>();

$("#criterion").textContent = CRITERION;

// Reason pills: optional, at most MAX_REASONS, cleared with each new pair. Keys 1-9 toggle them in order.
const pills = REASONS.map((r, i) => {
  const b = el("button", { type: "button", class: "pill", "aria-pressed": "false", "aria-keyshortcuts": String(i + 1) }, r.label);
  b.addEventListener("click", () => toggleReason(r.code));
  return b;
});
$("#pills").replaceChildren(...pills);

function renderPills(): void {
  const full = chosen.size >= MAX_REASONS;
  REASONS.forEach((r, i) => {
    const on = chosen.has(r.code);
    pills[i].setAttribute("aria-pressed", String(on));
    pills[i].disabled = full && !on;
  });
}

function toggleReason(code: ReasonCode): void {
  if (chosen.has(code)) chosen.delete(code);
  else if (chosen.size < MAX_REASONS) chosen.add(code);
  renderPills();
}

function renderMe(): void {
  $("#who").textContent = me.role;
  show($("#boardLink"), me.unlocked);
}

function fill(prefix: "left" | "right", side: Side): void {
  $(`#${prefix}Stem`).textContent = side.stem;
  const ul = $(`#${prefix}Bullets`);
  ul.replaceChildren(...side.bullets.map((b) => el("li", {}, b)));
}

function showPair(): void {
  const p = queue[0];
  fill("left", p.left);
  fill("right", p.right);
  closeBox.checked = false;
  chosen.clear();
  renderPills();
  const n = size - queue.length + 1;
  $("#position").textContent = `Pair ${n} of ${size}`;
  const bar = $<HTMLProgressElement>("#bar");
  bar.max = size;
  bar.value = n - 1;
  show(judge);
  show(between, false);
  shownAt = performance.now();
  window.scrollTo({ top: 0 });
}

let loading = false;
async function loadBatch(): Promise<void> {
  if (loading) return; // a double tap must not ask for two batches
  loading = true;
  try {
    await fetchBatch();
  } finally {
    loading = false;
  }
}

async function fetchBatch(): Promise<void> {
  say(msg, "");
  let b: Batch;
  try {
    b = await api<Batch>("/api/batch");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.replace("/");
    if (err instanceof ApiError && err.status === 409) {
      show(judge, false);
      return say(msg, "Voting is closed right now. Thank you for your votes.", "warn");
    }
    return say(msg, "Could not load the next pairs. Check your connection and reload.", "error");
  }
  if (b.done || !b.pairs.length) {
    show(judge, false);
    return say(msg, "You have judged every pair. Thank you.", "ok");
  }
  queue = b.pairs;
  size = b.size;
  showPair();
}

function batchDone(): void {
  show(judge, false);
  $("#betweenText").textContent = me.unlocked
    ? `You have cast ${me.votes} votes. Keep going, or stop and look at the leaderboard.`
    : `You have cast ${me.votes} votes. The leaderboard opens after ${me.unlockAt}.`;
  show(between);
  $("#betweenH").focus();
}

async function answer(kind: "L" | "R" | "skip"): Promise<void> {
  if (busy || !queue.length) return;
  busy = true;
  [pickL, pickR, skipBtn].forEach((b) => (b.disabled = true));
  judge.classList.add("busy");
  const p = queue[0];
  const clientMs = Math.round(performance.now() - shownAt);
  try {
    const r =
      kind === "skip"
        ? await api<AfterAnswer>("/api/skip", { body: { pairId: p.pairId, clientMs } })
        : await api<AfterAnswer>("/api/vote", {
            body: { pairId: p.pairId, pick: kind, closeCall: closeBox.checked, reasons: [...chosen], clientMs },
          });
    me.votes = r.votes;
    me.unlocked = r.unlocked;
    renderMe();
    queue.shift();
    if (queue.length) showPair();
    else batchDone();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.replace("/");
    if (err instanceof ApiError && err.status === 409) {
      show(judge, false);
      say(msg, "Voting just closed. Your earlier votes are saved.", "warn");
    } else say(msg, "That vote did not go through. Try again.", "error");
  } finally {
    busy = false;
    judge.classList.remove("busy");
    [pickL, pickR, skipBtn].forEach((b) => (b.disabled = false));
  }
}

pickL.addEventListener("click", () => void answer("L"));
pickR.addEventListener("click", () => void answer("R"));
skipBtn.addEventListener("click", () => void answer("skip"));
$("#more").addEventListener("click", () => void loadBatch());

// Tapping anywhere on a question card picks it, like its button. Ignored while text is selected (someone copying a
// line), and for a moment after a new pair appears, so a quick double tap cannot vote on the next pair unread.
const CARD_TAP_GUARD_MS = 700;
for (const [id, kind] of [["#leftCard", "L"], ["#rightCard", "R"]] as const) {
  $(id).addEventListener("click", () => {
    if (performance.now() - shownAt < CARD_TAP_GUARD_MS) return;
    if (window.getSelection()?.toString()) return;
    void answer(kind);
  });
}

document.addEventListener("keydown", (e) => {
  if (judge.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" && (t as HTMLInputElement).type === "text") return;
  if (e.key === "ArrowLeft") (e.preventDefault(), void answer("L"));
  else if (e.key === "ArrowRight") (e.preventDefault(), void answer("R"));
  else if (e.key === "c" || e.key === "C") (e.preventDefault(), (closeBox.checked = !closeBox.checked));
  else if (e.key === "s" || e.key === "S") (e.preventDefault(), void answer("skip"));
  else if (/^[1-9]$/.test(e.key) && REASONS[Number(e.key) - 1]) (e.preventDefault(), toggleReason(REASONS[Number(e.key) - 1].code));
});

async function init(): Promise<void> {
  try {
    me = await api<Me>("/api/me");
  } catch {
    return location.replace("/");
  }
  renderMe();
  if (!me.round || me.round.state !== "open") return say(msg, "Voting is closed right now.", "warn");
  await loadBatch();
}

void init();
