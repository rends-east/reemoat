// Drag to reorder machines: a finger arms on a hold, a mouse on travel; indexes are over tabs, so All never moves.
// The pointer is captured at arm, never at the press, or the click that selects a machine is retargeted (Q3.576).

import { useCallback, useEffect, useRef, useState } from "react";
import { isTypingInto } from "../keys";
import { moveRow } from "../agentStrip";
import { setMachineOrder, dropSlot } from "../machineOrder";
import { HAPTIC_MS, MOUSE_SLOP, PRESS_MS, PRESS_SLOP, driftFor, useTouchGesture } from "./rowDrag";
import { ALL_MACHINES, type MachineTab, type MachineTabId } from "./groups";

/** The keys each axis takes, exposed on the entry itself since it has no handle to name. */
const SHORTCUTS = {
  y: "Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End",
  x: "Alt+ArrowLeft Alt+ArrowRight Alt+Home Alt+End",
} as const;

const MOVABLE = "movable machine";

interface Move {
  from: number;
  to: number;
  size: number;
}

export interface MachineDrag {
  scrollerRef: (node: HTMLElement | null) => void;
  dragging: MachineTabId | null;
  sliding: boolean;
  shiftFor: (index: number) => number;
  /** Whether a drag has armed and owns the touch. Synchronous, for the swipe. */
  armed: () => boolean;
  /** What the last keyboard move did; the caller draws it in an sr-only live region. */
  announcement: string;
  bind: (id: MachineTabId, index: number) => {
    "data-machine": MachineTabId;
    "aria-keyshortcuts": string;
    "aria-roledescription": string;
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

export function useMachineDrag({ axis, tabs }: { axis: "x" | "y"; tabs: readonly MachineTab[] }): MachineDrag {
  const [move, setMove] = useState<Move | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const scroller = useRef<HTMLElement | null>(null);
  const live = useRef<{
    id: MachineTabId;
    node: HTMLElement;
    pointerId: number;
    start: number;
    startOff: number;
    grab: number;
    applied: number;
    byMove: boolean;
    armed: boolean;
    middles: number[];
    size: number;
    from: number;
    to: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rolling = useRef<number | null>(null);
  const last = useRef(0);
  const lastOff = useRef(0);
  /** Set when a drag armed, so the `click` the pointer leaves behind is eaten. */
  const suppress = useRef(false);
  /** Set only when a poll replaces tabs under a held drag; a pointer event re-places on its own. */
  const dirty = useRef(false);
  /** Touch listeners are registered once, so they read the current tabs through this ref. */
  const latest = useRef(tabs);
  latest.current = tabs;
  const axisRef = useRef(axis);
  axisRef.current = axis;

  const along = (event: { clientX: number; clientY: number }): number =>
    axisRef.current === "y" ? event.clientY : event.clientX;
  const across = (event: { clientX: number; clientY: number }): number =>
    axisRef.current === "y" ? event.clientX : event.clientY;

  /** Both reads before the one write: a layout read after a style write forces a reflow every frame. */
  const frameOf = (): { rect: DOMRect; scroll: number } | null => {
    const box = scroller.current;
    if (box === null) return null;
    return { rect: box.getBoundingClientRect(), scroll: axisRef.current === "y" ? box.scrollTop : box.scrollLeft };
  };

  const content = (frame: { rect: DOMRect; scroll: number } | null, at: number): number =>
    frame === null ? at : at - (axisRef.current === "y" ? frame.rect.top : frame.rect.left) + frame.scroll;

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Over tabs rather than the scroller's children, so All's own data-machine never shifts an index. */
  const measure = (): { middles: number[]; size: number } | null => {
    const box = scroller.current;
    if (box === null) return null;
    const rect = box.getBoundingClientRect();
    const vertical = axisRef.current === "y";
    const offset = vertical ? rect.top - box.scrollTop : rect.left - box.scrollLeft;
    const middles: number[] = [];
    let size = 0;
    for (const tab of latest.current) {
      const node = box.querySelector<HTMLElement>(`[data-machine="${CSS.escape(tab.id)}"]`);
      if (node === null) return null;
      const at = node.getBoundingClientRect();
      const near = (vertical ? at.top : at.left) - offset;
      const far = (vertical ? at.bottom : at.right) - offset;
      middles.push((near + far) / 2);
      size = Math.max(size, vertical ? at.height : at.width);
    }
    return { middles, size };
  };

  /** The base is recovered from the live rect on every call, so auto-scroll and a poll self-correct. */
  const place = (at: number, frame?: { rect: DOMRect; scroll: number } | null): void => {
    const going = live.current;
    if (going === null || !going.armed) return;
    dirty.current = false;
    const vertical = axisRef.current === "y";
    const where = frame === undefined ? frameOf() : frame;
    const rect = going.node.getBoundingClientRect();
    const base = (vertical ? rect.top : rect.left) - going.applied;
    const offset = at - going.grab - base;
    const to = dropSlot(going.middles, going.from, content(where, at));
    going.applied = offset;
    going.node.style.transform = vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`;
    if (to === going.to) return;
    going.to = to;
    setMove({ from: going.from, to, size: going.size });
  };

  /** Re-arms every frame so the follow self-corrects, but only works on drift or a stale follow. */
  const roll = (): void => {
    rolling.current = null;
    const going = live.current;
    const box = scroller.current;
    if (going === null || !going.armed || box === null) return;
    const vertical = axisRef.current === "y";
    const rect = box.getBoundingClientRect();
    const scroll = vertical ? box.scrollTop : box.scrollLeft;
    const drift = driftFor(vertical ? rect.top : rect.left, vertical ? rect.bottom : rect.right, last.current);
    if (drift !== 0) {
      if (vertical) box.scrollTop = scroll + drift;
      else box.scrollLeft = scroll + drift;
      // Read back rather than assumed: the engine clamps at either end.
      place(last.current, { rect, scroll: vertical ? box.scrollTop : box.scrollLeft });
    } else if (dirty.current) {
      place(last.current, { rect, scroll });
    }
    rolling.current = requestAnimationFrame(roll);
  };

  const arm = (): void => {
    const going = live.current;
    if (going === null || going.armed) return;
    clearTimer();
    const measured = measure();
    const from = latest.current.findIndex((tab) => tab.id === going.id);
    if (measured === null || from < 0) {
      live.current = null;
      return;
    }
    going.armed = true;
    going.middles = measured.middles;
    going.size = measured.size;
    going.from = from;
    going.to = from;
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
    setMove({ from, to: from, size: measured.size });
    place(last.current);
    if (rolling.current === null) rolling.current = requestAnimationFrame(roll);
    if (!going.byMove) navigator.vibrate?.(HAPTIC_MS);
  };

  const end = useCallback((): void => {
    clearTimer();
    if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    rolling.current = null;
    const going = live.current;
    live.current = null;
    setMove(null);
    if (going === null) return;
    going.node.style.transform = "";
    going.node.style.touchAction = "";
    going.node.style.willChange = "";
    going.node.style.webkitUserSelect = "";
    going.node.style.userSelect = "";
    going.node.style.removeProperty("-webkit-touch-callout");
    if (going.byMove) {
      try {
        going.node.releasePointerCapture(going.pointerId);
      } catch {
        // Already released, or a pointer that has gone.
      }
    }
    if (!going.armed || going.to === going.from) return;
    // The list may have changed on the poll since arm; an index that no longer names this row abandons the write.
    const settled = latest.current;
    if (settled.length !== going.middles.length || settled[going.from]?.id !== going.id) return;
    setMachineOrder(moveRow(settled, going.from, going.to).map((tab) => tab.id));
  }, []);

  useEffect(() => end, [end]);

  // A drag whose node left tabs gets no further events, so end it here or the next click stays eaten.
  useEffect(() => {
    const going = live.current;
    if (going === null) return;
    if (!tabs.some((tab) => tab.id === going.id)) end();
    else dirty.current = true;
  }, [tabs, end]);

  const begin = (id: MachineTabId, node: HTMLElement, at: number, byMove: boolean, pointerId: number): void => {
    suppress.current = false;
    const box = node.getBoundingClientRect();
    live.current = {
      id,
      node,
      pointerId,
      start: at,
      startOff: lastOff.current,
      grab: at - (axisRef.current === "y" ? box.top : box.left),
      applied: 0,
      byMove,
      armed: false,
      middles: [],
      size: 0,
      from: -1,
      to: -1,
    };
    last.current = at;
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      if (live.current !== null) end();
      return;
    }
    const finger = event.touches.item(0);
    const from = event.target instanceof Element ? event.target : null;
    if (finger === null || from === null) return;
    const node = from.closest<HTMLElement>("[data-machine]");
    if (node === null) return;
    const id = (node.dataset["machine"] ?? "") as MachineTabId;
    // All carries a data-machine but is not a machine; this membership test is what refuses it.
    if (id === ALL_MACHINES || !latest.current.some((tab) => tab.id === id)) return;
    // Set at touchstart: iOS decides on its long-press callout there.
    node.style.webkitUserSelect = "none";
    node.style.userSelect = "none";
    node.style.setProperty("-webkit-touch-callout", "none");
    lastOff.current = across(finger);
    begin(id, node, along(finger), false, -1);
    clearTimer();
    timer.current = setTimeout(arm, PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent): void => {
    const going = live.current;
    const finger = event.touches.item(0);
    if (going === null || finger === null || going.byMove) return;
    const at = along(finger);
    const off = across(finger);
    last.current = at;
    lastOff.current = off;
    if (going.armed) {
      // Only while armed: refusing the default keeps the scroller from taking the touch back.
      if (event.cancelable) event.preventDefault();
      place(at);
      return;
    }
    if (Math.hypot(at - going.start, off - going.startOff) > PRESS_SLOP) end();
  };

  const scrollerRef = useTouchGesture<HTMLElement>(
    { start: onTouchStart, move: onTouchMove, stop: () => end() },
    scroller,
  );

  const shiftFor = (index: number): number => {
    if (move === null || index === move.from) return 0;
    if (move.to > move.from && index > move.from && index <= move.to) return -move.size;
    if (move.to < move.from && index >= move.to && index < move.from) return move.size;
    return 0;
  };

  /** Alt with the arrows moves a focused entry; horizontally this deliberately preempts the platform's Back and Forward. */
  const onKey = (index: number, event: React.KeyboardEvent<HTMLElement>): void => {
    if (!event.altKey || isTypingInto(event.target)) return;
    const vertical = axisRef.current === "y";
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const on = vertical ? "ArrowDown" : "ArrowRight";
    const count = latest.current.length;
    let to = index;
    if (event.key === back) to = index - 1;
    else if (event.key === on) to = index + 1;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = count - 1;
    else return;
    event.preventDefault();
    to = Math.min(Math.max(to, 0), count - 1);
    if (to === index) return;
    const rows = moveRow(latest.current, index, to);
    setMachineOrder(rows.map((tab) => tab.id));
    const name = latest.current[index]?.name ?? "";
    setAnnouncement(`${name} moved to position ${String(to + 1)} of ${String(count)}.`);
  };

  const bind = (id: MachineTabId, index: number): ReturnType<MachineDrag["bind"]> => ({
    "data-machine": id,
    "aria-keyshortcuts": SHORTCUTS[axis],
    "aria-roledescription": MOVABLE,
    onPointerDown: (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      lastOff.current = across(event);
      begin(id, event.currentTarget, along(event), true, event.pointerId);
    },
    onPointerMove: (event) => {
      const going = live.current;
      if (event.pointerType !== "mouse" || going === null || !going.byMove) return;
      last.current = along(event);
      lastOff.current = across(event);
      if (going.armed) {
        place(along(event));
        return;
      }
      if (Math.hypot(along(event) - going.start, across(event) - going.startOff) > MOUSE_SLOP) arm();
    },
    onPointerUp: (event) => {
      if (event.pointerType === "mouse") end();
    },
    onPointerCancel: (event) => {
      if (event.pointerType === "mouse") end();
    },
    onLostPointerCapture: (event) => {
      if (event.pointerType === "mouse") end();
    },
    // Android's long press is ~500ms against this hold's 400, so the two race.
    onContextMenu: (event) => {
      if (live.current !== null) event.preventDefault();
    },
    // The drop must not also select the machine it dropped.
    onClickCapture: (event) => {
      if (!suppress.current) return;
      suppress.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    // The label is text and the browser will happily drag it instead.
    onDragStart: (event) => event.preventDefault(),
    onKeyDown: (event) => onKey(index, event),
  });

  return {
    scrollerRef,
    dragging: move === null ? null : (latest.current[move.from]?.id ?? null),
    sliding: move !== null,
    shiftFor,
    armed: () => live.current?.armed === true,
    announcement,
    bind,
  };
}
