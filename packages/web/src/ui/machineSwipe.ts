/**
 * Flick the chat list sideways to move between machine tabs below lg: clamped, no route change, never from the edge bands.
 * SWIPE_SLOP must stay rowDrag's PRESS_SLOP so a hold and a swipe are never both live on one finger.
 */

import { useCallback, useRef } from "react";
import { PRESS_SLOP, useTouchGesture } from "./rowDrag";
import { selectMachine, type MachineTab } from "./groups";

export const SWIPE_SLOP = PRESS_SLOP;
const DOMINANCE = 1.5;
const EDGE_DEAD_ZONE = 24;
const COMMIT = 56;
const CAP = 96;
const RUBBER = 0.35;
const SETTLE_MS = 160;
const SETTLE_CLEAR_MS = 180;

export interface MachineSwipe {
  scrollerRef: (node: HTMLElement | null) => void;
  stripRef: (node: HTMLElement | null) => void;
  wrapRef: (node: HTMLElement | null) => void;
}

export function useMachineSwipe({
  tabs,
  armed,
}: {
  tabs: readonly MachineTab[];
  armed: () => boolean;
}): MachineSwipe {
  const strip = useRef<HTMLElement | null>(null);
  const wrap = useRef<HTMLElement | null>(null);
  const live = useRef<{ x: number; y: number; axis: "x" | "y" | null; still: boolean; dx: number } | null>(null);
  const latest = useRef(tabs);
  latest.current = tabs;
  const busy = useRef(armed);
  busy.current = armed;

  // The settle's timer, cancelled by a new flick so the follow stays pinned to the finger.
  const settling = useRef<number | null>(null);

  const unsettle = (node: HTMLElement): void => {
    if (settling.current !== null) window.clearTimeout(settling.current);
    settling.current = null;
    if (node.style.transition !== "") node.style.transition = "";
  };

  const slide = (by: number): void => {
    const node = wrap.current;
    if (node === null) return;
    unsettle(node);
    node.style.transform = by === 0 ? "" : `translate3d(${String(by)}px, 0, 0)`;
  };

  const settle = (): void => {
    const node = wrap.current;
    if (node === null) return;
    // A settle in flight owns the node; cancelling it here would strand its transition.
    if (node.style.transform === "") return;
    if (settling.current !== null) window.clearTimeout(settling.current);
    node.style.transition = `transform ${String(SETTLE_MS)}ms ease-out`;
    node.style.transform = "";
    settling.current = window.setTimeout(() => {
      settling.current = null;
      if (wrap.current !== null) wrap.current.style.transition = "";
    }, SETTLE_CLEAR_MS);
  };

  const onStart = (event: TouchEvent): void => {
    live.current = null;
    if (event.touches.length !== 1 || busy.current()) return;
    const finger = event.touches.item(0);
    if (finger === null) return;
    // Layout gate: swipe only while the lg:hidden tab strip is laid out, so this can never disagree with CSS.
    if (strip.current === null || strip.current.offsetParent === null) return;
    if (finger.clientX < EDGE_DEAD_ZONE || window.innerWidth - finger.clientX < EDGE_DEAD_ZONE) return;
    live.current = {
      x: finger.clientX,
      y: finger.clientY,
      axis: null,
      still: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      dx: 0,
    };
  };

  const onMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (going === null || finger === null) return;
    if (busy.current()) {
      live.current = null;
      settle();
      return;
    }
    const dx = finger.clientX - going.x;
    const dy = finger.clientY - going.y;
    if (going.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= SWIPE_SLOP) return;
      // Not cancelable means the engine has already committed to a pan.
      going.axis = Math.abs(dx) > Math.abs(dy) * DOMINANCE && event.cancelable ? "x" : "y";
    }
    if (going.axis !== "x") return;
    if (event.cancelable) event.preventDefault();
    going.dx = dx;
    if (going.still) return;
    const at = latest.current.findIndex((tab) => tab.selected);
    const end = (dx > 0 && at <= 0) || (dx < 0 && at >= latest.current.length - 1);
    slide(end ? dx * RUBBER : Math.max(-CAP, Math.min(CAP, dx)));
  };

  const onEnd = (): void => {
    const going = live.current;
    live.current = null;
    settle();
    if (going === null || going.axis !== "x" || Math.abs(going.dx) < COMMIT) return;
    const at = latest.current.findIndex((tab) => tab.selected);
    if (at < 0) return;
    const to = Math.min(Math.max(at + (going.dx < 0 ? 1 : -1), 0), latest.current.length - 1);
    if (to === at) return;
    const tab = latest.current[to];
    if (tab !== undefined) selectMachine(tab.id);
  };

  const scrollerRef = useTouchGesture<HTMLElement>({ start: onStart, move: onMove, stop: onEnd });

  const stripRef = useCallback((node: HTMLElement | null): void => {
    strip.current = node;
  }, []);
  const wrapRef = useCallback((node: HTMLElement | null): void => {
    // Drop the settle's pending clear with the node, or it fires on the next one.
    if (settling.current !== null) window.clearTimeout(settling.current);
    settling.current = null;
    wrap.current = node;
  }, []);

  return { scrollerRef, stripRef, wrapRef };
}
