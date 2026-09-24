// The rail's row drag; the order arithmetic lives in sessionOrder (Q3.533). The row is the scroll surface, so it may not carry touch-none.
// A mouse arms on movement and a finger on a hold; leaving Pinned unpins even when the folder is not drawn.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTypingInto } from "../keys";
import { canReorder, rankForMove, resolveDrop, type Placement } from "../sessionOrder";
import type { SessionKey } from "../ids";
import { sessionGroups, store, type AppState, type SessionRow } from "../store";
import { PINNED_FOLDER, folderId, folderPathOf, siblingsOf } from "./groups";
import { toast } from "./Toast";

/** How long a finger must stay still before the row arms: past a tap, under the platform's 500ms long press. */
export const PRESS_MS = 400;

export const HAPTIC_MS = 12;

export const MOUSE_SLOP = 4;

/** How far a finger may move before the hold yields to the scroller: below the ~10px where engines commit a pan. */
export const PRESS_SLOP = 8;

// How far past Pinned a row must be carried to unpin: unpinning is the one move dragging back cannot undo.
const UNPIN_MARGIN = 48;

const REFUSAL_SLOP = 12;

const TOO_OLD = "This machine's daemon is too old to store an order. Restart it after updating.";

const UNREACHABLE = "That machine is not reachable right now, so the row was not moved.";

const PART_MOVED = "Some rows beside it did not move, so this group is not in the order you asked for.";

/** Pixels from an edge of the scroller at which a live drag starts scrolling it. */
export const SCROLL_EDGE = 60;
/** The fastest that scroll goes, per frame. */
export const SCROLL_MAX = 14;

/** Scroll speed for a pointer inside the edge band; near and far are the scroller's edges on the drag axis. */
export function driftFor(near: number, far: number, at: number): number {
  const intoNear = SCROLL_EDGE - (at - near);
  if (intoNear > 0) return -Math.min(SCROLL_MAX, (intoNear / SCROLL_EDGE) * SCROLL_MAX);
  const intoFar = SCROLL_EDGE - (far - at);
  if (intoFar > 0) return Math.min(SCROLL_MAX, (intoFar / SCROLL_EDGE) * SCROLL_MAX);
  return 0;
}

export interface TouchOps {
  start: (event: TouchEvent) => void;
  move: (event: TouchEvent) => void;
  stop: () => void;
}

/**
 * Listeners go on in the ref callback, before the first touchstart, non-passive and on the scroller, since React's are passive.
 * Stable trampolines let them come off the node they went on while the ops change every render.
 */
export function useTouchGesture<T extends HTMLElement>(ops: TouchOps, held?: RefObject<T | null>): (node: T | null) => void {
  const latest = useRef(ops);
  latest.current = ops;
  const relay = useRef({
    start: (event: TouchEvent): void => latest.current.start(event),
    move: (event: TouchEvent): void => latest.current.move(event),
    stop: (): void => latest.current.stop(),
  });
  const own = useRef<T | null>(null);
  const kept = useRef<RefObject<T | null>>(held ?? own);
  kept.current = held ?? own;
  const scrollerRef = useCallback((node: T | null): void => {
    const going = relay.current;
    const previous = kept.current.current;
    if (previous !== null) {
      previous.removeEventListener("touchstart", going.start);
      previous.removeEventListener("touchmove", going.move);
      previous.removeEventListener("touchend", going.stop);
      previous.removeEventListener("touchcancel", going.stop);
    }
    kept.current.current = node;
    if (node === null) return;
    node.addEventListener("touchstart", going.start, { passive: false });
    node.addEventListener("touchmove", going.move, { passive: false });
    node.addEventListener("touchend", going.stop);
    node.addEventListener("touchcancel", going.stop);
  }, []);
  return scrollerRef;
}

// Encoded because a FolderId joins with U+0000, which an attribute does not carry reliably.
const asAttribute = (zone: string): string => encodeURIComponent(zone);

interface Zone {
  id: string;
  rows: SessionRow[];
  middles: number[];
  top: number;
  bottom: number;
}

/** Where the dragged row will land. `zone === null` is "out of Pinned, no folder drawn". */
interface Target {
  zone: string | null;
  /** The slot between the target zone's rows, the dragged one excluded. */
  index: number;
}

