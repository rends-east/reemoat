// The one drag-to-dismiss every sliding panel uses, begun on the panel or on its scrim (Q3.650, Q3.651, Q3.660). A finger is
// handled on the touch stream, a mouse on the pointer stream; the panel moves by inline writes, one per frame, so it has one writer.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { MOUSE_SLOP, PRESS_MS, PRESS_SLOP, useTouchGesture, type TouchOps } from "./rowDrag";
import {
  claimDrag,
  releaseVelocity,
  SHEET_EASE,
  SHEET_MS,
  sheetRelease,
  type Sample,
  type ScrollerEdge,
} from "./sheetMotion";

export type SheetAxis = "down" | "left";

/** What a surface does with a drag; `useSheetGesture` only decides that there is one. */
export interface SheetGeometry {
  begin: () => void;
  move: (travel: number) => void;
  /** `velocity` is px/ms toward the exit. */
  release: (travel: number, velocity: number) => void;
  cancel: () => void;
}

interface Going {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  /** `null` for a finger. */
  readonly pointer: number | null;
  readonly target: Element | null;
  readonly panel: Element | null;
  /** Begun on the scrim's bare surface rather than on the panel. */
  readonly scrim: boolean;
  scroller: HTMLElement | null;
  decided: boolean;
  engaged: boolean;
  travel: number;
  samples: Sample[];
}

const CLICK_AFTER_DRAG_MS = 400;

const SAMPLES = 16;

/** A mouse pressed here is editing or selecting, never moving the panel. */
const EDITABLE = "input, textarea, select, [contenteditable]";

