import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AGENT_HOST_OS, installCommand } from "../enrollment";
import { controlPlaneOrigin } from "../native";
import { keyOf } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import type { Route } from "../router";
import type { AppState } from "../store";
import { CommandLine } from "./CommandLine";
import { MachineColumn } from "./MachineColumn";
import { SessionBrowser } from "./SessionBrowser";
import { useKeyboard } from "./keyboard";
import { LAYER } from "./overlay";
import { PaneHandle } from "./PaneHandle";
import { rail, railWidth, subscribeRail } from "./rail";
import { subscribeTaskWidth, taskWidth } from "./taskWidth";

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
  onMenu,
  children,
}: {
  state: AppState;
  route: Route;
  /** Opens the menu drawer. Held in `App`, because two triggers share one panel. */
  onMenu: () => void;
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
  /*
   * ⚠ **The background panel's width is written here rather than by the panel**,
   * and the reason is the frame before the panel exists. `TaskPanel` mounts only
   * while it is open, so a property written from inside it would land one commit
   * after the card had already painted at `index.css`'s declared width — the exact
   * mount-jump `--rail-w`'s own declaration exists to prevent, arriving on every
   * open instead of on every reload.
   *
   * `null` is *nobody has chosen*, and it is removed rather than written: the
   * stylesheet declares 20rem and steps to 26rem at `xl`, and an inline declaration
   * on `documentElement` beats both media blocks. So a reader who has never dragged
   * gets the two breakpoints, one who has gets their own number at every size, and
   * a double-click on the separator hands the breakpoints back by removing this
   * again. `taskWidth.ts` carries the argument for the two defaults.
   */
  const taskW = useSyncExternalStore(subscribeTaskWidth, taskWidth);
  useEffect(() => {
    document.documentElement.style.setProperty("--rail-w", `${width}px`);
    if (taskW === null) document.documentElement.style.removeProperty("--task-w");
    else document.documentElement.style.setProperty("--task-w", `${String(taskW)}px`);
  }, [width, taskW]);

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
       * Three things needed that, and the middle one has since been replaced by a
       * fourth. The New session button has to sit at the bottom of the column
       * rather than at the bottom of a scrolling list. The footer stops being a
       * `sticky` strip with a `backdrop-blur`, which was blurring content that no
       * longer passes under it while costing a stacking context. ⚠ And the two
       * children of this element scroll *independently* — the machine folders and
       * the session list are each their own scrollport — which only works while
       * nothing above them scrolls.
       *
       * ⚠ **The reason that is no longer here is the one to know about**, because
       * it is why this rule reads as over-specified: the account row used to live
       * in that footer and open a popover *upward* out of it, and an `absolute`
       * panel inside an `overflow-y-auto` ancestor is a panel with its top half
       * clipped away. That row is the menu drawer now, portaled to
       * `document.body`, and could not be clipped by anything here. The clause is
       * recorded rather than deleted because it is the one that would otherwise be
       * re-discovered by somebody putting a popover back in the footer.
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
      {/*
       * ⚠ **A row, not a column, and `--rail-w` measures both children.**
       *
       * The machines are the leading column — this app's folders — and the session
       * list is beside them. Putting the folders *inside* this element rather than
       * before it is what keeps `RailHandle` anchored on `left: var(--rail-w)`: the
       * handle divides the rail from the conversation, and that join is this
       * element's trailing edge whichever way its own children are arranged. The
       * alternative, a sibling column before this one, forces the handle onto a
       * `calc` of two lengths — and the second of them would be written once in
       * `rail.ts` in device pixels and once in a class string, which is exactly the
       * `19.5rem`/`312` defect `index.css` records at the top of the file.
       *
       * `MachineColumn` is fixed at 72px and `SessionBrowser` takes the rest, so a
       * drag moves the list alone. `rail.ts`'s bounds are stated as
       * `MACHINE_COLUMN_PX` plus the old numbers for that reason: the floor is still
       * "240px of session row", now measured where the rows actually are.
       */}
      <aside className="hidden shrink-0 overflow-hidden border-r border-edge bg-ink lg:flex lg:w-[var(--rail-w)]">
        <MachineColumn state={state} onMenu={onMenu} />
        <SessionBrowser state={state} activeKey={activeKey} onMenu={onMenu} />
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
            <p className="text-xs text-muted">Run this on the {AGENT_HOST_OS} machine you want to use:</p>
            <div className="w-full max-w-lg text-left">
              <CommandLine command={installCommand(controlPlaneOrigin())} />
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
 * The divider you can drag — and what is left here is *where it sits*, nothing
 * about the gesture.
 *
 * ⚠ **`PaneHandle` owns the drag, and this file may not carry a second copy of
 * it.** Four paragraphs describing the capture, the commit, the cancel and the
 * keyboard stayed behind when the mechanism was extracted, over a wrapper that has
 * no state, no handlers and no capture — and one of them was the *pre-correction*
 * version of a measurement: it said a captured drag leaves "nothing to leak when
 * this unmounts mid-drag", which `PaneHandle`'s unmount effect records as measured
 * wrong and repairs. A reader who found this copy first would have believed a
 * mid-drag unmount was safe, and it is not. The corrected measurement is therefore
 * deliberately **not** restated here: read it at the effect that acts on it.
 *
 * **Out of flow entirely, anchored on `--rail-w`.** It straddles the rail's own
 * `border-r` instead of displacing it, so the rail keeps the geometry it had and
 * the border stays the one line dividing the two panes at 1.06:1 — the ratio this
 * file's docblock says a line is doing the work at. A real flex child would have
 * inserted 8px of nothing between the rail and the conversation and pushed that
 * line off the join.
 *
 * It sits *outside* the `<aside>` because that element is `overflow-hidden` — which
 * is what lets the machine folders and the session list inside it scroll
 * independently — and anything hanging past its right edge would be clipped by the
 * same rule.
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
 */
function RailHandle(): ReactNode {
  return (
    /*
     * ⚠ **Out of flow, anchored on `--rail-w`, and *after* `<main>`** — all three
     * are held by a driver reading this file, which is why this wrapper exists at
     * all rather than `<PaneHandle>` being mounted here directly. `Header` is
     * `sticky` at `LAYER.header` and `Composer` is `sticky` in the same pane; a
     * positioned element with `z-auto` loses to one with `z-30`, so the strip has
     * to carry `LAYER.header` **and** be the later sibling. Move it back between
     * the panes, or drop the layer class, and the top and bottom of a full-height
     * divider go dead while the app looks entirely normal.
     */
    <div
      /*
       * ⚠ **`[@media(pointer:fine)]` nested inside `lg:`, and this was false here
       * before the panel's separator existed.** `lg` is 1024px, which an iPad Pro
       * in portrait matches exactly, so this 8px `touch-action: none` strip was
       * grabbable by a finger lying across the first character of every session
       * title — with `bg-transparent group-hover:` as its whole appearance, i.e.
       * none. `PaneHandle`'s docblock has always said these exist only where the
       * pointer is a mouse, and that is the standing argument for an 8px target
       * under this app's 44px floor; it is a mechanism rather than a claim now.
       *
       * Nested rather than a competing `[@media(pointer:coarse)]:hidden`: two
       * `display` utilities in one string are resolved by Tailwind's emission order
       * rather than by the string. Narrowing the one that turns it on has no such
       * contest.
       */
      className={`absolute inset-y-0 hidden w-2 -translate-x-1/2 lg:[@media(pointer:fine)]:block ${LAYER.header}`}
      style={{ left: "var(--rail-w)" }}
    >
      {/* `sign: 1` — the rail is to the left of its handle, so rightwards is wider. */}
      <PaneHandle pane={rail} label="Sidebar width" sign={1} className="absolute inset-0" />
    </div>
  );
}
