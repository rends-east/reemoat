/**
 * The chat list's own gestures below lg, arbitrated once by axis (`listGesture`): Telegram's folder pager (Q3.655), the menu
 * drawer pulled from the first page (Q3.657), and a pull down from the top that refreshes (Q3.658). Never from the edge bands.
 * The pages are one strip, and a turn commits only once the strip rests, so a flick may follow a flick (Q3.667).
 * SWIPE_SLOP must stay rowDrag's PRESS_SLOP so a hold and a swipe are never both live on one finger.
 */

import { useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { PRESS_SLOP, useTouchGesture } from "./rowDrag";
import { selectMachine, type MachineTab, type MachineTabId } from "./groups";
import { settleTransition, snap } from "./sheetDrag";
import type { TabPill } from "./tabPill";
import { beginPull, pullTo, releasePull } from "./drawerPull";
import {
  EDGE_DEAD_ZONE,
  legProgress,
  listGesture,
  nextPage,
  offsetFrom,
  pageOffset,
  pagesFor,
  pageTurn,
  pageX,
  PULL_HOLD_PX,
  pullOffset,
  pullRefreshes,
  releaseVelocity,
  SHEET_MS,
  sheetRelease,
  stripAt,
  type ListGesture,
  type Sample,
} from "./sheetMotion";

export const SWIPE_SLOP = PRESS_SLOP;
/** The shortest thing the list draws, a folder header; a neighbour mounts only as many rows as this many fit on screen. */
export const ROW_FLOOR_PX = 36;
const SAMPLES = 16;

/** A neighbouring page, mounted while the strip is away from rest: its tab, its place in the strip, and how many rows it needs. */
export interface Beside {
  readonly id: MachineTabId;
  readonly index: number;
  readonly rows: number;
}

export interface MachineSwipe {
  /** The pager's window, which never moves: it hears the finger wherever the pages are drawn, mid-turn included. */
  windowRef: (node: HTMLElement | null) => void;
  /** The list's own scroller: the page that moves. */
  scrollerRef: (node: HTMLElement | null) => void;
  stripRef: (node: HTMLElement | null) => void;
  /** On every neighbour, which carries its place in `data-beside`. */
  paneRef: (node: HTMLElement | null) => () => void;
  /** The refresh's mark, drawn in the gap a pull opens above the list. */
  pullRef: (node: HTMLElement | null) => void;
  /** A store rather than state, so mounting a neighbour renders the neighbour and not the list beside it. */
  subscribe: (listener: () => void) => () => void;
  beside: () => readonly Beside[];
}

/** The strip while it is away from rest: its offset from the page `ref`, which a settle is heading for once released. */
interface Strip {
  ref: number;
  offset: number;
  readonly width: number;
  readonly rows: number;
}

interface Going {
  readonly x: number;
  readonly y: number;
  readonly still: boolean;
  /** The touch caught a turn still settling. */
  readonly caught: boolean;
  mode: ListGesture | null;
  at: number;
  width: number;
  rows: number;
  /** The strip's offset from `at` when the touch landed: 0 from rest, wherever a caught turn was drawn otherwise. */
  start: number;
  offset: number;
  side: -1 | 0 | 1;
  samples: Sample[];
}

const NONE: readonly Beside[] = [];

function place(node: HTMLElement | null, x: number): void {
  if (node === null) return;
  const by = snap(x);
  node.style.transform = by === 0 ? "" : `translate3d(${String(by)}px, 0, 0)`;
}

// Held, never cleared: reduced motion gives every property a 0.01ms transition whose first frame is the old value.
function lift(node: HTMLElement | null): void {
  if (node === null) return;
  node.style.transition = "none";
  node.style.willChange = "transform";
}

function letGo(node: HTMLElement | null): void {
  if (node === null) return;
  node.style.transition = "none";
  node.style.willChange = "";
  node.style.transform = "";
}

export function useMachineSwipe({
  tabs,
  armed,
  pill,
  openMenu,
  refresh,
}: {
  tabs: readonly MachineTab[];
  armed: () => boolean;
  /** The strip's selection travels with the page, on the same progress and the same settle (Q3.656). */
  pill: TabPill;
  /** The menu button's own path: a pulled drawer that opens goes through it. */
  openMenu: () => void;
  /** Re-lists every machine and re-dials the unreachable; the gap holds until it settles. */
  refresh: () => Promise<void>;
}): MachineSwipe {
  const strip = useRef<HTMLElement | null>(null);
  const page = useRef<HTMLElement | null>(null);
  const panes = useRef(new Map<number, HTMLElement>());
  const live = useRef<Going | null>(null);
  const latest = useRef(tabs);
  latest.current = tabs;
  const busy = useRef(armed);
  busy.current = armed;
  const besideNow = useRef<readonly Beside[]>(NONE);
  const listeners = useRef(new Set<() => void>());
  const frame = useRef<number | null>(null);
  const away = useRef<Strip | null>(null);
  /** The pill's trip, in pages: where it set off from and the page it is heading for. */
  const leg = useRef<{ from: number; to: number } | null>(null);
  /** Where the pill is drawn, in pages, whenever the strip is away from rest. */
  const pillAt = useRef(0);
  const settling = useRef<{ timer: number; from: number; pillFrom: number } | null>(null);
  const later = useRef<{ frame: number | null; timer: number | null }>({ frame: null, timer: null });
  const pillNow = useRef(pill);
  pillNow.current = pill;
  const actions = useRef({ openMenu, refresh });
  actions.current = { openMenu, refresh };
  const mark = useRef<HTMLElement | null>(null);
  /** The gap: held open while a refresh runs, then closing; no other gesture starts until it has closed. */
  const gap = useRef<{ timer: number | null } | null>(null);
  const mounted = useRef(true);

  /** The page the list itself shows: the committed machine, which stays put until the strip rests. */
  const committed = (): number => latest.current.findIndex((tab) => tab.selected);

  const mount = (next: readonly Beside[]): void => {
    besideNow.current = next;
    for (const listener of listeners.current) listener();
  };

  /** Mounts the pages at `indices` not already there, and with `prune` lets the others go; one commit either way. */
  const ensure = (indices: readonly number[], rows: number, sync: boolean, prune = false): void => {
    const tabsNow = latest.current;
    const base = committed();
    const have = besideNow.current;
    const keep = prune ? have.filter((one) => indices.includes(one.index)) : have;
    const added = indices
      .filter((index) => index !== base && keep.every((one) => one.index !== index))
      .flatMap((index) => {
        const tab = tabsNow[index];
        return tab === undefined ? [] : [{ id: tab.id, index, rows }];
      });
    if (added.length === 0 && keep.length === have.length) return;
    const next = [...keep, ...added];
    if (sync) flushSync(() => mount(next));
    else mount(next);
  };

  const cancelLater = (): void => {
    if (later.current.frame !== null) window.cancelAnimationFrame(later.current.frame);
    if (later.current.timer !== null) window.clearTimeout(later.current.timer);
    later.current = { frame: null, timer: null };
  };

  // After the frame that starts a settle, so a mount never holds the transition back; a composited transition then runs on.
  const afterFrame = (task: () => void): void => {
    cancelLater();
    later.current.frame = window.requestAnimationFrame(() => {
      later.current.frame = null;
      later.current.timer = window.setTimeout(() => {
        later.current.timer = null;
        task();
      }, 0);
    });
  };

  /** Every page where the strip puts it: the list's own at the committed machine's place, each neighbour at its own. */
  const draw = (now: Strip): void => {
    place(page.current, pageX(now.offset, now.ref, committed(), now.width));
    for (const [index, node] of panes.current) place(node, pageX(now.offset, now.ref, index, now.width));
  };

  // The list pushed down by `y`, and the mark centred in the gap it opens, fading in as the pull nears the hold.
  const open = (y: number): void => {
    const node = page.current;
    if (node !== null) node.style.transform = y <= 0 ? "" : `translate3d(0, ${String(snap(y))}px, 0)`;
    const drawn = mark.current;
    if (drawn === null) return;
    drawn.style.transform = `translate3d(0, ${String(snap(y / 2 - PULL_HOLD_PX / 2))}px, 0)`;
    drawn.style.opacity = String(Math.min(1, y / PULL_HOLD_PX));
  };

  // Shown closed first, so the frame before the finger's first write draws nothing.
  const showMark = (): void => {
    const drawn = mark.current;
    if (drawn === null) return;
    drawn.style.transition = "none";
    drawn.style.opacity = "0";
    drawn.style.transform = `translate3d(0, ${String(-PULL_HOLD_PX / 2)}px, 0)`;
    drawn.style.display = "flex";
  };

  // Under reduced motion the gap opens and closes with no transition at all: a 0.01ms one draws its first frame at the old value.
  const gapTransition = (): string =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : settleTransition(["transform", "opacity"]);

  const closeGap = (): void => {
    const node = page.current;
    const drawn = mark.current;
    for (const one of [node, drawn]) if (one !== null) one.style.transition = gapTransition();
    open(0);
    if (gap.current === null) gap.current = { timer: null };
    gap.current.timer = window.setTimeout(() => {
      gap.current = null;
      letGo(page.current);
      if (mark.current !== null) {
        mark.current.style.transition = "none";
        mark.current.style.display = "";
      }
    }, SHEET_MS);
  };

  // Past the hold the gap stays open for exactly as long as the refresh takes, a machine that never answers included.
  const settlePull = (refreshes: boolean): void => {
    if (!refreshes) {
      closeGap();
      return;
    }
    for (const one of [page.current, mark.current]) if (one !== null) one.style.transition = gapTransition();
    open(PULL_HOLD_PX);
    gap.current = { timer: null };
    void actions.current.refresh().finally(() => {
      if (mounted.current) closeGap();
    });
  };

  // Every page moves as one, once a frame, and the pill with them.
  const write = (): void => {
    frame.current = null;
    const going = live.current;
    if (going === null) return;
    if (going.mode === "drawer") {
      pullTo(going.offset / going.width);
      return;
    }
    if (going.mode === "pull") {
      open(going.offset);
      return;
    }
    const now = away.current;
    if (now === null) return;
    const at = stripAt(now.offset, now.ref, now.width);
    // Before the pages move: a new leg reads the strip, and nothing written this frame is laid out for it.
    steer(at);
    draw(now);
    const trip = leg.current;
    if (trip === null) return;
    const progress = legProgress(at, trip.from, trip.to);
    pillNow.current.at(progress);
    pillAt.current = trip.from + (trip.to - trip.from) * progress;
  };

  /** A new leg for the pill whenever the strip leaves the one it is on: from where the pill is drawn to the next page ahead. */
  const steer = (at: number): void => {
    const trip = leg.current;
    if (trip !== null && at >= Math.min(trip.from, trip.to) && at <= Math.max(trip.from, trip.to)) return;
    const from = pillAt.current;
    const tabsNow = latest.current;
    const to = nextPage(at, from, tabsNow.length);
    const origin = tabsNow[Math.round(from)];
    const target = tabsNow[to];
    if (at === from || to === from || origin === undefined || target === undefined) {
      leg.current = null;
      return;
    }
    leg.current = pillNow.current.begin(origin.id, target.id) ? { from, to } : null;
  };

  /** The strip's rest: the page it stopped on becomes the list's, in one task, or nothing changes where it came back. */
  const rest = (): void => {
    settling.current = null;
    cancelLater();
    const now = away.current;
    away.current = null;
    leg.current = null;
    const base = committed();
    const target = now === null ? undefined : latest.current[now.ref];
    // One task: the new list is committed, scrolled to its top and put back at 0, and the new tab's own pill takes over
    // where the traveller stopped, before anything paints.
    if (now !== null && now.ref !== base && target !== undefined) {
      flushSync(() => {
        selectMachine(target.id);
        mount(NONE);
      });
      if (page.current !== null) page.current.scrollTop = 0;
    } else {
      mount(NONE);
    }
    pillNow.current.finish();
    letGo(page.current);
  };

  const settle = (target: number, turn: -1 | 0 | 1): void => {
    const now = away.current;
    if (now === null) return;
    const from = stripAt(now.offset, now.ref, now.width);
    now.ref = target;
    now.offset = 0;
    for (const node of [page.current, ...panes.current.values()]) if (node !== null) node.style.transition = settleTransition(["transform"]);
    draw(now);
    // The pill ends where the pages do: a trip already heading there carries on, any other is overtaken from where it is drawn.
    const tabsNow = latest.current;
    const to = tabsNow[target];
    const pillFrom = pillAt.current;
    if (to !== undefined && leg.current?.to !== target && (pillNow.current.travelling() || pillFrom !== target)) {
      const origin = tabsNow[Math.round(pillFrom)] ?? to;
      pillNow.current.begin(origin.id, to.id);
    }
    pillNow.current.settle(1);
    leg.current = null;
    settling.current = { timer: window.setTimeout(rest, SHEET_MS), from, pillFrom };
    // The page beyond, mounted while this one settles, so a flick that follows finds it there and nothing mounts under it.
    const beyond = pagesFor(target, turn, committed(), tabsNow.length);
    if (beyond.length > 0) afterFrame(() => ensure(beyond, now.rows, false, true));
  };

  /** A touch catches a turn still settling where it is drawn, rather than landing it: nothing commits and nothing jumps. */
  const hold = (): boolean => {
    const pending = settling.current;
    const now = away.current;
    if (pending === null || now === null) return false;
    window.clearTimeout(pending.timer);
    settling.current = null;
    const node = page.current;
    // The list's own page is where the strip is read from: mid-transition, its computed transform is where it is drawn.
    const drawn = node === null ? 0 : new DOMMatrixReadOnly(getComputedStyle(node).transform).m41;
    now.offset = offsetFrom(drawn, committed(), now.ref, now.width);
    for (const one of [node, ...panes.current.values()]) if (one !== null) one.style.transition = "none";
    draw(now);
    pillNow.current.hold();
    // The pill settled on the same clock and curve as the pages, so it is as far through its trip as they are through theirs.
    const at = stripAt(now.offset, now.ref, now.width);
    const through = pending.from === now.ref ? 1 : (at - pending.from) / (now.ref - pending.from);
    pillAt.current = pending.pillFrom + (now.ref - pending.pillFrom) * through;
    return true;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      if (settling.current !== null) window.clearTimeout(settling.current.timer);
      if (gap.current?.timer != null) window.clearTimeout(gap.current.timer);
      cancelLater();
    };
  }, []);

  const onStart = (event: TouchEvent): void => {
    const going = live.current;
    live.current = null;
    // A second finger ends the gesture it lands on as a cancel, as sheetDrag and backSwipe do; dropped, a pull's gap never closes.
    if (going !== null) finish(going, true, event.timeStamp);
    if (event.touches.length !== 1 || busy.current()) return;
    const finger = event.touches.item(0);
    if (finger === null) return;
    // Layout gate: swipe only while the lg:hidden tab strip is laid out, so this can never disagree with CSS.
    if (strip.current === null || strip.current.offsetParent === null) return;
    if (finger.clientX < EDGE_DEAD_ZONE || window.innerWidth - finger.clientX < EDGE_DEAD_ZONE) return;
    // While the gap is open the list is not where a page or a drawer would start from.
    if (gap.current !== null) return;
    const caught = hold();
    live.current = {
      x: finger.clientX,
      y: finger.clientY,
      still: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      caught,
      mode: null,
      at: -1,
      width: 0,
      rows: 0,
      start: caught ? (away.current?.offset ?? 0) : 0,
      offset: 0,
      side: 0,
      samples: [],
    };
  };

  /** A caught turn the touch did not take over carries on to where it was going. */
  const resume = (going: Going): void => {
    if (going.caught && away.current !== null) settle(away.current.ref, 0);
  };

  const onMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (going === null || finger === null) return;
    if (busy.current()) {
      live.current = null;
      if (going.still) return;
      if (going.mode === "page") settle(going.at, 0);
      else resume(going);
      if (going.mode === "drawer") releasePull(false, actions.current.openMenu);
      if (going.mode === "pull") closeGap();
      return;
    }
    const dx = finger.clientX - going.x;
    const dy = finger.clientY - going.y;
    if (going.mode === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= SWIPE_SLOP) return;
      const node = page.current;
      going.at = away.current?.ref ?? committed();
      // Not cancelable means the engine has already committed to a pan, and a pan is never argued with.
      going.mode = listGesture(dx, dy, {
        cancelable: event.cancelable,
        firstPage: going.at === 0,
        atTop: (node?.scrollTop ?? 0) <= 0,
        refreshing: gap.current !== null,
        turning: going.caught,
      });
      // One read per gesture: how far a page is, and how many rows fill one.
      going.width = away.current?.width ?? node?.offsetWidth ?? 0;
      going.rows = away.current?.rows ?? Math.ceil((node?.clientHeight ?? 0) / ROW_FLOOR_PX) + 1;
      if (going.mode === "drawer" && !going.still) going.width = beginPull();
      if (going.mode === "drawer" && going.width <= 0) going.mode = "none";
      if (going.mode === "pull" && !going.still) {
        gap.current = { timer: null };
        showMark();
      }
      if ((going.mode === "page" || going.mode === "pull") && !going.still) lift(node);
      if (going.mode === "page" && !going.still && away.current === null) {
        away.current = { ref: going.at, offset: 0, width: going.width, rows: going.rows };
        pillAt.current = going.at;
      }
    }
    if (going.mode === "none") {
      live.current = null;
      resume(going);
      return;
    }
    if (event.cancelable) event.preventDefault();
    if (going.mode === "drawer" || going.mode === "pull") {
      going.offset = going.mode === "drawer" ? Math.min(Math.max(dx, 0), going.width) : pullOffset(dy);
      going.samples.push({ t: event.timeStamp, at: going.offset });
      if (going.samples.length > SAMPLES) going.samples.shift();
      if (!going.still) frame.current ??= window.requestAnimationFrame(write);
      return;
    }
    const tabsNow = latest.current;
    going.offset = pageOffset(going.start + dx, going.width, going.at > 0, going.at >= 0 && going.at < tabsNow.length - 1);
    going.samples.push({ t: event.timeStamp, at: going.offset });
    if (going.samples.length > SAMPLES) going.samples.shift();
    const now = away.current;
    if (going.still || now === null) return;
    now.offset = going.offset;
    // The pages in view when the strip first leaves `at` toward a side, and again only if the finger turns the other way.
    const side = going.offset < 0 ? 1 : going.offset > 0 ? -1 : 0;
    if (side !== 0 && tabsNow[going.at + side] !== undefined && going.side !== side) {
      going.side = side;
      // Synchronous, and only for a page not already there: it exists before the frame that first shows it.
      ensure([going.at, going.at + side], going.rows, true);
    }
    frame.current ??= window.requestAnimationFrame(write);
  };

  const onEnd = (event: TouchEvent): void => {
    const going = live.current;
    live.current = null;
    if (going !== null) finish(going, event.type === "touchcancel", event.timeStamp);
  };

  const finish = (going: Going, cancelled: boolean, at: number): void => {
    if (going.mode === null || going.mode === "none") {
      resume(going);
      return;
    }
    // The settle starts from what was painted last, so a write still waiting for its frame is dropped rather than jumped to.
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    if (going.mode === "drawer") {
      // Opening is the drawer's exit from the list's point of view: the sheets' rule, sideways.
      const opens = !cancelled && sheetRelease(going.offset, releaseVelocity(going.samples, at), going.width) === "dismiss";
      if (going.still) {
        if (opens) actions.current.openMenu();
        return;
      }
      releasePull(opens, actions.current.openMenu);
      return;
    }
    if (going.mode === "pull") {
      const refreshes = !cancelled && pullRefreshes(going.offset);
      if (going.still) {
        // Nothing followed the finger; the gap still opens for the refresh, and reduced motion makes both movements instant.
        if (!refreshes) return;
        gap.current = { timer: null };
        showMark();
        lift(page.current);
      }
      settlePull(refreshes);
      return;
    }
    const turn = cancelled ? 0 : pageTurn(going.offset, releaseVelocity(going.samples, at), going.width);
    if (!going.still) {
      settle(going.at + turn, turn);
      return;
    }
    // Under reduced motion nothing followed the finger, and the page turns in place.
    const to = latest.current[going.at + turn];
    if (turn === 0 || to === undefined) return;
    selectMachine(to.id);
    if (page.current !== null) page.current.scrollTop = 0;
  };

  const windowRef = useTouchGesture<HTMLElement>({ start: onStart, move: onMove, stop: onEnd });

  const scrollerRef = useCallback((node: HTMLElement | null): void => {
    page.current = node;
  }, []);

  const stripRef = useCallback((node: HTMLElement | null): void => {
    strip.current = node;
  }, []);

  // Placed as it mounts, before it paints, so a neighbour never shows at 0 for a frame; with no transition, since one
  // mounted during a settle is the page beyond, off the screen until a flick that follows brings it in.
  const paneRef = useCallback((node: HTMLElement | null): (() => void) => {
    if (node === null) return () => undefined;
    const index = Number(node.dataset["beside"]);
    panes.current.set(index, node);
    lift(node);
    const now = away.current;
    if (now !== null) place(node, pageX(now.offset, now.ref, index, now.width));
    return () => {
      if (panes.current.get(index) === node) panes.current.delete(index);
    };
  }, []);

  const subscribe = useCallback((listener: () => void): (() => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  const beside = useCallback((): readonly Beside[] => besideNow.current, []);

  const pullRef = useCallback((node: HTMLElement | null): void => {
    mark.current = node;
  }, []);

  return { windowRef, scrollerRef, stripRef, paneRef, pullRef, subscribe, beside };
}
