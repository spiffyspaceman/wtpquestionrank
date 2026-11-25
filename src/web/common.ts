// Shared browser helpers. No third-party code.

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.message ?? body.error ?? `HTTP ${status}`));
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET");
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : init.raw ? { "content-type": "application/octet-stream" } : {},
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error("missing element " + sel);
  return el;
}

/** Create an element with text content. Never sets innerHTML from data. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export function show(node: HTMLElement, on = true): void {
  node.hidden = !on;
}

export function say(node: HTMLElement, text: string, kind: "" | "warn" | "error" | "ok" = ""): void {
  node.textContent = text;
  node.className = "notice" + (kind ? " " + kind : "");
  node.hidden = !text;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Single-key shortcuts (S, C, 0-9) can be switched off on the home page; the choice stays in this browser only.
const KEYS_OFF = "wtpqr-keys-off";
export function shortcutsOn(): boolean {
  try {
    return localStorage.getItem(KEYS_OFF) !== "1";
  } catch {
    return true;
  }
}
export function setShortcuts(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEYS_OFF);
    else localStorage.setItem(KEYS_OFF, "1");
  } catch {
    /* storage unavailable: shortcuts stay on */
  }
}

// ---------- day and night ----------

/** True when the page is showing its night colours, by the reader's choice or the device's setting. */
function isNight(): boolean {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Wire the masthead toggle, if the page has one. The button names the scheme it switches to. */
export function initTheme(): void {
  const b = document.querySelector<HTMLButtonElement>("#themeToggle");
  if (!b) return;
  const label = () => (b.textContent = isNight() ? "Day" : "Night");
  label();
  b.addEventListener("click", () => {
    const next = isNight() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("wtpqr-theme", next);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
    label();
  });
  // With no stored choice the page follows the device, so the label follows it too.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", label);
}
initTheme();

// ---------- published footnotes (owner decision, 25 Nov 2026) ----------

/** A footnote as the server sends it: text pieces, each with a link target or null. */
export interface ShownNote {
  mark: string;
  parts: [string, string | null][];
}
export type Marks = [number, number, string][];

/** A question's text with its footnote markers set back in, as superscripts, where CCE printed them. */
export function marked(text: string, part: number, marks: Marks | undefined): (Node | string)[] {
  const here = (marks ?? []).filter((m) => m[0] === part && m[1] > 0 && m[1] <= text.length).sort((a, b) => a[1] - b[1]);
  const out: (Node | string)[] = [];
  let last = 0;
  for (const [, at, mark] of here) {
    out.push(text.slice(last, at), el("sup", { class: "fnmark" }, mark));
    last = at;
  }
  out.push(text.slice(last));
  return out;
}

/** The footnotes under a question, or null when it has none. Web addresses that were checked are links. */
export function footnotes(notes: ShownNote[] | undefined): HTMLElement | null {
  if (!notes?.length) return null;
  return el(
    "div",
    { class: "fnotes" },
    ...notes.map((n) =>
      el(
        "p",
        {},
        el("span", { class: "fnmark" }, n.mark),
        " ",
        ...n.parts.map(([text, href]) => (href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text) : text)),
      ),
    ),
  );
}

export const CRITERION =
  "Which is the better hearing question: the one that more clearly lets a panel separate a strong, well-prepared team from a weak one, across a 4-minute opening and 6–10 minutes of follow-up?";

/** The hearing format, as the LLM judges were given it (llm-arm packet). */
export const FORMAT =
  "In a We the People simulated congressional hearing, a unit of high school students answers one published hearing question. They give a prepared opening statement of about 4 minutes. A panel of judges then asks follow-up questions for 6 to 10 minutes and scores the team. Each question has a main prompt (the stem) and two follow-up bullets.";
