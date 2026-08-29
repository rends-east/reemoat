import { Bell, ChevronLeft, X } from "lucide-react";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { navigate, sessionPath, useUnder } from "../router";
import { sessionLists, store } from "../store";
import { Icon, IconButton, SHEET_BODY, SHEET_HEAD, SHEET_PANEL, TAP_GROW_Y } from "./bits";
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
  screen,
  children,
  footer,
  labelledBy,
  up,
  upLabel,
}: {
  /**
   * The head's one line — a `string` rather than a `ReactNode`, because the live
   * region at the foot of the panel speaks it and a node cannot be spoken. The
   * `<h1>` below already had to hold one unconditional text node for
   * `aria-labelledby` to resolve at both widths; this is that rule in the type
   * rather than in a comment under it.
   */
  title: string;
  /**
   * Which screen inside this pop-up is on, as a value an effect can compare.
   *
   * The focus effect and the live region move on **this** changing and on nothing
   * else. Omitted by a pop-up with one screen (`ImportCode`), which then behaves
   * exactly as this component did while every pop-up mounted its own panel:
   * focused once, on the way in.
   *
   * ⚠ **Neither the route nor the title, and both were candidates.** Several
   * screens here keep their own state in the address — `NewSession`'s folder
   * effect replaces `/new/:machineId/:cwd` on every step *into a directory*,
   * `PluginSettings` rewrites the machine list in its own URL from a control on
   * the screen — so an effect keyed on the route takes focus off the picker
   * somebody is walking through, once per tap, which is worse than the defect it
   * fixes. The title fails the other way: `sheetTitle` answers "Settings" for
   * every screen under `/settings` and "Plugins" for every screen under
   * `/plugins`, because a head that spans a section rail names the pop-up and the
   * pane names the screen (Q3.427) — so the two pop-ups with the most screens
   * would fire on none of them. `screenOf` in `App.tsx` is the answer, and names
   * the fields that are the screen rather than the screen's own state.
   */
  screen?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Overrides the generated id when the caller draws its own heading. */
  labelledBy?: string;
  /**
   * Where this screen goes when you leave it *without* leaving the pop-up, or
   * omitted at the pop-up's shallowest screen.
   *
   * ⚠ **This is a narrowing of Q3.432 rather than a reversal of it.** That
   * decision moved the settings chevron out of this row and into the pane, and
   * the argument was about *width*: above `sm` the settings sheet's head spans a
   * 224px section rail as well as the pane beside it, so a ◀ there points at
   * something the rail already lists and the only honest string in the row is the
   * pop-up's own name. Settings therefore still passes nothing here and still
   * draws its own — `webcheck` pins that.
   *
   * The New session sheet has no rail at any width. It is one column, its head
   * names the screen you are on rather than the pop-up, and its screens are a
   * chain — session, agent, the choice being made. There a ◀ in the head is the
   * only place it can be without spending a whole row on one glyph, which on a
   * phone is the difference between the model list starting above the fold and
   * below it. Q3.473.
   */
  up?: () => void;
  /**
   * Where the ◀ goes, for a reader who cannot see the head change.
   *
   * ⚠ **Required whenever `up` is passed, and it names the destination rather
   * than saying "Back".** That is `Header`'s standing rule for this control and
   * the whole difference between it and the history button it must never become:
   * this thing has a fixed destination derived from the URL, and saying so is how
   * a reader can tell. What is *drawn* is the glyph alone — the label was on
   * screen for one release and spent a row of a phone's sheet restating what the
   * chevron already meant.
   */
  upLabel?: string;
}): ReactNode {
  const under = useUnder();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = (): void => navigate(under, true);

  useDismissible("sheet", close, true);

  /*
   * Giving focus back, and nothing else — the effect below is what takes it.
   *
   * ⚠ **Declared first, and that is the whole reason the two are separate.**
   * React runs a component's effects in declaration order, so this records what
   * held focus *before* the panel was handed it; the other way round it would
   * capture the panel and restore the sheet to itself. It also has to keep `[]`
   * while the other one does not: run per screen, its cleanup would fire on every
   * change and restore focus to a control the outgoing screen has just unmounted,
   * which lands on `<body>` — precisely the state this pair exists to end.
   *
   * Restoration is guarded on `isConnected` because the trigger routinely does not
   * survive: the profile row that opens settings is inside `#root`, which this
   * sheet has just made `inert`, and on a phone the row itself may have unmounted
   * with the list behind the sheet.
   */
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.body.focus();
    };
  }, []);

  /*
   * Focus goes to the **panel**, not to the first control inside it.
   *
   * Two reasons and the second is the one that bites. The settings sheet's first
   * control is a navigation row, so focusing it announces "Machines, button"
   * rather than the dialog somebody just opened. And on iOS, focusing an
   * interactive element can raise the soft keyboard — which for a sheet that is
   * already `92dvh` tall means opening it eats the screen.
   *
   * ⚠ **On every screen rather than once per sheet, which is the bill for
   * `OverlaySheet`.** One `<Sheet>` element now serves `/new`, `/agent` and
   * `/agent/:step`, so this ran once for the whole flow: tapping the Model row
   * unmounted the button holding focus, dropped it to `<body>`, and left a
   * keyboard user re-Tabbing from the top of the document on every screen and on
   * every ◀ back out of one.
   *
   * Keyed on `screen` and not on every render, because a screen that re-renders
   * under somebody — a poll answering, a list arriving — must not pull focus off
   * the control they deliberately reached inside it. See the prop.
   */
  useEffect(() => {
    panelRef.current?.focus();
  }, [screen]);

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
      data-sheet-scrim=""
      className={`animate-scrim fixed inset-0 ${LAYER.overlay} flex touch-manipulation flex-col justify-end bg-fg/25 sm:items-center sm:justify-center sm:p-6`}
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
        /*
         * `data-sheet-*` marks the three things a closing sheet animates, and
         * `index.css` hangs a `view-transition-name` off each. Attributes rather
         * than classes because a name has to be **unique in the document** and
         * there is exactly one sheet — a utility class is an invitation to put a
         * second one somewhere and get neither.
         */
        data-sheet-panel=""
        className={`${SHEET_PANEL} outline-none`}
      >
        <div className={SHEET_HEAD}>
          {/*
           * ⚠ **Drawn only where there is somewhere to go, and never reserved.**
           * A slot held open for a control that may not mount is what Q3.432
           * deleted; this pop-up's head changes its *title* between screens
           * anyway, so a left edge that moves with it costs nothing that was
           * being kept still. `-ml-1` is the settings pane's own inset: 24px of
           * ink reaching 44px through `IconButton`'s own growth, sitting flush
           * with the panel's padding rather than 8px inside it.
           */}
          {up !== undefined && (
            <IconButton
              icon={ChevronLeft}
              label={`Back to ${upLabel ?? "the previous screen"}`}
              onClick={up}
              /*
               * `sm`: 24px of ink reaching 44 through `after:-inset-2.5`, which is
               * also the size the settings pane draws its own chevron at, so the
               * two controls are the same object in two places rather than two
               * objects.
               *
               * ⚠ **This used to read "`sm`, never the `md` default", and all
               * three of its claims have expired.** `md` was `h-9 w-9` with no
               * growth mechanism, it was what `size` fell back to, and `webcheck`
               * ratcheted a list of the call sites that had taken it. It is
               * deleted, `size` is required, and the list is gone because it
               * emptied — so there is no default here to be "never", and a size
               * that misses 44px is no longer expressible. What survives is the
               * *choice*, and that is what `webcheck` pins now: `sm` keeps this
               * chevron flush in a head row that a 44px box would have made taller
               * than the title beside it. The ✕ at the end of this same row is
               * `sm` for this same reason and says so; `Header`'s pair went the
               * other way, to `lg`, and its docblock argues why. The two rows may
               * not be quietly converged.
               */
              size="sm"
              className="-ml-1"
            />
          )}
          {/*
           * **What this head holds — and it is no longer only what leaves the
           * pop-up.**
           *
           * The ✕ goes to `useUnder` and the waiting badge to the session that has
           * waited longest, so both of those leave. The ◀ does not, and it is in
           * this same row, immediately above this comment.
           *
           * ⚠ **This block opened "the head holds only controls that leave the
           * pop-up", and that sentence and three others expired together at
           * Q3.473.** It said the one control that moves you *within* the pop-up
           * "is drawn by the pane now"; it is drawn here as well. It said "the prop
           * is deleted rather than half-emptied, so that objection evaporates" —
           * Q3.427's objection being that `Sheet` would be left declaring an `up`
           * it no longer read — while `up` is declared in the props above, read by
           * the chevron and passed by `App.tsx`. And it said the title's left edge
           * is "still constant at every depth", which a ◀ mounting before the
           * `<h1>` is precisely what ends. What Q3.432 actually settled is
           * *settings*, and that half is untouched: a head spanning a 224px section
           * rail passes nothing here and draws its own chevron in the pane, which
           * `webcheck` pins. A railless pop-up is the narrowing, argued at the prop.
           *
           * The reserved 12px slot went with Q3.432 and is still not owed back,
           * which is the one claim here that never depended on where the ◀ lives.
           * That rule was about a control appearing and disappearing *between the
           * title and the edge it is measured against*; `WaitingHere` sits on the
           * far side of a `flex-1` heading, so what it displaces is that heading's
           * truncation and nothing else — which is exactly "a mount only displaces
           * what lies between it and the nearest `flex-1` sibling". The ◀ is on the
           * other side of that heading and is measured against the panel's own
           * padding, so it is drawn only where there is somewhere to go and never
           * reserved; its own comment above argues why a left edge that moves with
           * the title costs nothing on a head whose title changes anyway. Q3.432,
           * Q3.473.
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
           * `title` is typed `string` rather than `ReactNode` to keep that true by
           * construction, and for a second reason the live region below gives.
           */}
          <h1 id={headingId} className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title}
          </h1>
          <WaitingHere />
          {/*
           * ⚠ **`sm`, for the reason the ◀ above already gives, and it was the
           * `md` default until `md` was deleted.** The two controls in this row do
           * the same kind of work and sat at two different sizes — a 12px glyph in
           * a 24px box on the left and a 16px glyph in a 36px box on the right —
           * because one of them named a size and the other took whatever the
           * primitive handed out. `sm` is 24px of ink reaching 44px through
           * `after:-inset-2.5`, so this ✕, which this file's own docblock calls
           * "the accessible way out", clears the tap minimum for the first time.
           *
           * `ml-1` is what keeps that growth off its neighbour. `SHEET_HEAD` is
           * `gap-2` — 8px — and the pseudo-element reaches 10px, so with the badge
           * beside it the ✕'s target would land 2px on the badge's *face*, which
           * is the failure `ICON_BUTTON_SIZE.chip` was invented to describe. 4px
           * more gap puts 12px between the boxes and 2px of clear space between
           * the targets. Unconditional, so the row's geometry does not depend on
           * whether anything is waiting; the `<h1>` is `flex-1` and absorbs it.
           */}
          <IconButton icon={X} label="Close" onClick={close} size="sm" className="-mr-1 ml-1" />
        </div>

        {/* Named for the section slide: what changes when you tap a section is
            this box's contents, and the frame around it must not travel. */}
        <div data-sheet-body="" className={SHEET_BODY}>
          {children}
        </div>
        {footer}
        {/*
         * The screen's name, spoken.
         *
         * **Focus moving is not an announcement.** Where somebody has not left the
         * panel it is already the active element, so the effect above is a no-op
         * and a screen reader is told nothing at all about a head that has just
         * changed from "New session" to "Choose model". A repeat where the move
         * *does* speak is the cheap side of that trade; silence is not.
         *
         * Mounted **unconditionally** with only its text swapping, which is the one
         * arrangement that reliably announces: a `role="status"` inserted into the
         * DOM in the same paint as its content is commonly not spoken at all,
         * VoiceOver on iOS included — and this app is used from a phone. `Toast`
         * and `EventList` both record that measurement about their own regions.
         *
         * ⚠ **It renders `title` live rather than a string captured when the screen
         * changed, and that is what covers the plugin screen.** That pop-up is the
         * one whose name is not a constant: `sheetTitle` answers `null` for it and
         * `OverlaySheet` holds the empty string until the plugin's own fetch
         * reports one, a network round-trip later. Fed from the effect above this
         * region would speak that placeholder and never correct itself; rendered
         * live it stays silent — an empty region announces nothing — and speaks the
         * name at the moment it arrives.
         *
         * Inside the dialog rather than beside it, because `aria-modal="true"` lets
         * a screen reader hide everything outside this element and a hidden live
         * region never fires. Last child, so a reader entering the panel meets it
         * after the contents rather than ahead of them; `sr-only` is `absolute`, so
         * it is out of the flex flow and this panel's definite height is untouched.
         */}
        <p role="status" aria-live="polite" className="sr-only">
          {title}
        </p>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The "N waiting" badge, back in this head and **below `lg` only**.
 *
 * ⚠ **This narrows Q3.434 rather than reversing it, and the width is the whole
 * narrowing.** That decision deleted this badge because settings had stopped
 * *replacing* the rail and become a pop-up over it: at `lg` the rail is on screen
 * behind the scrim with its own blocked counts on the folders, so a count in this
 * row was a second copy of a number three inches to the left. That is still true
 * and this is still `lg:hidden`. What Q3.434 wrote down in its own last paragraph
 * is the cost *below* `lg`, where `SHEET_PANEL` is `92dvh` over a rail that is not
 * mounted at all — "a session that starts waiting while you are in settings is now
 * unannounced until you close it" — and that is the one surface in this app able
 * to hide an approval, which is the failure the whole product is shaped around.
 * Restored exactly there and nowhere else, so both halves of Q3.434 hold at once.
 *
 * **It reads the count itself rather than taking a prop.** Two elements draw a
 * `Sheet` today — `OverlaySheet`'s one panel, which serves every route-backed
 * pop-up, and `ImportCode`'s own, which is drawn *over* that one — and a prop is a
 * convention the third one forgets. "An approval cannot be hidden" is not a rule
 * that survives being re-declared at each call site; a pop-up that covers the list
 * inherits the obligation by *being* a pop-up that covers the list.
 *
 * Subscribing *here* rather than in `Sheet` is the other half. `store.getSnapshot`
 * changes identity on every four-second poll, so a subscription on the panel would
 * re-render every screen inside every pop-up for a number none of them draw.
 *
 * **A count and not a dot.** The rail's bell can afford a bare dot because the
 * numbers are on the folders under it; there are no folders behind this, so the
 * number has to be on the control. The words and the weight are the folder
 * header's own — `N waiting`, `font-semibold text-fg` — because a reader who has
 * learnt that phrase in the rail should not have to learn a second one here, and
 * semibold is already this palette's word for "waiting" (the monochrome brief left
 * no amber to spend).
 *
 * **A real destination, which is what makes it a control rather than a badge.**
 * The same one the rail's bell uses: the session that has waited longest, which
 * `sessionLists` has already sorted to the front, so the two cannot disagree about
 * where "the oldest" is. Q3.94's ancestor of this control went to `/` instead, and
 * that was right where it stood — it was in a rail *beside* the list, so `/` put
 * the reader in front of the rows. From a pop-up that is covering the list on a
 * phone, `/` means "here is the list, now find it again", which is the trip this
 * badge exists to save. It **replaces** rather than pushes: leaving a pop-up for
 * the screen underneath it is moving shallower, which is the ✕'s rule one line up
 * and the app-wide rule for anything inside an overlay.
 *
 * `TAP_GROW_Y` rather than a 44px box, which is the opposite of what Q3.94 chose
 * and for the reason `bits.tsx` states above `TAP_GROW_Y` itself: a control that
 * owns its row grows its box, a control in a row of controls keeps its box and
 * grows a transparent `::after`. Q3.94's badge owned a rail header; this one has a
 * heading on its left and a ✕ on its right. Vertical only, so nothing it grows
 * into is a neighbour — the head is 56px and the ink is 32px, so 4px up and 8px
 * down lands on the border and on nothing that can be pressed.
 */
function WaitingHere(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const waiting = sessionLists(state).blocked;
  const oldest = waiting[0];
  // Nothing waiting draws nothing. The rail's bell is `disabled` at zero instead,
  // and is right to be: it is a fixture of a header that is always the same shape,
  // where a control that vanishes is a control that moves everything beside it.
  // This row is a title that truncates against a ✕, so an inert "0 waiting" would
  // spend a phone's title width saying that there is nothing to say.
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

