import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { parseGateScreen, type GateScreen } from "./gate";
import { machineId, sessionId, type MachineId, type SessionRef } from "./ids";
import { navMove } from "./nav";
import { parseSettingsRoute, type SettingsRoute } from "./settings";
import { isOverlayPath } from "./ui/overlay";

/**
 * Four screens, so four lines of routing.
 *
 * The one thing that matters here is that `/m/:machineId/s/:sessionId` is parsed
 * in exactly one place, into a `SessionRef`. A route carrying a bare session id
 * would be the easiest way to reintroduce the collision `ids.ts` exists to
 * prevent — the URL is the one part of an app that is routinely handled as a
 * string — so the machine is in the path and the two are branded the moment they
 * come out of it.
 */

export type Route =
  | { name: "home" }
  | { name: "session"; ref: SessionRef }
  /**
   * `/new`, optionally `/new/:machineId`.
   *
   * The machine rides the URL rather than component state so "new session here"
   * from a machine section lands on a screen that has already chosen — and so that
   * going back and forward again does not silently forget which one you meant.
   */
  | { name: "new"; machineId: MachineId | null; cwd: string | null }
  /**
   * `/settings`, optionally `/settings/:section`.
   *
   * The section rides the URL rather than component state for the same reason the
   * machine does on `new`, plus one specific to this screen: `Header`'s close has
   * a fixed destination, so a section needs a list to close *to*. With component
   * state the ✕ inside "Change password" would either leave settings entirely or
   * become a second, section-scoped close — which is `history.back()` wearing a
   * hat, the exact control `Header.tsx` argues against. It also survives a reload,
   * which matters because a phone routinely discards this page mid-flow — the
   * reason `AgentCard` already keeps a `sessionStorage` reattach key.
   *
   * Two segments deeper under `machines`, since agent settings moved inside a
   * machine: `/settings/machines/:machineId/agents/:agentId`. Every rule about
   * those is in `settings.ts` rather than here, so this stays four lines and
   * `webcheck` — which cannot import this file at all, because the module body
   * touches `window.location` — can assert all of them.
   */
  | ({ name: "settings" } & SettingsRoute)
  /**
   * `/register`, `/confirm`, `/forgot`, `/reset`, `/verify`.
   *
   * The token these carry is **not here**: it rides the URL fragment, which
   * `window.location.pathname` does not contain and which therefore never
   * reaches the server, any proxy log, or a mail scanner that follows the link.
   * The screen reads it with `readGateToken(location.hash)`. Every rule about
   * these URLs lives in `gate.ts`, for the reason `settings.ts` gives: this
   * module cannot be imported by `webcheck` at all.
   */
  | { name: "gate"; screen: GateScreen };

/**
 * `decodeURIComponent`, for a segment nobody here wrote.
 *
 * It throws `URIError` on a lone `%` — `decodeURIComponent("s_1234%")` is
 * "URI malformed" — and `parse` runs in this module's body, before React ever
 * mounts. So one truncated link pasted out of a chat app, or a stray `%` typed
 * into the bar, took down the whole ES module graph: the control plane's SPA
 * fallback correctly served `index.html`, the bundle loaded, and `#root` stayed
 * empty. A blank white page with no error and no console, on a phone, that a
 * reload cannot fix — which is the exact symptom the SPA fallback was changed to
 * remove, arriving by another door.
 *
 * A segment that will not decode is kept as written. It is still a perfectly
 * usable string: it simply names no machine and no session, so the route falls
 * through to home, which is what a nonsense URL should do.
 */
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * A path as a route, for a caller that has one in hand rather than in the bar.
 *
 * Exported for exactly one reader: `App` draws the background of an open pop-up
 * from the path `history.state` recorded, and that path is a string. Everything
 * else asks `useRoute`.
 */
export function parsePath(pathname: string): Route {
  return parse(pathname);
}

