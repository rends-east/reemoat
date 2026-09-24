// The machine strip's selection pill, and the one that travels between tabs (Q3.656). At rest the selected tab draws its own
// pill, so scrolling, reordering and resizing move it with no code; any change of tab hands it to a traveller for the trip.

import { useCallback, useEffect, useRef } from "react";
import type { MachineTabId } from "./groups";
import { settleTransition, snap } from "./sheetDrag";
import { clipSpan, easeAt, pillBetween, pillPieces, scrollToShow, SHEET_MS, type Span } from "./sheetMotion";

/** The traveller's middle piece is `w-16`; it stretches from this. */
const MIDDLE_PX = 64;

interface End {
  /** In the strip's coordinates at the scroll the trip began at. */
  readonly span: Span;
  /** Inside the machine tabs' scroller, so it moves when the strip scrolls; All does not. */
  readonly scrolls: boolean;
}

interface Trip {
  readonly from: End;
  readonly to: End;
  readonly s0: number;
  readonly s1: number;
  /** The scroller's visible box along the strip; a pill is never drawn outside it. */
  readonly lo: number;
  readonly hi: number;
  readonly height: number;
  progress: number;
  /** Where a settle is taking the strip's scroll, so a hand-off can land it there first. */
  scrollTo: number | null;
  /** A page turn owns its trip until the commit; a tap's may be overtaken by the next. */
  readonly owner: "page" | "tap";
}

export interface TabPill {
  stripRef: (node: HTMLElement | null) => void;
  scrollerRef: (node: HTMLElement | null) => void;
  travellerRef: (node: HTMLElement | null) => void;
  /** Measures both tabs once and stands the traveller on `from`, or where one already is; false where there is nothing to travel between. */
  begin: (from: MachineTabId, to: MachineTabId, owner?: "page" | "tap") => boolean;
  at: (progress: number) => void;
  /** Carried on (1) or given back (0), on the sheets' clock and curve. */
  settle: (to: 0 | 1) => void;
  /** A touch caught the turn this trip settles with: it stops where it is drawn, and the strip's scroll where it is (Q3.667). */
  hold: () => void;
  /** The selected tab's own pill takes over, where the traveller stopped. */
  finish: () => void;
  /** A change of tab nobody dragged: a tap, a key, a fallback. */
  moveTo: (from: MachineTabId, to: MachineTabId) => void;
  /** A page turn is carrying the pill, and the commit it ends in must not start another trip. */
  turning: () => boolean;
  /** Any trip: it scrolls the strip itself, so nothing else may. */
  travelling: () => boolean;
}

