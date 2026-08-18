import { store } from "./store";

/**
 * Noticing that the phone woke up.
 *
 * This file holds only the detection. Everything that *happens* on a wake lives
 * in `store.resume()`, as one sequence, on purpose — the failure mode this avoids
 * is four half-recoveries racing each other from four different effects.
 *
 * Four triggers, because no single one of them is reliable:
 *
 *   - `visibilitychange` fires when the tab comes back, but not when the phone
 *     wakes with the tab already foregrounded. It is also the *noisiest* of the
 *     four — a desktop delivers it every time you glance at another tab — so it
 *     only counts as a wake once the tab has been away long enough for anything
 *     to have gone stale; below that it asks for a single poll instead.
 *   - `pageshow` with `persisted` catches a bfcache restore, which is how Safari
 *     on iOS returns to a page — with every socket dead and no event on any of
 *     them saying so.
 *   - `online` catches a network change, and lies often enough in both directions
 *     that it can only ever be one signal among several.
 *   - the wall-clock watchdog catches everything else, and is the only one that
 *     actually fires for a locked phone: JavaScript is frozen, no event is
 *     delivered, and the sole evidence that time passed is that it did.
 *
 * All four are the same event as far as this client is concerned, which is why
 * they all call the same function and it coalesces.
 */

/**
 * A tick this far apart means we were not running in between.
 *
 * The interval is 1s, so anything past 5s is a suspension rather than jitter — a
 * busy main thread on a phone can lose a second or two, and treating that as a
 * wake would re-mint tokens for no reason.
 */
const SUSPEND_THRESHOLD_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 1_000;

/**
 * Coalescing window.
 *
 * Unlocking a phone delivers visibilitychange, pageshow and online within a few
 * milliseconds of each other. Without this, one wake is three resumes and three
 * tokens per machine.
 */
const COALESCE_MS = 250;

/**
 * How long the tab must have been hidden for coming back to count as a *wake*.
 *
 * Below this it is a tab switch, and a tab switch breaks nothing: tokens live
 * 300s and are refreshed at `exp − 90s`, sockets keep running while hidden and
 * rotate on their own timer, and routes do not change because a different tab
 * had focus. Only the four-second poll is paused, so the correct response is one
 * poll — not re-reading the registry from the control plane, re-minting a token
 * per machine, re-probing every route and reconnecting every socket, which is
 * what a full resume does and what made switching tabs look like a page reload.
 *
 * Comfortably under the token refresh margin, so nothing can expire inside it.
 */
const WAKE_AFTER_HIDDEN_MS = 20_000;

export function installWakeDetection(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastTick = Date.now();
  /** When the tab was last hidden, or null while it is visible. */
  let hiddenAt: number | null = document.visibilityState === "visible" ? null : Date.now();

  const wake = (reason: string): void => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void store.resume(reason);
    }, COALESCE_MS);
  };

  const onVisibility = (): void => {
    if (document.visibilityState !== "visible") {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? Infinity : Date.now() - hiddenAt;
    hiddenAt = null;
    // A real absence is a wake. A tab switch is a poll. The watchdog below still
    // catches a suspension that delivered no event at all, so nothing is lost by
    // being conservative here.
    if (away >= WAKE_AFTER_HIDDEN_MS) wake("visible");
    else void store.poll();
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) wake("bfcache");
  };

  const onOnline = (): void => wake("online");

  const watchdog = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick;
    lastTick = now;
    // Also fires on a clock jump backwards, which is a different problem with the
    // same correct response: everything we believe about expiry is now suspect.
    if (drift > SUSPEND_THRESHOLD_MS || drift < 0) wake("slept");
  }, WATCHDOG_INTERVAL_MS);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);

  return () => {
    if (pending !== null) clearTimeout(pending);
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
  };
}
