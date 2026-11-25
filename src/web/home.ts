import { $, api, ApiError, say } from "./common";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
    };
  }
}

const form = $<HTMLFormElement>("#redeem");
const codeInput = $<HTMLInputElement>("#code");
const msg = $("#msg");
const go = $<HTMLButtonElement>("#go");
let token = "";
let widgetId: string | undefined;

/**
 * An invite link carries the code after "#" (https://host/#XXXX-XXXX-XXXX). Browsers never send that part to the
 * server. Take it, then wipe it from the address bar and history before any other script (Turnstile) loads.
 */
function codeFromLink(): string {
  const raw = decodeURIComponent(location.hash.slice(1)).trim();
  if (!raw) return "";
  history.replaceState(null, "", location.pathname + location.search);
  return /^[0-9A-Za-z][0-9A-Za-z -]{5,38}$/.test(raw) ? raw : "";
}
const linkCode = codeFromLink();
let autoTried = false;

async function redeem(): Promise<void> {
  const code = codeInput.value.trim();
  if (!code) {
    say(msg, "Enter your invite code.", "error");
    codeInput.focus();
    return;
  }
  if (!token) {
    say(msg, "Wait for the security check to finish, then press Start.", "warn");
    return;
  }
  go.disabled = true;
  say(msg, "");
  try {
    await api("/api/redeem", { body: { code, turnstileToken: token } });
    location.assign("/vote");
  } catch (err) {
    const m = err instanceof ApiError ? err.message : "Something went wrong. Try again.";
    say(msg, m, "error");
    token = "";
    window.turnstile?.reset(widgetId);
    go.disabled = false;
    codeInput.focus();
  }
}

async function start(): Promise<void> {
  if (linkCode) codeInput.value = linkCode;
  // Already signed in on this device: go straight to voting. An invite link signs in with its own code instead,
  // since the device may belong to someone else.
  if (!linkCode) try {
    await api("/api/me");
    location.replace("/vote");
    return;
  } catch {
    /* not signed in */
  }
  let sitekey = "";
  try {
    sitekey = (await api<{ turnstileSitekey: string }>("/api/config")).turnstileSitekey;
  } catch {
    say(msg, "This page cannot reach the server right now. Try again in a minute.", "error");
    go.disabled = true;
    return;
  }
  if (!sitekey) {
    say(msg, "Sign-in is not set up yet.", "warn");
    go.disabled = true;
    return;
  }
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  s.async = true;
  s.onload = () => {
    widgetId = window.turnstile?.render($("#turnstile"), {
      sitekey,
      callback: (t: string) => {
        token = t;
        // One tap: the link already supplied the code. Only once, so a wrong code cannot loop on every new token.
        if (linkCode && !autoTried) {
          autoTried = true;
          void redeem();
        }
      },
      "expired-callback": () => (token = ""),
      "error-callback": () => (token = ""),
    });
  };
  s.onerror = () => say(msg, "The security check did not load. Check your connection and reload.", "error");
  document.head.append(s);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void redeem();
});

void start();
