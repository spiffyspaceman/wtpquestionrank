import { MAX_REASONS, OTHER_LABEL, OTHER_MAX_WORDS, REASONS, wordCount, type ReasonCode } from "../worker/reasons";
import { $, api, ApiError, CRITERION, el, say, shortcutsOn, show } from "./common";

interface Side {
  stem: string;
  bullets: string[];
}
interface Given {
  pick: "L" | "R";
  closeCall: boolean;
  reasons: ReasonCode[];
  other: string | null;
}
type Answer = Given | { skipped: true } | null;
interface Pair {
  pairId: string;
  left: Side;
  right: Side;
  answer: Answer;
}
interface Batch {
  done: boolean;
  size: number;
  start: number;
  pairs: Pair[];
}
const isGiven = (a: Answer): a is Given => a !== null && "pick" in a;
interface Me {
  role: string;
  votes: number;
  unlockAt: number;
  unlocked: boolean;
  open: boolean;
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
const nextBtn = $<HTMLButtonElement>("#next");
const closeBox = $<HTMLInputElement>("#close");
const after = $("#after");

/** The side the voter has chosen for this pair; the vote is sent only with Next. */
let pick: "L" | "R" | null = null;

// The whole current batch, answered pairs included, and the pair on screen. A voter can go back to any pair of this
// batch and change the answer, until the next batch starts (owner decision, 25 Nov 2026).
let pairs: Pair[] = [];
let idx = 0;
let shownAt = 0;
let busy = false;
let me: Me;
const chosen = new Set<ReasonCode>();

$("#criterion").textContent = CRITERION;

// Reason pills: optional, at most MAX_REASONS counting "Other", cleared with each new pair. Keys 1-9 toggle the listed
// reasons in order and 0 toggles "Other", which opens a short text box (at most OTHER_MAX_WORDS words).
const pills = REASONS.map((r, i) => {
  const b = el("button", { type: "button", class: "pill", "aria-pressed": "false", "aria-keyshortcuts": String(i + 1) }, r.label);
  b.addEventListener("click", () => toggleReason(r.code));
  return b;
});
const otherPill = el("button", { type: "button", class: "pill", "aria-pressed": "false", "aria-keyshortcuts": "0", "aria-controls": "otherRow" }, OTHER_LABEL);
otherPill.addEventListener("click", () => toggleOther());
$("#pills").replaceChildren(...pills, otherPill);
const otherRow = $("#otherRow");
const otherText = $<HTMLInputElement>("#otherText");
const otherCount = $("#otherCount");
let otherOn = false;

function picked(): number {
  return chosen.size + (otherOn ? 1 : 0);
}

function renderPills(): void {
  const full = picked() >= MAX_REASONS;
  REASONS.forEach((r, i) => {
    const on = chosen.has(r.code);
    pills[i].setAttribute("aria-pressed", String(on));
    pills[i].disabled = full && !on;
  });
  otherPill.setAttribute("aria-pressed", String(otherOn));
  otherPill.disabled = full && !otherOn;
  show(otherRow, otherOn);
  $("#reasonsHint").textContent = full ? "Two chosen" : "If you like, up to two";
  renderCount();
}

function renderCount(): void {
  const n = wordCount(otherText.value);
  otherCount.textContent = `${n} of ${OTHER_MAX_WORDS} words`;
  otherCount.classList.toggle("over", n > OTHER_MAX_WORDS);
}

function toggleReason(code: ReasonCode): void {
  if (chosen.has(code)) chosen.delete(code);
  else if (picked() < MAX_REASONS) chosen.add(code);
  renderPills();
}

function toggleOther(): void {
  if (otherOn) otherOn = false;
  else if (picked() < MAX_REASONS) otherOn = true;
  renderPills();
  if (otherOn) otherText.focus();
}

otherText.addEventListener("input", renderCount);

function renderMe(): void {
  $("#who").textContent = me.role;
  show($("#boardLink"), me.unlocked);
}

function fill(prefix: "left" | "right", side: Side): void {
  $(`#${prefix}Stem`).textContent = side.stem;
  const ul = $(`#${prefix}Bullets`);
  ul.replaceChildren(...side.bullets.map((b) => el("li", {}, b)));
}

function frontier(): number {
  const i = pairs.findIndex((p) => p.answer === null);
  return i < 0 ? pairs.length : i;
}

/** Show pair i, with the answer already given to it, if any, filled in so it can be changed. */
function showPair(i: number): void {
  idx = i;
  const p = pairs[i];
  fill("left", p.left);
  fill("right", p.right);
  const a = p.answer;
  pick = isGiven(a) ? a.pick : null;
  closeBox.checked = isGiven(a) && a.closeCall;
  chosen.clear();
  if (isGiven(a)) a.reasons.forEach((r) => chosen.add(r));
  otherOn = isGiven(a) && a.other !== null;
  otherText.value = isGiven(a) ? (a.other ?? "") : "";
  renderPick();
  renderPills();
  const state = a === null ? "" : isGiven(a) ? ", answered" : ", skipped";
  $("#position").textContent = `Pair ${i + 1} of ${pairs.length}${state}`;
  const bar = $<HTMLProgressElement>("#bar");
  bar.max = pairs.length;
  bar.value = pairs.filter((x) => x.answer !== null).length;
  show($("#back"), i > 0);
  show($("#fwd"), a !== null);
  // A vote cannot become a skip; an unanswered or skipped pair can still be skipped past.
  show(skipBtn, !isGiven(a));
  // On a pair already answered, Forward leaves the answer as it was; only Next sends a change.
  show($("#saveHint"), isGiven(a));
  show(judge);
  show(between, false);
  shownAt = performance.now();
  window.scrollTo({ top: 0 });
  // The control that was just used (Next, Skip) may now be hidden, which drops keyboard focus to the top of the
  // document. Put it on the pair counter instead: neutral between A and B, and a screen reader reads the new place.
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active.closest("[hidden]")) $("#position").focus({ preventScroll: true });
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
  // Nothing is on screen yet on a first load; say so instead of showing an empty page.
  say(msg, judge.hidden && between.hidden ? "Loading the next pairs" : "");
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
  say(msg, "");
  if (b.done || !b.pairs.length) {
    show(judge, false);
    return say(msg, "You have judged every pair. Thank you.", "ok");
  }
  pairs = b.pairs;
  if (b.start >= pairs.length) batchDone();
  else showPair(b.start);
}

