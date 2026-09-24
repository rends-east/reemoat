// A conversation dragged back to the list below lg, as Telegram's is (Q3.663). App draws the list under it for the gesture as
// the same element the list's own route draws, cut to one screen, so landing there remounts nothing; inline writes move both.

import { useEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { navigate, navigateDrawn } from "../router";
import { ROW_FLOOR_PX } from "./machineSwipe";
import { currentLayers } from "./overlay";
import { PRESS_MS, PRESS_SLOP, useTouchGesture } from "./rowDrag";
import { letGo, settleTransition, snap } from "./sheetDrag";
import {
  backClaim,
  EDGE_DEAD_ZONE,
  releaseVelocity,
  SHEET_MS,
  sheetRelease,
  underAt,
  type Sample,
} from "./sheetMotion";

let under: number | null = null;
const listeners = new Set<() => void>();

export function subscribeBack(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** How many rows the list draws under the conversation for a back swipe, or null while there is none. */
export function backRows(): number | null {
  return under;
}

function announce(next: number | null): void {
  if (under === next) return;
  under = next;
  for (const listener of listeners) listener();
}

/** A finger on a field is placing a caret or selecting, never going back. */
const EDITABLE = "input, textarea, select, [contenteditable]";

const SAMPLES = 16;

interface Going {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  readonly target: Element | null;
  /** Where the finger started: a settle that lands anywhere else was overtaken by another door. */
  readonly path: string;
  /** Reduced motion: nothing follows the finger, and a release that goes back goes at once. */
  readonly still: boolean;
  decided: boolean;
  engaged: boolean;
  width: number;
  offset: number;
  samples: Sample[];
}

/** A horizontal scroller between the finger and the conversation that can still scroll back keeps the drag. */
function scrollsBack(target: Element | null, root: Element): boolean {
  for (let node = target; node !== null && node !== root; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollLeft <= 0) continue;
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

/** Back to the page's own layer; `none` rather than cleared, since reduced motion's 0.01ms transition shows the old value first. */
function restore(node: HTMLElement): void {
  letGo(node);
  node.style.transform = "";
  node.style.opacity = "";
}

/** A menu, a sheet or the task panel owns the screen; the ask card is part of the conversation and does not. */
function covered(): boolean {
  return currentLayers().some((layer) => layer.kind !== "ask");
}

export function useBackSwipe(): {
  ref: (node: HTMLElement | null) => void;
  /** On the back chevron: the swipe runs only while it is laid out, so the breakpoint stays in CSS. */
  gate: RefObject<HTMLButtonElement | null>;
  /** Capture phase on the same node: a menu closes on the press, before the touch that follows can ask what was open. */
  press: () => void;
} {
  const gate = useRef<HTMLButtonElement | null>(null);
  const pressedCovered = useRef(false);
  const root = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLElement | null>(null);
  const live = useRef<Going | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ offset: number; width: number } | null>(null);
  const settling = useRef<{ timer: number; done: () => void; home: boolean } | null>(null);

  const draw = (offset: number, width: number): void => {
    const node = root.current;
    if (node !== null) node.style.transform = `translate3d(${String(snap(offset))}px, 0, 0)`;
    const beneath = list.current;
    if (beneath === null) return;
    const { shift, opacity } = underAt(offset, width);
    beneath.style.transform = `translate3d(${String(snap(shift))}px, 0, 0)`;
    beneath.style.opacity = String(opacity);
  };

  // Moves arrive faster than frames on a phone; only the last one in each frame is written.
  const flush = (): void => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null) draw(next.offset, next.width);
  };

  /** Draws the list under the conversation, found by what it is, and promotes both for the gesture. */
  const engage = (going: Going): boolean => {
    const node = root.current;
    if (node === null) return false;
    // One screen of rows: the rest mount when it lands, below the fold.
    flushSync(() => announce(Math.ceil(node.offsetHeight / ROW_FLOOR_PX)));
    const beneath = document.querySelector<HTMLElement>("[data-back-under]");
    if (beneath === null) {
      flushSync(() => announce(null));
      return false;
    }
    list.current = beneath;
    for (const layer of [node, beneath]) layer.style.transition = "none";
    node.style.willChange = "transform";
    beneath.style.willChange = "transform, opacity";
    draw(going.offset, going.width);
    return true;
  };

  /** Home: the route lands on the list already drawn, in the same task as the list lets go, so nothing paints between. */
  const arrive = (): void => {
    const beneath = list.current;
    list.current = null;
    flushSync(() => {
      navigateDrawn("/");
      announce(null);
    });
    if (beneath !== null) restore(beneath);
  };

  const giveBack = (): void => {
    list.current = null;
    flushSync(() => announce(null));
    if (root.current !== null) restore(root.current);
  };

  const settle = (going: Going, wanted: boolean): void => {
    const home = wanted && window.location.pathname === going.path;
    if (going.still) {
      // Nothing was drawn, so the chevron's own path; its transition already stands down under reduced motion.
      if (home) navigate("/");
      return;
    }
    const node = root.current;
    const beneath = list.current;
    if (node !== null) node.style.transition = settleTransition(["transform"]);
    if (beneath !== null) beneath.style.transition = settleTransition(["transform", "opacity"]);
    draw(home ? going.width : 0, going.width);
    const done = (): void => {
      settling.current = null;
      if (home && window.location.pathname === going.path) arrive();
      else giveBack();
    };
    settling.current = { timer: window.setTimeout(done, SHEET_MS), done, home };
  };

  /** A new touch lands a conversation still settling back rather than grabbing it mid-flight. */
  const land = (): void => {
    const pendingSettle = settling.current;
    if (pendingSettle === null) return;
    window.clearTimeout(pendingSettle.timer);
    pendingSettle.done();
  };

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      if (settling.current !== null) window.clearTimeout(settling.current.timer);
      settling.current = null;
      // Left by another door mid-gesture, Android's Back included: the list that route draws keeps nothing of this one.
      if (list.current !== null) restore(list.current);
      list.current = null;
      announce(null);
    },
    [],
  );

  const ref = useTouchGesture<HTMLElement>(
    {
      start: (event) => {
        const finger = event.touches.item(0);
        const going = live.current;
        live.current = null;
        if (event.touches.length !== 1 || finger === null) {
          // A second finger is a pinch, not a faster drag.
          if (going?.engaged === true) settle(going, false);
          return;
        }
        const node = root.current;
        if (node === null || gate.current === null || gate.current.offsetParent === null) return;
        if (finger.clientX < EDGE_DEAD_ZONE || window.innerWidth - finger.clientX < EDGE_DEAD_ZONE) return;
        const target = event.target instanceof Element ? event.target : null;
        // A selection already made may be what the finger has come back to adjust.
        if (target?.closest(EDITABLE) != null || window.getSelection()?.isCollapsed === false) return;
        // The press that closes a menu closes it and does nothing else.
        if (pressedCovered.current || covered()) return;
        if (settling.current?.home === true) return;
        land();
        live.current = {
          x: finger.clientX,
          y: finger.clientY,
          t: event.timeStamp,
          target,
          path: window.location.pathname,
          still: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          decided: false,
          engaged: false,
          width: 0,
          offset: 0,
          samples: [],
        };
      },
      move: (event) => {
        const going = live.current;
        const finger = event.touches.item(0);
        const node = root.current;
        if (going === null || finger === null || node === null) return;
        const dx = finger.clientX - going.x;
        const dy = finger.clientY - going.y;
        if (!going.decided) {
          // A finger held past a long press is selecting text.
          if (event.timeStamp - going.t > PRESS_MS) {
            live.current = null;
            return;
          }
          if (Math.max(Math.abs(dx), Math.abs(dy)) <= PRESS_SLOP) return;
          going.decided = true;
          const free = event.cancelable && !event.defaultPrevented;
          if (!backClaim(dx, dy, { cancelable: free, scrollsBack: scrollsBack(going.target, node) })) {
            live.current = null;
            return;
          }
          going.width = node.offsetWidth;
          going.offset = Math.min(dx, going.width);
          if (!going.still && !engage(going)) {
            live.current = null;
            return;
          }
          going.engaged = true;
        }
        if (event.cancelable) event.preventDefault();
        going.offset = Math.min(Math.max(dx, 0), going.width);
        going.samples.push({ t: event.timeStamp, at: going.offset });
        if (going.samples.length > SAMPLES) going.samples.shift();
        if (going.still) return;
        pending.current = { offset: going.offset, width: going.width };
        frame.current ??= window.requestAnimationFrame(flush);
      },
      stop: (event) => {
        const going = live.current;
        live.current = null;
        if (going === null || !going.engaged) return;
        flush();
        const home =
          event.type !== "touchcancel" &&
          sheetRelease(going.offset, releaseVelocity(going.samples, event.timeStamp), going.width) === "dismiss";
        settle(going, home);
      },
    },
    root,
  );

  const press = (): void => {
    pressedCovered.current = covered();
  };

  return { ref, gate, press };
}
