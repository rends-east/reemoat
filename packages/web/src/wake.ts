// Pure: what `resume.ts` detects and what `store.ts` keeps across a wake, on fake clocks in `webcheck` (Q3.703).

/** Never steps back, so a wall clock corrected after sleep cannot make an old socket look newer than the sleep. */
export function monotonicNow(): number {
  return performance.now();
}

/** A route or stream proved at or after `since` is the wake's own answer; one proved before it may have died asleep. */
export function trusted(provedAt: number | null, since: number): boolean {
  return provedAt !== null && provedAt >= since;
}

/** Only ever later: one wake reports several starts, and the latest absence is the one a socket may have died in. */
export function raiseSuspicion(current: number, reported: number | null): number {
  return reported === null ? current : Math.max(current, reported);
}

const SUSPEND_THRESHOLD_MS = 5_000;

/** Shorter absences are tab switches and get one poll; must stay under the token refresh margin. */
export const WAKE_AFTER_HIDDEN_MS = 20_000;

/** Each answer is the monotonic moment an absence began, or null where nothing was absent. */
export class WakeClock {
  private lastWall: number;
  private lastMono: number;
  private hiddenWall: number | null;
  private hiddenMono: number | null;
  private offlineMono: number | null = null;

  constructor(wall: number, mono: number, visible: boolean) {
    this.lastWall = wall;
    this.lastMono = mono;
    this.hiddenWall = visible ? null : wall;
    this.hiddenMono = visible ? null : mono;
  }

  /** The watchdog: a wall clock past the threshold (or behind) means the machine slept after the previous tick. */
  tick(wall: number, mono: number): number | null {
    const drift = wall - this.lastWall;
    const before = this.lastMono;
    this.lastWall = wall;
    this.lastMono = mono;
    return drift > SUSPEND_THRESHOLD_MS || drift < 0 ? before : null;
  }

  hide(wall: number, mono: number): void {
    this.hiddenWall = wall;
    this.hiddenMono = mono;
  }

  /** `wake` false is a tab switch; a page that never saw itself hidden counts as away since now. */
  show(wall: number, mono: number): { wake: boolean; since: number } {
    const away = this.hiddenWall === null ? Infinity : wall - this.hiddenWall;
    const since = this.hiddenMono ?? mono;
    this.hiddenWall = null;
    this.hiddenMono = null;
    return { wake: away >= WAKE_AFTER_HIDDEN_MS, since };
  }

  offline(mono: number): void {
    this.offlineMono ??= mono;
  }

  /** Null with no `offline` seen: the duplicate a wake fires, which must not redial what that wake rebuilt. */
  online(): number | null {
    const since = this.offlineMono;
    this.offlineMono = null;
    return since;
  }
}
