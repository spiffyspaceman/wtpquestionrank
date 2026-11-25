// Sign-up by email through the owner's sign-up link (owner decision, 25 Nov 2026). The page asks for the email
// alone; an address that has signed up before is signed in at once, and only a new one is asked for a name and a
// role (owner decision, 25 Nov 2026).
import { $, api, ApiError, say, show } from "./common";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
    };
  }
}

const form = $<HTMLFormElement>("#join");
const email = $<HTMLInputElement>("#email");
const nameBox = $<HTMLInputElement>("#name");
const msg = $("#msg");
const go = $<HTMLButtonElement>("#go");
let token = "";
let widgetId: string | undefined;

/**
 * The sign-up link carries its word after "#" (https://host/join#XXXX-XXXX-XXXX), which browsers never send to the
 * server. Take it, then wipe it from the address bar and history before any other script (Turnstile) loads.
 */
function wordFromLink(): string {
  let raw = "";
  try {
    raw = decodeURIComponent(location.hash.slice(1)).trim();
  } catch {
    // A mangled link (a stray "%"): treat it as no link at all, and still clear it from the address bar below.
    raw = location.hash.length > 1 ? "?" : "";
  }
  if (!raw) return "";
  history.replaceState(null, "", location.pathname + location.search);
  return /^[0-9A-Za-z][0-9A-Za-z -]{5,38}$/.test(raw) ? raw : "";
}
const word = wordFromLink();

const profile = $("#profile");

async function join(): Promise<void> {
  const asking = !profile.hidden;
  const role = asking ? form.querySelector<HTMLInputElement>('input[name="role"]:checked')?.value : undefined;
  if (!email.value.trim() || !email.checkValidity()) {
    say(msg, "Enter your email address.", "error");
    email.focus();
    return;
  }
  if (asking && !role) {
    say(msg, "Choose the role that fits you best.", "error");
    form.querySelector<HTMLInputElement>('input[name="role"]')?.focus();
    return;
  }
  if (!token) {
    say(msg, "Wait for the security check to finish, then press the button again.", "warn");
    return;
  }
  go.disabled = true;
  say(msg, "");
  try {
    const r = await api<{ needProfile?: boolean }>("/api/join", {
      body: { word, email: email.value.trim(), ...(asking ? { name: nameBox.value.trim(), role } : {}), turnstileToken: token },
    });
    if (r.needProfile) {
      // A new address: ask for the rest. The check token is good for one request, so a fresh one is fetched.
      show(profile);
      go.textContent = "Sign up and start";
      token = "";
      window.turnstile?.reset(widgetId);
      go.disabled = false;
      $("#profileNote").focus();
      return;
    }
    location.assign("/start");
  } catch (err) {
    say(msg, err instanceof ApiError ? err.message : "Something went wrong. Try again.", "error");
    token = "";
    window.turnstile?.reset(widgetId);
    go.disabled = false;
  }
}

async function start(): Promise<void> {
  // Already signed in on this device: nothing to sign up for.
  try {
    await api("/api/me");
    location.replace("/start");
    return;
  } catch {
    /* not signed in */
  }
  if (!word) {
    show(form, false);
    say(msg, "This page opens from the sign-up link you were sent. If you have already signed up, sign in with your email on the front page.", "warn");
    return;
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
    say(msg, "Sign-up is not set up yet.", "warn");
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

// The message about a missing answer stays until the next press of the button: taking it away as soon as a field
// changes moves the form up under the pointer, and the tap then lands on the wrong role.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  void join();
});

// A link pasted into this same tab changes only the part after "#", which does not reload the page: reload, so the
// link is read like any other.
window.addEventListener("hashchange", () => location.reload());

void start();
