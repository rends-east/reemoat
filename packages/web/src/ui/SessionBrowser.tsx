import {
  Bell,
  Check,
  ChevronRight,
  Folder as FolderIcon,
  Layers,
  ListFilter,
  Menu as MenuIcon,
  Pin,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MachineId, SessionKey } from "../ids";
import { AGENT_HOST_OS, installCommand } from "../enrollment";
import { controlPlaneOrigin } from "../native";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { folderLabel } from "../paths";
import { useMachineDrag } from "./machineDrag";
import { useMachineSwipe } from "./machineSwipe";
import { navigate, newPath, sessionPath } from "../router";
import { settingsPath } from "../settings";
import { elapsedSince, sessionGroups, sessionLists, type AppState, type SessionRow, type SetupState } from "../store";
import { machineDisplayName } from "../machineOrder";
import { humanRequests, needsHuman, resumeStalled } from "../wire";
import {
  Button,
  Icon,
  IconButton,
  menuRow,
  Menu,
  Skeleton,
  StatusDot,
  resumeFailureText,
  sessionLabel,
  shortDuration,
} from "./bits";
import {
  ALL_FOLDER,
  PINNED_FOLDER,
  allRows,
  allTab,
  currentFilter,
  currentQuery,
  currentView,
  foldersOf,
  groupsVersion,
  machineTabs,
  matching,
  orphansFor,
  pinnedFor,
  rowSubpath,
  selectMachine,
  setFilter,
  setQuery,
  subscribeGroups,
  toggleFolder,
  isFolderCollapsed,
  waitingFloor,
  type Filter,
  type Folder,
  type FolderId,
  type MachineTab,
} from "./groups";
import { useRowDrag, type RowDrag } from "./rowDrag";
import { CommandLine } from "./CommandLine";
import { RenameField, SessionMenu } from "./SessionMenu";

/**
 * The whole left column: the fleet, and everything you do to it.
 *
 * **Machines are a horizontal tab bar, not stacked sections.** One machine's chats
 * at a time, grouped into folders by the directory they work in. That buys a list
 * that fits on a phone and costs one thing, which is the reason `waitingFloor`
 * exists: a session waiting on you elsewhere in the fleet now has no row at all,
 * and the tab carrying its count can be scrolled off the end of the bar. Every
 * rule about which rows are on screen — the tab, the folders, the needle, the
 * floor — lives in `groups.ts`, because `keyboard.ts` walks the same order and
 * `webcheck` can only reach a module without a DOM.
 *
 * One component at every width. It is mounted twice — inside `AppShell`'s
 * `lg:flex` aside and inside `App`'s `lg:hidden` wrapper — and the breakpoint is
 * answered in those two class strings and nowhere in JavaScript. The `variant`
 * prop is gone with the split: its only remaining job was row density, and the
 * mount already knows the width, so density is `py-3.5 lg:py-2.5` and a prop that
 * could disagree with the CSS no longer exists.
 */