export function useTabPill(): TabPill {
  const strip = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const traveller = useRef<HTMLElement | null>(null);
  const trip = useRef<Trip | null>(null);
  const timer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  const pieces = (): HTMLElement[] => [...(traveller.current?.children ?? [])].filter((one) => one instanceof HTMLElement);

  const spanAt = (end: End, scroll: number, now: Trip): Span =>
    end.scrolls ? clipSpan({ x: end.span.x - (scroll - now.s0), width: end.span.width }, now.lo, now.hi) : end.span;

  // One transform per piece: the caps move, the middle moves and stretches.
  const draw = (now: Trip, progress: number, scroll: number): void => {
    const where = pillPieces(pillBetween(spanAt(now.from, scroll, now), spanAt(now.to, scroll, now), progress), now.height, MIDDLE_PX);
    const [left, middle, right] = pieces();
    if (left !== undefined) left.style.transform = `translate3d(${String(snap(where.left))}px, 0, 0)`;
    if (middle !== undefined) middle.style.transform = `translate3d(${String(snap(where.middle))}px, 0, 0) scaleX(${String(where.scale)})`;
    if (right !== undefined) right.style.transform = `translate3d(${String(snap(where.right))}px, 0, 0)`;
  };

  const scrollAt = (now: Trip, progress: number): number => now.s0 + (now.s1 - now.s0) * progress;

  const stop = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    timer.current = null;
    frame.current = null;
  };

  const finish = (): void => {
    stop();
    // Lands a scroll still in its last frame, or the tab's own pill would take over a few pixels from the traveller.
    const landing = trip.current?.scrollTo ?? null;
    if (landing !== null && scroller.current !== null) scroller.current.scrollLeft = landing;
    trip.current = null;
    strip.current?.removeAttribute("data-pill-travel");
    for (const piece of pieces()) {
      // Held, never cleared: reduced motion gives every property a 0.01ms transition whose first frame is the old value.
      piece.style.transition = "none";
      piece.style.willChange = "";
    }
    if (traveller.current !== null) traveller.current.style.display = "";
  };

  // Where the traveller is drawn this moment, mid-flight included: a trip that overtakes another starts from here.
  const drawnNow = (origin: DOMRect): Span | null => {
    const [left, , right] = pieces();
    if (trip.current === null || left === undefined || right === undefined) return null;
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return { x: a.left - origin.left, width: b.right - a.left };
  };

  const begin = (from: MachineTabId, to: MachineTabId, owner: "page" | "tap" = "page"): boolean => {
    const box = strip.current;
    const overtaken = box === null ? null : drawnNow(box.getBoundingClientRect());
    finish();
    const moving = traveller.current;
    // Not laid out where the strip is not: the wide layout draws the machine column instead.
    if (box === null || moving === null || box.offsetParent === null) return false;
    const find = (id: MachineTabId): HTMLElement | null => box.querySelector<HTMLElement>(`[data-tab-pill="${CSS.escape(id)}"]`);
    const first = find(from);
    const last = find(to);
    if (first === null || last === null) return false;
    // Every read of the trip, once: the strip, both tabs and the scroller.
    const origin = box.getBoundingClientRect();
    const rail = scroller.current;
    const view = rail?.getBoundingClientRect() ?? null;
    const end = (node: HTMLElement): End & { top: number; height: number } => {
      const rect = node.getBoundingClientRect();
      return {
        span: { x: rect.left - origin.left, width: rect.width },
        scrolls: rail?.contains(node) === true,
        top: rect.top - origin.top,
        height: rect.height,
      };
    };
    const tabStart = end(first);
    const start = overtaken === null ? tabStart : { ...tabStart, span: overtaken, scrolls: false };
    const finishAt = end(last);
    const lo = view === null ? Number.NEGATIVE_INFINITY : view.left - origin.left;
    const hi = view === null ? Number.POSITIVE_INFINITY : view.right - origin.left;
    const s0 = rail?.scrollLeft ?? 0;
    // Telegram's strip keeps the pill it is heading for in view; only the machine tabs scroll.
    // The whole tab, not only its pill, so the selection's own scrollIntoView finds nothing left to do.
    const tab = last.closest("button")?.getBoundingClientRect() ?? null;
    const s1 =
      rail !== null && finishAt.scrolls && tab !== null
        ? scrollToShow(s0, rail.clientWidth, rail.scrollWidth - rail.clientWidth, { x: tab.left - origin.left - lo + s0, width: tab.width })
        : s0;
    const now: Trip = { from: start, to: finishAt, s0, s1, lo, hi, height: start.height, progress: 0, scrollTo: null, owner };
    trip.current = now;
    moving.style.display = "block";
    moving.style.transform = `translate3d(0, ${String(snap(start.top))}px, 0)`;
    for (const piece of pieces()) {
      piece.style.transition = "none";
      piece.style.willChange = "transform";
    }
    box.setAttribute("data-pill-travel", "");
    draw(now, 0, s0);
    return true;
  };

  const at = (progress: number): void => {
    const now = trip.current;
    if (now === null) return;
    now.progress = Math.min(1, Math.max(0, progress));
    const scroll = scrollAt(now, now.progress);
    const rail = scroller.current;
    if (rail !== null && now.s1 !== now.s0) rail.scrollLeft = scroll;
    draw(now, now.progress, scroll);
  };

  const settle = (to: 0 | 1): void => {
    const now = trip.current;
    if (now === null) return;
    const from = scrollAt(now, now.progress);
    const target = to === 1 ? now.s1 : now.s0;
    now.progress = to;
    for (const piece of pieces()) piece.style.transition = settleTransition(["transform"]);
    draw(now, to, target);
    const rail = scroller.current;
    if (rail === null || from === target) return;
    now.scrollTo = target;
    // CSS has no transition for a scroll offset, so it runs on the same curve in frames, and ends where the pill does.
    const started = performance.now();
    const step = (): void => {
      const t = (performance.now() - started) / SHEET_MS;
      rail.scrollLeft = from + (target - from) * easeAt(t);
      frame.current = t < 1 ? window.requestAnimationFrame(step) : null;
    };
    frame.current = window.requestAnimationFrame(step);
  };

  const hold = (): void => {
    const now = trip.current;
    if (now === null) return;
    stop();
    now.scrollTo = null;
    for (const piece of pieces()) {
      piece.style.transform = getComputedStyle(piece).transform;
      piece.style.transition = "none";
    }
  };

  const moveTo = (from: MachineTabId, to: MachineTabId): void => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!begin(from, to, "tap")) return;
    // Commits the start, so the transition has somewhere to move from.
    traveller.current?.getBoundingClientRect();
    settle(1);
    timer.current = window.setTimeout(finish, SHEET_MS);
  };

  useEffect(() => stop, []);

  const stripRef = useCallback((node: HTMLElement | null): void => {
    strip.current = node;
  }, []);
  const scrollerRef = useCallback((node: HTMLElement | null): void => {
    scroller.current = node;
  }, []);
  const travellerRef = useCallback((node: HTMLElement | null): void => {
    traveller.current = node;
  }, []);

  return {
    stripRef,
    scrollerRef,
    travellerRef,
    begin,
    at,
    settle,
    hold,
    finish,
    moveTo,
    turning: () => trip.current?.owner === "page",
    travelling: () => trip.current !== null,
  };
}