/** The nearest box between the finger and the panel that scrolls vertically; read once per gesture, never marked by hand. */
function scrollerOf(target: Element | null, panel: Element | null): HTMLElement | null {
  for (let node = target; node !== null && node !== panel; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

function edgeOf(node: HTMLElement | null): ScrollerEdge | null {
  if (node === null) return null;
  return { atStart: node.scrollTop <= 0, atEnd: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 };
}

/** Whole device pixels: a thin bar re-rasterised at a new sub-pixel phase every frame is what flickered (Q3.651). */
export function snap(css: number): number {
  const ratio = window.devicePixelRatio || 1;
  return Math.round(css * ratio) / ratio;
}

export function slide(node: HTMLElement, axis: SheetAxis, at: number): void {
  const by = snap(Math.max(0, at));
  node.style.transform = by === 0 ? "" : axis === "down" ? `translateY(${String(by)}px)` : `translateX(${String(-by)}px)`;
}

/**
 * Stops the panel where it is drawn, arrival or settle included, and answers that offset.
 * Promotes it for the gesture, so each move is a compositor update rather than a repaint of everything on it.
 */
export function hold(node: HTMLElement, axis: SheetAxis): number {
  const drawn = new DOMMatrixReadOnly(getComputedStyle(node).transform);
  for (const running of node.getAnimations()) if ("animationName" in running) running.finish();
  node.style.transition = "none";
  node.style.willChange = "transform";
  const at = axis === "down" ? drawn.m42 : -drawn.m41;
  slide(node, axis, at);
  return at;
}

/**
 * The gesture is over and the panel still: its layer goes back to the page's.
 * `none` rather than cleared: reduced motion gives every property a 0.01ms transition, whose first frame is the old value.
 */
export function letGo(node: HTMLElement): void {
  node.style.transition = "none";
  node.style.willChange = "";
}

export function settleTransition(properties: readonly string[]): string {
  return properties.map((name) => `${name} ${String(SHEET_MS)}ms ${SHEET_EASE}`).join(", ");
}

/** As `hold`, for a scrim that fades with its panel: its arrival finished and its opacity on a layer of its own. */
export function holdFade(node: HTMLElement): void {
  for (const running of node.getAnimations()) if ("animationName" in running) running.finish();
  node.style.transition = "none";
  node.style.willChange = "opacity";
}

/** `shown` is how much of the panel is out, 0 to 1. */
export function fade(node: HTMLElement, shown: number): void {
  node.style.opacity = String(Math.min(1, Math.max(0, shown)));
}

interface PointerBind<E extends HTMLElement> {
  onPointerDown: (event: ReactPointerEvent<E>) => void;
  onPointerMove: (event: ReactPointerEvent<E>) => void;
  onPointerUp: (event: ReactPointerEvent<E>) => void;
  onPointerCancel: (event: ReactPointerEvent<E>) => void;
  onClickCapture: (event: ReactMouseEvent<E>) => void;
}

export function useSheetGesture<T extends HTMLElement>({
  axis,
  enabled,
  geometry,
  gate,
  held,
  scrim,
}: {
  axis: SheetAxis;
  enabled: boolean;
  geometry: SheetGeometry;
  /** Asked per gesture, never cached: the drag runs only while this is laid out, so the breakpoint stays in CSS. */
  gate?: RefObject<HTMLElement | null>;
  held?: RefObject<T | null>;
  scrim?: RefObject<HTMLElement | null>;
}): {
  ref: (node: T | null) => void;
  bind: PointerBind<T>;
  /** Spread on the scrim: a drag begun on it moves the panel as one begun on the panel does, and a tap still closes. */
  scrim: { ref: (node: HTMLElement | null) => void; bind: PointerBind<HTMLElement> };
} {
  const live = useRef<Going | null>(null);
  const ended = useRef(Number.NEGATIVE_INFINITY);
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const latest = useRef({ axis, enabled, geometry, gate });
  latest.current = { axis, enabled, geometry, gate };

  // Moves arrive faster than frames on a phone; only the last one in each frame is written.
  const flush = (): void => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    const travel = pending.current;
    pending.current = null;
    if (travel !== null) latest.current.geometry.move(travel);
  };

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  const start = (
    target: EventTarget | null,
    panel: EventTarget | null,
    x: number,
    y: number,
    t: number,
    pointer: number | null,
    onScrim: boolean,
  ): boolean => {
    live.current = null;
    ended.current = Number.NEGATIVE_INFINITY;
    const now = latest.current;
    if (!now.enabled) return false;
    if (now.gate !== undefined && (now.gate.current?.offsetParent ?? null) === null) return false;
    const node = target instanceof Element ? target : null;
    const box = panel instanceof Element ? panel : null;
    live.current = { x, y, t, pointer, target: node, panel: box, scrim: onScrim, scroller: null, decided: false, engaged: false, travel: 0, samples: [] };
    return true;
  };

  /** Answers whether the move is the panel's, so the finger's caller can keep it from the scroller. */
  const follow = (going: Going, dx: number, dy: number, t: number, slop: number, free: boolean): boolean => {
    const now = latest.current;
    if (!now.enabled) {
      live.current = null;
      return false;
    }
    const along = now.axis === "down" ? dy : -dx;
    if (!going.decided) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= slop) return false;
      going.decided = true;
      if (now.axis === "down") going.scroller = scrollerOf(going.target, going.panel);
      if (!claimDrag(along, now.axis === "down" ? dx : dy, edgeOf(going.scroller), free)) {
        live.current = null;
        return false;
      }
      going.engaged = true;
      now.geometry.begin();
    }
    going.travel = along;
    going.samples.push({ t, at: along });
    if (going.samples.length > SAMPLES) going.samples.shift();
    pending.current = along;
    frame.current ??= window.requestAnimationFrame(flush);
    return true;
  };

  const finish = (going: Going, t: number, cancelled: boolean): void => {
    if (!going.engaged) return;
    flush();
    ended.current = t;
    if (cancelled) latest.current.geometry.cancel();
    else latest.current.geometry.release(going.travel, releaseVelocity(going.samples, t));
  };

  // A routed sheet's scrim is its panel's parent, so every handler on the scrim answers only for what began on its bare surface.
  const touchOps = (onScrim: boolean): TouchOps => ({
    start: (event) => {
      const finger = event.touches.item(0);
      if (event.touches.length !== 1 || finger === null) {
        // A second finger is a pinch, not a faster drag.
        const going = live.current;
        live.current = null;
        if (going !== null) finish(going, event.timeStamp, true);
        return;
      }
      if (onScrim && event.target !== event.currentTarget) return;
      start(event.target, event.currentTarget, finger.clientX, finger.clientY, event.timeStamp, null, onScrim);
    },
    move: (event) => {
      const going = live.current;
      const finger = event.touches.item(0);
      if (going === null || going.pointer !== null || going.scrim !== onScrim || finger === null) return;
      // A finger held past a long press is selecting text or arming a row's own drag.
      if (!going.decided && event.timeStamp - going.t > PRESS_MS) {
        live.current = null;
        return;
      }
      const free = event.cancelable && !event.defaultPrevented;
      const mine = follow(going, finger.clientX - going.x, finger.clientY - going.y, event.timeStamp, PRESS_SLOP, free);
      if (mine && event.cancelable) event.preventDefault();
    },
    stop: (event) => {
      const going = live.current;
      if (going === null || going.pointer !== null || going.scrim !== onScrim) return;
      live.current = null;
      finish(going, event.timeStamp, event.type === "touchcancel");
    },
  });

  const pointerBind = <E extends HTMLElement>(onScrim: boolean): PointerBind<E> => ({
    onPointerDown: (event) => {
      if (event.pointerType === "touch") {
        ended.current = Number.NEGATIVE_INFINITY;
        return;
      }
      if (event.button !== 0 || (onScrim && event.target !== event.currentTarget)) return;
      if (!start(event.target, event.currentTarget, event.clientX, event.clientY, event.timeStamp, event.pointerId, onScrim)) return;
      const going = live.current;
      // A mouse on a field, or inside a scroller, is editing, selecting or dragging a scrollbar.
      if (going !== null && (going.target?.closest(EDITABLE) != null || scrollerOf(going.target, going.panel) !== null)) {
        live.current = null;
      }
    },
    onPointerMove: (event) => {
      const going = live.current;
      if (going === null || going.pointer !== event.pointerId || going.scrim !== onScrim) return;
      const was = going.engaged;
      const mine = follow(going, event.clientX - going.x, event.clientY - going.y, event.timeStamp, MOUSE_SLOP, true);
      // Captured at engage, never at the press, which would retarget a row's click.
      if (mine && !was) event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerUp: (event) => {
      const going = live.current;
      if (going === null || going.pointer !== event.pointerId || going.scrim !== onScrim) return;
      live.current = null;
      finish(going, event.timeStamp, false);
    },
    onPointerCancel: (event) => {
      const going = live.current;
      if (going === null || going.pointer !== event.pointerId || going.scrim !== onScrim) return;
      live.current = null;
      finish(going, event.timeStamp, true);
    },
    // The click a drag leaves behind would otherwise choose the row it ended on, or close what it let settle back.
    onClickCapture: (event) => {
      if (event.timeStamp - ended.current > CLICK_AFTER_DRAG_MS) return;
      ended.current = Number.NEGATIVE_INFINITY;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  const ref = useTouchGesture<T>(touchOps(false), held);
  const scrimRef = useTouchGesture<HTMLElement>(touchOps(true), scrim);

  return { ref, bind: pointerBind<T>(false), scrim: { ref: scrimRef, bind: pointerBind<HTMLElement>(true) } };
}

/**
 * A panel that slides out along its axis and stops at open, a sibling scrim fading with it: a transform and an opacity, so no
 * move lays anything out. A scrim that is the panel's parent is not passed, or the panel would fade with it (Q3.650).
 */
export function useSlideSheet(
  panel: RefObject<HTMLElement | null>,
  axis: SheetAxis,
  onDismiss: () => void,
  beside?: { scrim: RefObject<HTMLElement | null>; open: boolean },
): SheetGeometry {
  const state = useRef({ extent: 0, from: 0, timer: null as number | null, left: null as HTMLElement | null });
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const open = beside?.open ?? true;
  const shade = (): HTMLElement | null => beside?.scrim.current ?? null;
  const shown = (at: number): number => 1 - at / Math.max(1, state.current.extent);

  // Reopened mid-exit, the same nodes still carry the drag that dismissed them.
  useLayoutEffect(() => {
    if (!open) return;
    const node = state.current.left;
    state.current.left = null;
    if (node === null || node !== panel.current) return;
    letGo(node);
    slide(node, axis, 0);
    const scrim = shade();
    if (scrim === null) return;
    letGo(scrim);
    scrim.style.opacity = "";
  }, [open]);

  const settle = (node: HTMLElement): void => {
    node.style.transition = settleTransition(["transform"]);
    slide(node, axis, 0);
    const scrim = shade();
    if (scrim !== null) {
      scrim.style.transition = settleTransition(["opacity"]);
      scrim.style.opacity = "";
    }
    state.current.timer = window.setTimeout(() => {
      state.current.timer = null;
      letGo(node);
      if (scrim !== null) letGo(scrim);
    }, SHEET_MS);
  };

  return {
    begin: () => {
      const node = panel.current;
      if (node === null) return;
      if (state.current.timer !== null) window.clearTimeout(state.current.timer);
      state.current.timer = null;
      const box = node.getBoundingClientRect();
      state.current.extent = axis === "down" ? box.height : box.width;
      state.current.from = hold(node, axis);
      const scrim = shade();
      if (scrim === null) return;
      holdFade(scrim);
      fade(scrim, shown(state.current.from));
    },
    move: (travel) => {
      const at = Math.max(0, state.current.from + travel);
      if (panel.current !== null) slide(panel.current, axis, at);
      const scrim = shade();
      if (scrim !== null) fade(scrim, shown(at));
    },
    release: (travel, velocity) => {
      const node = panel.current;
      if (node === null) return;
      // The offsets stay: the exit keyframes have no `from`, so both leave from where the finger let go.
      if (sheetRelease(state.current.from + travel, velocity, state.current.extent) === "dismiss") {
        state.current.left = node;
        dismiss.current();
      } else settle(node);
    },
    cancel: () => {
      if (panel.current !== null) settle(panel.current);
    },
  };
}
