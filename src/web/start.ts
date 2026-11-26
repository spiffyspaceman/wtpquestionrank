import type { Slice } from "../worker/slice";
import { $, api, ApiError, CRITERION, FORMAT, setName, setShortcuts, shortcutsOn, show, slicePicker } from "./common";

interface Me {
  role: string;
  votes: number;
  unlockAt: number;
  unlocked: boolean;
  open: boolean;
  /** What this judge chose to judge; null for all questions. */
  slice: Slice | null;
  /** No round is open and none is waiting to open. */
  ended: boolean;
  batch: { size: number; remaining: number } | null;
}

$("#format").textContent = FORMAT;
$("#criterion").textContent = CRITERION;

const keysOn = $<HTMLInputElement>("#keysOn");
keysOn.checked = shortcutsOn();
keysOn.addEventListener("change", () => setShortcuts(keysOn.checked));

// Sign out on this device only. Whatever the answer, the sign-in page is the place to land.
$("#signOut").addEventListener("click", () => {
  void api("/api/signout", { body: {} })
    .catch(() => undefined)
    .then(() => location.replace("/"));
});

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

async function init(): Promise<void> {
  let me: Me;
  try {
    me = await api<Me>("/api/me");
  } catch {
    return location.replace("/");
  }
  $("#who").textContent = me.role;
  show($("#boardLink"), me.unlocked);
  $("#votes").textContent = String(me.votes);
  $("#votesWord").textContent = plural(me.votes, "pair judged", "pairs judged");

  const open = me.open;
  $("#roundLine").textContent = open ? "" : me.ended ? "Voting has ended. Thank you for your votes." : "Voting has not opened yet.";

  const unlock = $("#unlockLine");
  if (me.unlocked) {
    unlock.replaceChildren("The leaderboard is open to you. ", Object.assign(document.createElement("a"), { href: "/board", textContent: "See it" }), ".");
  } else {
    const left = me.unlockAt - me.votes;
    unlock.textContent = `The leaderboard opens after ${me.unlockAt} pairs: ${left} to go.`;
    const bar = $<HTMLProgressElement>("#unlockBar");
    bar.max = me.unlockAt;
    bar.value = me.votes;
    show($("#unlockMeter"));
  }

  const start = $<HTMLAnchorElement>("#startBtn");
  // A first visit: what the task is comes before the button that starts it (owner decision, 25 Nov 2026). The words
  // are the same; the count of zero and its meter are left out. The button follows the task itself and comes before
  // the longer guidance, so it is not far down the page (owner decision, 25 Nov 2026).
  if (me.votes === 0 && open) {
    $("#task").after($("#tally"));
    show($("#tallyH"), false);
    show($("#unlockMeter"), false);
    unlock.textContent = `The leaderboard opens after ${me.unlockAt} pairs.`;
    const h = $("#taskH");
    h.classList.add("h1");
    h.setAttribute("role", "heading");
    h.setAttribute("aria-level", "1");
    $("#page").classList.add("first-visit");
  }
  show($("#page"));
  if (open) setUpSlice(me);
  if (!open) {
    show(unlock, me.unlocked);
    return;
  }
  // A batch left part-way through (closed tab, another device) is waiting where it stopped.
  if (me.batch && me.batch.remaining < me.batch.size) {
    const r = me.batch.remaining;
    $("#resumeLine").textContent = `Your last batch has ${r} ${plural(r, "pair", "pairs")} left.`;
    show($("#resumeLine"));
    start.textContent = "Continue your batch";
  }
  show(start);
}

/**
 * "Narrow your set": all questions, or some units and levels (owner decisions, 26 Nov 2026). It sits directly above
 * the Start button, and the button names the set it starts. A change saves at once; if a batch is waiting, the rest
 * of it is set aside so the next batch follows the new set (the answers already given stay).
 */
function setUpSlice(me: Me): void {
  const panel = $("#slicePanel");
  $("#tally .actions").before(panel);
  const start = $<HTMLAnchorElement>("#startBtn");
  const status = $("#sliceStatus");
  let saved = me.slice;
  let waiting = Boolean(me.batch && me.batch.remaining < me.batch.size);
  const label = () => (waiting ? "Continue your batch" : `Start a batch: ${setName(saved)}`);
  const picker = slicePicker("judge", (part) => {
    // Moving to "Only some units" opens the boxes with everything ticked; nothing changes until one is cleared.
    if (part === "mode" && picker.mode() === "some" && !saved) {
      picker.set(null, true);
      status.textContent = "Clear the units or level you would rather not judge.";
      return;
    }
    void save();
  });
  $("#slicePicker").replaceChildren(picker.el);
  // One save at a time, the latest choice last: quick changes on a slow connection must not land out of order.
  let saving = false;
  let again = false;
  async function save(): Promise<void> {
    if (saving) return void (again = true);
    saving = true;
    try {
      do {
        again = false;
        await saveOnce();
      } while (again);
    } finally {
      saving = false;
    }
  }
  async function saveOnce(): Promise<void> {
    const s = picker.read();
    if (s === false) return void (status.textContent = "Tick at least one unit and one level.");
    try {
      const r = await api<{ slice: Slice | null; ended: number }>("/api/slice", { body: s ? { units: s.units, levels: s.levels, bridge: Boolean(s.bridge) } : { all: true } });
      saved = r.slice;
      let note = `Your set: ${setName(saved)}.`;
      if (r.ended) {
        waiting = false;
        show($("#resumeLine"), false);
        note += " Your waiting batch was set aside; any answers you gave in it stay.";
      }
      status.textContent = note;
      start.textContent = label();
      // Everything ticked is the same as all questions.
      if (!saved && picker.mode() === "some") picker.set(null);
    } catch (err) {
      status.textContent = err instanceof ApiError ? err.message : "That did not save. Try again.";
    }
  }
  picker.set(saved);
  start.textContent = label();
  show(panel);
}

void init();
