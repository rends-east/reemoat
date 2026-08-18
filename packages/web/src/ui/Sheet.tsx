import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { navigate, useUnder } from "../router";
import { IconButton, SHEET_BODY, SHEET_HEAD, SHEET_PANEL } from "./bits";
import { LAYER, useDismissible } from "./overlay";

/**
 * The large overlay: settings, and starting a session.
 *
 * A bottom sheet on a phone and a centred card above `sm`, in one class string
 * decided by CSS — there is no breakpoint state in JavaScript here any more than
 * anywhere else in this app.
 *
 * **It portals to `document.body`, and that is the whole mechanism rather than a
 * detail.** `position: fixed` only resolves against the viewport while no ancestor
 * carries `filter`, `backdrop-filter`, `transform`, `perspective` or `contain`, and
 * every plausible mount point inside this app is one hop from a `backdrop-blur`
 * (`Header`, `Composer`, the rail's footer). Rendered in place it would also have
 * to *outrank* things inside `Composer`'s stacking context, which is precisely the
 * measured regression `AskCard`'s docblock records. Outside `#root` there is
 * nothing to outrank: it participates in the root stacking context, whose only
 * other member is `#root` itself at `z: auto`.
 *
 * That is also why `AskCard` cannot use this and must keep its bare `absolute`
 * with no z-index: a parked question makes one *session* unanswerable, not the
 * app, so it is deliberately scoped to the conversation region it belongs to.
 */
export function Sheet({
  title,
  children,
  footer,
  labelledBy,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Overrides the generated id when the caller draws its own heading. */
  labelledBy?: string;
}): ReactNode {
  const under = useUnder();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = (): void => navigate(under, true);

  useDismissible("sheet", close, true);

  /*
   * Focus goes to the **panel**, not to the first control inside it.
   *
   * Two reasons and the second is the one that bites. The settings sheet's first
   * control is a navigation row, so focusing it announces "Machines, button"
   * rather than the dialog somebody just opened. And on iOS, focusing an
   * interactive element can raise the soft keyboard — which for a sheet that is
   * already `92dvh` tall means opening it eats the screen.
   *
   * Restoration is guarded on `isConnected` because the trigger routinely does not
   * survive: the profile row that opens settings is inside `#root`, which this
   * sheet has just made `inert`, and on a phone the row itself may have unmounted
   * with the list behind the sheet.
   */
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.body.focus();
    };
  }, []);

  return createPortal(
    /*
     * The scrim is opacity only, and the missing `backdrop-blur` is deliberate.
     *
     * `AskCard` records a measurement that dimming the conversation **smears the
     * text you need in order to answer** — but that is a fact about a question
     * that is *about* the conversation behind it, and settings is not. So a scrim
     * is right here and wrong there, which is why this is a narrow reversal rather
     * than a change of mind.
     *
     * The blur half of that finding stands unchanged: it smears, it creates a
     * stacking context, and it is a full-screen filter pass on every scroll frame
     * on a phone.
     *
     * `touch-manipulation` because `index.css` grants it to `button` only and this
     * is a `<div>` — without it the 300ms double-tap delay is back on the largest
     * tap target on screen. It stays a `<div>`: a viewport-sized `<button>` would
     * be a phantom tab stop, and the ✕ is the accessible way out.
     */
    <div
      className={`fixed inset-0 ${LAYER.overlay} flex touch-manipulation flex-col justify-end bg-fg/25 sm:items-center sm:justify-center sm:p-6`}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? headingId}
        tabIndex={-1}
        className={`${SHEET_PANEL} outline-none`}
      >
        <div className={SHEET_HEAD}>
          {/*
           * **The head holds only controls that leave the pop-up.**
           *
           * The ✕ goes to `useUnder`; the waiting badge goes to `/`. The one
           * control that moves you *within* the pop-up — the ◀ to `settingsUp` —
           * is drawn by the pane now, pressed against the name of the screen it
           * leaves, so a 56px bar no longer carries two different chevrons' worth
           * of meaning at its two ends.
           *
           * The reserved 12px slot went with it. That rule was about a control
           * which mounts and unmounts *in this row*; nothing can mount here any
           * more, so the title's left edge is constant at every depth with no slot
           * at all. Q3.427 declined this move on the grounds that `Sheet` would be
           * left declaring an `up` it no longer read — the prop is deleted rather
           * than half-emptied, so that objection evaporates. Q3.432.
           */}
          {/*
           * **The pop-up's own name, not the screen's.**
           *
           * This row is a child of `SHEET_PANEL`, so it spans the panel — at `sm`
           * and above that is the 224px section rail *and* the pane beside it.
           * The only string true of everything under it is the pop-up's name, so
           * the screen's name is drawn by the pane — with the ◀ beside it — and
           * withdrawn there wherever the rail already draws it as a row.
           * `settingsPaneTitle` decides what it says, `withinNav` where. Q3.427.
           *
           * **`<h1>` rather than `<h2>`.** `syncInert` puts `inert` on `#root` for
           * the whole life of a sheet and `inert` implies `aria-hidden`, so the
           * app's own `<h1>` is out of the accessibility tree and this one is free
           * — which gives the pane's `<h2>` a real rank to sit under, at no visual
           * cost (nothing in `index.css` styles a heading element) and without
           * pushing fourteen section headings down to `<h3>`.
           *
           * It holds one always-rendered text node and nothing conditional, and
           * that is the whole of `aria-labelledby` working at both widths: a name
           * computed from a `display:none` subtree is no name at all. `webcheck`
           * pins exactly one element carrying this id, and that nothing hides it.
           */}
          <h1 id={headingId} className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title}
          </h1>
          <IconButton icon={X} label="Close" onClick={close} className="-mr-1" />
        </div>

        <div className={SHEET_BODY}>{children}</div>
        {footer}
      </div>
    </div>,
    document.body,
  );
}

/*
 * `WaitingHere` was here — the "N waiting" badge this head drew for anything that
 * covered the fleet view.
 *
 * **Removed as noise, which reverses Q3.201.** The rule it served is real and is
 * not being denied: a settings screen that hid every blocked row is the failure
 * this app is shaped around, and that is why the badge existed. What changed
 * underneath it is that settings stopped *replacing* the rail and became a pop-up
 * over it — so on a desktop the rail is on screen behind the scrim, with its own
 * blocked counts on the folders, and the badge was a second copy of a number
 * already visible three inches to the left.
 *
 * ⚠ The cost is real and is on a phone, where 92dvh of sheet does cover the list:
 * a session that starts waiting while you are in settings is now unannounced
 * until you close it. Q3.434.
 */

