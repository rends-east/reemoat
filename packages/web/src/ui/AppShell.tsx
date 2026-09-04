import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { installCommand } from "../enrollment";
import { keyOf } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import type { Route } from "../router";
import type { AppState } from "../store";
import { CommandLine } from "./CommandLine";
import { SessionBrowser } from "./SessionBrowser";
import { useKeyboard } from "./keyboard";
import { LAYER } from "./overlay";
import { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, clampRailWidth, railWidth, setRailWidth, subscribeRail } from "./rail";

/**
 * One layout, two shapes.
 *
 * Below `lg` this is exactly what it was: one screen at a time, list → detail,
 * and a leading close on the detail that always goes to that list — **not** a
 * back button, which is a control this app deleted and `Header` says why. At
 * `lg` and above the list becomes a permanent rail beside the content, which is
 * the shape a desktop actually wants — you are watching several agents, and
 * having to leave the one you are reading to see whether another needs you is
 * the whole problem this app exists to solve.
 *
 * The rail is `hidden lg:flex` and the mobile home screen is a route, so neither
 * is a copy of the other: the same `SessionBrowser` renders in both, and the
 * only thing that differs is density and whether a row can be selected.
 *
 * There is no breakpoint state in JavaScript and no `matchMedia` here on
 * purpose. CSS already knows the width, and a second source of truth for it is
 * how a resized window ends up rendering a rail that is not there.
 */