export interface RowDrag {
  scrollerRef: (node: HTMLDivElement | null) => void;
  dragging: string | null;
  pressing: string | null;
  sliding: boolean;
  /** Read synchronously by the swipe's touchmove: the dragging state is a render behind, and the hold arms on a timer. */
  armed: () => boolean;
  /** A ref rather than state: the pointer moves every frame, and per-frame work goes to the DOM (Q3.533). */
  pillRef: (node: HTMLElement | null) => void;
  unpinning: boolean;
  /** The joined group reserves a row's height and the left group gives it back, since translating rows makes no room. */
  spaceFor: (zone: string) => number;
  shiftFor: (zone: string, index: number, key: string) => number;
  bind: (row: SessionRow, zone: string) => {
    "data-row-key": string;
    "data-zone": string;
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void;
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onDragStart: (event: React.DragEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
}

export function useRowDrag(state: AppState): RowDrag {
  const [pressing, setPressing] = useState<string | null>(null);
  const [move, setMove] = useState<{
    key: string;
    height: number;
    origin: { zone: string; index: number };
    target: Target;
  } | null>(null);

  const scroller = useRef<HTMLDivElement | null>(null);
  const live = useRef<{
    row: SessionRow;
    node: HTMLElement;
    pointerId: number;
    startY: number;
    startX: number;
    grab: number;
    applied: number;
    byMove: boolean;
    armed: boolean;
    zones: Zone[];
    origin: { zone: string; index: number };
    height: number;
    target: Target;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rolling = useRef<number | null>(null);
  const lastY = useRef(0);
  const lastX = useRef(0);
  /** Set when a drag armed, so the `click` the pointer leaves behind is eaten. */
  const suppress = useRef(false);
  const pill = useRef<HTMLElement | null>(null);
  // The current render's state, for touch listeners that are registered once.
  const latest = useRef(state);
  latest.current = state;
  const refused = useRef<{ x: number; y: number; told: boolean } | null>(null);

  const contentY = (clientY: number): number => {
    const box = scroller.current;
    if (box === null) return clientY;
    return clientY - box.getBoundingClientRect().top + box.scrollTop;
  };

  const tellRefused = (x: number, y: number): void => {
    const denied = refused.current;
    if (denied === null || denied.told) return;
    if (Math.hypot(y - denied.y, x - denied.x) <= REFUSAL_SLOP) return;
    denied.told = true;
    toast("error", TOO_OLD);
  };

  // Under the All tab a neighbour may be on a daemon that cannot store rank, so each is checked; a failure toasts once per group.
  const respace = (also: readonly Placement[]): void => {
    let told = false;
    const note = (): void => {
      if (told) return;
      told = true;
      toast("error", PART_MOVED);
    };
    for (const entry of also) {
      if (!canReorder(entry.row.snapshot)) {
        note();
        continue;
      }
      if (!store.setSessionMeta(entry.row.ref, { rank: entry.rank }, note)) note();
    }
  };

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const measure = (row: SessionRow): { zones: Zone[]; height: number } => {
    const box = scroller.current;
    if (box === null) return { zones: [], height: 0 };
    const offset = box.getBoundingClientRect().top - box.scrollTop;
    const wanted = new Set<string>([PINNED_FOLDER, folderId(row.ref.machineId, folderPathOf(row))]);
    const byZone = new Map<string, { rows: SessionRow[]; middles: number[]; top: number; bottom: number }>();
    let height = 0;
    for (const node of box.querySelectorAll<HTMLElement>("[data-row-key][data-zone]")) {
      const id = decodeURIComponent(node.dataset["zone"] ?? "");
      if (!wanted.has(id)) continue;
      // The latest state, not this render's: the touch path arrives through a 400ms timer and may be a poll behind.
      const other = latest.current.rowsByKey.get((node.dataset["rowKey"] ?? "") as SessionKey);
      if (other === undefined) continue;
      const rect = node.getBoundingClientRect();
      const top = rect.top - offset;
      const bottom = rect.bottom - offset;
      height = Math.max(height, rect.height);
      const zone = byZone.get(id) ?? { rows: [], middles: [], top, bottom };
      zone.rows.push(other);
      zone.middles.push((top + bottom) / 2);
      zone.top = Math.min(zone.top, top);
      zone.bottom = Math.max(zone.bottom, bottom);
      byZone.set(id, zone);
    }
    return { zones: [...byZone].map(([id, zone]) => ({ id, ...zone })), height };
  };

  const pickTarget = (going: NonNullable<typeof live.current>, y: number): Target => {
    const slotIn = (zone: Zone): number => {
      let slot = 0;
      for (let i = 0; i < zone.rows.length; i += 1) {
        if ((zone.rows[i] as SessionRow).key === going.row.key) continue;
        if (y > (zone.middles[i] as number)) slot += 1;
      }
      return slot;
    };
    const pinnedZone = going.zones.find((zone) => zone.id === PINNED_FOLDER);
    const ownZone = going.zones.find((zone) => zone.id !== PINNED_FOLDER);
    // The boundary is whichever group is nearer, never one group's own edge, or the last slot in Pinned is unreachable.
    const gap = (zone: Zone): number => (y < zone.top ? zone.top - y : y > zone.bottom ? y - zone.bottom : 0);
    const sticky = going.origin.zone === PINNED_FOLDER ? UNPIN_MARGIN : 0;

    if (pinnedZone !== undefined && ownZone !== undefined) {
      const nearer = gap(pinnedZone) - sticky <= gap(ownZone) ? pinnedZone : ownZone;
      return { zone: nearer.id, index: slotIn(nearer) };
    }
    if (pinnedZone !== undefined && gap(pinnedZone) <= sticky) {
      return { zone: PINNED_FOLDER, index: slotIn(pinnedZone) };
    }
    if (ownZone !== undefined) return { zone: ownZone.id, index: slotIn(ownZone) };
    return going.origin.zone === PINNED_FOLDER ? { zone: null, index: 0 } : going.origin;
  };

  const place = (clientY: number, clientX?: number): void => {
    const going = live.current;
    if (going === null || !going.armed) return;
    const y = contentY(clientY);
    // Anchored to where the row is now, not where it armed, or a group growing above it makes it jump.
    const base = going.node.getBoundingClientRect().top - going.applied;
    const offset = clientY - going.grab - base;
    going.applied = offset;
    going.node.style.transform = `translateY(${offset}px)`;
    const badge = pill.current;
    if (badge !== null) {
      const box = scroller.current;
      const left = box === null ? 0 : (clientX ?? lastX.current) - box.getBoundingClientRect().left;
      badge.style.transform = `translate3d(${left}px, ${y}px, 0)`;
    }
    const next = pickTarget(going, y);
    if (next.zone === going.target.zone && next.index === going.target.index) return;
    going.target = next;
    setMove({ key: going.row.key, height: going.height, origin: going.origin, target: next });
  };

  const roll = (): void => {
    const box = scroller.current;
    const going = live.current;
    if (box === null || going === null || !going.armed) {
      rolling.current = null;
      return;
    }
    const seen = box.getBoundingClientRect();
    const drift = driftFor(seen.top, seen.bottom, lastY.current);
    if (drift !== 0) box.scrollTop += drift;
    // Every frame: the reserved space animates in, so the row's base moves while the pointer is still.
    place(lastY.current);
    rolling.current = requestAnimationFrame(roll);
  };

  const end = useCallback((): void => {
    clearTimer();
    if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    rolling.current = null;
    const going = live.current;
    live.current = null;
    setMove(null);
    setPressing(null);
    if (going === null) return;
    going.node.style.transform = "";
    going.node.style.willChange = "";
    going.node.style.touchAction = "";
    going.node.style.webkitUserSelect = "";
    going.node.style.userSelect = "";
    going.node.style.removeProperty("-webkit-touch-callout");
    if (!going.armed) return;

    const wasPinned = going.row.snapshot.pinned === true;
    const nowPinned = going.target.zone === PINNED_FOLDER;
    const zone = going.zones.find((entry) => entry.id === going.target.zone);
    const say = (message: string): void => toast("error", message);

    if (zone === undefined) {
      if (nowPinned === wasPinned) return;
      if (!store.setSessionMeta(going.row.ref, { pinned: nowPinned }, say)) say(UNREACHABLE);
      return;
    }

    // origin.index counts the dragged row and target.index does not, so only target === origin is a no-op.
    if (nowPinned === wasPinned && going.target.zone === going.origin.zone) {
      if (going.target.index === going.origin.index) return;
    }
    const neighbours = zone.rows.filter((row) => row.key !== going.row.key);
    const landed = resolveDrop(neighbours, going.target.index, going.row);
    const patch = nowPinned === wasPinned ? { rank: landed.rank } : { rank: landed.rank, pinned: nowPinned };
    if (!store.setSessionMeta(going.row.ref, patch, say)) {
      say(UNREACHABLE);
      return;
    }
    respace(landed.also);
  }, []);

  const arm = (): void => {
    const going = live.current;
    if (going === null || going.armed) return;
    clearTimer();
    const measured = measure(going.row);
    const zone = measured.zones.find((entry) => entry.rows.some((row) => row.key === going.row.key));
    if (zone === undefined) {
      live.current = null;
      setPressing(null);
      return;
    }
    going.armed = true;
    going.zones = measured.zones;
    going.height = measured.height;
    going.origin = { zone: zone.id, index: zone.rows.findIndex((row) => row.key === going.row.key) };
    going.target = { zone: zone.id, index: going.origin.index };
    suppress.current = true;
    if (going.byMove) {
      try {
        going.node.setPointerCapture(going.pointerId);
      } catch {
        // A pointer that has already gone. The drag ends on the next event.
      }
    }
    going.node.style.touchAction = "none";
    going.node.style.willChange = "transform";
    setPressing(null);
    setMove({ key: going.row.key, height: going.height, origin: going.origin, target: going.target });
    place(lastY.current);
    if (rolling.current === null) rolling.current = requestAnimationFrame(roll);
    // A haptic tick on arming, since the lift is under the finger; optional, as desktops and iOS lack it.
    if (!going.byMove) navigator.vibrate?.(HAPTIC_MS);
  };

  // A finger is handled entirely on the touch stream: an engine may dispatch touchstart first, making pointerdown setup too late.
  const mouseOps = useRef((_event: PointerEvent): void => {});

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      if (live.current !== null) end();
      return;
    }
    const finger = event.touches.item(0);
    const from = event.target instanceof Element ? event.target : null;
    if (finger === null || from === null) return;
    // The row is the drag surface *except* where it already carries a control.
    if (from.closest("[data-no-drag]") !== null) return;
    const node = from.closest<HTMLElement>("[data-row-key][data-zone]");
    if (node === null) return;
    const row = latest.current.rowsByKey.get((node.dataset["rowKey"] ?? "") as SessionKey);
    if (row === undefined) return;
    if (!canReorder(row.snapshot)) {
      refused.current = { x: finger.clientX, y: finger.clientY, told: false };
      return;
    }
    refused.current = null;
    suppress.current = false;
    live.current = {
      row,
      node,
      pointerId: -1,
      startY: finger.clientY,
      startX: finger.clientX,
      grab: finger.clientY - node.getBoundingClientRect().top,
      applied: 0,
      byMove: false,
      armed: false,
      zones: [],
      origin: { zone: decodeURIComponent(node.dataset["zone"] ?? ""), index: 0 },
      height: 0,
      target: { zone: decodeURIComponent(node.dataset["zone"] ?? ""), index: 0 },
    };
    lastY.current = finger.clientY;
    lastX.current = finger.clientX;
    // Set at touchstart: iOS decides there whether a long press raises its callout and selection, and cancels the touch.
    node.style.webkitUserSelect = "none";
    node.style.userSelect = "none";
    // Not in the DOM typings, and the only way to stop iOS opening its menu over the row.
    node.style.setProperty("-webkit-touch-callout", "none");
    clearTimer();
    setPressing(row.key);
    timer.current = setTimeout(arm, PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (finger === null) return;
    if (going === null) {
      tellRefused(finger.clientX, finger.clientY);
      return;
    }
    if (going.byMove) return;
    lastY.current = finger.clientY;
    lastX.current = finger.clientX;
    if (going.armed) {
      // Refuse the scroll only while a drag is live, so the rest of the list scrolls normally.
      if (event.cancelable) event.preventDefault();
      place(finger.clientY, finger.clientX);
      return;
    }
    if (Math.hypot(finger.clientY - going.startY, finger.clientX - going.startX) > PRESS_SLOP) end();
  };

  const onMousePointer = (event: PointerEvent): void => {
    const going = live.current;
    if (going === null || !going.byMove || going.armed) return;
    if (going.pointerId !== event.pointerId) return;
    if (event.type !== "pointermove") {
      end();
      return;
    }
    lastY.current = event.clientY;
    lastX.current = event.clientX;
    if (Math.hypot(event.clientY - going.startY, event.clientX - going.startX) > MOUSE_SLOP) arm();
  };

  mouseOps.current = onMousePointer;
  const scrollerRef = useTouchGesture(
    { start: onTouchStart, move: onTouchMove, stop: () => end() },
    scroller,
  );

  useEffect(() => {
    const relayed = (event: PointerEvent): void => mouseOps.current(event);
    document.addEventListener("pointermove", relayed);
    document.addEventListener("pointerup", relayed);
    document.addEventListener("pointercancel", relayed);
    return () => {
      document.removeEventListener("pointermove", relayed);
      document.removeEventListener("pointerup", relayed);
      document.removeEventListener("pointercancel", relayed);
    };
  }, []);

  useEffect(() => end, [end]);

  const shiftFor = (zone: string, index: number, key: string): number => {
    if (move === null || key === move.key) return 0;
    const { origin, target, height } = move;
    if (zone === origin.zone && zone === target.zone) {
      if (target.index > origin.index && index > origin.index && index <= target.index) return -height;
      if (target.index < origin.index && index >= target.index && index < origin.index) return height;
      return 0;
    }
    if (zone === origin.zone) return index > origin.index ? -height : 0;
    if (zone === target.zone) return index >= target.index ? height : 0;
    return 0;
  };

  const bind = (row: SessionRow, zone: string): ReturnType<RowDrag["bind"]> => ({
    "data-row-key": row.key,
    "data-zone": asAttribute(zone),
    // A mouse's only: a finger's gesture belongs to the scroller's touch listeners.
    onPointerDown: (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      // Controls marked data-no-drag are not a grab surface; a marker lets the next control inherit that.
      if ((event.target as HTMLElement).closest("[data-no-drag]") !== null) return;
      if (!canReorder(row.snapshot)) {
        refused.current = { x: event.clientX, y: event.clientY, told: false };
        return;
      }
      refused.current = null;
      suppress.current = false;
      live.current = {
        row,
        node: event.currentTarget,
        pointerId: event.pointerId,
        startY: event.clientY,
        startX: event.clientX,
        grab: event.clientY - event.currentTarget.getBoundingClientRect().top,
        applied: 0,
        byMove: true,
        armed: false,
        zones: [],
        origin: { zone, index: 0 },
        height: 0,
        target: { zone, index: 0 },
      };
      lastY.current = event.clientY;
      lastX.current = event.clientX;
      clearTimer();
      // The pointer is captured when the drag arms, never at the press, which would retarget the click that opens the session.
    },
    onPointerMove: (event) => {
      if (event.pointerType !== "mouse") return;
      const going = live.current;
      if (going === null) {
        tellRefused(event.clientX, event.clientY);
        return;
      }
      if (!going.byMove || going.pointerId !== event.pointerId) return;
      lastY.current = event.clientY;
      lastX.current = event.clientX;
      if (!going.armed) {
        if (Math.hypot(event.clientY - going.startY, event.clientX - going.startX) > MOUSE_SLOP) arm();
        return;
      }
      place(event.clientY, event.clientX);
    },
    // These end a mouse drag only: for a finger they mean the browser claimed a scroll, which the drag exists to take back.
    onPointerUp: (event) => {
      if (event.pointerType !== "mouse") return;
      refused.current = null;
      end();
    },
    onPointerCancel: (event) => {
      if (event.pointerType !== "mouse") return;
      refused.current = null;
      end();
    },
    onLostPointerCapture: (event) => {
      if (event.pointerType === "mouse") end();
    },
    // Refused, or the browser's own text drag races ours and wins.
    onDragStart: (event: React.DragEvent<HTMLElement>) => event.preventDefault(),
    // Refused for the whole press: Android's ~500ms long-press menu races the 400ms hold.
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      if (live.current !== null) event.preventDefault();
    },
    // Eats the click a drag leaves behind; cleared on the next press so it cannot eat a later tap.
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (!suppress.current) return;
      suppress.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    // Alt+arrows reorder from the keyboard, since a pointer-only reorder is unreachable (Q3.533).
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      // Typing wins: in the rename field Option+arrow moves the caret, not the row.
      if (isTypingInto(event.target)) return;
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      if (!canReorder(row.snapshot)) return;
      event.preventDefault();
      const siblings = siblingsOf(row, sessionGroups(state));
      const from = siblings.findIndex((other) => other.key === row.key);
      if (from < 0) return;
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= siblings.length) return;
      const say = (message: string): void => toast("error", message);
      const direct = rankForMove(siblings, from, to);
      if (direct !== null) {
        if (!store.setSessionMeta(row.ref, { rank: direct }, say)) say(UNREACHABLE);
        return;
      }
      const landed = resolveDrop(
        siblings.filter((other) => other.key !== row.key),
        to,
        row,
      );
      if (!store.setSessionMeta(row.ref, { rank: landed.rank }, say)) {
        say(UNREACHABLE);
        return;
      }
      respace(landed.also);
    },
  });

  const pillRef = useCallback((node: HTMLElement | null): void => {
    pill.current = node;
    if (node !== null) place(lastY.current, lastX.current);
  }, []);

  const spaceFor = (zone: string): number => {
    if (move === null || move.target.zone === move.origin.zone) return 0;
    if (zone === move.target.zone) return move.height;
    if (zone === move.origin.zone) return -move.height;
    return 0;
  };

  return {
    scrollerRef,
    dragging: move?.key ?? null,
    pressing,
    sliding: move !== null,
    armed: () => live.current?.armed === true,
    pillRef,
    unpinning: move !== null && move.origin.zone === PINNED_FOLDER && move.target.zone !== PINNED_FOLDER,
    spaceFor,
    shiftFor,
    bind,
  };
}
