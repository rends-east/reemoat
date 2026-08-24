import { Bell, Check, ChevronRight, Folder as FolderIcon, Layers, ListFilter, Pin, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MachineId, SessionKey } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { displayCwd } from "../paths";
import { navigate, newPath, sessionPath } from "../router";
import { settingsPath } from "../settings";
import { elapsedSince, sessionGroups, sessionLists, type AppState, type SessionRow } from "../store";
import { humanRequests, needsHuman, resumeStalled } from "../wire";
import {
  Button,
  Icon,
  MENU_ROW,
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
import { Mark } from "./Mark";
import { HelpButton, ProfileMenu } from "./ProfileMenu";
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
}: {
  state: AppState;
  activeKey?: SessionKey | null;
}): ReactNode {
  const groups = sessionGroups(state);
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
  const pinned = matching(pinnedFor(groups, filter), view.query);
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
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader state={state} />

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

      {state.machines.length > 0 && (
        <MachineTabs tabs={tabs} all={allTab(groups, view)} canAdd={mayAddMachine(state.me)} />
      )}

      {state.cpError !== null && <ControlPlaneNotice />}

      {state.machines.length > 0 && <ChatSearch value={needle} />}


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
      <div className="min-h-0 flex-1 overflow-y-auto">
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
              <Button className="mt-3" onClick={() => navigate(settingsPath("machines"))}>
                Add a machine
              </Button>
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
          >
            {pinned.map((row) => (
              <SessionLine
                key={row.key}
                row={row}
                state={state}
                selected={row.key === activeKey}
                showMachine={view.all}
                indented
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
              <p className="text-sm text-muted">Nothing matches.</p>
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
              <p className="text-sm text-muted">No sessions here yet.</p>
            )}
          </div>
        )}
      </div>

      <SidebarFoot state={state} machine={view.machine} />
    </div>
  );
}

/** The logo, the name, and the one number that must never be hidden. */
function SidebarHeader({ state }: { state: AppState }): ReactNode {
  const waiting = sessionLists(state).blocked;
  return (
    <div className="pt-safe flex shrink-0 items-center gap-2 px-3 pb-2">
      {/*
       * The mark, where the placeholder square was — that square's own comment
       * said "a logo goes here", and this is the logo.
       *
       * **Taller than the cap height beside it**, 20px against 16px text, which is
       * the landing page's own sizing rule and the reason it is not `h-7`: matched
       * to the cap height a glyph-shaped mark reads as undersized next to its own
       * name. It takes `currentColor`, so it is the same ink as the name and needs
       * no token of its own.
       */}
      <Mark size={20} className="shrink-0" />
      {/* Capitalised, because it is a name. The `<title>` and the landing page
          both say Reemoat; the lowercase spelling here was the last place that
          still read as a command you type. */}
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Reemoat</h1>
      {/*
       * **This is not the chat search, and it must not act like it.**
       *
       * It was wired to focus the search box below, which was wrong twice over:
       * that box is already on screen and needs no shortcut, and the two are
       * different questions. The one below filters *this machine's* chats by
       * title; this one is the fleet-wide search — across machines, and
       * eventually across what was said inside a conversation — which does not
       * exist yet.
       *
       * So it is drawn and inert, deliberately, and `disabled` rather than
       * silently doing nothing: a control that answers a tap with no change is
       * one somebody taps again. The bell beside it is the honest comparison —
       * that one is a real number and a real destination, which is why it is
       * enabled.
       */}
      <button
        type="button"
        disabled
        aria-label="Search everything — not built yet"
        title="Search everything — not built yet"
        className="tap inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted disabled:pointer-events-none disabled:opacity-40"
      >
        <Icon as={Search} size={16} />
      </button>
      {/*
       * The bell is the blocked count, not a stub.
       *
       * A notification glyph that does nothing is a claim this app cannot keep —
       * there is no push and no service worker, and the whole product is the
       * question "does anything need me". So it says the number and goes to the
       * session that has waited longest, which `sessionLists` already sorts to the
       * front. With nothing waiting it is `disabled`, which is the honest drawing
       * of "nowhere to go" rather than a control that shrugs.
       */}
      <button
        type="button"
        disabled={waiting.length === 0}
        onClick={() => {
          const first = waiting[0];
          if (first !== undefined) navigate(sessionPath(first.ref));
        }}
        aria-label={
          waiting.length === 0 ? "Nothing is waiting on you" : `${waiting.length} waiting on you`
        }
        title={waiting.length === 0 ? "Nothing is waiting on you" : `${waiting.length} waiting on you`}
        className="tap relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40"
      >
        <Icon as={Bell} size={16} />
        {waiting.length > 0 && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-fg ring-2 ring-ink" />
        )}
      </button>
    </div>
  );
}

