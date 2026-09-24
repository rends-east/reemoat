import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PaneWidth } from "./paneWidth";

/**
 * A drag writes only the custom property; with `setPointerCapture` there is nothing to leak when this unmounts, but read the unmount effect below.
 * `cursor-col-resize` is the app's one cursor exception (`webcheck` allow-list); `pointerdown` arms, `pointerup` commits, `pointercancel` reverts.
 */
export function PaneHandle({
  pane,
  label,
  sign,
  className,
  style,
}: {
  /** A module singleton: an object literal would resubscribe on every render. */
  pane: PaneWidth;
  label: string;
  sign: 1 | -1;
  className: string;
  style?: React.CSSProperties;
}): ReactNode {
  const [dragging, setDragging] = useState(false);
  const announced = useSyncExternalStore(pane.subscribe, pane.width);
  const latest = useRef(pane.clamp(Number.NaN));

  const apply = (px: number): void => {
    document.documentElement.style.setProperty(pane.prop, `${String(px)}px`);
  };
  const resolve = (): number =>
    pane.clamp(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(pane.prop)));
  /** Cached because this renders on every streamed token; dropped on a committed-width change, a resize and each `pointerdown`. */
  const cached = useRef<number | null>(null);
  const declared = (): number => (cached.current ??= resolve());
  // After the commit, so the next render reads the stylesheet rather than the stale inline value.
  useEffect(() => {
    cached.current = null;
  }, [announced]);
  useEffect(() => {
    const forget = (): void => {
      cached.current = null;
    };
    window.addEventListener("resize", forget);
    return () => void window.removeEventListener("resize", forget);
  }, []);

  /** Carries the pointer id so a second pointer's release cannot end the first one's drag. */
  const from = useRef<{ id: number; x: number; width: number } | null>(null);
  const owns = (event: React.PointerEvent<HTMLDivElement>): boolean => from.current?.id === event.pointerId;
  /** A bare click must commit nothing, or it would store the stylesheet's width as a chosen one. */
  const moved = useRef(false);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if (from.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cached.current = null;
    const start = pane.width() ?? declared();
    from.current = { id: event.pointerId, x: event.clientX, width: start };
    latest.current = start;
    moved.current = false;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const origin = from.current;
    if (origin === null || origin.id !== event.pointerId) return;
    moved.current = true;
    latest.current = pane.clamp(origin.width + sign * (event.clientX - origin.x));
    apply(latest.current);
  };

  const finish = (commit: boolean): void => {
    if (from.current === null) return;
    from.current = null;
    setDragging(false);
    if (commit && moved.current) pane.setWidth(latest.current);
    const settled = pane.width();
    if (settled === null) document.documentElement.style.removeProperty(pane.prop);
    else apply(settled);
  };

  // Unmounting mid-drag is not a `pointercancel`: no terminal event arrives, so revert the property here, as a cancel.
  useEffect(
    () => () => {
      if (from.current === null) return;
      const settled = pane.width();
      if (settled === null) document.documentElement.style.removeProperty(pane.prop);
      else document.documentElement.style.setProperty(pane.prop, `${String(settled)}px`);
    },
    [pane],
  );

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (owns(event)) finish(true);
  };
  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (owns(event)) finish(false);
  };
  // A lost capture (another element, or a `releasePointerCapture`) ends the gesture, or `from` would block every later press.
  const onLostPointerCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (owns(event)) finish(false);
  };

  const step = (by: number): void => {
    pane.setWidth((pane.width() ?? declared()) + by);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const by = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") step(-by * sign);
    else if (event.key === "ArrowRight") step(by * sign);
    else if (event.key === "Home") pane.reset();
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      // Required on a focusable separator; announces the stored width (`--task-w`), not the viewport-clamped one.
      aria-valuenow={announced ?? declared()}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => pane.reset()}
      onKeyDown={onKeyDown}
      className={`group cursor-col-resize touch-none ${className}`}
      style={style}
    >
      <div
        aria-hidden="true"
        className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
          dragging ? "bg-edge-strong" : "bg-transparent group-hover:bg-edge-strong/60"
        }`}
      />
    </div>
  );
}