export function AppShell({
  state,
  route,
  children,
}: {
  state: AppState;
  route: Route;
  children: ReactNode;
}): ReactNode {
  const activeKey = route.name === "session" ? keyOf(route.ref) : null;
  // Mounted once, here, rather than per screen: these move *between* screens, so
  // a listener that unmounted with the session view would stop working exactly
  // when it is wanted.
  useKeyboard(state, route);

  /*
   * The committed width onto `documentElement`, and only the committed one.
   *
   * This effect is not what a drag talks to — `RailHandle` writes the property
   * directly, once per `pointermove`, and never re-renders anything. What this is
   * for is the two moments a drag is not happening: the first paint after a reload,
   * where the stored width has to replace `index.css`'s default, and a keyboard or
   * double-click change, which goes through the store like any other state.
   *
   * `subscribeRail` rather than `useState` for the reason `rail.ts` gives: the
   * value outlives any component, and `webcheck` reads it with no React at all.
   */
  const width = useSyncExternalStore(subscribeRail, railWidth);
  useEffect(() => {
    document.documentElement.style.setProperty("--rail-w", `${width}px`);
  }, [width]);

  return (
    /*
     * `h-dvh` and not `h-full`, which is a real fix rather than a preference.
     *
     * `h-full` is `height: 100%`, and a percentage resolves against the parent —
     * so this column being the height of the window depended on a chain of three
     * ancestors (`html`, `body`, `#root`) all carrying `height: 100%`. When any
     * link in that chain fails to resolve, the whole app collapses to its content
     * height: the transcript stops being `flex-1` of anything, the composer lands
     * directly under the last message, and the rest of the window is empty. That
     * is the exact symptom reported, and it reproduces precisely by breaking one
     * link of the chain in a fixture against this app's own built CSS.
     *
     * `dvh` resolves against the viewport and depends on no ancestor at all, so
     * there is no chain left to break. It is also the *correct* unit here rather
     * than merely a sturdier one: on a mobile browser with a collapsing toolbar,
     * `100%` and the visible viewport are different numbers, which is the problem
     * `dvh` was added to CSS to solve — and this app is used from a phone with
     * `viewport-fit=cover` set.
     *
     * The `html, body, #root { height: 100% }` rule stays: it is what `SignIn`
     * and the loading screen — the two things `App` renders *outside* this shell,
     * both `min-h-full` — size against. It named `KeyGate` until that screen was
     * deleted, and `SignIn` inherited the role rather than the chain being one
     * link shorter; its own docblock says so from the other end.
     */
    <div className="relative flex h-dvh">
      {/*
       * **The rail is always the sessions now.**
       *
       * It used to be route-switched: while settings was open the aside drew
       * `SettingsNav` *instead* of `SessionBrowser`, which is why that component
       * had to carry a "N waiting" badge — a wide screen left on Settings made
       * every blocked row in the fleet invisible otherwise. Settings is a pop-up
       * over this column now, so the rail stays visible behind it and the
       * obligation moved with the covering surface: `Sheet` carries the count.
       *
       * This reverses "settings is a page that takes the app over", and the
       * property that decision was protecting is better served by the reversal.
       */}
      {/*
       * **No `scroll-stable` on either pane, and the reason differs on each.**
       *
       * `index.css` forces a classic scrollbar on a pointer device
       * (`scrollbar-width: thin`), so `scrollbar-gutter: stable` reserves about
       * ten pixels on the inline-end edge whether or not anything is scrolling.
       * Here it landed immediately left of the divider — so every row separator
       * in the list stopped ten pixels short of it, and the rail read as a column
       * that had come unstuck from its own border. It was reported as a gap that
       * had appeared, which is exactly what it looks like.
       *
       * What the gutter buys is that content does not shift when a box crosses
       * the fit threshold, and the case that earned the rule is the transcript,
       * where a *centred* label slides sideways for no visible reason. This list
       * is left-aligned: what moves when a scrollbar arrives is the right-hand
       * edge, which is where the scrollbar now is. The movement explains itself,
       * which the transcript's never did.
       */}
      {/*
       * **`overflow-hidden`, with the scroll moved inside `SessionBrowser`.**
       *
       * Three things needed that. The account row has to sit at the bottom of the
       * column rather than at the bottom of a scrolling list. The profile popover
       * opens *upward* out of that row, and an `absolute` panel inside an
       * `overflow-y-auto` ancestor is a panel with its top half clipped away — the
       * alternative being to portal it and measure the viewport, which this app
       * does not do. And the footer stops being a `sticky` strip with a
       * `backdrop-blur`, which was blurring content that no longer passes under it
       * while costing a stacking context.
       *
       * **`border-r` is back, and it has now been argued in both directions with
       * the same sentence, which is why the number is written down.** It was
       * deleted on the grounds that the rail is `bg-ink`, the pane is
       * `bg-surface`, and a tonal step draws the division — a claim that was
       * simply false while `main` painted nothing at all, and then true for one
       * revision at 1.18:1 when it was given `bg-surface`. The palette went
       * delicate after that: `ink` against `surface` is **1.06:1**, which is a
       * hint and not a division, and two panes meeting with no line between them
       * read as one pane. So the rule is the ratio rather than the tokens — below
       * roughly 1.15:1 a line does the dividing and the tone only supports it.
       *
       * **The width is now the reader's, between bounds, and 19.5rem is only where
       * it starts.** It came down from 21rem when the border went, and the border
       * coming back did not put it up again: 21rem was sized for a denser list than
       * this one now is. That reasoning picked a good *default* and there was never
       * a reason for it to be the only value — a rail holding folder names and
       * session titles is exactly the thing whose right width depends on the paths
       * somebody actually works in. `--rail-w` carries it, `rail.ts` owns the
       * number and the bounds, and `RailHandle` below is how it moves.
       *
       * The class is `lg:w-[…]` and not `w-[…]`: below `lg` this element is
       * `display: none` and has no width to be wrong, and scoping it to the
       * breakpoint keeps the *existence* of the rail a pure-CSS question, which is
       * the property this file's header refuses to give up. Nothing in JavaScript
       * here knows what `lg` is; the width is a number, and CSS decides whether
       * there is anything to apply it to.
       */}
      <aside className="hidden shrink-0 flex-col overflow-hidden border-r border-edge bg-ink lg:flex lg:w-[var(--rail-w)]">
        <SessionBrowser state={state} activeKey={activeKey} />
      </aside>

      {/*
       * `min-w-0` is load-bearing: without it a long path or an unbroken line
       * of JSON in the transcript widens this flex child and pushes the rail
       * off screen instead of scrolling inside itself.
       *
       * `flex flex-col` is load-bearing for a different reason, and it is the
       * second half of the `h-dvh` fix. This element gets its own height by
       * *stretching* inside the row above, and that works — measured in the live
       * app at 798×823. What did not work was the next step down: a screen filling
       * it with `h-full`, a percentage, which resolved to `auto` and left the
       * composer sitting under the last message with 450px of nothing beneath it.
       *
       * So the screens stop asking for a percentage of this and stretch inside it
       * instead, which is the mechanism that was already demonstrably working one
       * level up. Routes that want the viewport say `flex-1`; anything
       * content-height stays content-height, since a flex item defaults to
       * `flex: 0 1 auto`. (`Home` and `Settings` were the two examples this named
       * and neither is one now — `Home.tsx` is deleted, and `Settings` is a
       * `Sheet` portaled to `document.body`, so it is not inside this box at all.)
       */}
      {/*
       * **`bg-surface`, and its absence was one defect wearing three faces.**
       *
       * This element painted nothing, so the whole right-hand column fell through
       * to `body { background: var(--color-ink) }` — the *same value* the rail
       * paints with `bg-ink`. Three separate things were reported and all three
       * were this: the conversation was the same colour as the menu (the comment
       * above claims a tonal step draws the division, and on the strength of that
       * claim `border-r` was deleted, so there was no divider of any kind); the
       * session header's fill and rule stopped short of the pane's right edge,
       * because what showed in the reserved gutter was ink beside the header's
       * surface; and the transcript's tonal order was upside down, with a tool
       * card on `bg-surface` reading as the *brightest* object on a screen where
       * it should be the quietest. `EventList` and `Bubble` are repainted against
       * this, not against the old ground.
       *
       * **`scroll-stable` came off with it, and that is the header fix rather
       * than a tidy-up.** A sticky header is laid out in this box's content
       * width, so a permanently reserved gutter is a header permanently ten
       * pixels short — and the gutter was never used, because nothing scrolls
       * here: every route puts a `min-h-0 flex-1` column inside this one and owns
       * its own scroller (`SessionView`'s transcript keeps its `scroll-stable`,
       * which is the box the rule was written for). `overflow-y-auto` stays as
       * the backstop for a route that one day does overflow — it would scroll
       * rather than escape — and if that ever happens the centred lines in
       * `SessionView` shift by half a scrollbar and the gutter comes back here.
       */}
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface">{children}</main>

      <RailHandle />
    </div>
  );
}

