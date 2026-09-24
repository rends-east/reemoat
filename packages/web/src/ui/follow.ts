import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Whether the conversation stays at its foot is decided by what the reader did, never by where layout happened to leave the box (Q3.648).

/** Inside the column's own 48px foot, so a reader counted as there has only blank space hidden. */
export const FOOT_SLACK_PX = 48;

/** `scrollTop` is fractional where `scrollHeight` and `clientHeight` are rounded. */
export const FOOT_EXACT_PX = 2;

export interface Extent {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function gapBelow(box: Extent): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/**
 * Against where the box was last left. Growth landing after a pin is a gap with no move, which is nobody leaving; only a move up
 * leaves — and not one the box's own growth explains, which is the clamp a taller box makes, however much streamed in after it (Q3.664).
 */
export function followsAfterScroll(atBottom: boolean, now: Extent, lastTop: number, lastClientHeight = now.clientHeight): boolean {
  const gap = gapBelow(now);
  if (gap <= FOOT_EXACT_PX) return true;
  const moved = now.scrollTop - lastTop;
  const clamped = Math.max(0, now.clientHeight - lastClientHeight);
  if (moved < -FOOT_EXACT_PX && -moved > clamped + FOOT_EXACT_PX) return false;
  if (moved > 0 && gap < FOOT_SLACK_PX) return true;
  return atBottom;
}

/** How long after the window's last resize the offset is written again, past the end of a full-screen transition. */
export const RESIZE_SETTLE_MS = 250;

/**
 * Writes the offset WebKit already holds, as a change it cannot drop. A resize clamps it in layout, and the pin that follows writes
 * that same value, a no-op WebKit never sends on — so a scrolling layer the resize left at the old offset stayed there (Q3.664).
 */
export function resync(box: HTMLElement): void {
  if (box.scrollHeight - box.clientHeight < 1) return;
  const top = box.scrollTop;
  box.scrollTop = top >= 1 ? top - 1 : top + 1;
  box.scrollTop = top;
}

/** Taken at the wheel, since a pin landing before its scroll event would take the move back; a finger is left to that event. */
export function wheelLeavesFoot(deltaY: number, ctrlKey: boolean): boolean {
  return deltaY < 0 && !ctrlKey;
}

/** An element between the target and the box that is scrolled off its own top takes the gesture first. */
function innerTakesIt(target: EventTarget | null, box: HTMLElement): boolean {
  for (let at = target instanceof Element ? target : null; at !== null && at !== box; at = at.parentElement) {
    if (at.scrollTop > 0) return true;
  }
  return false;
}

export interface Follow {
  boxRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  scrolledDown: boolean;
  /** Stable: it rides a context past the memoised rows. A tap resized a row, so the next resize is measured rather than followed (Q3.26). */
  remeasure: () => void;
}

/** `sent` is a counter: every message this tab sends puts the conversation back on its foot, wherever the reader was. */
export function useFollow(key: string, firstSeq: number, sent: number): Follow {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [scrolledDown, setScrolledDown] = useState(false);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const lastClient = useRef(0);
  const seen = useRef({ key, sent, firstSeq });
  const tapped = useRef(false);

  const decide = useCallback((next: boolean): void => {
    if (atBottomRef.current === next) return;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  // Judged first, since a reader's move can land before its scroll event; then back to the foot if held there, and remember where it was left.
  const settle = useCallback(
    (box: HTMLElement): void => {
      decide(followsAfterScroll(atBottomRef.current, box, lastTop.current, lastClient.current));
      if (atBottomRef.current) box.scrollTop = box.scrollHeight;
      if (box.clientHeight !== lastClient.current) resync(box);
      lastTop.current = box.scrollTop;
      lastHeight.current = box.scrollHeight;
      lastClient.current = box.clientHeight;
    },
    [decide],
  );

  // Every commit, before paint: the echo, its row, the working line and the ask card's padding all land here.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const was = seen.current;
    seen.current = { key, sent, firstSeq };
    if (key !== was.key || sent !== was.sent) {
      // Outranks a move not reported yet: a send lands at the foot wherever the reader was.
      lastTop.current = box.scrollTop;
      decide(true);
    } else {
      // Nothing anchors this for us: WebKit has no scroll anchoring and Chrome's is switched off on the box.
      const grewAbove = firstSeq < was.firstSeq;
      if (grewAbove && !atBottomRef.current) box.scrollTop += box.scrollHeight - lastHeight.current;
    }
    settle(box);
  });

  // Content an observer sees and no commit of this component does: a settled markdown run, a re-hugged bubble, the composer, a width.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (box === null || content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (tapped.current) {
        tapped.current = false;
        decide(gapBelow(box) < FOOT_SLACK_PX);
      }
      settle(box);
    });
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [decide, settle]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const onScroll = (): void => {
      settle(box);
      setScrolledDown(box.scrollTop > 0);
    };
    const onWheel = (event: WheelEvent): void => {
      if (wheelLeavesFoot(event.deltaY, event.ctrlKey) && box.scrollTop > 0 && !innerTakesIt(event.target, box)) decide(false);
    };
    // Once more after the window stops changing size, since the layer a transition leaves behind is only caught up afterwards.
    let settling = 0;
    const onResize = (): void => {
      window.clearTimeout(settling);
      settling = window.setTimeout(() => {
        settle(box);
        resync(box);
      }, RESIZE_SETTLE_MS);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    box.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(settling);
    };
  }, [decide, settle]);

  const remeasure = useCallback((): void => {
    tapped.current = true;
    // Cleared two frames on, so a tap that resized nothing cannot turn the next unrelated growth into a measurement.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        tapped.current = false;
      }),
    );
  }, []);

  return { boxRef, contentRef, atBottom, scrolledDown, remeasure };
}