/**
 * The machines, as folder tabs.
 *
 * Order is `groups.groups`' order and nothing else — by name, decided in
 * `store.ts` and asserted there. Never by activity or reachability: both flicker
 * on the four-second poll, and a bar that reorders under a travelling thumb is the
 * one thing this list cannot do.
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

  return (
    <div
      ref={stripRef}
      className="flex shrink-0 items-center gap-1.5 px-3 pb-2"
    >
      {/*
       * **`All` is pinned to the left, outside the scroller.**
       *
       * It is the one tab that is about the whole fleet, so it is also the one
       * that must never scroll away — a machine tab going off the end costs you a
       * drag, and All going off the end costs you the only view that can show a
       * session whose machine you have not thought of.
       *
       * **Flat on the left, round on the right, and bled to the rail's own edge.**
       * Every fill in this app it borrows unchanged — it is a machine pill in
       * colour, weight and hover, because it is one more tab and not a mode
       * switch. The one thing it does differently is the shape, and the shape is
       * the argument: a pill floating with air on both sides is a thing in a row
       * of things, while a half-pill running off the left edge is a thing *fixed
       * to* that edge, which is exactly the promise being made — the strip beside
       * it scrolls and this does not. `-ml-3` cancels the row's own padding so the
       * flat side has an edge to be flat against; `pl-3` puts the label back where
       * it would have been.
       *
       * That also retires the divider that used to follow it. A rule between two
       * pills says "these are different kinds of thing"; so does one of them being
       * a different shape, and saying it twice is what makes a bar look busy.
       */}
      <button
        type="button"
        onClick={() => selectMachine(all.id)}
        aria-pressed={all.selected}
        className={`tap -ml-3 flex min-h-8 shrink-0 items-center gap-1.5 rounded-l-none rounded-r-full py-1 pr-4 pl-3.5 text-xs whitespace-nowrap ${
          all.selected
            ? "bg-raised font-medium text-fg"
            : "bg-raised/50 text-muted hover:bg-raised hover:text-fg"
        }`}
      >
        {all.name}
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
      <div
        // `no-scrollbar` only in the many-machine case: this strip is the one box
        // in the app whose contents already say there is more of them by being cut
        // off at the edge, so the classic bar under the pills was a permanent
        // eight-pixel line the rail did not need. With one tab there is nothing to
        // scroll and nothing to hide.
        className={`min-w-0 flex-1 ${lone ? "" : "no-scrollbar overflow-x-auto overscroll-x-contain"}`}
      >
        <div className={`flex gap-1.5 ${lone ? "w-full" : "w-max"}`}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectMachine(tab.id)}
              aria-pressed={tab.selected}
              // Read by the effect above, which is how it finds this node without
              // a ref per tab that would change identity on every render.
              data-machine={tab.id}
              /*
               * **The selected tab is `raised`, not `bg-fg`, and an unselected one
               * is `raised/50` rather than nothing.**
               *
               * A near-black pill was the loudest object on a page whose whole
               * palette is three greys within 1.22:1 of each other, and it is a
               * *selection* — the least eventful state a control can be in.
               * `bg-fg` in this app means the affirmative action (Send, an
               * approval), and spending it on "you are looking at this machine"
               * is what made the rail read as though something were alarming.
               *
               * The resting fill is the other half and arrived later: with only
               * the selected tab filled, every other tab was bare text on the
               * rail's own ground, so a bar of four machines read as one tab and
               * three labels — and the shape of the tabs, which is the only thing
               * saying the strip is draggable, existed only where you already
               * were. `raised/50` against `raised` is 1.10 against 1.22 on the
               * rail; the selection is still obvious because it also carries the
               * weight and the text value.
               */
              className={`tap flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap ${
                lone ? "flex-1 justify-center" : "shrink-0"
              } ${
                tab.selected
                  ? "bg-raised font-medium text-fg"
                  : "bg-raised/50 text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {tab.name}
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
         * **Wider than a square, so it is a tab and not a column.**
         *
         * At `w-8` it sat directly above the filter glyph below it — both 32–36px
         * icon boxes flush to the same right edge — and two icon squares stacked
         * on one axis read as a *toolbar column*, which is a thing this rail does
         * not have and which put "add a machine" and "filter these chats" in the
         * same visual group despite being about different scopes. `px-6` moves its
         * centre inboard of the glyph below and gives it the proportions of the
         * pills beside it, which is what it is one of.
         */
        className="tap flex min-h-8 shrink-0 items-center justify-center rounded-full px-6 text-muted hover:bg-raised hover:text-fg"
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
    <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
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
        <input
          type="search"
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
       * bare 36px glyph this row is designed around would have become a labelled
       * control sitting beside the search box competing with it. `Menu` draws
       * nothing and hands the trigger back, which is exactly what an icon needs.
       */}
      <Menu
        align="right"
        panelClassName="w-40"
        className="shrink-0"
        trigger={(open, toggle) => (
          <button
            type="button"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Showing ${FILTERS.find((item) => item.value === filter)?.label ?? "All"}`}
            title={`Showing: ${FILTERS.find((item) => item.value === filter)?.label ?? "All"}`}
            className={`tap inline-flex h-9 w-9 items-center justify-center rounded-md ${
              filter === "active" && !open ? "text-faint hover:bg-raised hover:text-fg" : "bg-raised text-fg"
            }`}
          >
            <Icon as={ListFilter} size={16} />
          </button>
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
                className={`${MENU_ROW} items-center hover:bg-raised ${
                  item.value === filter ? "font-medium text-fg" : "text-muted"
                }`}
              >
                {/* A reserved slot, so choosing does not shift the three labels
                    sideways — the same rule the sheet header's chevron follows. */}
                <span className="inline-flex w-3 shrink-0 justify-center">
                  {item.value === filter && <Icon as={Check} size={12} />}
                </span>
                {item.label}
              </button>
            ))}
          </>
        )}
      </Menu>
    </div>
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
}: {
  icon: typeof Pin;
  name: string;
  id: FolderId;
  blockedCount: number;
  children: ReactNode;
}): ReactNode {
  // A query overrides collapse, the same rule `foldersOf` applies and for the
  // same reason: you search, get a match, and it is inside something you shut.
  const collapsed = currentQuery().trim().length === 0 && isFolderCollapsed(id);
  return (
    <section>
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
}: {
  folder: Folder;
  state: AppState;
  activeKey: SessionKey | null;
}): ReactNode {
  return (
    <section>
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
           * Revealed on hover and always present on a coarse pointer, the same rule
           * the row kebab follows and expressed the same way: a *pointer* query in
           * CSS, never a width read in JavaScript.
           */}
          <button
            type="button"
            onClick={() => navigate(newPath(folder.machineId, folder.path))}
            aria-label={`New session in ${folder.name}`}
            title={`New session in ${folder.name}`}
            className="tap ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 group-hover/folder:opacity-100 hover:bg-edge hover:text-fg focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            <Icon as={Plus} size={13} />
          </button>
        </div>
      </h2>
      {!folder.collapsed &&
        folder.rows.map((row) => (
          <SessionLine
            key={row.key}
            row={row}
            state={state}
            selected={row.key === activeKey}
            folderPath={folder.path}
            indented
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
   * No caller passes it now. It is kept as a parameter rather than deleted
   * because it is the shape of the question, and the day a group has a real
   * reason to withhold a path this is where that reason goes.
   */
  showPath?: boolean;
}): ReactNode {
  const at = row.snapshot.turnStartedAt ?? row.snapshot.lastEventAt ?? row.snapshot.createdAt;
  // Both kinds, oldest first — a question waiting on you is the same fact as an
  // approval waiting on you, and this row draws whichever has waited longest.
  const requests = humanRequests(row.snapshot);
  const waiting = requests.length;
  const pending = requests[0];
  const pinned = row.snapshot.pinned === true;
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
   * daemon's own roots now (`displayCwd`, reached through `sessionLabel` and
   * `rowSubpath`), so it reads `~/2026-07-tare-reemoat`. And a session **nobody
   * has named** has a title that *is* its directory — `sessionLabel` falls back
   * to exactly this string — so repeating it below is one fact drawn twice, in a
   * row 40 characters wide. `headlineWorthDrawing` in `tail.ts` refuses an echo
   * one screen over for the same reason; this is that rule on a list row.
   *
   * Compared rather than keyed on `title`, because the two are only *usually* the
   * same question: a folder row draws a subpath the title never had, and a named
   * session draws both because they say different things.
   */
  const located =
    !showPath
      ? null
      : folderPath === null
        ? displayCwd(row.snapshot.workspace.requestedCwd, roots)
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
      className={`group relative flex items-center ${selected ? "bg-raised" : "hover:bg-raised/50"}`}
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
              <RenameField
                sessionRef={row.ref}
                current={row.snapshot.title ?? null}
                placeholder={label}
                onDone={() => setRenaming(false)}
              />
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
            <div className="mt-0.5 truncate text-xs text-muted">
              {row.snapshot.agent}
              {showMachine && ` · ${row.machineName}`}
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
       * Revealed on hover or focus, and always present on a coarse pointer, which
       * has no hover to reveal it with. A *pointer* query and never a width one,
       * expressed in CSS and never read in JavaScript. A pinned row keeps the menu
       * visible regardless, since that is a row you return to.
       */}
      {/*
       * `mr-2.5` and not `mr-1`, and the 10px is measured rather than chosen:
       * `IconButton size="sm"` grows its 24px box to a 44px target with
       * `after:-inset-2.5`, and a positioned pseudo-element is part of its
       * scroll container's overflow region. At 4px the pad hung 6px past the
       * list's content edge and put a permanent horizontal scrollbar along the
       * bottom of the rail. See the note on that box.
       */}
      <span
        className={`mr-2.5 ${
          pinned
            ? ""
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
        }`}
      >
        <SessionMenu sessionRef={row.ref} state={state} size="sm" onRename={() => setRenaming(true)} />
      </span>
    </div>
  );
}

