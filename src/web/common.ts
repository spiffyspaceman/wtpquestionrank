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

export const CRITERION =
  "Which is the better hearing question: the one that more clearly lets a panel separate a strong, well-prepared team from a weak one, across a 4-minute opening and 6–10 minutes of follow-up?";

/** The hearing format, as the LLM judges were given it (llm-arm packet). */
export const FORMAT =
  "In a We the People simulated congressional hearing, a unit of high school students answers one published hearing question. They give a prepared opening statement of about 4 minutes. A panel of judges then asks follow-up questions for 6 to 10 minutes and scores the team. Each question has a main prompt (the stem) and two follow-up bullets.";
