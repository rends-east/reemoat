import { store } from "./store";
import { monotonicNow, raiseSuspicion, WakeClock } from "./wake";

// Detection only: every trigger funnels into `store.wake`, coalesced. The watchdog is the only one that fires for a locked phone.

const WATCHDOG_INTERVAL_MS = 1_000;

const COALESCE_MS = 250;

export function installWakeDetection(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  // The latest absence the events in one coalescing window reported; null, none that may have killed a socket.
  let pendingSince: number | null = null;
  const clock = new WakeClock(Date.now(), monotonicNow(), document.visibilityState === "visible");

  const wake = (reason: string, since: number | null): void => {
    pendingSince = pendingSince === null ? since : raiseSuspicion(pendingSince, since);
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const reported = pendingSince;
      pendingSince = null;
      void store.wake(reason, reported);
    }, COALESCE_MS);
  };

  const onVisibility = (): void => {
    if (document.visibilityState !== "visible") {
      clock.hide(Date.now(), monotonicNow());
      return;
    }
    const back = clock.show(Date.now(), monotonicNow());
    if (back.wake) wake("visible", back.since);
    else void store.poll();
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) wake("bfcache", monotonicNow());
  };

  const onOffline = (): void => {
    clock.offline(monotonicNow());
    store.noteDevice(false);
  };
  const onOnline = (): void => {
    store.noteDevice(true);
    wake("online", clock.online());
  };

  const watchdog = setInterval(() => {
    const slept = clock.tick(Date.now(), monotonicNow());
    if (slept !== null) wake("slept", slept);
  }, WATCHDOG_INTERVAL_MS);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);

  return () => {
    if (pending !== null) clearTimeout(pending);
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
  };
}