export function SessionBrowser({
  state,
  activeKey = null,
  onMenu,
}: {
  state: AppState;
  activeKey?: SessionKey | null;
  /** Opens the menu drawer. Drawn only below `lg`; see `SidebarHeader`. */
  onMenu: () => void;
}): ReactNode {
  const groups = sessionGroups(state);
  // Dragging a row. It owns the scroller's ref, every row's pointer handlers and
  // how far each neighbour stands aside; this component hands it rows, a zone and
  // an index, and knows nothing else about the gesture. See `rowDrag.ts`.
  const drag = useRowDrag(state);
  // Collapse, the filter, the selected tab and the needle all live outside React,
  // so they survive the phone's list → detail → back, which unmounts this. See
  // `groups.ts`.
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const view = currentView(groups);
  // Destructured so the two calls below read exactly as `webcheck` greps for them
  // in this file's source text. That is not a formality: the assertion exists
  // because this component once reached past the helper into the raw group while
  // `visibleRows` filtered it, so the rail drew rows the caret could not reach.
  // The companion assertion — that the raw field is named nowhere here — is *not*
  // comment-stripped, so even describing it by name would fail the check.
  const { filter } = view;

  const tabs = machineTabs(groups, view);
  const all = allTab(groups, view);
  /*
   * The flick between machines. `[All, …machines]` is the list it steps through,
   * which is the strip's own draw order read once — `All` is a tab you can be on,
   * so it is a tab you can arrive at.
   *
   * It refuses while a row drag owns the touch; it needs no such arrangement with
   * the *tab* drag, whose listeners are on the strip's scroller rather than this
   * one. `machineSwipe.ts` argues both.
   */
  const swipe = useMachineSwipe({ tabs: [all, ...tabs], armed: drag.armed });
  const listRef = useCallback(
    (node: HTMLDivElement | null): void => {
      drag.scrollerRef(node);
      swipe.scrollerRef(node);
    },
    [drag.scrollerRef, swipe.scrollerRef],
  );
  const floor = waitingFloor(groups, view);
  // **Through the helper *and* through the needle**, which is the whole point:
  // these lists are drawn here and stepped through by `keyboard.ts`, and they were
  // the two groups where the two read different arrays. The helper closed the
  // *filter* half; the search box reopened the same hole one axis over, because
  // `visibleRows` pushes `matching(pinnedFor(…), query)` while this drew the
  // unfiltered slice. A row that fails the search was then painted and absent from
  // the caret's walk, so `findIndex` answered `-1` and `j` jumped to the top of the
  // fleet — the identical symptom, from the identical cause.
  //
  // `folders` and `everything` below need no wrapping: both take `view`, which
  // carries the query, and filter internally.
  const pinned = matching(pinnedFor(groups, view), view.query);
  const orphans = matching(orphansFor(groups, filter), view.query);
  const folders = foldersOf(groups, view);
  // The flat cross-fleet list. Empty unless the All tab is selected, so the JSX
  // needs no second branch for which view it is in.
  const everything = allRows(groups, view);
  const probing = state.machines.some((m) => m.reach === "probing" || m.reach === "unknown");
  const needle = currentQuery();
  // How many rows this machine has that the *filter alone* is withholding — asked
  // by the empty state, so it can tell "nothing here" apart from "nothing here
  // under this slice". Computed only when the list came back empty, and off the
  // same `foldersOf` the list is drawn from, so it cannot disagree with it.
  const hiddenHere =
    folders.length > 0 || everything.length > 0
      ? 0
      : view.all
        ? allRows(groups, { ...view, filter: "all" }).length
        : foldersOf(groups, { ...view, filter: "all" }).reduce((sum, one) => sum + one.rows.length, 0);
  /*
   * Whether the machine whose tab is selected is switched off.
   *
   * Read from the group rather than from `state.machines` so it agrees with the
   * rows the list is drawn from, and only meaningful when one machine is
   * selected — under "All" there is no single machine the empty state is about.
   */
  /*
   * Both reasons the control plane switches a machine off, kept apart because
   * the sentences differ — retiring a machine does nothing for one whose owner
   * is banned. The ban is read first for `machineBadgeText`'s reason: it is the
   * fact that has to be fixed first, so naming the limit would send the reader
   * to the wrong remedy.
   */
  const selected = view.all ? undefined : groups.groups.find((candidate) => candidate.id === view.machine);
  const selectedOwnerDisabled = selected?.ownerDisabled === true;
  const selectedOverLimit = !selectedOwnerDisabled && selected?.overLimit === true;

  return (
    /*
     * `min-w-0 flex-1` for the desktop mount, inert on the phone's.
     *
     * At `lg` this is the second child of a flex row — the machine folders are the
     * first — so it has to be allowed both to take the remaining width and to be
     * narrower than its own content, which is `<main>`'s `min-w-0` rule read one
     * element over. Below `lg` the wrapper in `App.tsx` is an ordinary block and
     * neither token does anything.
     */
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <SidebarHeader state={state} machines={state.machines.length} needle={needle} onMenu={onMenu} />

      {/*
       * **First of everything, and that is the same rule as its own existence.**
       *
       * This band holds sessions waiting on a human that the view cannot draw
       * anywhere else, so it is drawn before the view. It also has to come before
       * Pinned specifically, because `visibleRows` walks floor → pinned → folders
       * → orphans and `keyboard.ts` steps that order: a section that is second on
       * screen and first in the walk is how `j` starts jumping to rows a thumb
       * has already scrolled past.
       */}
      {floor.length > 0 && (
        <WaitingElsewhere rows={floor} state={state} activeKey={activeKey} />
      )}

      {/*
       * **Below `lg` only, because above it the machines are a column.**
       *
       * `MachineColumn` draws the same `machineTabs` and the same `allTab` on the
       * vertical axis, inside `AppShell`'s aside; this strip keeps every word of
       * its own comments because it is still a strip you drag sideways at the
       * width it is drawn at. The breakpoint is this class string and the aside's,
       * and nothing in JavaScript — which is `AppShell`'s standing rule.
       */}
      {state.machines.length > 0 && (
        /*
         * `stripRef` on the element that *carries* the breakpoint, not on anything
         * derived from it: the swipe asks once per gesture whether this is laid out
         * at all, which is how it runs on a phone and not on the desktop rail
         * without a second source of truth for the width. `machineSwipe.ts` argues
         * why that is not a breakpoint in JavaScript.
         */
        <div ref={swipe.stripRef} className="lg:hidden">
          <MachineTabs tabs={tabs} all={all} canAdd={mayAddMachine(state.me)} />
        </div>
      )}

      {state.cpError !== null && <ControlPlaneNotice />}

      {state.setup !== null && <SetupNotice setup={state.setup} />}



      {/*
       * **This box declares one scroller and CSS gives it two, so what overflows
       * horizontally has to be fixed rather than hidden.**
       *
       * Tailwind's `overflow-y-auto` emits `overflow-y: auto` and says nothing
       * about the other axis — and CSS Overflow 3 computes a `visible` paired
       * with a non-`visible` to `auto`. So a single pixel of horizontal overflow
       * paints a permanent classic bar across the bottom of the rail (this app is
       * opted out of overlay scrollbars by `scrollbar-width: thin`), immediately
       * above the account row, where it reads as a rendering fault.
       *
       * What overflowed is the row kebab's **tap pad**: `IconButton size="sm"` is
       * 24px of ink grown to a 44px target by `after:-inset-2.5`, which is 10px
       * of absolutely-positioned pseudo-element on each side against a 4px
       * margin — 6px past this box's content edge, and a positioned descendant is
       * part of the scrollable overflow region. `SessionLine` gives it `mr-2.5`
       * now so the pad ends exactly at the edge.
       *
       * `overflow-x-hidden` was the first fix here and it is the wrong one:
       * clipping applies to hit testing as well as painting, so it took 6px off
       * the far side of that 44px target — the strip at the screen edge where a
       * thumb actually lands — and cut the vertical sides off every focus ring in
       * the list, `outline-offset: 2px` reaching 4px past a `w-full` folder
       * header. An outline contributes nothing to scrollable overflow, so it was
       * never part of the problem and was pure collateral.
       */}
      {/*
       * `relative` so a lifted row's `z-10` has a stacking context to sit in, and
       * because every drop slot is measured in this box's own content coordinates
       * — which is what lets auto-scroll move the box under a gesture without any
       * of the arithmetic needing a correction.
       */}
      {/*
       * ⚠ **One stable callback composing the two tenants of this box**, never an
       * inline arrow: React detaches and re-attaches a new function every render,
       * and this rail re-renders on the four-second poll and on every stream event.
       *
       * ⚠ **`[touch-action:pan-y_pinch-zoom]`, and every part of that is chosen.**
       * It tells the engine up front that this box pans vertically and that the
       * horizontal axis belongs to the app, which is the second guard the swipe
       * leans on — one that does not share a cause with its `preventDefault`, which
       * is `agent-strip.md`'s standing pattern. One *arbitrary value* rather than
       * two utilities, because two setting one property are resolved by Tailwind's
       * emission order rather than by the class string. `pinch-zoom` is kept
       * deliberately: `pan-y` alone would take zoom off the whole rail for one
       * gesture's convenience. And it names an axis rather than refusing every
       * gesture: `touch-action: none` here would take vertical scrolling from nine
       * tenths of this list, which is why the class spelling of it is banned from
       * this file outright — the rail is a scroller before it is anything else.
       */}
      <div
        ref={listRef}
        className="relative min-h-0 flex-1 overflow-y-auto [touch-action:pan-y_pinch-zoom]"
      >
        {drag.unpinning && (
          /*
           * **What letting go will do, said in words, at the pointer.**
           *
           * Unpinning is the one outcome of this gesture that carrying the row
           * back does not undo — every other drop is a position, and a position is
           * one more drag away. So it is the one that owes a sentence before it
           * happens rather than a toast after.
           *
           * `text-danger` is this palette's only non-monochrome ink and is
           * otherwise reserved for acts nothing brings back. The deviation is
           * deliberate and narrow: this is not destruction, it is the one state
           * change in a gesture whose every other outcome is reversible by
           * continuing to drag, and it lasts only while the pointer is out there.
           * The ground stays `surface` with `edge-strong`, which is the ordinary
           * rule for a control on a plane of its own.
           */
          <div
            ref={drag.pillRef}
            /* Two elements: the outer one is *where*, written by the gesture as a
               single transform rather than as two React re-renders a frame; the
               inner one is *what*, offset from its own size so the chip clears the
               pointer whatever its text measures. */
            className="pointer-events-none absolute top-0 left-0 z-30"
          >
            {/* ⚠ **Above the contact point, not centred on it.** Centred is where a
                mouse cursor wants it and where a thumb hides it: this is the one
                pre-commit notice in the gesture — the only outcome carrying the row
                back does not undo — and on the surface this rail is read from, the
                finger holding the row covered it completely. Horizontal centring
                stays; the vertical half is what had to move, by the chip's own
                height plus a thumb's clearance. */}
            <div className="-translate-x-1/2 -translate-y-[calc(100%+18px)] rounded-md border border-edge-strong bg-surface px-2 py-1 text-2xs font-medium whitespace-nowrap text-danger shadow-sm">
              Release to unpin
            </div>
          </div>
        )}
        {/*
         * ⚠ **A bare wrapper, carrying no layout of its own.** The swipe writes a
         * transform onto this node once per `touchmove`, and everything that
         * measures inside this box measures in the *scroller's* content
         * coordinates — `rowDrag.measure`'s drop slots above all. A wrapper that
         * established a containing block, or changed the document's height, would
         * move every one of those midpoints. The "release to unpin" pill stays a
         * child of the scroller and **outside** this, or it would travel with the
         * swipe instead of following the pointer.
         */}
        <div ref={swipe.wrapRef}>
            {/* Skeletons only while the answer is genuinely unknown. "No sessions"
              from a machine that has answered is information; from one that is
              still probing it is a guess that flickers. */}
          {folders.length === 0 && everything.length === 0 && pinned.length === 0 && probing && (
            <Skeleton rows={4} />
          )}

          {/* Names a remedy the reader can act on, rather than describing something
              somebody else has not done. */}
          {state.machines.length === 0 && !probing && (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-muted">No machines yet.</p>
              {/*
                * A door, or the sentence saying why there is not one — never
                * neither, which is the property `machineQuotaNotice` and
                * `mayAddMachine` are asserted as a pair to keep.
                *
                * This is the screen a newly-confirmed account lands on when the
                * instance hands out no machines by default, so it is the one place
                * that sentence has to be right.
                *
                * `plain`, for the reason spelled out at the New session button
                * below: `bg-fg` is the affirmative action *inside* a decision, and
                * this is a navigation to Settings. An empty fleet is the one screen
                * where nothing competes with it anyway, so the fill bought no
                * emphasis it did not already have.
                */}
              {mayAddMachine(state.me) ? (
                <>
                  {/*
                    * The command is the whole answer: it installs the daemon, asks
                    * for a credential on the terminal and enrols the machine. There
                    * is no button beside it any more — it led to Settings → Machines,
                    * which used to hand back a code to carry by hand and now draws
                    * this same command, so the door opened onto the thing already on
                    * screen.
                    *
                    * `location.origin` and not a constant: the page is served by
                    * the control plane it talks to, so this is the same address the
                    * server substitutes into the script it hands back. A
                    * self-hosted instance prints its own.
                    */}
                  {/*
                    * Below `lg` only. At `lg` the rail is `RAIL_DEFAULT` (384px) and the pane beside
                    * it is empty, so `NothingSelected` draws the command there at a
                    * width it can be read at; here it is the whole screen and the
                    * command takes the rail's width rather than a `max-w-xs` it
                    * could not fit in.
                    */}
                  <div className="lg:hidden">
                    <p className="mt-3 text-xs text-muted">Run this on the {AGENT_HOST_OS} machine you want to use:</p>
                    <div className="text-left">
                      <CommandLine command={installCommand(controlPlaneOrigin())} />
                    </div>
                  </div>
                </>
              ) : (
                <p className="mx-auto mt-2 max-w-xs text-xs text-muted">{machineQuotaNotice(state.me)}</p>
              )}
            </div>
          )}

          {/*
           * **Pinned is a folder, and it is back below the machine bar.**
           *
           * It was hoisted above the tabs on the argument that a pin is
           * cross-machine, and that is true — but it made the top of the rail a
           * region that does not scroll, so a handful of pins pushed the folders off
           * the screen. Down here it is one more collapsible group among the
           * folders, drawn with a pin where the folder glyph goes: it reads as one
           * without being one, and it collapses through the same persisted set.
           *
           * The machine is named on these rows only under All. On a machine's own
           * tab every row on screen is that machine's, so the label would be the
           * same word on every line.
           */}
          {pinned.length > 0 && (
            <GroupSection
              icon={Pin}
              name="Pinned"
              id={PINNED_FOLDER}
              blockedCount={pinned.filter((row) => needsHuman(row.snapshot)).length}
              space={drag.spaceFor(PINNED_FOLDER)}
              sliding={drag.sliding}
            >
              {pinned.map((row, index) => (
                <SessionLine
                  key={row.key}
                  row={row}
                  state={state}
                  selected={row.key === activeKey}
                  showMachine={view.all}
                  indented
                  drag={drag.bind(row, PINNED_FOLDER)}
                  lifted={drag.dragging === row.key}
                  pressed={drag.pressing === row.key && drag.dragging !== row.key}
                  sliding={drag.sliding}
                  shift={drag.shiftFor(PINNED_FOLDER, index, row.key)}
                />
              ))}
            </GroupSection>
          )}

          {/*
           * The whole fleet, flat, when the All tab is selected.
           *
           * One group rather than folders, because a folder is a directory *on a
           * machine* and the same path on two hosts is two different folders. What
           * replaces the folder as the "where" is the machine on each row.
           */}
          {everything.length > 0 && (
            <GroupSection
              icon={Layers}
              name="All chats"
              id={ALL_FOLDER}
              blockedCount={everything.filter((row) => needsHuman(row.snapshot)).length}
            >
              {everything.map((row) => (
                <SessionLine
                  key={row.key}
                  row={row}
                  state={state}
                  selected={row.key === activeKey}
                  showMachine
                  indented
                />
              ))}
            </GroupSection>
          )}

          {folders.map((folder) => (
            <FolderSection
              key={folder.id}
              folder={folder}
              state={state}
              activeKey={activeKey}
              drag={drag}
            />
          ))}

          {/* Rows whose machine is no longer granted. Shown rather than dropped: a
              session vanishing with no explanation is the worse failure. Drawn on
              every tab, because their machines have no tab at all — which is also
              what lets `waitingFloor` count them as reachable. */}
          {orphans.length > 0 && (
            <Section name="No longer granted" count={orphans.length}>
              {orphans.map((row) => (
                <SessionLine
                  key={row.key}
                  row={row}
                  state={state}
                  selected={row.key === activeKey}
                  showMachine
                  indented
                />
              ))}
            </Section>
          )}

          {/*
           * **"No sessions here yet" is a claim, and with a narrowing default it
           * became a false one.**
           *
           * When the filter was `"all"` an empty list really did mean the machine
           * had never run anything. It is `"active"` now, so this fires whenever
           * the current *slice* is empty — and a machine whose four conversations
           * have all ended drew "No sessions here yet." over them, with the filter
           * glyph in its resting state, so nothing on screen contradicted it. The
           * mirror case is one tap away: choose Ended on a machine that is busy.
           *
           * So the sentence asks the unfiltered question before it makes a claim,
           * and where there *are* rows behind the filter it says so and offers the
           * way to them — which is also the only thing that makes narrowing the
           * default honest rather than merely quieter.
           */}
          {folders.length === 0 && everything.length === 0 && state.machines.length > 0 && !probing && (
            <div className="px-4 py-6 text-center">
              {needle.trim().length > 0 ? (
                /*
                 * **The way out, symmetric with the `Show all` three branches
                 * below.** ⚠ It read *one branch below*, and `selectedOwnerDisabled`
                 * and `selectedOverLimit` both sit between the two — a count in a
                 * comment, which is the kind of claim a new arm expires with no
                 * symptom anywhere.
                 *
                 * The needle is module state in `groups.ts` and deliberately not
                 * persisted, so the only other exit is the native clear on a
                 * `type="search"` field — which Firefox and several Android
                 * browsers do not draw at all. A typo therefore emptied the fleet
                 * and left a screen with nothing on it to press, which is the one
                 * shape this empty state exists to refuse: it already refuses it
                 * for the filter, and the search is the same trap one axis over.
                 *
                 * Clearing does not promise rows. It hands the arms below this one
                 * the question, and whichever of them fires makes its own offer —
                 * the filter's `Show all`, or one of the two sentences about a
                 * machine that is not being reached. Two taps to two different
                 * remedies, each named where it applies, rather than one button
                 * guessing which was meant.
                 */
                <>
                  <p className="text-sm text-muted">Nothing matches.</p>
                  <Button className="mt-3" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                </>
              ) : selectedOwnerDisabled ? (
                /*
                 * The sibling of the arm below, and it has to be its own sentence:
                 * this machine is switched off because its **owner** was banned, so
                 * retiring a machine — the remedy the limit arm names — does
                 * nothing at all here. Ordered first for `machineBadgeText`'s
                 * reason.
                 */
                <p className="text-sm text-muted">
                  This machine&rsquo;s owner has been disabled, so it is not being reached.
                </p>
              ) : selectedOverLimit ? (
                /*
                 * The same class of false claim as the one above, from a different
                 * cause: this machine may have a dozen conversations, and none of
                 * them can be listed because it is not being reached at all. It is
                 * the only place in the rail that says why, machine reachability
                 * having left this column with the machine headers.
                 */
                <p className="text-sm text-muted">
                  This machine is over the machine limit, so it is not being reached.
                </p>
              ) : hiddenHere > 0 ? (
                <>
                  <p className="text-sm text-muted">
                    {hiddenHere === 1 ? "One conversation here" : `${hiddenHere} conversations here`}
                    {filter === "ended" ? ", none of them ended." : ", all of them ended."}
                  </p>
                  <Button className="mt-3" onClick={() => setFilter("all")}>
                    Show all
                  </Button>
                </>
              ) : (
                /*
                 * The genuine first run, and the only arm here where the sentence
                 * is the whole truth: no needle, no filter withholding anything,
                 * the machine reachable and it has never run a session.
                 *
                 * **A line rather than a button, and the button it points at is
                 * the reason.** New session already sits at the foot of this
                 * column, and a second copy of it in the middle of the list would
                 * be the app's one create action drawn twice on the one screen
                 * where it cannot be missed. What that button deliberately is not
                 * is loud — `plain` rather than `primary`, argued at length in
                 * `SidebarFoot`, because it is pressed a few times a day — and on
                 * an empty list that de-emphasis leaves it as quiet as the folder
                 * headers it no longer sits under. So the sentence does the
                 * pointing that the fill declines to do.
                 */
                <>
                  <p className="text-sm text-muted">No sessions here yet.</p>
                  <p className="mx-auto mt-2 max-w-xs text-xs text-muted">
                    New session, at the bottom of this list, starts one.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <SidebarFoot machine={view.machine} />
    </div>
  );
}

/**
 * One row: the menu, the search box, the filter and the bell.
 *
 * **This was two rows and an application title, and the merge is the change.** It
 * drew the product mark, `Reemoat` as an `<h1>`, a *disabled* magnifier and the
 * bell; the box you actually type into was a second band underneath. Every chat
 * client puts one search field at the top with a menu to its left, and that is what
 * this is now.
 *
 * ⚠ **The disabled magnifier is gone, and that reverses a recorded decision.** It
 * was drawn `disabled` on the argument that it is the *fleet-wide* search — across
 * machines, eventually across what was said inside a conversation — and therefore a
 * different question from the box below it, which filters this machine's chats by
 * title. That argument was about two controls on two rows. With both in one row,
 * forty pixels apart, a dead magnifier beside a live field is not a distinction, it
 * is the conflation the original decision was trying to prevent. When fleet-wide
 * search is built it is a **scope** of this one box — searching under the `All`
 * entry — rather than a second control, and the `All` entry is now permanently on
 * screen to the left, which is what makes that spelling available.
 *
 * ⚠ **The `<h1>` stays, `sr-only`.** It is not decoration: below `lg` there is no
 * `Header` on this route at all, so this element is the only heading on the app's
 * primary screen, and `Header.tsx`'s docblock rests on it — *"the rail has
 * `<h1>Reemoat</h1>` and its folders are `<h2>`"*. What left is the *visible*
 * wordmark, and it did not move: the drawer's foot draws the build alone, and
 * `MenuDrawer`'s own docblock argues why — a wordmark at the foot of a menu is a
 * thing to look at rather than a thing to read. So this `<h1>` is the only copy of
 * the name in the chrome, and it is never painted.
 *
 * **The menu button is drawn here only below `lg`.** Above it the machines are a
 * column and the button is at the top of that column, which is where a desktop chat
 * client puts it. Two mounts, one `lg:hidden`, the breakpoint answered in CSS —
 * `AppShell`'s rule.
 *
 * **The field and the filter are withheld together on an empty fleet**, and the
 * menu is not: with no machines there is nothing to search, and the one thing
 * somebody needs is the door to Settings → Machines, which is behind that button.
 */
function SidebarHeader({
  state,
  machines,
  needle,
  onMenu,
}: {
  state: AppState;
  machines: number;
  needle: string;
  onMenu: () => void;
}): ReactNode {
  const waiting = sessionLists(state).blocked;
  return (
    <div className="pt-safe flex shrink-0 items-center gap-1.5 px-3 pb-2">
      <h1 className="sr-only">Reemoat</h1>
      {/*
       * `chip` rather than `sm`, for the same neighbour argument the two controls
       * on the right of this row already make: these sit `gap-1.5` apart, and
       * `sm`'s symmetric `after:-inset-2.5` is 10px a side into a 6px gap, which
       * puts this control's tap target over the field beside it. `chip` grows
       * vertically only, into this row's `pt-safe` above and `pb-2` below, so 44px
       * is reached without reaching anything.
       */}
      <IconButton icon={MenuIcon} label="Menu" size="chip" onClick={onMenu} className="lg:hidden" />
      {machines > 0 && <ChatSearch value={needle} />}
      {/*
       * The bell is the blocked count, not a stub.
       *
       * A notification glyph that does nothing is a claim this app cannot keep —
       * there is no push and no service worker, and the whole product is the
       * question "does anything need me". So it goes to the session that has
       * waited longest, which `sessionLists` already sorts to the front. With
       * nothing waiting it is `disabled`, which is the honest drawing of "nowhere
       * to go" rather than a control that shrugs.
       *
       * ⚠ **It does not say the number.** What is drawn is the glyph plus an 8px
       * dot; the count reaches `aria-label` and `title` and goes no further, and on
       * a phone there is no tooltip — so a sighted reader here gets "something" and
       * never "three". Left as a dot on purpose and as an open question rather than
       * a settled trade: a numeral here would be the fourth copy of a count the
       * screen already draws — on each machine, on `All`, and on every folder
       * header that has one.
       *
       * ⚠ **Its old comment said the nearest of those is "the tab bar immediately
       * below this row", and at `lg` that is false**: the machines are a column to
       * the left now. The claim survives the correction — the counts are still on
       * screen, just in a different direction — which is the only reason the
       * sentence is rewritten rather than the control reconsidered.
       *
       * The dot is a sibling of the button rather than a child of it, because
       * `IconButton` takes no children — so the wrapper is what `absolute` is
       * measured against. `pointer-events-none` is load-bearing: as a sibling it
       * would otherwise be an 8px hole in the middle of the one control this row
       * exists for.
       */}
      {/*
       * ⚠ **`ml-auto`, and it is only load-bearing in one state.** With the field
       * present it is inert — that `flex-1` already pushes this to the end of the
       * row. With an empty fleet the field and the filter are both withheld, and
       * without this the bell slid to the *left* edge and sat alone beside the
       * hamburger, which reads as a second leading control rather than as the
       * trailing one it is. Seen on the empty-fleet screen, which is the first
       * screen a new account gets.
       */}
      <span className="relative ml-auto inline-flex shrink-0">
        <IconButton
          icon={Bell}
          label={waiting.length === 0 ? "Nothing is waiting on you" : `${waiting.length} waiting on you`}
          size="chip"
          disabled={waiting.length === 0}
          onClick={() => {
            const first = waiting[0];
            if (first !== undefined) navigate(sessionPath(first.ref));
          }}
        />
        {waiting.length > 0 && (
          <span className="pointer-events-none absolute top-1 right-1 h-2 w-2 rounded-full bg-fg ring-2 ring-ink" />
        )}
      </span>
    </div>
  );
}

/**
 * The mark under the tab you are on.
 *
 * **A rule rather than a fill, and that is the whole of why it is allowed to be
 * `bg-fg`.** `web-shell.md` reserves that token for the affirmative action inside
 * a decision — Send, and the approval on the ask card — on the grounds that
 * anything else wearing it becomes the loudest object on screen. Two pixels of it
 * under a word is not a fill and cannot be loud; what it replaces is a `raised`
 * pill, and `raised` on `ink` is 1.22:1, which is the tone this palette keeps
 * failing to divide anything with. The reference this is drawn from marks the
 * selected tab with an accent underline, and with the palette monochrome the
 * underline is the half that survives translation.
 *
 * `-bottom-px` so it sits **on** the bar's own hairline rather than above it: a
 * 2px mark with a 1px rule showing beneath it reads as two lines that failed to
 * meet, which is the defect `SidebarFoot` records about the composer's border.
 *
 * ⚠ **`inset-x-4` matches the tab's own `px-4`, and the pair was two numbers
 * agreeing by hand with nothing checking them.** This paragraph claimed the match
 * while the tabs were widened around it, which is exactly when such a pair drifts;
 * `webcheck` now reads **both** out of this file and requires them equal.
 *
 * What the mark spans is therefore the tab's **content box** — the word wherever
 * the word is wider than the tab's floor, and the padded box where it is not.
 * Wrapping the label in a `relative` span to make it the word's width *by
 * construction* was considered and rejected: `-bottom-px` would then resolve
 * against the label's line box rather than the bar's hairline, and a 2px mark
 * floating under the text is the defect the paragraph above is about.
 */
function TabUnderline(): ReactNode {
  return <span aria-hidden="true" className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-fg" />;
}

/**
 * The machines, as folder tabs.
 *
 * Order is `groups.groups`' order and nothing else — by name, this computer's own
 * machine first, until a reader drags; decided in `store.ts` and asserted there.
 * Never by activity or reachability: both flicker on the four-second poll, and a
 * bar that reorders under a travelling thumb is the one thing this list cannot do.
 * The name on a tab is `MachineGroup.name`, so this computer's reads `local`
 * (`machineDisplayName`) — and nothing here spells that rule a second time.
 *
 * The count on a tab is `blockedCount`, and it is necessary but **not sufficient**
 * — the bar scrolls, so a tab can be off screen. `waitingFloor` is what actually
 * closes that hole; this is what makes the floor's rows navigable to.
 */
function MachineTabs({ tabs, all, canAdd }: { tabs: MachineTab[]; all: MachineTab; canAdd: boolean }): ReactNode {
  /*
   * **One machine takes whatever the bar has left.**
   *
   * A content-width pill with nothing after it leaves a run of empty strip, which
   * reads as tabs that have scrolled away and invites a drag that does nothing.
   * Filling says what is true: this is the machine, there is no other. This came
   * back after being removed on the grounds that `All` is always beside it now —
   * which is a reason for the *strip* to read as a strip, and not a reason for the
   * one machine in it to be a small pill in a wide gap.
   *
   * "What is left" and not "the whole bar": `All` and the `+` are its siblings and
   * keep their own widths, so this is `flex-1` inside the space between them.
   */
  const lone = tabs.length === 1;
  const selected = tabs.find((tab) => tab.selected)?.id ?? null;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useMachineDrag({ axis: "x", tabs });
  /*
   * ⚠ **One stable callback ref, composing three readers of this node.** The drag
   * installs its touch listeners, the cut-edge effect measures it, and the
   * scroll-into-view effect finds a tab inside it. An inline arrow here is a new
   * function every render — the exact defect the `[selected]` effect below records
   * having shipped, on a strip that re-renders on the four-second poll.
   */
  const hold = useCallback(
    (node: HTMLDivElement | null): void => {
      scroller.current = node;
      drag.scrollerRef(node);
    },
    [drag.scrollerRef],
  );
  /**
   * The gradient at the cut edge, and it is the second cue rather than the first.
   *
   * ⚠ **The pill's own shape is a cue only when a pill is actually bisected.**
   * That is the argument `.no-scrollbar` is applied on here and it is half true:
   * with four machines the last tab inside the box routinely *ends* a few pixels
   * short of the edge, so the strip draws three whole pills and a gap and reads
   * as a bar holding three machines. Nothing on screen says the fourth is there,
   * and the tab carrying a blocked count is exactly the one that can be off the
   * end — which is the hole `waitingFloor` exists to cover and should not have to.
   *
   * So the class stays and this is added beside it: `.edge-fade` is the primitive
   * `AgentStrip` had built for the identical question one screen over, and its
   * `index.css` docblock is the argument — it says "there is more" on a first
   * paint, before anybody has touched anything, which is the one thing a
   * scroll-position cue cannot. Translucent rather than opaque for that file's
   * reason too: a solid band would delete the pill under it instead of saying
   * there is one, and half a pill saying "more" is the cue this is reinforcing.
   */
  const fade = useRef<HTMLDivElement | null>(null);
  /*
   * **An effect keyed on the selection, and it was an inline callback ref.**
   *
   * A callback ref written inline is a new function on every render, so React
   * detaches and re-attaches it every time — which re-ran `scrollIntoView` on
   * every render of this strip, not on every *change of selection*. This rail
   * re-renders on the four-second poll and on every stream event, so a bar that
   * had been dragged sideways to look at another machine was yanked back to the
   * selected tab within seconds, repeatedly, and could not be held anywhere the
   * selected tab was not already visible. That is the "a list that moves under a
   * travelling thumb" failure this component's comments spend their length
   * avoiding, introduced by the mechanism meant to help.
   *
   * Still a scroll position and not a viewport measurement — `AppShell` forbids
   * the second and this is emphatically the first: with a dozen machines a reload
   * would otherwise leave your own tab off the end of a bar you have to drag to
   * find. It just has to happen when the answer changes, which is what `[selected]`
   * says and what an inline ref could not.
   */
  useEffect(() => {
    if (lone || selected === null) return;
    stripRef.current
      ?.querySelector(`[data-machine="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, lone]);

  /*
   * Whether the strip is cut, answered from the box's own scroll metrics — the
   * same three numbers and the same one-pixel slack `AgentStrip` measures, which
   * is deliberate: two answers to "is this row cut" that could disagree is two
   * gradients that blink at different moments.
   *
   * `scrollWidth`, `clientWidth` and `scrollLeft` are integers rounded from
   * fractional layout, so a strip dragged fully to its end routinely reports a
   * remainder of 1 — without the slack the gradient stays lit at the end of the
   * bar, saying there is more where there is nothing. `rail > 0` is the
   * un-laid-out box the `ResizeObserver` really does report on its first call:
   * with a `clientWidth` of 0 the remainder is the whole row, and the arithmetic
   * would claim "cut" about a box nobody has measured yet.
   *
   * Both boxes are watched because either one moving changes the answer: the
   * scrollport's width is the rail's (which is a *drag*, `rail.ts`), and the
   * row's is however many machines this account has a grant on — which arrives a
   * poll after this effect runs. `ResizeObserver` fires once on `observe`, which
   * is also where the first layout comes from.
   *
   * Keyed on `lone`, not `[]`: the fade is not rendered for a single machine —
   * there is nothing to be cut — so the ref is `null` until a second machine
   * appears, and an effect that ran once at mount would never see it.
   */
  useEffect(() => {
    const box = scroller.current;
    const edge = fade.current;
    if (box === null || edge === null) return;
    const layout = (): void => {
      const rail = box.clientWidth;
      const room = box.scrollWidth - rail;
      edge.classList.toggle("is-cut", rail > 0 && box.scrollLeft < room - 1);
    };
    const sizes = new ResizeObserver(layout);
    sizes.observe(box);
    const row = box.firstElementChild;
    if (row !== null) sizes.observe(row);
    box.addEventListener("scroll", layout, { passive: true });
    return () => {
      sizes.disconnect();
      box.removeEventListener("scroll", layout);
    };
  }, [lone]);

  return (
    <div
      ref={stripRef}
      className="flex shrink-0 items-center border-b border-edge px-1.5"
    >
      {/*
       * **`All` is pinned to the left, outside the scroller.**
       *
       * It is the one tab that is about the whole fleet, so it is also the one
       * that must never scroll away — a machine tab going off the end costs you a
       * drag, and All going off the end costs you the only view that can show a
       * session whose machine you have not thought of.
       *
       * ⚠ **It is drawn exactly like a machine tab, and the shape argument that
       * used to live here is gone with the pills.** This paragraph read *"flat on
       * the left, round on the right, and bled to the rail's own edge"*, and named
       * `-ml-3`/`pl-3` as the mechanism; the strip is underline tabs now and the
       * class string carries none of it. What still marks `All` as fixed is
       * position alone: it is `shrink-0` and sits *outside* the scroller, so it is
       * the only tab that cannot travel. That is a weaker cue than a half-pill was
       * and it is the one being relied on — worth knowing before anything moves
       * `All` inside the scroller to tidy the markup.
       */}
      <button
        type="button"
        onClick={() => selectMachine(all.id)}
        aria-pressed={all.selected}
        className={`tap relative flex min-h-11 shrink-0 items-center gap-1.5 px-4 text-sm whitespace-nowrap ${
          all.selected ? "font-semibold text-fg" : "text-muted hover:text-fg"
        }`}
      >
        {all.name}
        {all.selected && <TabUnderline />}
        {all.blockedCount > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-2xs font-semibold text-ink">
            {all.blockedCount}
          </span>
        )}
      </button>

      {/*
       * The strip scrolls; the `+` beside it does not.
       *
       * They are siblings rather than one row so that adding a machine stays
       * reachable with a dozen tabs — inside the scroller it would be at the far
       * end of a bar you have to drag to find, which is the same objection
       * `waitingFloor` answers one section up.
       */}
      {/*
       * A containing block for the fade and nothing else: no padding, no margin,
       * no height of its own. It has to sit *outside* the scroller — an absolute
       * child of an `overflow-x-auto` box travels with the content it is supposed
       * to be pinned in front of.
       */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={hold}
          /*
           * `no-scrollbar` only in the many-machine case, and the classic bar it
           * hides really is worth hiding: this strip is one 44px row of tabs above
           * a list of chats, and an eight-pixel rule under it reads as a rendering
           * fault rather than as an affordance. (It said "32px of pill" — the
           * measurement predates the underline tabs, and the argument is the one
           * thing about it that survived them.)
           *
           * ⚠ **What that class used to be justified by was a cue that is only
           * sometimes there.** The argument was "this strip's contents already
           * say there is more of them by being cut off at the edge" — true of a
           * bisected pill and false whenever the last visible tab happens to end
           * short of the edge, which with four machines is most positions. The
           * gradient beside this box is what closes that gap; see the ref it
           * hangs off.
           *
           * With one tab there is nothing to scroll, nothing to hide and nothing
           * to fade.
           */
          className={lone ? "" : "no-scrollbar overflow-x-auto overscroll-x-contain"}
        >
          <div className={`flex ${lone ? "w-full" : "w-max"}`}>
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectMachine(tab.id)}
                aria-pressed={tab.selected}
                style={
                  drag.shiftFor(index) === 0
                    ? undefined
                    : { transform: `translateX(${String(drag.shiftFor(index))}px)` }
                }
                /*
                 * `data-machine` comes from `bind` now and is read by three things:
                 * the scroll-into-view effect above, which is how it finds this node
                 * without a ref per tab that would change identity on every render;
                 * the drag's own `closest`; and its measurement.
                 *
                 * ⚠ **A hold reorders and a flick does not.** The swipe that moves
                 * between machines lives on the list below this strip and stands
                 * down while `drag.armed()` is true, and this gesture is abandoned
                 * the moment a finger travels `PRESS_SLOP` — so the same 8px that
                 * tells the swipe it is horizontal has already killed the hold.
                 * One number, imported rather than re-typed, in `machineDrag.ts`.
                 */
                {...drag.bind(tab.id, index)}
                /*
                 * **Selection is weight plus `TabUnderline`, and no fill at all.**
                 *
                 * The half of this that has never changed: it may not be `bg-fg`.
                 * A near-black pill was the loudest object on a page whose whole
                 * palette is three greys within 1.22:1 of each other, and this is a
                 * *selection* — the least eventful state a control can be in.
                 * `bg-fg` in this app means the affirmative action (Send, an
                 * approval), and spending it on "you are looking at this machine"
                 * made the rail read as though something were alarming.
                 *
                 * ⚠ **What went with the pills is the resting fill, and the defect
                 * it was added for is now accepted rather than solved.** This said
                 * an unselected tab is `raised/50` "rather than nothing", because
                 * with only the selected tab filled "a bar of four machines read as
                 * one tab and three labels" and the shape — the only thing saying
                 * the strip is draggable — existed only where you already were.
                 * Every unselected tab is bare text on the rail's own ground again.
                 * The edge fade below is what now says there is more of the strip;
                 * nothing says it is draggable when it is not cut.
                 */
                /*
                 * ⚠ **`min-w-22` is 88px, which is two 44px tap floors** — derived
                 * from the one bound this app already has rather than chosen by
                 * eye, and on the **non-`lone`** arm only, so the one-machine case
                 * below keeps `flex-1` and its own paragraph stays true word for
                 * word. The cost is paid by the change that incurs it: with four
                 * or more machines a floor means fewer tabs fit and the strip is
                 * cut more often, which is what the fade beside it and the swipe
                 * under it are both for.
                 */
                className={`tap relative flex min-h-11 items-center gap-1.5 px-4 text-sm whitespace-nowrap ${
                  lone ? "flex-1 justify-center" : "min-w-22 shrink-0 justify-center"
                } ${tab.selected ? "font-semibold text-fg" : "text-muted hover:text-fg"} ${
                  /* `slides` rather than `transition-transform`: this tab carries
                     `.tap`, which is unlayered and resets `transition-property` to
                     three colours, so the utility never applies and the neighbours
                     jump. `index.css` has the measurement. */
                  drag.sliding && drag.dragging !== tab.id ? "slides" : ""
                } ${drag.dragging === tab.id ? "z-10 bg-ink shadow-lg will-change-transform" : ""}`}
              >
                {tab.name}
                {tab.selected && <TabUnderline />}
                {tab.blockedCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-2xs font-semibold text-ink">
                    {tab.blockedCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        {/*
         * ⚠ **Not rendered at all with one machine**, rather than rendered and
         * left un-`is-cut`. A lone tab is `flex-1` and fills the strip by
         * construction, so there is nothing that could ever be cut — and a fade
         * mounted over it would be one more node the effect has to reason about
         * on a screen where the answer is already known.
         *
         * `pointer-events-none` because it lies over the last tab: a gradient
         * that swallowed the tap would make the machine you can half-see the one
         * machine you cannot select. `w-8` was "one pill-height of gradient" and is
         * 8px against a 44px tab. ⚠ **It said this "is no longer a fraction of
         * anything and would have to be re-measured rather than re-derived", and
         * widening the tabs re-derived it instead**: at `px-4` it is exactly twice
         * a tab's own inset, which is a relation `webcheck` asserts rather than the
         * literal. Still short enough that what it dims is the cut edge rather than
         * a whole label.
         */}
        {!lone && (
          <div
            ref={fade}
            aria-hidden="true"
            className="edge-fade pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink/70 to-transparent"
          />
        )}
      </div>

      {/* The keyboard half of the reorder, said out loud. Both axes owe the same
          sentence and the hook owns it, so they cannot drift. */}
      <p role="status" aria-live="polite" className="sr-only">
        {drag.announcement}
      </p>

      {/*
       * Add a machine, drawn as one more tab.
       *
       * The same pill, the same height, a `+` where a name would be — so it reads
       * as "and one more" rather than as a control that has wandered into the tab
       * bar. It is the only thing in the rail that leaves the rail, and it goes to
       * the settings sheet over it, which is where machines are added.
       *
       * `shrink-0` and outside the scroller, so it is in the same place whether
       * there is one machine or twelve.
       *
       * **Gone entirely when this account may not add one**, and nothing takes
       * its place: a 32px pill has no room for a sentence, and the screen it
       * leads to carries the notice one tap away. This is the one withheld
       * affordance in the app that draws no explanation beside it, and it is
       * deliberate — the `notice === null` iff `mayAddMachine` property is about
       * the pair of functions, and the obligation to print it falls wherever
       * there is room.
       */}
      {canAdd && (
      <button
        type="button"
        onClick={() => navigate(settingsPath("machines"))}
        aria-label="Add a machine"
        title="Add a machine"
        /*
         * **Wider than a square, so it is a tab and not an icon button.**
         *
         * `px-4` is the machine tabs' own inset, so this sits in their rhythm and
         * reads as one more thing in the row rather than as a control bolted to the
         * end of it.
         *
         * ⚠ **The argument that put it here has expired and the shape is kept on
         * its own merits.** It was that at `w-8` this sat directly above the filter
         * glyph, two icon squares stacked on one axis reading as a *toolbar column*
         * that grouped "add a machine" with "filter these chats". The filter moved
         * into `SidebarHeader` in the same change that made these tabs — it is
         * above this strip now, not below it — so there is no stack left to break.
         */
        className="tap flex min-h-11 shrink-0 items-center justify-center px-4 text-muted hover:text-fg"
      >
        <Icon as={Plus} size={14} />
      </button>
      )}
    </div>
  );
}

/**
 * Everything waiting on a human that this view cannot draw anywhere else.
 *
 * The count is not reserved a slot: an always-present "0 waiting" is a number
 * people stop reading, which is the same argument `SettingsNav`'s badge already
 * made about itself.
 */
function WaitingElsewhere({
  rows,
  state,
  activeKey,
}: {
  rows: SessionRow[];
  state: AppState;
  activeKey: SessionKey | null;
}): ReactNode {
  return (
    <div className="shrink-0 border-y border-edge bg-raised">
      {/* Not `SETTINGS_HEADING`: this is the same type at `text-fg` rather than
          `text-muted`, and the tone is the point — a floor of sessions waiting on
          another machine is the one band in this list that should read louder than
          the rows under it. See `.claude/rules/web-typography.md`. */}
      <p className="px-3 pt-2 pb-1 text-2xs font-semibold tracking-wider text-fg uppercase">
        Waiting elsewhere · {rows.length}
      </p>
      {rows.map((row) => (
        <SessionLine
          key={row.key}
          row={row}
          state={state}
          selected={row.key === activeKey}
          showMachine
        />
      ))}
    </div>
  );
}

/** What the filter icon offers. Three words; nothing here needs a description. */
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

/** The chat search, and the filter beside it. */
function ChatSearch({ value }: { value: string }): ReactNode {
  const filter = currentFilter();
  return (
    /*
     * A fragment, because the row around this is `SidebarHeader`'s now.
     *
     * The box and the filter beside it used to be their own band under the
     * header. They are the header: one row of `[menu] [search] [filter] [bell]`,
     * which is the arrangement every chat client uses and which this app had
     * spread over two rows with an application title in the first. Nothing about
     * the field changed in the move — including the four autofill defences, which
     * are here because a password manager filled this box with the account's
     * email address.
     */
    <>
      <span className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
          <Icon as={Search} size={13} />
        </span>
        {/*
         * **The field is the colour of what it sits on, and the border is the
         * whole of what says it is a field.**
         *
         * It was `bg-surface` on a rail painted `bg-ink`, i.e. a white box on the
         * menu — which read as an object dropped onto the list rather than as part
         * of it. `bg-ink` is the rule the buttons in this app already follow
         * (`BUTTON_TONE.plain` is `bg-surface` on surfaces), and it is the reason
         * `edge-strong` is not optional here: with no fill of its own this control
         * has exactly one identification left, and `edge` at 1.23:1 on ink is the
         * hairline `index.css` forbids for that job.
         */}
        {/*
         * ⚠ **The browser filled this box with an e-mail address.** Reported as
         * a screenshot: the field blue with the autofill tint, holding the
         * account's address, over "Nothing matches." — a `type="search"` input
         * with no `autocomplete` is fair game for a password manager's username
         * heuristics, and this one sits on the same screen as the account row.
         * The needle is deliberately not persisted (see `groups.ts`), so a value
         * nobody typed can only have come from the browser. `autoComplete="off"`
         * plus the two vendor opt-outs; `name` is set so the heuristics have a
         * word to read that is not "search".
         */}
        <input
          type="search"
          name="session-filter"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          value={value}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search sessions"
          placeholder="Search"
          className="w-full rounded-md border border-edge-strong bg-ink py-2 pr-2.5 pl-8 text-sm outline-none"
        />
      </span>
      {/*
       * **Wired, and it had to be before the list could hide anything.**
       *
       * This was drawn inert, and the whole reason `groups.ts` defaulted to `"all"`
       * was that an inert control here is the app's *only* route to an ended
       * session: hiding them behind a placeholder puts every finished conversation
       * permanently out of reach. The list is `"active"` now, so this is the way
       * back, and the two changes belong in one commit for that reason.
       *
       * The glyph goes solid when the filter is **not where it started**, and
       * that is the honest reading of one square of chrome rather than the
       * tempting one. "Solid means rows are hidden" would have to be solid at
       * rest, because the default itself withholds ended conversations — a
       * permanently lit indicator, which is a signal people stop reading — and it
       * would be *off* on All, which is the one slice that withholds nothing.
       * What actually carries "there is more here than you can see" is the empty
       * state below, which counts the rows behind the filter and offers them.
       */}
      {/*
       * `Menu` and not `Dropdown`, which is the other picker in `bits.tsx` and is
       * the wrong one here: it draws its own bordered pill with a chevron, so the
       * bare glyph this row is designed around would have become a labelled
       * control sitting beside the search box competing with it. `Menu` draws
       * nothing and hands the trigger back, which is exactly what an icon needs.
       *
       * `MachineInstalls` draws the identical control — the same glyph, the same
       * `Menu`, the same three-value filter — and this follows it rather than
       * inventing a second shape for one square of chrome.
       */}
      <Menu
        align="right"
        panelClassName="w-40"
        className="shrink-0"
        trigger={(open, toggle) => (
          <IconButton
            icon={ListFilter}
            label={`Showing ${FILTERS.find((item) => item.value === filter)?.label ?? "All"}`}
            title={`Showing: ${FILTERS.find((item) => item.value === filter)?.label ?? "All"}`}
            /*
             * ⚠ **`chip`, where this was a hand-rolled `h-9 w-9`** — 36px with no
             * growth mechanism, which is precisely the size `ICON_BUTTON_SIZE`
             * deleted. `sm` is wrong beside a search box at `gap-1.5`: its
             * symmetric `after:-inset-2.5` would put this control's tap target
             * over the field's face, and a thumb aimed at the filter would open
             * the keyboard. `chip` grows vertically only and so reaches 44px
             * without reflowing the row, which stays the field's own height.
             *
             * At rest it is `ghost`'s `text-muted` where the copy it replaces
             * wrote `text-faint` — one step less recessive, which is the price
             * of the tone table being the tone table, and it buys the focus ring
             * a hand-rolled square in this app has never had.
             */
            size="chip"
            /* `expanded`, not `active`: `aria-pressed` is a toggle that stays
               pressed, and this is a control that reveals a region.

               `haspopup` says what kind of thing opens, where `expanded` says
               that it is open — the pair the hand-rolled button carried before
               this control moved onto the primitive. It was briefly lost in that
               move and written down here as a ⚠ rather than absorbed; the note
               named the remedy as a prop on the primitive rather than a fifth
               hand-rolled button, and that is what this now is. */
            expanded={open}
            haspopup="menu"
            onClick={toggle}
            /*
             * Solid when the filter is not where it started — the paragraph above
             * argues which of the two readings that is.
             *
             * ⚠ **The fill is the whole of the lit state, and an appended
             * `text-fg` would be a dead class.** Tailwind v4 emits utilities
             * alphabetically, so `.text-fg` is printed *before* the tone's own
             * `.text-muted` and loses to it however the class attribute reads —
             * the `menuRow` defect one file over, measured again here. `bg-raised`
             * has no competitor in `ICON_BUTTON_TONE.ghost`, so it applies, and
             * `raised` is what this app spends on state anyway.
             */
            className={filter === "active" && !open ? "" : "bg-raised"}
          />
        )}
      >
        {(close) => (
          <>
            {FILTERS.map((item) => (
              <button
                key={item.value}
                role="menuitem"
                onClick={() => {
                  setFilter(item.value);
                  close();
                }}
                className={`${menuRow("center")} hover:bg-raised ${
                  item.value === filter ? "font-medium text-fg" : "text-muted"
                }`}
              >
                {/* A reserved slot, so choosing does not shift the three labels
                    sideways.

                    ⚠ **This cited "the same rule the sheet header's chevron
                    follows", and that control decided the opposite** — `Sheet`
                    states *drawn only where there is somewhere to go, and never
                    reserved* as its decision, because a ◀ against the panel's own
                    padding has nothing between it and the edge it is measured
                    against, and the head's title changes between screens anyway.
                    The rule both of them answer to is `web-shell.md`'s: delete the
                    mark when it is redundant, reserve its slot when it is the only
                    copy, move it off the row when it is neither. A check beside a
                    label is the only copy this menu has, and it has a label on its
                    right to push. */}
                <span className="inline-flex w-3 shrink-0 justify-center">
                  {item.value === filter && <Icon as={Check} size={12} />}
                </span>
                {item.label}
              </button>
            ))}
          </>
        )}
      </Menu>
    </>
  );
}

/**
 * A collapsible group that is not a directory: Pinned, and All.
 *
 * The same header as a folder, the same caret, the same persisted collapse set —
 * because to a reader they are the same thing, and two components would be two
 * places for the header to drift. What it does not have is a machine or a path,
 * so there is no `+`: "new session in Pinned" is not a sentence.
 *
 * `blockedCount` is passed in rather than derived here for the reason a folder's
 * is: a *collapsed* group still has to say how many rows under it are waiting on
 * you, and that is the mechanism this app uses instead of hoisting them.
 */
function GroupSection({
  icon,
  name,
  id,
  blockedCount,
  children,
  space = 0,
  sliding = false,
}: {
  icon: typeof Pin;
  name: string;
  id: FolderId;
  blockedCount: number;
  children: ReactNode;
  /**
   * How much taller or shorter this group is while a row is in the air over it.
   *
   * ⚠ **A `translateY` on the rows does not make room for one.** A row carried in
   * from a folder makes this group one row taller and its folder one row shorter,
   * and shifting the rows below the insertion point moves them *over* whatever
   * follows the group — reported as Pinned riding on top of the sessions under it.
   * The group being joined takes the height and the group being left gives it
   * back, so everything past both of them stays where it is.
   */
  space?: number;
  /** Some row is being dragged, so the room this group makes is worth animating. */
  sliding?: boolean;
}): ReactNode {
  // A query overrides collapse, the same rule `foldersOf` applies and for the
  // same reason: you search, get a match, and it is inside something you shut.
  const collapsed = currentQuery().trim().length === 0 && isFolderCollapsed(id);
  return (
    /*
     * ⚠ **The room a group makes animates on the same clock the rows do.** The
     * rows move under `transition-transform`; the height they are moving into
     * appeared in one jump, so a row crossing into Pinned slid smoothly while
     * everything below it snapped — reported as the motion being jerky in exactly
     * that direction. Bare `transition-[margin-bottom]` takes the same default
     * duration and easing the rows take, which is the point: two numbers that had
     * to agree are now one.
     *
     * Off at rest for the transform's own reason — a transition left on would
     * animate the margin back to zero over a layout that has already reflowed.
     */
    <section
      className={sliding ? "transition-[margin-bottom]" : ""}
      style={space === 0 ? undefined : { marginBottom: `${space}px` }}
    >
      <h2>
        <button
          type="button"
          onClick={() => toggleFolder(id)}
          aria-expanded={!collapsed}
          className="tap flex min-h-9 w-full items-center gap-1.5 py-1.5 pr-2 pl-3 text-left hover:bg-raised"
        >
          <Icon as={icon} size={12} className="shrink-0 text-faint" />
          <span className="min-w-0 truncate text-xs text-faint">{name}</span>
          <span className={`shrink-0 text-muted transition-transform ${collapsed ? "" : "rotate-90"}`}>
            <Icon as={ChevronRight} size={13} />
          </span>
          {blockedCount > 0 && (
            <span className="ml-auto shrink-0 pl-1.5 text-2xs font-semibold text-fg">
              {blockedCount} waiting
            </span>
          )}
        </button>
      </h2>
      {!collapsed && children}
    </section>
  );
}

/**
 * A titled run of rows that does not collapse.
 *
 * One caller left — "No longer granted" — and it is the one group that should
 * *not* be collapsible: those rows are there to explain a disappearance, and a
 * shut folder is how the explanation goes missing. Pinned and All went to
 * {@link GroupSection} when they became foldable; a `divided` variant went with
 * them, which existed only while Pinned sat outside the scroller.
 */
function Section({ name, count, children }: { name: string; count: number; children: ReactNode }): ReactNode {
  return (
    <section>
      {/* Same quiet label a folder header uses, because this is their peer in the
          list. The one heading that stays loud is `WaitingElsewhere`, and it stays
          loud on purpose. */}
      <h2 className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs text-faint">
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/**
 * One working directory, and the sessions in it.
 *
 * The header carries `blockedCount` even when the folder is closed, which is the
 * mechanism this app already used for a collapsed machine section and the reason a
 * collapsed folder is not a way to hide an approval.
 */
function FolderSection({
  folder,
  state,
  activeKey,
  drag,
}: {
  folder: Folder;
  state: AppState;
  activeKey: SessionKey | null;
  /**
   * The drag, passed down rather than started here.
   *
   * One gesture spans several of these — a row leaves its folder for Pinned and
   * comes back — so the state has to live above every folder. A hook per section
   * would give the row and its destination two different drags.
   */
  drag: RowDrag;
}): ReactNode {
  return (
    // Reserves or gives back a row's height while one is in the air between this
    // folder and Pinned. See `GroupSection`'s own `space`.
    <section
      // Same clock as the rows, and off at rest. See `GroupSection`'s own `space`.
      className={drag.sliding ? "transition-[margin-bottom]" : ""}
      style={{ marginBottom: `${drag.spaceFor(folder.id)}px` }}
    >
      <h2>
        {/*
         * **A row of two controls, not one button with things inside it.**
         *
         * The whole header used to be the toggle, and the `+` cannot live inside
         * it — a button inside a button is invalid HTML and browsers resolve it by
         * breaking the outer one, which is the same reason `SessionLine` is a
         * `div` holding a navigating button and a sibling menu.
         */}
        <div className="group/folder flex min-h-9 items-center pr-2 hover:bg-raised">
          <button
            type="button"
            onClick={() => toggleFolder(folder.id)}
            aria-expanded={!folder.collapsed}
            title={folder.path.length > 0 ? folder.path : undefined}
            className="tap flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-3 text-left"
          >
          {/*
           * **A folder header is a label, and it was competing with the rows under
           * it.**
           *
           * It was `text-2xs font-semibold tracking-wider uppercase` — which is
           * loud typography however faint the colour, because letter-spaced caps
           * read as a *heading* and the chats below are the thing somebody came to
           * find. So this loses the caps, the tracking and the weight, and keeps
           * only `text-faint`: a quiet line of normal text with the chat titles
           * (`text-sm text-fg`) plainly above it in the hierarchy. The row also
           * comes down from 44px to 36px, because it is not a tap target in the
           * way a chat is — it toggles, and the whole width of it does that.
           */}
          <Icon as={FolderIcon} size={12} className="shrink-0 text-faint" />
          {/*
           * **Not `flex-1`, which is what pushed the caret to the far edge.**
           *
           * A `flex-1` name swallows the whole row, so the caret after it landed
           * against the right border — beside the `+`, reading as a second
           * trailing control rather than as the disclosure for the word it opens.
           * Without it the name is content-width and the caret sits against it,
           * while `min-w-0` is what still lets `truncate` bite on a long folder
           * name. The slack ends up after the pair, inside the button, so the whole
           * row still toggles.
           */}
          <span className="min-w-0 truncate text-xs text-faint">{folder.name}</span>
            {/*
             * **The caret sits against the name, and the count is gone.**
             *
             * The count was a number nobody acts on: the rows are directly below
             * it and countable, and it changed on the four-second poll, so the one
             * numeral on the line was also the only thing on it that moved.
             * `blockedCount` is **not** the same and survives below — a hidden
             * approval is the failure this screen exists to prevent, and a
             * collapsed folder saying "2 waiting" is how that is prevented.
             *
             * The caret is immediately right of the name rather than at the far
             * edge, so it reads as belonging to the word it opens; the far edge
             * belongs to the `+`, which is a different act.
             */}
            <span
              className={`shrink-0 text-muted transition-transform ${folder.collapsed ? "" : "rotate-90"}`}
            >
              <Icon as={ChevronRight} size={13} />
            </span>
            {folder.blockedCount > 0 && (
              <span className="ml-auto shrink-0 pl-1.5 text-2xs font-semibold text-fg">
                {folder.blockedCount} waiting
              </span>
            )}
          </button>
          {/*
           * Start a session **in this folder**, which is the one thing the folder
           * knows that the New session button at the bottom of the rail does not.
           *
           * The path rides the route (`/new/:machineId/:cwd`) rather than being
           * handed to the dialog as state, for `router.ts`'s reason: sidebar state
           * feeding a routed dialog forgets itself on back-and-forward. So this is
           * a real link — deep-linkable, and Back closes it.
           *
           * Revealed on hover and always present on a coarse pointer: a *pointer*
           * query in CSS, never a width read in JavaScript. The row kebab below
           * followed this rule and no longer does — it is drawn on every row now,
           * for the reason recorded there. This one stays hidden because it is an
           * *addition* to a header that already has a control, where the kebab is
           * the only way into its row's menu at all.
           *
           * ⚠ **`chip`, and it was `h-7 w-7` — 28px, hand-rolled, with no growth of
           * any kind.** It was never one of the `h-9 w-9` copies, so no earlier scan
           * reached it; the sweep that did find it weighed two remedies and recorded
           * the control instead, because both cost something: growing the *box*
           * makes this header taller than every session row beneath it, and growing
           * the target symmetrically spends 10px a side onto the face of the folder's
           * own collapse `<button>`, 4px to the left.
           *
           * There is a third, and this repo already built it. `chip` is a 32px box —
           * which fits the header's `min-h-9` without changing it — grown to 44px by
           * `TAP_GROW_Y`, which is **vertical only** and therefore spends nothing
           * horizontally. That is the same adjacency the composer's paperclip has and
           * the same answer it takes. The target is 32×44 rather than square, which
           * is what this house standard trades for not landing on a neighbour.
           */}
          <IconButton
            icon={Plus}
            label={`New session in ${folder.name}`}
            size="chip"
            onClick={() => navigate(newPath(folder.machineId, folder.path))}
            className="ml-1 opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
          />
        </div>
      </h2>
      {!folder.collapsed &&
        folder.rows.map((row, index) => (
          <SessionLine
            key={row.key}
            row={row}
            state={state}
            selected={row.key === activeKey}
            folderPath={folder.path}
            indented
            drag={drag.bind(row, folder.id)}
            lifted={drag.dragging === row.key}
            pressed={drag.pressing === row.key && drag.dragging !== row.key}
            sliding={drag.sliding}
            shift={drag.shiftFor(folder.id, index, row.key)}
          />
        ))}
    </section>
  );
}

function SessionLine({
  row,
  state,
  selected,
  showMachine = false,
  folderPath = null,
  indented = false,
  showPath = true,
  drag,
  lifted = false,
  pressed = false,
  sliding = false,
  shift = 0,
}: {
  row: SessionRow;
  /** For the menu, which reads the live snapshot rather than this row's copy. */
  state: AppState;
  selected: boolean;
  /**
   * Whether to name the machine on the row.
   *
   * Off inside a folder, where the tab above already says it. On in the pinned
   * group, among orphans and in the waiting floor, which are cross-fleet and where
   * it is the whole point.
   */
  showMachine?: boolean;
  /**
   * The folder this row is drawn under, so the subline can say only the rest.
   *
   * Non-null also means *inside a folder*, which is what the row indents against.
   */
  folderPath?: string | null;
  /**
   * Draw this row inboard, because it is inside a named group.
   *
   * Separate from `folderPath` because the two questions came apart: Pinned and
   * All are groups with headers and no directory, so they indent while having no
   * path to shorten against.
   */
  indented?: boolean;
  /**
   * Whether the subline may name where this session works.
   *
   * ⚠ **It used to be off in Pinned and that was only ever true while pinning
   * *copied*.** The argument was that a pin means "this one, wherever it lives",
   * so naming the folder says nothing the same row drawn again under that folder
   * does not already say. There is no second copy any more — pinning moves — so
   * withholding the path left the pinned rows as the only ones in the rail that
   * did not say where they work, which is the thing a folder was a folder for.
   *
   * ⚠ **And turning it back on overshot, which is why Pinned is still not the
   * caller this was waiting for.** On it, a pin drew its whole `displayCwd` and
   * became the only row in the rail that named the directory it was *launched
   * from* — the one thing the reader already knew, since they pinned it. But the
   * fix is not this switch and it is not `folderPath` either: cutting a pinned row
   * against its own folder was tried and blanked the line for every session
   * launched at its repository root, which is most of them. That history is
   * written once, at `located` below, where the arm it is about lives.
   *
   * What Pinned actually passes is **neither** — no `showPath={false}` and no
   * `folderPath` — so it takes `located`'s folderless arm and draws `folderLabel`:
   * the whole directory minus the `~/` marker every row on a machine shares. The
   * complaint was never that a pin named a directory; it was that it spent the
   * row's first characters on the part that is the same everywhere. Q3.581.
   *
   * No caller passes this switch now. It is kept as a parameter rather than
   * deleted because it is the shape of the question, and the day a group has a
   * real reason to withhold a path this is where that reason goes.
   */
  showPath?: boolean;
  /**
   * What the long-press drag needs on this row, or nothing where it cannot happen.
   *
   * Absent in the waiting floor and under All — the floor is a *view* of rows that
   * live elsewhere, and All has no folders, so in both there is no group a drop
   * could name. `useRowDrag` supplies the whole set; the row spreads it and knows
   * none of it, which is what keeps the gesture out of this file.
   */
  drag?: Record<string, unknown>;
  /** True while this row is the one under the finger. */
  lifted?: boolean;
  /**
   * True between the finger landing and the press becoming a drag.
   *
   * Its own state rather than a shade of `lifted`, because it answers a different
   * question: `lifted` says *this row is moving*, and this says *I heard you, keep
   * holding*. Without the second one the 400ms before a drag arms is 400ms of the
   * app doing nothing, which reads as the gesture not existing.
   */
  pressed?: boolean;
  /** Some row is being dragged, so a shift is worth animating. */
  sliding?: boolean;
  /**
   * How far this row stands aside while another is dragged over it, in pixels.
   *
   * A measured pixel count rather than one of a set of positions, so it is a style
   * rather than a class — and it is the only inline style here, the dragged row's
   * own offset never going through React at all.
   */
  shift?: number;
}): ReactNode {
  const at = row.snapshot.turnStartedAt ?? row.snapshot.lastEventAt ?? row.snapshot.createdAt;
  // Both kinds, oldest first — a question waiting on you is the same fact as an
  // approval waiting on you, and this row draws whichever has waited longest.
  const requests = humanRequests(row.snapshot);
  const waiting = requests.length;
  const pending = requests[0];
  const roots = state.rootsByMachine.get(row.ref.machineId) ?? [];
  const label = sessionLabel(row, roots);
  /*
   * Where this session works, and **only where the row is not already saying it.**
   *
   * ⚠ Reported from a phone against a pinned row: the title read
   * `…/rends/2026-07-tare-r…` and the line under it read
   * `claude · …/rends/2026-07-ta…`. The same absolute path, truncated twice, both
   * of them mostly `/Users/rends`.
   *
   * Two separate faults, and this is both fixes. The path is cut against the
   * daemon's own roots now (`folderLabel` and `rowSubpath`, both reaching
   * `displayCwd`'s own cut), so it reads `2026-07-tare-reemoat`. And a session **nobody
   * has named** has a title that *is* its directory — `sessionLabel` falls back
   * to exactly this string — so repeating it below is one fact drawn twice, in a
   * row 40 characters wide. `headlineWorthDrawing` in `tail.ts` refuses an echo
   * one screen over for the same reason; this is that rule on a list row.
   *
   * Compared rather than keyed on `title`, because the two are only *usually* the
   * same question: a folder row draws a subpath the title never had, and a named
   * session draws both because they say different things.
   *
   * **A row with no folder header above it draws `folderLabel`, not `displayCwd`
   * — the folder, without the `~/` that says which root.** Pinned, All, the
   * waiting floor and the orphans all name the directory in full because nothing
   * else on screen does; what they drop is the prefix every row on a machine
   * shares. `~/2026-07-taskmanager` is `2026-07-taskmanager` here, and the two
   * characters go from the end nearest the reader's eye.
   *
   * ⚠ **Withholding the folder itself was tried here and was wrong.** Cutting a
   * pinned row against its own `folderPathOf` blanked the line for every session
   * launched at its repository root, which is most of them — the folder vanished
   * instead of getting shorter. The complaint was never that a pin named a
   * directory; it was that it spent the row's first characters on the part of the
   * path that is the same on every row. Q3.581.
   */
  const located =
    !showPath
      ? null
      : folderPath === null
        ? folderLabel(row.snapshot.workspace.requestedCwd, roots)
        : rowSubpath(row, folderPath);
  const subpath = located === label ? null : located;
  // Only when the daemon actually gave up. A session it is still working
  // through — the common case for the length of a deploy — is drawn as an
  // ordinary row on purpose, because from here nothing is wrong with it.
  const stalled = resumeStalled(row.snapshot)
    ? resumeFailureText(
        row.snapshot.resume?.error?.code ?? "no_agent_session_id",
        row.snapshot.resume?.error?.message ?? "",
        row.snapshot.agent,
        row.machineName,
      )
    : null;
  const [renaming, setRenaming] = useState(false);

  /*
   * A `div` holding a navigating button and a sibling menu, not one big button.
   *
   * The row used to *be* the `<button>`, and a control inside it would have been a
   * button inside a button — invalid HTML, and browsers resolve it by breaking the
   * outer one. So the click target is the inner `flex-1` button and the menu sits
   * beside it.
   */
  /*
   * **The selected row is `raised`, and the rule it replaces was correct until
   * the palette made it unreadable.**
   *
   * It was `bg-surface` — the pane's own colour — on the argument that a row
   * painted what it opens reads as connected to it. That worked at 1.18:1 against
   * the rail. `surface` is white and `ink` is 1.06:1 from it now, so the row
   * telling you which conversation is open was the least visible thing in the
   * list. The premise went with it in any case: `border-r` is back, so a row
   * cannot run into the pane however it is painted.
   *
   * `raised` at 1.15:1 is the strongest ground the rail has, and hover drops to
   * half of it so the two do not read as the same state.
   */
  return (
    <div
      {...drag}
      style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
      /*
       * ⚠ **`select-none` only while this row is the one moving.** A long press
       * starts a text selection on every engine, and the selection then follows
       * the finger over the rows the drag is passing. Putting it on the list
       * unconditionally would take selection away from the rail permanently to
       * fix a state that lasts a second.
       *
       * `shadow-lg` and its own ground, so the row reads as picked up rather than
       * as sliding under its neighbours; `z-10` because the sections around it
       * paint their own backgrounds. **No `.press`** — `scale(0.97)` held for the
       * length of a gesture reads as broken, which is `agent-strip.md`'s
       * measurement rather than a preference here.
       */
      /*
       * ⚠ **The transition is on only while a drag is live, and taking it off at
       * the drop is the point.** Clearing the transform and reordering the keyed
       * children happen in one commit, and a transition takes its start value from
       * the last style recalc — so a row left with the class would animate
       * `translateY(±h) → none` over a layout that has *already* moved by ∓h,
       * overshooting by a full row and sliding back on every drop.
       *
       * ⚠ **And the row under the pointer is never transitioned.** Its transform is
       * rewritten on every pointer event; with one, each write restarts the
       * interpolation from wherever the last had reached and the row crawls after
       * the finger instead of following it. Both are `agent-strip.md`'s
       * measurements rather than preferences.
       */
      className={`group relative flex items-center ${sliding ? "select-none" : ""} ${
        sliding && !lifted ? "transition-transform" : ""
      } ${
        lifted
          ? "z-10 bg-surface shadow-lg will-change-transform"
          : pressed
            ? /*
               * ⚠ **The hold has to be visible before it has done anything, and
               * `bg-raised` on `ink` is 1.15:1 — under a thumb, on a phone, that
               * is nothing at all.** So the press wears a shadow, which is the
               * one cue that spills past the finger covering the row, and it is
               * the *same* cue the lift wears one step stronger: the row is
               * picked up gradually rather than switching appearance at 400ms.
               * A shadow and never a `scale`, because `measure` reads this row's
               * own height at the moment it arms and a transformed rect would
               * report the wrong one. The other half of the answer is haptic and
               * lives at `arm` in `rowDrag.ts`.
               */
              "z-10 bg-raised shadow-md"
            : selected
              ? "bg-raised"
              : "hover:bg-raised/50"
      }`}
    >
      <button
        onClick={() => navigate(sessionPath(row.ref))}
        aria-current={selected ? "page" : undefined}
        // No separator, and the vertical rhythm is what replaces it: a border
        // between two items of the same kind is a rule this app now spends only
        // between two *regions*.
        /*
         * **A row inside a folder starts inboard of its folder header.**
         *
         * Everything in this list sat flush at `px-3`, so a chat under an open
         * folder began at the same left edge as the folder itself, and the only
         * thing saying it was *in* that folder was vertical adjacency — which says
         * nothing once a second folder is open below it. Twelve pixels is the
         * whole fix, and it is the indent `EventList` already gives a subagent's
         * steps.
         *
         * Rows that are not in a folder — Pinned, the orphans, the waiting floor —
         * keep the flush edge, which is what says they are not in one.
         */
        className={`tap flex min-w-0 flex-1 items-center gap-2 py-3.5 pr-3 text-left lg:py-2.5 ${
          indented || folderPath !== null ? "pl-8" : "pl-3"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* Before the name, never after it. State that trails the content it
                describes is state you read second, and the whole point of a dot
                is that it is read *instead* of reading. It also gives every row
                one fixed left edge for its name. */}
            <StatusDot session={row.snapshot} />
            {renaming ? (
              /*
               * ⚠ **`data-no-drag`, the same marker the kebab carries, and for a
               * sharper reason.** The row is the drag surface and this is a text
               * field inside it: without the marker a mouse drag-select over the
               * name passes `MOUSE_SLOP` and arms the row drag, and a long press
               * to place a caret passes `PRESS_MS` and does the same — after
               * which `rowDrag` writes `user-select: none` and
               * `-webkit-touch-callout: none` onto the row and `preventDefault`s
               * the touchmove, so the field cannot be selected in at all and the
               * session is reordered instead of renamed. `rowDrag.ts` states the
               * rule: the row is the drag surface *except* where it already
               * carries a control.
               */
              <span data-no-drag className="flex min-w-0 flex-1">
                <RenameField
                  sessionRef={row.ref}
                  current={row.snapshot.title ?? null}
                  placeholder={label}
                  onDone={() => setRenaming(false)}
                />
              </span>
            ) : (
              // Semibold when it is waiting on you. With the amber gone this is
              // half of what makes a blocked row findable at arm's length — the
              // dot's permanent ring is the other half, and the folder's own
              // count is the third.
              <span className={`min-w-0 truncate text-sm ${waiting > 0 ? "font-semibold" : ""}`}>
                {label}
              </span>
            )}
          </div>
          {/*
           * What it is waiting for, in place of the path.
           *
           * The title of the pending request — "Edit", "Running: npm test" — is on
           * the *snapshot*, so it costs nothing and keeps the promise that you know
           * what you are about to approve before you open it.
           */}
          {waiting > 0 && pending !== undefined ? (
            <div className="mt-0.5 truncate text-xs font-medium text-fg">{pending.title}</div>
          ) : stalled !== null ? (
            /* A session the daemon could not bring back is the only other row in
               this list that is waiting on a person — it just is not waiting on an
               approval, which is why it is not counted in `blockedCount`. */
            <div className="mt-0.5 truncate text-xs text-danger">{stalled}</div>
          ) : (
            /*
             * **The machine reads after the agent, not as a badge over the title.**
             *
             * It was a `Badge` between the status dot and the name — an outlined
             * chip pushing the one string this row exists for to the right, on
             * exactly the rows (Pinned, the orphans, the waiting floor) where the
             * name matters most because they are the cross-fleet groups. Down here
             * it joins the sentence that was already being written: agent, then
             * where, in one `text-muted` line under the title.
             */
            /*
             * ⚠ **Sans, and `text-2xs` — this line is the one place a path is *not*
             * drawn in mono, and the reason is the same one that keeps the title
             * above it sans.**
             *
             * A row is the tightest slot in the app: at 390px this line shares its
             * width with the age and the overflow control, and mono's ~0.6em average
             * advance against sans's ~0.5em spends about a fifth of the characters on
             * the family. Measured on the reported row — `~/2026-07-ta…` was as far as
             * 12px mono reached; sans at the same step carries roughly a quarter more,
             * and the whole line dropping from `text-xs` adds to that.
             *
             * That is not an exception to `.claude/rules/web-typography.md`, it is the
             * carve-out that rule already makes one paragraph up: what a row draws is a
             * *name* — the thing you scan a list for — and a name is prose. Mono is for
             * where a path is being read as a path and there is room to read it: the
             * session header, the picker's crumbs, a diff, the import sheet.
             *
             * One size and one family for the whole line, rather than the path
             * differing from the two names beside it. A subline that changed font
             * halfway is what made this row unreadable in the first place.
             */
            <div className="mt-0.5 truncate text-2xs text-muted">
              {row.snapshot.agent}
              {/* The rail's name for the machine, so under All a row on this
                  computer says `local` like the tab it came from. */}
              {showMachine && ` · ${machineDisplayName({ id: row.ref.machineId, name: row.machineName }, state.localMachineId)}`}
              {/* The path left this row when the folder took it. What comes back
                  is only the part the folder does not already say. */}
              {subpath !== null && ` · ${subpath}`}
            </div>
          )}
        </div>
        {/* A fixed right-aligned slot, sized for the widest thing `shortDuration`
            produces: `2m` → `59m` → `1h` → `3d` changes character count on the 4s
            poll, and the only absorber is the `flex-1` holding the name, so every
            session name's truncation point would drift on a timer. */}
        <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums">
          {shortDuration(elapsedSince(row, at))}
        </span>
      </button>

      {/*
       * ⚠ **Always drawn, and it used to be revealed on hover for every row but a
       * pinned one.** Reported as "why do the pinned ones have three dots and the
       * others not — make them all show it", which is the reveal working exactly
       * as written and being wrong anyway: two rows a few pixels apart, identical
       * in every other way, and one of them has a control. The rule was a *pointer*
       * query rather than a width read and that part was right; what it got wrong
       * is that hiding a row's only menu until the pointer is already on the row
       * makes the menu undiscoverable and makes the list look inconsistent to
       * anybody whose pointer is elsewhere — which is the state a list is in
       * whenever somebody is reading it rather than aiming at it.
       *
       * The ink this costs was already being spent: `pinned` rows have drawn it
       * unconditionally all along, so nothing about the row's width, its
       * truncation point or the tap pad's reach past the scroller changes — see
       * the `mr-2.5` note above, which is the measurement that keeps a permanent
       * horizontal scrollbar off the bottom of the rail.
       */}
      {/*
       * `mr-2.5` and not `mr-1`, and the 10px is measured rather than chosen:
       * `IconButton size="sm"` grows its 24px box to a 44px target with
       * `after:-inset-2.5`, and a positioned pseudo-element is part of its
       * scroll container's overflow region. At 4px the pad hung 6px past the
       * list's content edge and put a permanent horizontal scrollbar along the
       * bottom of the rail. See the note on that box.
       */}
      {/*
       * ⚠ **`data-no-drag`: the row is the drag surface *except* here.** A mouse
       * takes the pointer at the press, so without this every later event — the
       * `click` this menu needs included — was retargeted to the row and the kebab
       * simply stopped working. Marked on the markup rather than tested by tag in
       * `rowDrag.ts`, so the next control added to this end of the row inherits it
       * without that file learning its name.
       */}
      <span data-no-drag className="mr-2.5">
        <SessionMenu sessionRef={row.ref} state={state} size="sm" onRename={() => setRenaming(true)} />
      </span>
    </div>
  );
}

/**
 * New session, and nothing else.
 *
 * A real flex footer rather than a `sticky` strip with a `backdrop-blur`: the
 * scroll lives in the box above it now, so there is nothing to blur.
 *
 * ⚠ **Recorded history, not a description.** The blur also created a stacking
 * context that would have clipped a profile popover opening upward out of this
 * footer. `ProfileMenu` is gone and who-you-are is `MenuDrawer`'s now, so that is
 * a reason not to put a popover back here rather than a thing being avoided.
 */
function SidebarFoot({ machine }: { machine: MachineId | null }): ReactNode {
  /*
   * **No `border-t`, because there was no way to make it meet the composer's.**
   *
   * This rule and the composer's top rule are the two horizontal lines at the
   * bottom of a wide screen, and they sit either side of the rail divider at
   * heights decided by two different stacks of content — one button here now that
   * the account row has gone to `MenuDrawer`, a textarea plus a control strip
   * there. They landed a couple of pixels apart, so what read across the divider
   * was one line with a step in it.
   * Nothing can align them: both heights are content-derived and either can
   * change on its own.
   *
   * So there is one line rather than two that nearly meet, and it belongs to the
   * composer, which needs it — the transcript scrolls under that edge. Nothing
   * scrolls under this one: the list above stops at its own box, and the space
   * plus the bordered New session button is what separates the footer, which is
   * the rule this list already follows between every other pair of things.
   */
  return (
    /*
     * ⚠ **`pb-2` on the inner box and `pb-safe` on this one, which is the
     * composer's own arrangement copied deliberately.**
     *
     * The two stacks sit either side of the rail divider and their bottom edges
     * are read as one line. They were 8px apart: the composer's band is `pb-safe`
     * (12px floor) with a `pb-2` on the column *inside* it, so the box you type in
     * stops 20px above the floor, while this footer had `pb-safe` alone and the
     * button stopped at 12 — hanging below the thing it is supposed to line up
     * with.
     *
     * ⚠ **The 8px may not go beside `pb-safe` on this element**, and that is a
     * cascade fact rather than a preference: `.pb-safe` is declared unlayered in
     * `index.css`, so it beats any `pb-*` utility on the same node whatever the
     * class string says, and the edit would be a **silent no-op**. `Composer.tsx`
     * records that measurement at length; this is the second surface to need it,
     * which is why it is written here too rather than pointed at.
     */
    <div className="pb-safe shrink-0 px-3 pt-3">
      <div className="pb-2">
        {/*
         * The tab bar **writes** the route rather than the dialog reading the tab
         * bar, which is `router.ts`'s own rule: sidebar state feeding a routed
         * dialog forgets itself on back-and-forward.
         */}
        {/*
         * `plain`, not `primary`, for the machine tab's reason read once more.
         *
         * `bg-fg` is a near-black block, and in a rail whose three greys sit within
         * 1.22:1 of each other it was the only heavy object on the screen — drawing
         * the eye to a button somebody presses a few times a day, permanently. This
         * app spends that fill on the affirmative action *inside* a decision (Send,
         * an approval on the ask card), and "start something new" is a navigation.
         * Full width and a leading glyph are what make it findable instead.
         */}
        {/*
         * **Not full width, and 36px rather than 44px.**
         *
         * Both come from where its top edge lands. This footer and the composer are
         * bottom-anchored stacks either side of the rail divider, so the button's
         * top sits as high above the bottom as the two rows below it are tall —
         * about twelve pixels above the composer's message box, which is what made
         * it read as floating rather than as part of the same line. `size="sm"`
         * spends eight of those twelve; the remainder is not chased, because both
         * stacks are content-derived and an exact match would be a coincidence that
         * the next change breaks (the same reason this footer has no `border-t`).
         *
         * Width does **not** follow, and that was tried the other way: at content
         * width the button floated in the middle of a column whose every other row
         * is full-bleed, which reads as an object dropped into the footer rather
         * than as the footer's own control. Full width with a leading glyph, short
         * rather than tall.
         */}
        <Button
          size="sm"
          className="w-full"
          onClick={() => navigate(machine === null ? newPath() : newPath(machine))}
        >
          <Icon as={Plus} size={16} />
          New session
        </Button>
      </div>
      {/*
       * ⚠ **The account row, the help popover and the plugin launcher have all
       * left this footer for the menu drawer, and only one of them is a loss.**
       *
       * The launcher's own rule is untouched by the move and worth restating,
       * because it is the one somebody will try to undo: the rail is the sessions,
       * and a plugin able to add rows to the list would open a hole in
       * `waitingFloor`, which is computed by subtraction precisely so that a new
       * section cannot. A menu row takes part in no ordering, no filter and no
       * count — it is one door further in, in the panel where the other doors out
       * of the rail now live.
       *
       * ⚠ **What was lost is `HelpButton`'s legend**, the only place this app
       * documented `j`, `k` and `/` — and, more importantly, the only place it
       * said that none of them fire while you are typing, which is most of the
       * time. It is not re-homed here: the drawer takes rows that are *places to
       * go*, and a legend is not one. That legend had already been deleted once,
       * from under this very button, for being advertised as a feature while being
       * wrong more often than right; it is gone again, and `docs/DECISIONS.md`
       * names `CommandMenu` as where it belongs if it comes back.
       */}
    </div>
  );
}

/**
 * What setting this computer up is doing, and what it said when it failed.
 *
 * ⚠ **The failure arm is the whole reason this exists.** The app creates a machine
 * and starts a daemon by itself now, and every part of that can fail on somebody
 * else's computer: a port in use, a code that expired, a payload that will not
 * spawn. Without this the symptom is a machine in the list that is simply *not
 * reachable*, with the cause sitting in a string nothing renders — which is exactly
 * what happened on the first real run, and cost a whole round trip to diagnose.
 *
 * ⚠ **And the evidence is no longer *here*** — owner's call, 2026-09-15. This
 * drew `host_daemon_state`'s ring, two hundred lines of it, in a `<pre>` under
 * that sentence: program output on a rail whose subject is somebody's sessions,
 * in the one place they are reading prose. The ring is Settings → Logs now
 * (`LogsSection`), and what is left here is `said` — one sentence, which for
 * every failure that has evidence ends by naming that screen.
 *
 * ⚠ **Sans, and `whitespace-pre-line` rather than a `<pre>`.** `said` is prose,
 * so `web-typography.md` puts it in sans; the newlines are preserved for the one
 * producer that needs them — the host's refusal when a `deploy/install.sh`
 * service already owns this computer, which ends with the command that clears it.
 * That is a remedy somebody retypes, bounded at two lines and written by this
 * fleet, and reflowing it into a paragraph makes it unusable.
 */
export function SetupNotice({ setup }: { setup: SetupState }): ReactNode {
  if (setup.step !== "failed") {
    return (
      <div className="mx-3 mb-2 shrink-0 rounded-md border border-edge-strong bg-raised px-3 py-2 text-xs text-fg">
        {setup.step === "creating" ? "Setting this computer up…" : "Starting the daemon on this computer…"}
      </div>
    );
  }
  return (
    <div className="mx-3 mb-2 shrink-0 rounded-md border border-edge-strong bg-raised px-3 py-2 text-xs text-fg">
      <p>This computer could not be set up.</p>
      {setup.said !== null && (
        <p className="mt-1 whitespace-pre-line break-words text-muted">{setup.said}</p>
      )}
    </div>
  );
}

export function ControlPlaneNotice(): ReactNode {
  return (
    <div className="mx-3 mb-2 shrink-0 rounded-md border border-edge-strong bg-raised px-3 py-2 text-xs text-fg">
      Control plane unreachable — running on tokens already issued. Sessions are unaffected until
      they expire.
    </div>
  );
}
