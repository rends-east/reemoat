import { Layers, Menu as MenuIcon, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { mayAddMachine } from "../quota";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { sessionGroups, type AppState } from "../store";
import { Icon, Monogram } from "./bits";
import { useMachineDrag, type MachineDrag } from "./machineDrag";
import {
  allTab,
  currentView,
  groupsVersion,
  machineTabs,
  selectMachine,
  subscribeGroups,
  type MachineTab,
} from "./groups";

/**
 * The machines, as a column of folders, at `lg` and above.
 *
 * **The same four calls `SessionBrowser` makes, on the same module state, drawn on
 * the other axis.** `machineTabs`, `allTab`, `currentView` and `selectMachine` are
 * untouched: there is one answer to "which machine am I looking at" and two
 * presentations of it, so picking a machine here and picking one on a phone write
 * the same `localStorage` key and cannot disagree.
 *
 * **Two components rather than one with an axis prop**, and that is the same split
 * `SessionBrowser` already made for the same reason. Its docblock: *"The `variant`
 * prop is gone with the split: its only remaining job was row density, and the
 * mount already knows the width, so a prop that could disagree with the CSS no
 * longer exists."* A strip that is horizontal below `lg` and vertical above it is
 * that argument one level up — and this file needs no breakpoint at all, because it
 * is only ever rendered inside `AppShell`'s `hidden … lg:flex` aside.
 *
 * ## What a horizontal strip carries that this one must not
 *
 * **No `.no-scrollbar`.** Its licence in `index.css` is granted to *"a strip dragged
 * sideways whose contents announce there is more of them by being cut off at the
 * edge"*, and the same docblock says outright: never on a vertical list, where a bar
 * is the only thing saying how much more there is. So this column takes the
 * app-wide thin bar under a fine pointer, which is the ordinary appearance of a
 * vertical scroller. That is also how the latent defect recorded against the phone's
 * strip — `.no-scrollbar` plus a desktop pointer — stops applying to a desktop at
 * all.
 *
 * **No `.edge-fade` and no `ResizeObserver`.** The fade answers "this row is cut at
 * its right edge before you touch it", which a scrollbar already answers for a
 * column. ⚠ It is also *wrong* rather than merely redundant here: the strip's
 * `is-cut` arithmetic is `scrollWidth - clientWidth`, which on a vertical box is
 * zero for ever, so the gradient would never light and nothing would fail. Dropping
 * it also leaves this file with no `clientWidth` read at all, which is the property
 * `AppShell`'s no-breakpoint-in-JavaScript rule is really about.
 *
 * **No `overscroll-contain`.** With one machine this column does not overflow, and
 * Chrome ends the scroll chain at a box carrying containment even when it cannot
 * move — 400px of wheel travel against 0px on the same gesture, measured, which is
 * the rule the plugin market's machine list is asserted against.
 *
 * **There is no `wheel` listener to carry over, and there never was one here.** A
 * mouse has no gesture for a horizontal box, so on a desktop the phone's strip
 * cannot be scrolled at all — `AgentStrip` is the one that had to add a non-passive
 * listener for it. A column has a wheel, so this is a gap the axis closes rather
 * than a feature the axis loses.
 *
 * **What does come across** is the scroll-into-view, keyed on `[selected]` and not
 * on every render — the rail re-renders on the four-second poll and on every stream
 * event, and an effect without that key yanks a column you had scrolled back to the
 * selected entry, repeatedly. It is a scroll position rather than a viewport
 * measurement, which is the distinction `AppShell`'s rule turns on.
 *
 * **Order is `machineTabs`', which is `store.ts`'s**: by name, this computer's
 * own machine first, until a reader drags. No sort here, ever: reachability and
 * activity both flicker on the poll, and a list reordering under a travelling
 * thumb is the one thing this app does not do. **Nor a name**: `tab.name` is
 * `MachineGroup.name`, so this computer's entry reads `local` — its label, its
 * `title` and the monogram's letter — through `machineDisplayName` in the store.
 * Reachability is drawn nowhere — an entry says its name and its waiting count, the
 * two things the pill says today — so this column reverses no part of that trade.
 */
export function MachineColumn({ state, onMenu }: { state: AppState; onMenu: () => void }): ReactNode {
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const groups = sessionGroups(state);
  const view = currentView(groups);
  const tabs = machineTabs(groups, view);
  const all = allTab(groups, view);
  const selected = view.all ? null : view.machine;
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useMachineDrag({ axis: "y", tabs });

  /*
   * ⚠ **One callback ref, stable, composing both readers of this node.** The drag
   * installs its touch listeners here and the effect below reads a scroll
   * position, and an inline arrow would be a new function every render — which is
   * the defect the phone's strip records at length: React detaches and re-attaches
   * it, so anything keyed on the ref runs on every render of a rail that
   * re-renders on the four-second poll and on every stream event.
   */
  const hold = useCallback(
    (node: HTMLDivElement | null): void => {
      scroller.current = node;
      drag.scrollerRef(node);
    },
    [drag.scrollerRef],
  );

  useEffect(() => {
    if (selected === null) return;
    scroller.current
      ?.querySelector(`[data-machine="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    /*
     * No `bg-*`. This sits inside `AppShell`'s `<aside>`, which paints `bg-ink`
     * explicitly, and the division from the list beside it is `border-r` — the
     * rail's own rule read a second time: `ink` against `surface` is 1.06:1, too
     * small a step to divide two panes, so a line is the divider and a tone would
     * be a hint at best. A ground of its own here would be a third plane in a
     * palette that has three in total.
     *
     * `w-[72px]` in device pixels and not `w-18`, because `rail.ts`'s bounds are
     * device pixels: two spellings of one width that agree only at a 16px root is
     * the defect `--rail-w`'s own docblock records at length. `MACHINE_COLUMN_PX`
     * is the same number in `rail.ts`, and `webcheck` asserts this class string
     * against it.
     */
    <nav aria-label="Machines" className="flex w-[72px] shrink-0 flex-col border-r border-edge">
      {/*
       * The menu, above the folders, which is where a desktop chat client puts it.
       * It needs no breakpoint of its own: this whole component is inside an
       * `<aside>` that is `hidden … lg:flex`, so the phone's copy of this control
       * carries the `lg:hidden` and this one carries nothing — the breakpoint is
       * answered twice in CSS and nowhere in JavaScript.
       */}
      {/*
       * ⚠ **The full width of the column, and not an `IconButton`.**
       *
       * It was a 32px chip centred in a 72px strip, which made the one control
       * above the folders the smallest target in the rail and left it floating in
       * the middle of a band whose every other row is full-bleed. A menu button is
       * the column's own header, so it takes the column's width — the same shape
       * the entries below it have, which is what stops it reading as an object
       * dropped on top of them.
       *
       * The primitive cannot do this: `ICON_BUTTON_SIZE.chip` is `h-8 w-8`, and a
       * `w-full` composed onto it is two width utilities of equal specificity
       * resolved by Tailwind's emission order rather than by the class string —
       * the defect `FIELD`'s docblock names. So this is a plain `<button>` with
       * `min-h-11` for the 44px floor, and `webcheck` matches the label rather
       * than the element.
       */}
      <div className="pt-safe shrink-0 px-1 pb-1">
        <button
          type="button"
          aria-label="Menu"
          onClick={onMenu}
          className="tap flex min-h-11 w-full items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
        >
          <Icon as={MenuIcon} size={18} />
        </button>
      </div>
      <div ref={hold} className="min-h-0 flex-1 overflow-y-auto">
        {/*
         * All is first, and unlike the horizontal strip it needs no pinning
         * outside the scroller. There it was half a pill bled to the rail's left
         * edge, because a tab about the whole fleet must never scroll away and a
         * horizontal row scrolls from the left. A column scrolls from the top, so
         * the first entry is the last thing to leave — the promise is kept by the
         * axis rather than by a shape.
         */}
        {/* `All` takes no `index` and no `drag`: it is the fleet rather than a
            machine, and it is not in the list a reorder may touch. */}
        <MachineEntry tab={all} glyph={<Icon as={Layers} size={14} />} />
        {tabs.map((tab, index) => (
          <MachineEntry key={tab.id} tab={tab} index={index} drag={drag} />
        ))}
      </div>
      {/* A keyboard move shifts an entry that may be scrolled out of view, on a
          column with no other live region. The sentence is the hook's, so both
          axes owe the same one. */}
      <p role="status" aria-live="polite" className="sr-only">
        {drag.announcement}
      </p>
      {mayAddMachine(state.me) && (
        /*
         * Outside the scroller and at the bottom: adding a machine is not one more
         * machine to pick between, and with a dozen of them it must not be the
         * thing you scroll to find. The destination is Settings → Machines, the
         * same as the strip's `+`.
         */
        <div className="pb-safe shrink-0 border-t border-edge pt-1">
          <button
            type="button"
            onClick={() => navigate(settingsPath("machines"))}
            className="tap flex min-h-11 w-full flex-col items-center justify-center gap-1 text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={Plus} size={16} />
            <span className="text-2xs">Add</span>
          </button>
        </div>
      )}
    </nav>
  );
}

/**
 * One machine in the column — or the fleet, which is drawn the same way.
 *
 * **Selection is a filled 28px mark, and the tile behind it paints nothing** —
 * `bg-fg text-ink` on the monogram, no band on the entry. The ⚠ at the top of the
 * function body is the argument, including the measurement that retired the band
 * and why `bg-fg` on a mark narrows Q3.209 rather than repealing it; read it before
 * moving the fill.
 *
 * **The name is drawn under the square and truncated, and that is what tells two
 * machines apart.** A monogram alone cannot: two hosts whose names begin with the
 * same letter would be one glyph twice, which is a failure the full-width pills
 * never had. `title` is the fallback for a name the 72px column cuts.
 *
 * ⚠ **That the entry can be *moved* is said by `bind` and not here**, and the
 * split matters: the accessible name stays the machine's name and its blocked
 * count, while `aria-roledescription` and `aria-keyshortcuts` arrive with the drag
 * — so `All`, which takes no `bind`, is a plain button that announces no gesture
 * it does not have. `machineDrag.ts`'s {@link SHORTCUTS} carries the argument and
 * the axis; the live region at the bottom of the column reports the result.
 *
 * The blocked badge is the strip's own class string, unchanged — `bg-fg` on a count
 * is already this app's one exception and this is not the place to open it again.
 * `pointer-events-none` so the badge is not a hole in the middle of the control it
 * sits on, which is the rail bell's rule.
 */
function MachineEntry({
  tab,
  glyph,
  index,
  drag,
}: {
  tab: MachineTab;
  glyph?: ReactNode;
  /** Absent on `All`, which is not a machine and may not be reordered. */
  index?: number;
  drag?: MachineDrag;
}): ReactNode {
  /*
   * ⚠ **The mark carries the selection, and the tile carries nothing** — which is
   * a reversal of what this docblock argued, and the reason is a measurement about
   * the *pair* of columns rather than about this one.
   *
   * It was a `bg-raised` band across the whole tile, on the argument that a folder
   * rail marks the selected folder as a band and that `raised` is what this palette
   * spends on state. Both halves are still true in isolation. What they missed is
   * that the session list beside this column marks its own selected row with the
   * same token, full-bleed and square — `bg-raised`, no radius, abutting across one
   * pixel of `border-edge`. Two identical grey rectangles, and they can never line
   * up: the heads agree at 56px and the rhythms then diverge, a machine tile being
   * `py-2` + a 28px mark + `gap-1` + an 18px label = 66px against a session row's
   * 64px with a subline and 42px without, with a folder header as the list's first
   * child. So the selected machine and the selected chat sat at unrelated offsets
   * wearing the same fill, which is what was reported as the column looking
   * crooked. It is not two numbers that need agreeing — it is one signal drawn
   * twice on two grids, and pinning the offsets would leave the next change to
   * either rhythm to reopen it.
   *
   * Filling the **mark** removes the failure by construction: there is no band, so
   * there is no edge to line up with anything. The selected entry is an inverted
   * 28px chip and the unselected one is the `raised` chip it always was.
   *
   * ⚠ **`bg-fg` on a 28px mark, which narrows Q3.209 rather than repealing it.**
   * The rule is that `bg-fg` is the affirmative action inside a decision and is not
   * spent on navigation, and this app already keeps a shorter list than the
   * sentence: `TabUnderline` is 2px of it, the rail bell is a dot with
   * `ring-2 ring-ink`, and the blocked count is `bg-fg text-ink` at 16px in three
   * places including the badge twelve lines down. The measurement is area — the
   * chip is 28×28 = 784px², smaller than the 32px circle `Composer` already draws
   * and a quarter of the ≈100×32 pill that rule was written about. So it is barred
   * as a pill-sized fill and licensed as a *mark*, which is the shape every
   * existing exception already has.
   *
   * ⚠ **`transition-colors` on the chip, and it is not decoration.** `.tap` is on
   * the `<button>`, `transition` is not inherited, and the chip is a child `<span>`
   * — so the band cross-faded only because the band was on the `.tap` element.
   * Moving the fill onto the chip without this makes the selection *snap*. It must
   * be `transition-colors` and never `transition-transform`: `webcheck` bans the
   * latter in this file by literal, because `.tap`'s `transition` shorthand is
   * unlayered and swallows it — see the `slides` ⚠ below.
   *
   * The label carries the second signal, `font-medium text-fg` against
   * `text-muted`, for the reason the session rows already give — with the palette
   * this delicate one signal is not enough, and it costs nothing.
   *
   * ⚠ **Full-bleed and square, not an inset rounded pill.** The inset was tried
   * and it cost eight pixels of every label in a column where the label is the
   * only thing telling two machines apart — `server-fra` and `server-hel` both
   * elided to `server-…`, which is the one failure a folder rail cannot have.
   * `px-0.5` leaves 68px of the 72 for the name. That argument was made for the
   * band and survives it: it is about the label's room, not about the fill.
   */
  const tile = tab.selected ? "" : "hover:bg-raised/60";
  const chip = tab.selected
    ? "bg-fg text-ink transition-colors"
    : "bg-raised text-muted transition-colors";
  const movable = drag !== undefined && index !== undefined;
  const shift = movable ? drag.shiftFor(index) : 0;
  const lifted = movable && drag.dragging === tab.id;
  /*
   * ⚠ **A lifted entry needs a ground of its own.** These tiles paint nothing at
   * all now — selected or not — so one carried over its neighbours would show them
   * straight through it. `bg-surface` is the one step above `raised` this palette
   * has, and it is still the right answer for a different reason than the one this
   * paragraph used to give: it said `bg-raised` was refused because *that* is what
   * selection means here, and selection is a filled mark now. What is left is the
   * plain one — `raised` is the tile's own hover, so a lifted entry wearing it
   * would read as a tile the pointer happens to be over.
   *
   * The neighbours are transitioned and the carried entry never is: its transform
   * is rewritten every frame, so a transition restarts the interpolation on each
   * write and it crawls after the finger. `.press` stays off it for the same
   * family of reason — `scale(0.97)` held for the length of a drag reads as broken.
   *
   * ⚠ **`slides`, not `transition-transform`.** This entry carries `.tap`, whose
   * `transition` shorthand resets `transition-property` to three colours and is
   * unlayered — so the utility is ignored outright and the neighbours *teleport*.
   * `index.css` carries the measurement; the short version is that the two lists
   * which already reorder both happen to shift an element with no `.tap` on it.
   */
  return (
    <button
      type="button"
      onClick={() => selectMachine(tab.id)}
      aria-pressed={tab.selected}
      title={tab.name}
      style={shift === 0 ? undefined : { transform: `translateY(${String(shift)}px)` }}
      {...(movable ? drag.bind(tab.id, index) : { "data-machine": tab.id })}
      className={`tap group relative flex w-full flex-col items-center gap-1 px-0.5 py-2 ${tile} ${
        drag?.sliding === true && !lifted ? "slides" : ""
      } ${lifted ? "z-10 bg-surface shadow-lg will-change-transform" : ""}`}
    >
      {glyph === undefined ? (
        <Monogram name={tab.name} className={chip} />
      ) : (
        <span
          aria-hidden="true"
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${chip}`}
        >
          {glyph}
        </span>
      )}
      <span
        className={`w-full truncate text-center text-2xs ${
          tab.selected ? "font-medium text-fg" : "text-muted group-hover:text-fg"
        }`}
      >
        {tab.name}
      </span>
      {tab.blockedCount > 0 && (
        /*
         * ⚠ **`ring-2 ring-ink`, which arrived with the filled mark.** The badge
         * and the selected chip are both `bg-fg` and they overlap by two pixels at
         * the mark's top-right corner, so on the one machine that most needs
         * reading — selected, with work blocked on it — the count grew out of the
         * chip as one shape. The ring is the rail bell's own idiom twelve files
         * over, and it is the cheapest thing that separates two fills of the same
         * colour without introducing a third.
         */
        <span className="pointer-events-none absolute top-1 right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-2xs font-semibold text-ink ring-2 ring-ink">
          {tab.blockedCount}
        </span>
      )}
    </button>
  );
}
