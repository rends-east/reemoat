import { store } from "./store";

// Detection only: every trigger funnels into `store.resume`, coalesced. The watchdog is the only one that fires for a locked phone.

const SUSPEND_THRESHOLD_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 1_000;

const COALESCE_MS = 250;

/** Shorter absences are tab switches and get one poll; must stay under the token refresh margin. */
const WAKE_AFTER_HIDDEN_MS = 20_000;

export function installWakeDetection(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastTick = Date.now();
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
