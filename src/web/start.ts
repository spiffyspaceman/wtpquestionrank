import { sliceLabel, type Slice } from "../worker/slice";
import { $, api, ApiError, CRITERION, FORMAT, setShortcuts, shortcutsOn, show, sliceBoxes } from "./common";

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

/** The "What you judge" panel: all questions, or some units and levels. Saved at once; it applies from the next batch. */
function setUpSlice(me: Me): void {
  const panel = $("#slicePanel");
  // On a first visit the count and Start button follow the task; the choice goes with them.
  $("#tally").after(panel);
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="sliceMode"]')];
  const boxes = sliceBoxes("judge", () => void save());
  $("#sliceBoxes").replaceChildren(boxes.el);
  const status = $("#sliceStatus");
  const mode = () => radios.find((r) => r.checked)?.value ?? "all";
  const pending = me.batch ? " The batch already waiting for you finishes as it was." : "";
  const describe = (s: Slice | null) =>
    s ? `You judge ${sliceLabel(s)}, from your next batch.${pending}` : `You judge all questions.${me.slice ? pending : ""}`;
  let saved = me.slice;
  const paint = () => {
    radios.forEach((r) => (r.checked = r.value === (saved ? "some" : "all")));
    boxes.set(saved);
    show($("#sliceBoxes"), Boolean(saved));
  };
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
    const some = mode() === "some";
    show($("#sliceBoxes"), some);
    const s = some ? boxes.read() : null;
    if (s === false) return void (status.textContent = "Tick at least one unit and one level.");
    try {
      const r = await api<{ slice: Slice | null }>("/api/slice", { body: s ? { units: s.units, levels: s.levels } : { all: true } });
      saved = r.slice;
      status.textContent = describe(saved);
      // Everything ticked is the same as all questions.
      if (!saved && some) paint();
    } catch (err) {
      status.textContent = err instanceof ApiError ? err.message : "That did not save. Try again.";
    }
  }
  radios.forEach((r) =>
    r.addEventListener("change", () => {
      // Moving to "Only some units" starts from everything ticked, so nothing changes until a box is cleared.
      if (mode() === "some" && !saved) {
        boxes.set(null);
        show($("#sliceBoxes"));
        status.textContent = "Clear the units or level you would rather not judge.";
        return;
      }
      void save();
    }),
  );
  paint();
  status.textContent = saved ? describe(saved).replace(", from your next batch", "") : "";
  show(panel);
}

void init();
