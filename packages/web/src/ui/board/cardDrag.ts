// The board's card drag (Q3.728), and the list's (Q3.733). A mouse arms on movement, as the rail's row drag does; the card is
// lifted into a copy that follows the pointer above every scroller, the column under it opens a slot where the board's own
// order will put the card, and on release the copy settles into that slot or back where it came from. A finger does not drag
// a card. Once armed the pointer is followed on window, since the card it left may unmount.

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { columnOrder, taskHolder, type BoardColumn, type BoardTask, type TaskHolder } from "../../board";
import { useDismissible } from "../overlay";
import { driftFor, MOUSE_SLOP } from "../rowDrag";
import { reducedMotion, SETTLE_EASE, SETTLE_MS } from "./Flip";

/** The lifted copy's tilt and size, which the settle eases back from. */
export const LIFTED = "rotate(1.5deg) scale(1.02)";

/** A card an agent is on may only be marked done: the agent is stopped from its conversation, which hands the task back. */
export function dropRefused(from: BoardColumn, to: BoardColumn): boolean {
  return from === "running" && to !== "running" && to !== "done";
}

export interface Carried {
  entry: BoardTask;
  key: string;
  from: BoardColumn;
  /** The column under the pointer, or null between and outside them. */
  over: BoardColumn | null;
  width: number;
  height: number;
  /** Set once let go: the copy is flying into its slot, or back to where it was lifted from. */
  settling: "in" | "back" | null;
}

/** The column the carried card would land in now: its own, none, and a refused one all send it back. */
export function landsIn(carried: Carried): BoardColumn | null {
  const { over, from } = carried;
  return over === null || over === from || dropRefused(from, over) ? null : over;
}

/** The key a card, a list line and a slot of one task share. */
export function cardKey(entry: Pick<BoardTask, "machineId" | "task">): string {
  return `${entry.machineId}/${entry.task.id}`;
}

/** One column's rows as drawn this moment: its cards, the carried one's ghost where it was lifted, and the slot it would land in. */
export type DragItem = { kind: "card" | "ghost"; entry: BoardTask; key: string } | { kind: "slot"; entry: BoardTask; key: string; holder: TaskHolder };

/**
 * The ghost stays where the card was lifted until another column would take it; the slot opens where the board's order puts it,
 * drawn as it will be there: Review's already shows its person, and Running shows nobody until one is picked, unless the backlog
 * named the agent that starts (Q3.732).
 */
export function laneItems(column: BoardColumn, tasks: readonly BoardTask[], carried: Carried | null): DragItem[] {
  const lands = carried === null ? null : landsIn(carried);
  const items: DragItem[] = tasks.flatMap((entry): DragItem[] => {
    const key = cardKey(entry);
    if (carried === null || carried.key !== key) return [{ kind: "card", entry, key }];
    return lands === null ? [{ kind: "ghost", entry, key }] : [];
  });
  if (carried === null || lands !== column) return items;
  const landed = { ...carried.entry, task: { ...carried.entry.task, status: column } };
  const named = carried.from === "ready" && carried.entry.task.assignee === "agent";
  const holder: TaskHolder = column === "running" && !named ? { kind: "nobody" } : taskHolder(landed.task);
  const at = items.filter((item) => columnOrder(item.entry, landed) < 0).length;
  items.splice(at, 0, { kind: "slot", entry: landed, key: carried.key, holder });
  return items;
}

export interface CardDrag {
  carried: Carried | null;
  boardRef: (node: HTMLElement | null) => void;
  laneRef: (column: BoardColumn) => (node: HTMLElement | null) => void;
  previewRef: (node: HTMLElement | null) => void;
  bind: (
    entry: BoardTask,
    column: BoardColumn,
    key: string,
  ) => {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  };
}

interface Press {
  entry: BoardTask;
  column: BoardColumn;
  key: string;
  pointerId: number;
  x: number;
  y: number;
  node: HTMLElement;
}

/** How far outside a column the pointer still counts as over it: the gap between two must not flicker the slot. */
const LANE_REACH = 8;

