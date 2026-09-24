import { Bell, ChevronLeft, X } from "lucide-react";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { navigate, sessionPath, useUnder } from "../router";
import { sessionLists, store } from "../store";
import { Icon, IconButton, SHEET_BODY, SHEET_HEAD, SHEET_PANEL, TAP_GROW_Y } from "./bits";
import { LAYER, useDismissible } from "./overlay";
import { useSheetGesture, useSlideSheet } from "./sheetDrag";

/** Portals to `document.body`, so `position: fixed` escapes the app's `backdrop-blur` ancestors and there is nothing to outrank. */
export function Sheet({
  title,
  screen,
  children,
  footer,
  labelledBy,
  up,
  upLabel,
  onClose,
}: {
  title: string;
  /** Focus and the live region move only when this changes; not the route or the title (Q3.427). */
  screen?: string;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
  /** Omitted at the shallowest screen and by settings, which draws its chevron in the pane (Q3.432, Q3.473). */
  up?: () => void;
  upLabel?: string;
  /** Only for `ImportCode`, which has no route; route-backed pop-ups must keep the default (`useUnder`). */
  onClose?: () => void;
}): ReactNode {
  const under = useUnder();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const grabber = useRef<HTMLSpanElement | null>(null);
  const scrimRef = useRef<HTMLElement | null>(null);

  const close = onClose ?? ((): void => navigate(under, true));

  useDismissible("sheet", close, true);
  // From anywhere on the panel or its scrim, as the pickers; the grabber is sm:hidden, so the centred card never drags.
  // The scrim is the panel's parent and does not fade with a drag, or the panel would fade too (Q3.650).
  const geometry = useSlideSheet(panelRef, "down", close);
  const drag = useSheetGesture<HTMLDivElement>({ axis: "down", enabled: true, geometry, gate: grabber, held: panelRef, scrim: scrimRef });

  // Declared before the focus-taking effect so it records the trigger first; `[]` so it restores only on close.
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.body.focus();
    };
  }, []);

  // The panel, not its first control (iOS would raise the keyboard); per `screen`, never per render.
  useEffect(() => {
    panelRef.current?.focus();
  }, [screen]);

  return createPortal(
    <div
      ref={drag.scrim.ref}
      {...drag.scrim.bind}
      data-sheet-scrim=""
      className={`animate-scrim fixed inset-0 ${LAYER.overlay} flex touch-manipulation flex-col justify-end bg-scrim sm:items-center sm:justify-center sm:p-6`}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={drag.ref}
        {...drag.bind}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? headingId}
        tabIndex={-1}
        data-sheet-panel=""
        className={`${SHEET_PANEL} outline-none`}
      >
        <div className={`${SHEET_HEAD} relative touch-none`}>
          <span ref={grabber} aria-hidden className="absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-edge-strong sm:hidden" />
          {up !== undefined && (
            <IconButton
              icon={ChevronLeft}
              label={`Back to ${upLabel ?? "the previous screen"}`}
              onClick={up}
              size="nav"
              className="-ml-1"
            />
          )}
          {/* `<h1>` because `#root` is inert under a sheet; one unconditional text node so `aria-labelledby` resolves at both widths. */}
          <h1 id={headingId} className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title}
          </h1>
          <WaitingHere />
          <IconButton icon={X} label="Close" onClick={close} size="nav" className="-mr-1 ml-1" />
        </div>

        <div data-sheet-body="" className={SHEET_BODY}>
          {children}
        </div>
        {footer}
        {/* Mounted unconditionally inside the dialog, rendering `title` live, so every screen change is announced. */}
        <p role="status" aria-live="polite" className="sr-only">
          {title}
        </p>
      </div>
    </div>,
    document.body,
  );
}

/** Below `lg` only, where no rail is mounted and an approval could be hidden (Q3.434). */
function WaitingHere(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const waiting = sessionLists(state).blocked;
  const oldest = waiting[0];
  if (oldest === undefined) return null;
  return (
    <button
      type="button"
      onClick={() => navigate(sessionPath(oldest.ref), true)}
      aria-label={`${waiting.length} waiting on you`}
      title={`${waiting.length} waiting on you`}
      className={`tap press relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-fg hover:bg-raised lg:hidden ${TAP_GROW_Y}`}
    >
      <Icon as={Bell} size={14} />
      {waiting.length} waiting
    </button>
  );
}