function batchDone(): void {
  show(judge, false);
  $("#betweenText").textContent = me.unlocked
    ? `You have cast ${me.votes} votes. Keep going, or stop and look at the leaderboard.`
    : `You have cast ${me.votes} votes. The leaderboard opens after ${me.unlockAt}.`;
  show(between);
  $("#betweenH").focus();
}

/** Choose a side, or change the choice. Nothing is sent yet: the reasons and Next appear below. */
function choose(kind: "L" | "R"): void {
  if (busy || !pairs.length) return;
  const first = pick === null;
  pick = kind;
  renderPick();
  if (first) renderPills();
}

function renderPick(): void {
  $("#pair").classList.toggle("chosen", pick !== null);
  $("#picks").classList.toggle("chosen", pick !== null);
  $("#leftCard").classList.toggle("selected", pick === "L");
  $("#rightCard").classList.toggle("selected", pick === "R");
  pickL.setAttribute("aria-pressed", String(pick === "L"));
  pickR.setAttribute("aria-pressed", String(pick === "R"));
  $("#whyText").textContent = pick === "R" ? "Why is B better?" : "Why is A better?";
  show(after, pick !== null);
}

/** After an answer: on to the first pair not yet answered, or the end of the batch. */
function advance(): void {
  const f = frontier();
  if (f < pairs.length) showPair(f);
  else batchDone();
}