/** The nearest box that scrolls on y, which the list's drag rolls: the list is not its own scroller. */
function scrollerOf(node: HTMLElement | null): HTMLElement | null {
  for (let at = node?.parentElement ?? null; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/** `x` is the board's columns side by side; `y` is the list's groups one under another, a folded one taking a card under its heading. */
export function useCardDrag(onDrop: (entry: BoardTask, from: BoardColumn, to: BoardColumn) => void, axis: "x" | "y" = "x"): CardDrag {
  const [carried, setCarried] = useState<Carried | null>(null);
  const held = useRef<Carried | null>(null);
  held.current = carried;
  const dropped = useRef(onDrop);
  dropped.current = onDrop;

  const press = useRef<Press | null>(null);
  const pointer = useRef({ x: 0, y: 0, grabX: 0, grabY: 0 });
  const lastOver = useRef<BoardColumn | null>(null);
  const board = useRef<HTMLElement | null>(null);
  const lanes = useRef(new Map<BoardColumn, HTMLElement>());
  const laneRefs = useRef(new Map<BoardColumn, (node: HTMLElement | null) => void>());
  const preview = useRef<HTMLElement | null>(null);
  const rolling = useRef<number | null>(null);
  const suppress = useRef(false);
  const unlisten = useRef<(() => void) | null>(null);

  const place = (): void => {
    const node = preview.current;
    if (node === null) return;
    const at = pointer.current;
    node.style.transform = `translate3d(${at.x - at.grabX}px, ${at.y - at.grabY}px, 0)`;
  };

  // On one axis alone, within the other's extent: columns stand side by side, and a slot that closed in each gap would flicker.
  const columnAt = (x: number, y: number): BoardColumn | null => {
    const area = board.current?.getBoundingClientRect();
    if (area === undefined) return null;
    if (axis === "x" ? y < area.top || y > area.bottom : x < area.left || x > area.right) return null;
    for (const [column, node] of lanes.current) {
      const box = node.getBoundingClientRect();
      const [from, to, at] = axis === "x" ? [box.left, box.right, x] : [box.top, box.bottom, y];
      if (at >= from - LANE_REACH && at <= to + LANE_REACH) return column;
    }
    return null;
  };

  const track = (): void => {
    place();
    const now = held.current;
    if (now === null || now.settling !== null) return;
    const over = columnAt(pointer.current.x, pointer.current.y);
    if (over === lastOver.current) return;
    lastOver.current = over;
    setCarried((before) => (before === null || before.settling !== null ? before : { ...before, over }));
  };

  const roll = (): void => {
    const now = held.current;
    if (now === null || now.settling !== null) {
      rolling.current = null;
      return;
    }
    const at = pointer.current;
    const box = axis === "x" ? board.current : scrollerOf(board.current);
    if (box !== null) {
      const seen = box.getBoundingClientRect();
      const drift = axis === "x" ? driftFor(seen.left, seen.right, at.x) : driftFor(seen.top, seen.bottom, at.y);
      if (drift !== 0) {
        if (axis === "x") box.scrollLeft += drift;
        else box.scrollTop += drift;
      }
    }
    const over = columnAt(at.x, at.y);
    const list = axis === "y" || over === null ? null : (lanes.current.get(over)?.querySelector<HTMLElement>("[data-lane-scroll]") ?? null);
    if (list !== null) {
      const seen = list.getBoundingClientRect();
      const drift = driftFor(seen.top, seen.bottom, at.y);
      if (drift !== 0) list.scrollTop += drift;
    }
    track();
    rolling.current = requestAnimationFrame(roll);
  };

  const stopFollowing = (): void => {
    unlisten.current?.();
    unlisten.current = null;
    if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    rolling.current = null;
    document.documentElement.style.removeProperty("cursor");
  };

  const settle = useCallback((back: boolean): void => {
    stopFollowing();
    press.current = null;
    setCarried((before) => {
      if (before === null || before.settling !== null) return before;
      const lands = back ? null : landsIn(before);
      return { ...before, over: lands ?? before.from, settling: lands === null ? "back" : "in" };
    });
  }, []);

  const arm = (at: Press, x: number, y: number): void => {
    // The press moved the card itself, as one that closes the agent menu and lets it slide back does: nothing is carried.
    if (!at.node.isConnected) {
      stopFollowing();
      press.current = null;
      return;
    }
    const box = at.node.getBoundingClientRect();
    pointer.current = { x, y, grabX: at.x - box.left, grabY: at.y - box.top };
    suppress.current = true;
    lastOver.current = at.column;
    document.documentElement.style.cursor = "grabbing";
    setCarried({ entry: at.entry, key: at.key, from: at.column, over: at.column, width: box.width, height: box.height, settling: null });
    rolling.current = requestAnimationFrame(roll);
  };

  const follow = (at: Press): void => {
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== at.pointerId) return;
      if (held.current === null) {
        if (Math.hypot(event.clientX - at.x, event.clientY - at.y) < MOUSE_SLOP) return;
        arm(at, event.clientX, event.clientY);
        return;
      }
      pointer.current.x = event.clientX;
      pointer.current.y = event.clientY;
      track();
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== at.pointerId) return;
      if (held.current === null) {
        // Never armed: a press and nothing more, which the card's own click answers.
        stopFollowing();
        press.current = null;
        return;
      }
      settle(false);
    };
    const lost = (): void => {
      if (held.current === null) {
        stopFollowing();
        press.current = null;
        return;
      }
      settle(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", lost);
    window.addEventListener("blur", lost);
    unlisten.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", lost);
      window.removeEventListener("blur", lost);
    };
  };

  // Escape puts the card back, through overlay.ts as every other Escape goes.
  useDismissible("menu", () => settle(true), carried !== null && carried.settling === null);

  // The flight, once the slot or the place it left is drawn: measured then, since either may have moved while it was carried.
  useLayoutEffect(() => {
    const now = carried;
    if (now === null || now.settling === null) return;
    const node = preview.current;
    const slot = board.current?.querySelector<HTMLElement>(`[data-slot="${CSS.escape(now.key)}"]`) ?? null;
    // A folded group has no slot: the copy goes into its heading and fades there.
    const head = slot === null && now.over !== null ? (lanes.current.get(now.over)?.querySelector<HTMLElement>("[data-lane-head]") ?? null) : null;
    const target = slot ?? head;
    const land = (): void => {
      const lands = now.settling === "in" ? landsIn(now) : null;
      if (lands !== null) dropped.current(now.entry, now.from, lands);
      setCarried(null);
    };
    if (node === null || target === null || reducedMotion()) {
      land();
      return;
    }
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    const to = target.getBoundingClientRect();
    const at = pointer.current;
    const flight = node.animate(
      [
        { transform: `translate3d(${at.x - at.grabX}px, ${at.y - at.grabY}px, 0)`, opacity: 1 },
        { transform: `translate3d(${to.left}px, ${to.top}px, 0)`, opacity: slot === null ? 0 : 1 },
      ],
      { duration: SETTLE_MS, easing: SETTLE_EASE, fill: "forwards" },
    );
    (node.firstElementChild as HTMLElement | null)?.animate([{ transform: LIFTED }, { transform: "none" }], {
      duration: SETTLE_MS,
      easing: SETTLE_EASE,
      fill: "forwards",
    });
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(late);
      land();
    };
    // A page hidden mid-flight stops its animations: the card lands anyway, a little late.
    const late = window.setTimeout(() => {
      flight.cancel();
      finish();
    }, SETTLE_MS + 250);
    flight.onfinish = finish;
    return () => {
      window.clearTimeout(late);
      // Unmounted mid-flight: the board went away, so nothing is left to land in.
      if (!done) flight.cancel();
    };
  }, [carried?.settling]);

  return {
    carried,
    boardRef: useCallback((node: HTMLElement | null) => void (board.current = node), []),
    laneRef: (column) => {
      let ref = laneRefs.current.get(column);
      if (ref === undefined) {
        ref = (node: HTMLElement | null): void => {
          if (node === null) lanes.current.delete(column);
          else lanes.current.set(column, node);
        };
        laneRefs.current.set(column, ref);
      }
      return ref;
    },
    previewRef: useCallback((node: HTMLElement | null) => {
      preview.current = node;
      // Placed before its first paint, or it flashes at the corner of the window for a frame.
      if (node !== null) place();
    }, []),
    bind: (entry, column, key) => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || event.pointerType === "touch" || held.current !== null || entry.unavailable) return;
        // A drag let go over another card leaves its click to an ancestor, so the flag is cleared by the next press, not by a click.
        suppress.current = false;
        stopFollowing();
        const at: Press = { entry, column, key, pointerId: event.pointerId, x: event.clientX, y: event.clientY, node: event.currentTarget };
        press.current = at;
        follow(at);
      },
      // The click a drag leaves behind opens nothing.
      onClickCapture: (event) => {
        if (!suppress.current) return;
        suppress.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragStart: (event) => event.preventDefault(),
    }),
  };
}