/**
 * New session, then who you are.
 *
 * A real flex footer rather than a `sticky` strip with a `backdrop-blur`: the
 * scroll lives in the box above it now, so there is nothing to blur — and the blur
 * was creating a stacking context that would have clipped the profile popover
 * opening upward out of it.
 */
function SidebarFoot({ state, machine }: { state: AppState; machine: MachineId | null }): ReactNode {
  /*
   * **No `border-t`, because there was no way to make it meet the composer's.**
   *
   * This rule and the composer's top rule are the two horizontal lines at the
   * bottom of a wide screen, and they sit either side of the rail divider at
   * heights decided by two different stacks of content — a button plus an account
   * row here, a textarea plus a control strip there. They landed a couple of
   * pixels apart, so what read across the divider was one line with a step in it.
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
    <div className="pb-safe shrink-0 px-3 pt-3">
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
      {/*
       * ⚠ **The launcher is inside the account menu now, and it is still not in
       * the list.** It used to be one bordered button per plugin, stacked directly
       * under New session — which put an unbounded, machine-dependent column
       * between the one control somebody presses all day and the account row, and
       * grew the footer by a row for every plugin installed.
       *
       * The rule it was written for is untouched: the rail is the sessions, and a
       * plugin able to add rows to the list would open a hole in `waitingFloor`,
       * which is computed by subtraction precisely so that a new section cannot.
       * A menu row takes part in no ordering, no filter and no count either — it
       * is one door further in than it was, in a menu that is already where the
       * other doors out of the rail live.
       */}
      <div className="mt-2 flex items-center gap-1">
        <ProfileMenu state={state} machine={machine} className="min-w-0 flex-1" />
        <HelpButton />
      </div>
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