async function answer(kind: "vote" | "skip"): Promise<void> {
  if (busy || !pairs.length) return;
  const p = pairs[idx];
  if (kind === "skip" && p.answer !== null) return advance(); // already answered: skipping just moves on
  if (kind === "vote" && !pick) return;
  if (kind === "vote" && otherOn && wordCount(otherText.value) > OTHER_MAX_WORDS) {
    say(msg, `Keep the Other reason to ${OTHER_MAX_WORDS} words.`, "error");
    otherText.focus();
    return;
  }
  say(msg, "");
  busy = true;
  [pickL, pickR, skipBtn, nextBtn].forEach((b) => (b.disabled = true));
  judge.classList.add("busy");
  const clientMs = Math.round(performance.now() - shownAt);
  const given: Given | null =
    kind === "vote" && pick ? { pick, closeCall: closeBox.checked, reasons: [...chosen], other: otherOn ? otherText.value : null } : null;
  try {
    let r: AfterAnswer;
    if (!given) r = await api<AfterAnswer>("/api/skip", { body: { pairId: p.pairId, clientMs } });
    else {
      // A first answer is a vote; changing an earlier answer (or voting on a skipped pair) is a correction.
      const path = p.answer === null ? "/api/vote" : "/api/correct";
      r = await api<AfterAnswer>(path, {
        body: {
          pairId: p.pairId,
          pick: given.pick,
          closeCall: given.closeCall,
          reasons: given.reasons,
          ...(given.other !== null ? { other: given.other } : {}),
          clientMs,
        },
      });
    }
    p.answer = given ?? { skipped: true };
    me.votes = r.votes;
    me.unlocked = r.unlocked;
    renderMe();
    advance();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return location.replace("/");
    if (err instanceof ApiError && err.body.error === "board_seen") {
      // The answer stays as it was (see /api/correct); put the saved answer back on screen.
      showPair(idx);
      say(msg, err.message, "warn");
    } else if (err instanceof ApiError && err.body.error === "batch_closed") {
      say(msg, "That batch is finished, so its answers can no longer change.", "warn");
      void loadBatch();
    } else if (err instanceof ApiError && err.status === 409) {
      show(judge, false);
      say(msg, "Voting just closed. Your earlier votes are saved.", "warn");
    } else say(msg, "That vote did not go through. Try again.", "error");
  } finally {
    busy = false;
    judge.classList.remove("busy");
    [pickL, pickR, skipBtn, nextBtn].forEach((b) => (b.disabled = false));
  }
}

pickL.addEventListener("click", () => choose("L"));
pickR.addEventListener("click", () => choose("R"));
nextBtn.addEventListener("click", () => void answer("vote"));
skipBtn.addEventListener("click", () => void answer("skip"));
$("#more").addEventListener("click", () => void loadBatch());
// Back and Forward move within this batch without sending anything; an answer changes only with Next.
$("#back").addEventListener("click", () => idx > 0 && showPair(idx - 1));
$("#fwd").addEventListener("click", () => (idx + 1 < pairs.length && pairs[idx].answer !== null ? showPair(idx + 1) : advance()));
$("#backFromDone").addEventListener("click", () => pairs.length && showPair(pairs.length - 1));

// Tapping anywhere on a question card chooses it, like its button; the vote still waits for Next. Ignored while text
// is selected (someone copying a line).
for (const [id, kind] of [["#leftCard", "L"], ["#rightCard", "R"]] as const) {
  $(id).addEventListener("click", () => {
    if (window.getSelection()?.toString()) return;
    choose(kind);
  });
}

document.addEventListener("keydown", (e) => {
  if (judge.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  const typing = t.tagName === "INPUT" && (t as HTMLInputElement).type === "text";
  // Enter sends the vote, from the Other box too. On a focused button, Enter already presses that button.
  // and on a focused link it follows the link.
  if (e.key === "Enter" && pick && t.tagName !== "BUTTON" && t.tagName !== "A") return (e.preventDefault(), void answer("vote"));
  if (typing) return;
  // Arrows and Enter always work; the letter and number keys can be switched off on the home page.
  if (!e.key.startsWith("Arrow") && !shortcutsOn()) return;
  if (e.key === "ArrowLeft") (e.preventDefault(), choose("L"));
  else if (e.key === "ArrowRight") (e.preventDefault(), choose("R"));
  else if (e.key === "s" || e.key === "S") (e.preventDefault(), void answer("skip"));
  else if (!pick) return;
  else if (e.key === "c" || e.key === "C") (e.preventDefault(), (closeBox.checked = !closeBox.checked));
  else if (e.key === "0") (e.preventDefault(), toggleOther());
  else if (/^[1-9]$/.test(e.key) && REASONS[Number(e.key) - 1]) (e.preventDefault(), toggleReason(REASONS[Number(e.key) - 1].code));
});

async function init(): Promise<void> {
  try {
    me = await api<Me>("/api/me");
  } catch {
    return location.replace("/");
  }
  renderMe();
  if (!me.open) return say(msg, "Voting is closed right now.", "warn");
  await loadBatch();
}

void init();
