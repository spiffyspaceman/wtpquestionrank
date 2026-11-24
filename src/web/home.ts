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

async function start(): Promise<void> {
  // Already signed in on this device: go straight to voting.
  try {
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
      callback: (t: string) => (token = t),
      "expired-callback": () => (token = ""),
      "error-callback": () => (token = ""),
    });
  };
  s.onerror = () => say(msg, "The security check did not load. Check your connection and reload.", "error");
  document.head.append(s);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
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
});

void start();