/**
 * What the content pane shows when the route is the list itself.
 *
 * Only ever seen at `lg`, where "the list" is already the rail — so the pane
 * beside it has nothing to show and should say so rather than repeating it.
 *
 * **Except on an empty fleet, where the pane is the right place for the one
 * thing there is to do.** A newly-confirmed account lands here with no machine,
 * and the rail — 280px wide — drew the one-line installer in a box it could not
 * fit, scrollbar and all, beside a pane saying "Pick a session from the list"
 * about a list with nothing in it. So at `lg` the rail keeps the sentence and
 * the pane draws the instruction and the command at a width it can be read at;
 * below `lg` there is no pane and the rail draws all of it (`SessionBrowser`).
 * The command is the only door: a machine is added by running it, and nothing
 * else — the by-name form that minted a code to carry by hand is gone. The same
 * rule as every other site of this question — a door, or the sentence saying why
 * there is not one, never neither — with `mayAddMachine` and
 * `machineQuotaNotice` as the pair.
 */
export function NothingSelected({ state }: { state: AppState }): ReactNode {
  const probing = state.machines.some((m) => m.reach === "probing" || m.reach === "unknown");
  if (state.machines.length === 0 && !probing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted">No machines yet.</p>
        {mayAddMachine(state.me) ? (
          <>
            <p className="text-xs text-muted">Run this on the machine you want to use:</p>
            <div className="w-full max-w-lg text-left">
              <CommandLine command={installCommand(location.origin)} />
            </div>
          </>
        ) : (
          <p className="max-w-xs text-xs text-muted">{machineQuotaNotice(state.me)}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-muted">Pick a session from the list.</p>
      {/* What the list actually promises now. It used to say blocked sessions
          sort to the top "from every machine at once", which described the flat
          needs-you zone that the machine sections replaced — a guarantee this
          arrangement does not give, stated to the user as though it did. Rows
          sort blocked-first *inside* their own machine, and a section says on its
          header how many are waiting under it even when it is closed, which is
          the promise that survived. */}
      <p className="max-w-xs text-xs text-faint">
        A machine with sessions waiting on you says so on its header, open or closed.
      </p>
    </div>
  );
}

/**
 * The divider you can drag, and the three ways to move it.
 *
 * **Out of flow entirely, anchored on `--rail-w`.** It straddles the rail's own
 * `border-r` instead of displacing it, so the rail keeps the geometry it had and
 * the border stays the one line dividing the two panes at 1.06:1 — the ratio this
 * file's docblock says a line is doing the work at. A real flex child would have
 * inserted 8px of nothing between the rail and the conversation and pushed that
 * line off the join.
 *
 * It sits *outside* the `<aside>` because that element is `overflow-hidden` — so
 * the account row's popover can open upward without a scrolling ancestor clipping
 * it — and anything hanging past its right edge would be clipped by the same rule.
 *
 * **After `<main>` in the DOM, and at `LAYER.header`, which together are one fix
 * rather than two choices.** The first draft was a zero-width flex child sitting
 * between the two panes: correct geometry, and the top and bottom of the strip
 * were dead. `Header` is `sticky` at `LAYER.header` and `Composer` is `sticky`
 * inside the same pane, both *later* in the tree than that position, and a
 * positioned element with `z-auto` loses to a positioned element with `z-30` — so
 * the outer half of the grab strip was captured by the header for the top ~48px
 * and by the composer at the bottom, leaving 4px to aim at exactly where a window
 * is tallest and a pointer is least precise. Equal `z-index` and a later sibling
 * wins, which is what puts it above both without reaching `LAYER.menu` and
 * painting over an open dropdown. Out of flow is what makes the DOM move free: the
 * position comes from `left: var(--rail-w)`, not from where it sits in the row.
 *
 * **A drag writes the custom property and nothing else.** No React state moves
 * while the pointer does — not width, not a "dragging" transform — because
 * `AppShell` re-renders on the four-second poll and on every streamed event, and a
 * width owned by `style={{ width }}` would be reset to where the drag *started*
 * every time one landed. `dragging` is React state, but it is set once at
 * `pointerdown` and once at `pointerup`, never in between.
 *
 * **`setPointerCapture`, not listeners on `window`.** A pointer moving faster than
 * the layout follows leaves the 8px strip on the first frame, so the element's own
 * handlers are only enough once the capture redirects every later event for that
 * `pointerId` back to it. The first draft used `window` listeners instead, which
 * covers the fast pointer and *not* the case that strands the drag: release the
 * button outside the browser window and no `pointerup` is delivered to the
 * document at all, so the strip stays armed, the next click anywhere resizes the
 * rail, and nothing looks wrong until it happens. Capture also makes teardown
 * structural — there is nothing to remove, so there is nothing to leak when this
 * unmounts mid-drag.
 *
 * `pointercancel` is a real outcome rather than defensive: on a touch laptop the
 * browser can decide mid-gesture that this was a scroll. It reverts to the
 * committed width rather than keeping wherever the finger was when the gesture was
 * taken away, because a cancelled gesture is not a smaller one.
 *
 * **Keyboard and double-click are not decoration.** A separator that only answers
 * to a pointer is one nobody on a keyboard can move, and `aria-valuenow` would be
 * announcing a number with no way to change it. Home resets, which is also the
 * answer to "I have dragged this somewhere silly" that does not require finding the
 * default by feel.
 */
function RailHandle(): ReactNode {
  const [dragging, setDragging] = useState(false);
  /**
   * Read for `aria-valuenow` alone — the *visible* width is the custom property,
   * which a drag writes without telling React. Subscribed rather than read once
   * because a screen reader has to be told the committed number after a keyboard
   * step, and that is the one path that does re-render.
   */
  const announced = useSyncExternalStore(subscribeRail, railWidth);
  /** The last width the pointer asked for, so `pointerup` commits what is on screen. */
  const latest = useRef(RAIL_DEFAULT);

  const apply = (px: number): void => {
    document.documentElement.style.setProperty("--rail-w", `${px}px`);
  };

  /** Where this drag began, and `null` whenever one is not in flight. */
  const from = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Left button only. A right-click would otherwise arm a drag that no
    // `pointerup` on the same button ever disarms.
    if (event.button !== 0) return;
    // One pointer at a time. A second one landing on the strip mid-drag would
    // rebase `from` onto `railWidth()` — the width as it was *before* the drag
    // started, since nothing commits until `pointerup` — and the rail would jump
    // by however far the first finger had already travelled.
    if (from.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    from.current = { x: event.clientX, width: railWidth() };
    latest.current = railWidth();
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const origin = from.current;
    if (origin === null) return;
    latest.current = clampRailWidth(origin.width + event.clientX - origin.x);
    apply(latest.current);
  };

  const finish = (commit: boolean): void => {
    if (from.current === null) return;
    from.current = null;
    setDragging(false);
    if (commit) setRailWidth(latest.current);
    // Re-stated from the committed value either way: on commit `setRailWidth`
    // clamps and may land where the pointer did not, and on cancel the property is
    // still showing wherever the gesture was abandoned.
    apply(railWidth());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Inline-start/end rather than "smaller/bigger": this app is LTR throughout —
    // `Header`'s leading control, the rail on the left — so the two coincide, and
    // spelling it this way is what a future RTL pass has to change rather than
    // discover.
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") setRailWidth(railWidth() - step);
    else if (event.key === "ArrowRight") setRailWidth(railWidth() + step);
    else if (event.key === "Home") setRailWidth(RAIL_DEFAULT);
    else return;
    // Only after one of the three matched. An unconditional `preventDefault` here
    // would eat Tab off a focused separator, which is the one key that has to keep
    // working on a control whose whole purpose is to be reachable.
    event.preventDefault();
  };

  return (
    <div
      className={`absolute inset-y-0 hidden w-2 -translate-x-1/2 lg:block ${LAYER.header}`}
      style={{ left: "var(--rail-w)" }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Sidebar width"
        aria-valuenow={announced}
        aria-valuemin={RAIL_MIN}
        aria-valuemax={RAIL_MAX}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
        onKeyDown={onKeyDown}
        /*
         * `-left-1` centres the 8px target on the 1px border rather than beside it,
         * so the thing under the cursor is the line somebody is aiming at. 8px is
         * under the 44px this app gives a *tap* target and deliberately so: this
         * control exists only at `lg`, where the pointer is a mouse, and a 44px
         * grab strip there would swallow clicks aimed at the first character of
         * every session title in the list.
         *
         * `touch-none` because a touchscreen laptop is still `lg`: without it the
         * browser claims the gesture as a scroll and `pointercancel` fires instead
         * of a drag.
         */
        className="group absolute inset-0 cursor-col-resize touch-none"
      >
        {/*
         * The line itself, which is the rail's border thickening under the cursor.
         * `bg-edge-strong` is the token every control in this app is identified by
         * and the only one with a ≥3:1 floor — the same reason a field's border is
         * that and never `edge`. Transparent at rest: the `border-r` underneath is
         * already drawing the division, and a permanently visible second line beside
         * it is two dividers where the palette argument asks for one.
         */}
        <div
          aria-hidden="true"
          className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
            dragging ? "bg-edge-strong" : "bg-transparent group-hover:bg-edge-strong/60"
          }`}
        />
      </div>
    </div>
  );
}