function parse(pathname: string): Route {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts[0] === "new") {
    /*
     * A third segment, and it is a whole absolute path in one of them.
     *
     * `encodeURIComponent` turns its slashes into `%2F`, so a POSIX path is one
     * segment however deep it is and `parts` cannot mis-split on it. It goes in
     * the **path** rather than a query for the reason the machine id does:
     * `parse` reads `window.location.pathname` and nothing else, so a query
     * string would be a second source of route state that `under`, back and
     * forward all have to be taught about separately.
     */
    return {
      name: "new",
      machineId: parts[1] === undefined ? null : machineId(decodeSegment(parts[1])),
      cwd: parts[2] === undefined ? null : decodeSegment(parts[2]),
    };
  }
  const gate = parseGateScreen(parts);
  if (gate !== null) return { name: "gate", screen: gate };
  if (parts[0] === "settings") {
    // `decodeSegment` is passed in rather than applied here, so the one place
    // that knows a segment may not decode stays the one place.
    return { name: "settings", ...parseSettingsRoute(parts.slice(1), decodeSegment) };
  }
  if (parts[0] === "m" && parts[1] !== undefined && parts[2] === "s" && parts[3] !== undefined) {
    return {
      name: "session",
      ref: {
        machineId: machineId(decodeSegment(parts[1])),
        sessionId: sessionId(decodeSegment(parts[3])),
      },
    };
  }
  return { name: "home" };
}

/**
 * The URL now answers two questions, and the second one is what makes a pop-up a
 * pop-up.
 *
 * `/settings…` and `/new/:machineId` are drawn as overlays over whatever you were
 * looking at, so something has to remember *what was underneath* — otherwise the
 * ✕ has nowhere to go but `/`, and closing settings from a session drops you back
 * to the list you did not ask for.
 *
 * It lives in `history.state` rather than in a module variable or `sessionStorage`
 * because it is **per history entry**, which is the only store that survives Back,
 * Forward *and* a reload. It is also the argument `pushState` was already passing
 * as `null`, so this is one value changing rather than a mechanism arriving.
 */
interface Location {
  route: Route;
  /** The path the overlay is drawn over. `/` on a cold deep link. */
  under: string;
}

const listeners = new Set<() => void>();

function readUnder(): string {
  const state = window.history.state as { under?: unknown } | null;
  return typeof state?.under === "string" && state.under.length > 0 ? state.under : "/";
}

function read(): Location {
  return { route: parse(window.location.pathname), under: readUnder() };
}

let current: Location = read();

function tell(): void {
  for (const listener of listeners) listener();
}

/** Which navigation owns `data-nav` right now. See {@link announce}. */
let navToken = 0;

