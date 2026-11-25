import { $, api, CRITERION, FORMAT, show } from "./common";

interface Me {
  role: string;
  votes: number;
  unlockAt: number;
  unlocked: boolean;
  round: { name: string; state: string } | null;
  batch: { size: number; remaining: number } | null;
}

$("#format").textContent = FORMAT;
$("#criterion").textContent = CRITERION;

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

  const open = me.round?.state === "open";
  $("#roundLine").textContent = me.round ? `${me.round.name}${open ? "" : ", voting closed"}` : "No round yet";

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

void init();
