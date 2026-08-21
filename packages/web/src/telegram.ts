/**
 * The Telegram Mini App bridge, hand-written, with no script from anybody else.
 *
 * This app opens inside Telegram as a mini app, where the client draws its own
 * floating control top-left: **✕ Close** by default, and **‹ Back** instead once
 * the page asks for one. Asking is the whole of what this module does, so the
 * session list closes the app and a conversation goes back to the list — reported
 * from a phone, where Close was the only option at every depth.
 *
 * **No `telegram-web-app.js`, and two independent reasons.** The document is
 * served `script-src 'self'`, so a CDN script is refused before it runs; and
 * nothing in this repository loads code from anywhere else. Neither is a
 * limitation here, because that script is a **wrapper**: on iOS and Android
 * Telegram injects the transport itself as `TelegramWebviewProxy`, and the SDK's
 * whole job on this path is `JSON.stringify` plus a version check. Verified
 * against the real file rather than from memory — see the shapes below.
 *
 * **Owning `window.Telegram` is safe here for the same reason.** Telegram
 * delivers events by *calling* `window.Telegram.WebView.receiveEvent`, so
 * something must define it; normally that is the SDK. Under `script-src 'self'`
 * the SDK can never load, so there is no second writer to collide with. If that
 * header is ever relaxed, this becomes a real collision and the remedy is to
 * stop defining it and read theirs.
 *
 * **The iframe transport is deliberately absent.** Telegram Desktop and Web embed
 * a mini app in an `<iframe>` and expect `window.parent.postMessage`; the control
 * plane sends `frame-ancestors 'none'` and `X-Frame-Options`, so those clients
 * cannot load this page at all and the arm would be unreachable code. Adding it is
 * the *second* half of allowing Telegram to frame a document whose purpose is
 * approving shell commands with a tap — see the CSP's own docblock. Do both or
 * neither.
 *
 * Everything here answers "not in Telegram" in an ordinary browser, so nothing
 * below runs and nothing changes.
 */

/** What Telegram injects into its own webview, and nothing else does. */
interface Proxy {
  postEvent?: (eventType: string, eventData: string) => void;
}

interface TelegramGlobal {
  WebView?: { receiveEvent?: (eventType: string, eventData?: unknown) => void };
}

function proxy(): Proxy | null {
  const held = (window as unknown as { TelegramWebviewProxy?: Proxy }).TelegramWebviewProxy;
  return typeof held?.postEvent === "function" ? held : null;
}

/**
 * Whether this page is running inside Telegram at all.
 *
 * Keyed on the transport being there rather than on the launch parameters, which
 * is the narrower and more honest test: what everything below needs is somewhere
 * to post to, and a hash somebody pasted is not that.
 */
export function inTelegram(): boolean {
  return proxy() !== null;
}

/**
 * The mini-app API version this client speaks, or `null` outside Telegram.
 *
 * Read from `tgWebAppVersion` in the launch hash, which is where Telegram puts
 * it. Parsed defensively for `router.ts`'s reason one module over: this runs
 * during startup, and a malformed hash somebody pasted must produce a `null`
 * rather than an exception nothing catches.
 *
 * ⚠ It shares the fragment with the mailed-link tokens, and they do not collide:
 * `readGateToken` accepts only a `t=` parameter whose value is token-shaped, and
 * Telegram writes `tgWebApp*` names.
 */
export function telegramVersion(): string | null {
  try {
    const raw = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    return new URLSearchParams(raw).get("tgWebAppVersion");
  } catch {
    return null;
  }
}

/**
 * Whether this client is new enough for a feature, by Telegram's own rule.
 *
 * Segment-wise on integers, so `6.10` is above `6.9` — a string compare answers
 * the opposite, and the back button's own gate is `6.1`. A version that will not
 * parse counts as **too old**: refusing a control is a control that is not there,
 * while asking an old client for one is a request it answers by doing nothing,
 * which is a back button drawn nowhere and a page that thinks it has one.
 */
export function versionAtLeast(version: string | null, wanted: string): boolean {
  if (version === null) return false;
  const mine = version.split(".");
  const theirs = wanted.split(".");
  for (let at = 0; at < Math.max(mine.length, theirs.length); at += 1) {
    const a = Number.parseInt(mine[at] ?? "0", 10);
    const b = Number.parseInt(theirs[at] ?? "0", 10);
    if (!Number.isFinite(a)) return false;
    if (a !== b) return a > b;
  }
  return true;
}

/** Bot API 6.1, which is where `web_app_setup_back_button` starts existing. */
const BACK_BUTTON_SINCE = "6.1";

function post(eventType: string, eventData: unknown = {}): void {
  const held = proxy();
  if (held === null) return;
  try {
    held.postEvent?.(eventType, JSON.stringify(eventData));
  } catch {
    // The bridge is somebody else's code in somebody else's webview. A throw
    // here must cost the chrome and never the app: every caller is decoration.
  }
}

/**
 * Tell Telegram the page is up, so it takes its loading placeholder away.
 *
 * Fired once, from `main.tsx`, and unconditional past `inTelegram` — an app that
 * never says this is one Telegram keeps a spinner over.
 */
export function telegramReady(): void {
  post("web_app_ready");
}

/** Callers of the back button, so a press reaches whatever is on screen now. */
let onBack: (() => void) | null = null;
let listening = false;

/**
 * Start receiving events, by defining the function Telegram calls.
 *
 * Idempotent, and installed lazily on the first `setTelegramBack` rather than at
 * import: a module body that writes a global on a page that is not in Telegram is
 * a global nobody asked for.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  const global = window as unknown as { Telegram?: TelegramGlobal };
  const existing = global.Telegram ?? {};
  const view = existing.WebView ?? {};
  const previous = view.receiveEvent;
  view.receiveEvent = (eventType: string, eventData?: unknown): void => {
    // Chained rather than replaced. Nothing else defines this today — see the
    // docblock — and a handler that silently drops somebody else's events is the
    // kind of thing that is only ever found much later.
    previous?.(eventType, eventData);
    if (eventType === "back_button_pressed") onBack?.();
  };
  existing.WebView = view;
  global.Telegram = existing;
}

/**
 * Show or hide Telegram's back button, and say what a press does.
 *
 * `null` hides it, which is what makes the client draw **Close** again — the two
 * are one control and one call, so "Close on the list, Back inside" is this
 * function being given `null` at the root and a destination everywhere else.
 *
 * The handler is replaced rather than accumulated: there is one back button and
 * one screen under it, and a stack of stale closures is how a press ends up
 * navigating to where you were three screens ago.
 */
export function setTelegramBack(go: (() => void) | null): void {
  if (!inTelegram()) return;
  if (!versionAtLeast(telegramVersion(), BACK_BUTTON_SINCE)) return;
  listen();
  onBack = go;
  post("web_app_setup_back_button", { is_visible: go !== null });
}