/**
 * A screen replacing another one **moves**, on a phone.
 *
 * Opening a conversation used to be a swap: the list was there and then it was
 * not, with nothing saying which way you had gone or that going back was a
 * direction at all. Every app a phone already has answers that with motion, and
 * the answer is not decoration — it is the only thing distinguishing "I went
 * somewhere" from "the screen changed".
 *
 * **Through the browser's own view transitions, and the alternative is why.** The
 * hand-rolled way is to hold the outgoing screen mounted while it animates out,
 * which here means two `SessionBrowser`s, or a second `SessionView` running its
 * `openSession` effect against the socket LRU, for the length of an animation —
 * paid on every navigation, to draw one that is over in 220ms. The browser
 * snapshots the old frame instead: nothing is mounted twice, `App` still unmounts
 * synchronously, and `AppShell`'s rule that no breakpoint may be read in
 * JavaScript is untouched, because **which widths animate is decided in CSS** by
 * the rules keyed on `data-nav`.
 *
 * Three ways this declines, and each leaves exactly today's behaviour:
 *
 * - **Nothing moves.** `navMove` answers `null` for a session-to-session move,
 *   and for opening a sheet — which `SHEET_PANEL`'s own CSS animates without a
 *   snapshot, on every engine. Nothing is captured at all, so the desktop rail's
 *   ordinary use pays nothing.
 * - **No support.** `startViewTransition` is absent on older engines. Read at the
 *   navigation and thrown away, the `shouldFocusComposer` idiom, so nothing can
 *   go stale.
 * - **Reduced motion.** Read the same way, and it skips rather than animating to
 *   zero: the block at the foot of `index.css` collapses durations with a `*`
 *   selector, and `*` does not reach `::view-transition-*` — but more to the
 *   point, somebody who asked for no motion should not be paying for a snapshot
 *   either.
 *
 * `flushSync` is required rather than defensive: the callback has to leave the
 * DOM in its new state before it returns, and every subscriber here is a
 * `useSyncExternalStore` whose update React would otherwise schedule. It runs
 * inside the transition's own callback, which the browser invokes off the event
 * handler, so this is not a flush from inside a lifecycle.
 *
 * The attribute is cleared on `finished`, **and only by the navigation that wrote
 * it.** A second tap during the first animation is ordinary rather than exotic —
 * the browser skips the running transition and starts another — and both
 * `finished` promises then settle, in the order they were made. Without the
 * token, the first one's cleanup deletes the *second* one's attribute while it is
 * still travelling, and that navigation finishes with no rule matching: the new
 * screen appears with the old one still snapshotted over it, which reads as the
 * app having frozen rather than as a missing animation. Cleared on rejection as
 * well as fulfilment, so a transition that fails leaves nothing on the document.
 */
function announce(): void {
  const previous = current.route;
  current = read();
  const move = navMove(previous, current.route);
  if (
    move === null ||
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    tell();
    return;
  }
  const root = document.documentElement;
  const token = (navToken += 1);
  root.dataset["nav"] = move;
  const clear = (): void => {
    if (navToken !== token) return;
    delete root.dataset["nav"];
  };
  document.startViewTransition(() => {
    flushSync(tell);
  }).finished.then(clear, clear);
}

window.addEventListener("popstate", announce);

/**
 * What an overlay opened at `target` is drawn over.
 *
 * Carried **forward** when one overlay opens another, which is the case that
 * decides the shape: `/new` → "Add a machine" → `/settings/machines` must keep the
 * *session* underneath rather than stacking `/new` under settings, or closing the
 * second pop-up reopens the first one over a screen nobody asked for.
 */
function underFor(target: string): string {
  if (!isOverlayPath(target)) return "/";
  const here = window.location.pathname;
  return isOverlayPath(here) ? readUnder() : here;
}

export function navigate(path: string, replace = false): void {
  const under = underFor(path);
  if (replace) window.history.replaceState({ under }, "", path);
  else window.history.pushState({ under }, "", path);
  announce();
}

export function newPath(machine?: MachineId, cwd?: string): string {
  if (machine === undefined) return "/new";
  const base = `/new/${encodeURIComponent(machine)}`;
  // A folder without a machine is not expressible and should not be: the picker
  // it seeds is a listing of *that daemon's* filesystem.
  return cwd === undefined ? base : `${base}/${encodeURIComponent(cwd)}`;
}

export function sessionPath(ref: SessionRef): string {
  return `/m/${encodeURIComponent(ref.machineId)}/s/${encodeURIComponent(ref.sessionId)}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current.route);
}

/**
 * The path an open overlay is drawn over — where its ✕ goes.
 *
 * Deliberately **not** `history.back()`, which `Header.tsx` deleted for reasons
 * that hold twice as hard here: on a cold deep link to `/settings` there is
 * exactly one history entry, so Back would leave the app entirely. This is a fixed
 * destination computed when the overlay opened, which is the same rule
 * `Header`'s `closeTo` always followed — it just knows a better answer now than
 * the constant `/` it used to be given.
 *
 * Android's Back button is a *different* control and needs no code: the overlay is
 * a real route, so Back pops the entry that opened it and the sheet unmounts. That
 * is the entire payoff of keeping these as URLs.
 */
export function useUnder(): string {
  return useSyncExternalStore(subscribe, () => current.under);
}
