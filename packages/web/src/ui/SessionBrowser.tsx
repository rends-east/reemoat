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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MachineId, SessionKey } from "../ids";
import { AGENT_HOST_OS, installCommand } from "../enrollment";
import { controlPlaneOrigin } from "../native";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { folderLabel } from "../paths";
import { ConnectionPill } from "./ConnectionPill";
import { useMachineDrag } from "./machineDrag";
import { useMachineSwipe, type MachineSwipe } from "./machineSwipe";
import { useTabPill, type TabPill } from "./tabPill";
import { navigate, newPath, sessionPath } from "../router";
import { settingsPath } from "../settings";
import {
  elapsedSince,
  sessionGroups,
  sessionLists,
  store,
  type AppState,
  type SessionGroups,
  type SessionRow,
  type SetupState,
} from "../store";
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
  ALL_MACHINES,
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
  takeRows,
  toggleFolder,
  isFolderCollapsed,
  waitingFloor,
  type Filter,
  type Folder,
  type FolderId,
  type ListView,
  type MachineTab,
} from "./groups";
import { useRowDrag, type RowDrag } from "./rowDrag";
import { CommandLine } from "./CommandLine";
import { RenameField, SessionMenu } from "./SessionMenu";
import { WorkingMark } from "./Mark";

/** Mounted twice, in the desktop aside and the phone wrapper; the breakpoint lives only in those two class strings. */
export function SessionBrowser({
  state,
  activeKey = null,
  onMenu,
  rows = null,
}: {
  state: AppState;
  activeKey?: SessionKey | null;
  /** Opens the menu drawer. Drawn only below `lg`; see `SidebarHeader`. */
  onMenu: () => void;
  /** Cut to one screen while it is drawn under a conversation for a back swipe (Q3.663). */
  rows?: number | null;
}): ReactNode {
  const groups = sessionGroups(state);
  const drag = useRowDrag(state);
  // Collapse, filter, tab and needle live in `groups.ts`, outside React, so they survive an unmount.
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const view = currentView(groups);

  const tabs = machineTabs(groups, view);
  const all = allTab(groups, view);
  const pill = useTabPill();
  const swipe = useMachineSwipe({
    tabs: [all, ...tabs],
    armed: drag.armed,
    pill,
    openMenu: onMenu,
    // The app's own wake path: the registry, every machine re-dialled and re-listed, streams reattached (Q3.658).
    refresh: () => store.resume("pull"),
  });
  const listRef = useCallback(
    (node: HTMLDivElement | null): void => {
      drag.scrollerRef(node);
      swipe.scrollerRef(node);
    },
    [drag.scrollerRef, swipe.scrollerRef],
  );
  const floor = waitingFloor(groups, view);
  const needle = currentQuery();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <SidebarHeader state={state} machines={state.machines.length} needle={needle} onMenu={onMenu} />

      {/* First: `visibleRows` walks floor, pinned, folders, orphans, and the draw order must match. */}
      {floor.length > 0 && (
        <WaitingElsewhere rows={floor} state={state} activeKey={activeKey} />
      )}

      {/* Below lg only; above it `MachineColumn` draws the machines as a column. */}
      {state.machines.length > 0 && (
        <div ref={swipe.stripRef} className="lg:hidden">
          <MachineTabs tabs={tabs} all={all} canAdd={mayAddMachine(state.me)} pill={pill} />
        </div>
      )}

      {state.setup !== null && <SetupNotice setup={state.setup} />}

      {/* The pager's window: the list and its neighbours move side by side inside it, and it clips them (Q3.655). */}
      {/* It hears the finger, never the page: a page mid-turn has moved from under it, and a neighbour takes no touch (Q3.667). */}
      <div ref={swipe.windowRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* The gap a pull opens above the list; drawn only while there is one, and the refresh's own mark in it. */}
        <div
          ref={swipe.pullRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 hidden h-14 items-center justify-center text-muted"
        >
          <WorkingMark size={20} />
        </div>
        {/* Overflow-y alone computes x to auto, so any horizontal overflow here paints a scrollbar: fix the overflow, never clip it. */}
        {/* `relative`: every drop slot is measured in this box's content coordinates. */}
        {/* Pan-y plus pinch-zoom: the horizontal axis is the swipe's; refusing every gesture would stop the rail scrolling. */}
        <div
          ref={listRef}
          className="relative min-h-0 flex-1 overflow-y-auto [touch-action:pan-y_pinch-zoom]"
        >
          {drag.unpinning && (
            <div
              ref={drag.pillRef}
              className="pointer-events-none absolute top-0 left-0 z-30"
            >
              <div className="-translate-x-1/2 -translate-y-[calc(100%+18px)] rounded-md border border-edge-strong bg-surface px-2 py-1 text-2xs font-medium whitespace-nowrap text-danger shadow-sm">
                Release to unpin
              </div>
            </div>
          )}
          <ListBody state={state} groups={groups} view={view} activeKey={activeKey} drag={drag} rows={rows} />
        </div>
        <BesidePanes swipe={swipe} state={state} groups={groups} view={view} activeKey={activeKey} drag={drag} />
        {/* Over the list and above the foot's New session, like Telegram's; a row's own target runs its full width. */}
        <ConnectionPill
          state={state}
          openKey={activeKey}
          machines={view.all ? "all" : view.machine === null ? [] : [view.machine]}
          placement="bottom-3 left-3"
        />
      </div>

      <SidebarFoot machine={view.machine} />
    </div>
  );
}

/** The neighbouring machines' pages while the strip is away from rest: inert, unread, and cut to the rows one screen shows. */
function BesidePanes({
  swipe,
  state,
  groups,
  view,
  activeKey,
  drag,
}: {
  swipe: MachineSwipe;
  state: AppState;
  groups: SessionGroups;
  view: ListView;
  activeKey: SessionKey | null;
  drag: RowDrag;
}): ReactNode {
  const besides = useSyncExternalStore(swipe.subscribe, swipe.beside);
  return besides.map((beside) => (
    <div
      key={beside.id}
      ref={swipe.paneRef}
      data-beside={beside.index}
      aria-hidden="true"
      inert
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <ListBody
        state={state}
        groups={groups}
        view={{ ...view, all: beside.id === ALL_MACHINES, machine: beside.id === ALL_MACHINES ? null : beside.id }}
        activeKey={activeKey}
        drag={drag}
        rows={beside.rows}
      />
    </div>
  ));
}

/** One page of the list; the pager draws a second for the neighbour, cut to `rows` so a long machine costs one screen. */
function ListBody({
  state,
  groups,
  view,
  activeKey,
  drag,
  rows,
}: {
  state: AppState;
  groups: SessionGroups;
  view: ListView;
  activeKey: SessionKey | null;
  drag: RowDrag;
  rows: number | null;
}): ReactNode {
  // Destructured so the call below reads exactly as webcheck greps for it; never reach past the helper here, not even in prose.
  const { filter } = view;
  const left = { rows: rows ?? Number.POSITIVE_INFINITY };
  // Through the helper and the needle, so the drawn rows are exactly the ones `keyboard.ts` steps through.
  const pinned = takeRows(matching(pinnedFor(groups, view), view.query), left);
  const everything = takeRows(allRows(groups, view), left);
  const folders = foldersOf(groups, view).flatMap((folder) =>
    left.rows <= 0 ? [] : [{ ...folder, rows: takeRows(folder.rows, left, 1) }],
  );
  const orphans = takeRows(matching(orphansFor(groups, filter), view.query), left);
  const probing = state.machines.some((m) => m.reach === "probing" || m.reach === "unknown");
  const needle = currentQuery();
  // Rows the filter alone withholds, so the empty state can offer them.
  const hiddenHere =
    folders.length > 0 || everything.length > 0
      ? 0
      : view.all
        ? allRows(groups, { ...view, filter: "all" }).length
        : foldersOf(groups, { ...view, filter: "all" }).reduce((sum, one) => sum + one.rows.length, 0);
  // The ban is checked first: it is the fact to fix before the limit.
  const selected = view.all ? undefined : groups.groups.find((candidate) => candidate.id === view.machine);
  const selectedOwnerDisabled = selected?.ownerDisabled === true;
  const selectedOverLimit = !selectedOwnerDisabled && selected?.overLimit === true;

  return (
    <>
    {folders.length === 0 && everything.length === 0 && pinned.length === 0 && probing && (
      <Skeleton rows={4} />
    )}

    {/* Not while the registry is unreadable: no machines would be a guess. */}
    {state.machines.length === 0 && !probing && state.cpError === null && (
      <div className="px-4 py-6 text-center">
        <p className="text-sm text-muted">No machines yet.</p>
        {mayAddMachine(state.me) ? (
          <>
            {/* Below lg only: at lg `NothingSelected` draws the command in the pane. */}
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

    {/* Shown rather than dropped, on every tab: a vanished session is the worse failure. */}
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

    {/* Ask the unfiltered question before claiming the machine is empty. */}
    {folders.length === 0 && everything.length === 0 && state.machines.length > 0 && !probing && (
      <div className="px-4 py-6 text-center">
        {needle.trim().length > 0 ? (
          // The only exit from a typo: the needle is not persisted and some browsers draw no native clear.
          <>
            <p className="text-sm text-muted">Nothing matches.</p>
            <Button className="mt-3" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </>
        ) : selectedOwnerDisabled ? (
          <p className="text-sm text-muted">
            This machine&rsquo;s owner has been disabled, so it is not being reached.
          </p>
        ) : selectedOverLimit ? (
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
          <>
            <p className="text-sm text-muted">No sessions here yet.</p>
            <p className="mx-auto mt-2 max-w-xs text-xs text-muted">
              New session, at the bottom of this list, starts one.
            </p>
          </>
        )}
      </div>
    )}
    </>
  );
}

/** The sr-only h1 is the only heading on the phone's primary screen. */
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
      <IconButton icon={MenuIcon} label="Menu" size="bar" onClick={onMenu} className="-ml-1.5 lg:hidden" />
      {machines > 0 && <ChatSearch value={needle} />}
      {/* To the longest-waiting session; the dot is a sibling because `IconButton` takes no children, hence `pointer-events-none`. */}
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

// `inset-x-4` must equal the tab's `px-4`; `-bottom-px` puts the mark on the bar's hairline.
/** The selected tab's own pill is this span's ground, so it rides a scroll, a reorder or a resize with its tab (Q3.656). */
function TabLabel({ tab }: { tab: MachineTab }): ReactNode {
  return (
    <span data-tab-pill={tab.id} className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 ${tab.selected ? "bg-raised" : ""}`}>
      {tab.name}
      {tab.blockedCount > 0 && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-2xs font-semibold text-ink [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:min-w-5">
          {tab.blockedCount}
        </span>
      )}
    </span>
  );
}

// Order is the store's, never activity or reachability, which flicker on the poll.
function MachineTabs({
  tabs,
  all,
  canAdd,
  pill,
}: {
  tabs: MachineTab[];
  all: MachineTab;
  canAdd: boolean;
  pill: TabPill;
}): ReactNode {
  const lone = tabs.length === 1;
  const selected = tabs.find((tab) => tab.selected)?.id ?? null;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useMachineDrag({ axis: "x", tabs });
  // One stable callback ref: an inline arrow would re-attach on every poll render.
  const hold = useCallback(
    (node: HTMLDivElement | null): void => {
      scroller.current = node;
      drag.scrollerRef(node);
      pill.scrollerRef(node);
    },
    [drag.scrollerRef, pill.scrollerRef],
  );
  const holdStrip = useCallback(
    (node: HTMLDivElement | null): void => {
      stripRef.current = node;
      pill.stripRef(node);
    },
    [pill.stripRef],
  );
  // Before paint: the new tab's own pill is hidden until the traveller reaches it, so a tap never teleports it.
  const current = all.selected ? all.id : selected;
  const shown = useRef(current);
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = current;
    if (previous === null || current === null || previous === current || pill.turning()) return;
    pill.moveTo(previous, current);
  }, [current]);
  const fade = useRef<HTMLDivElement | null>(null);
  // Keyed on the selection, not an inline ref, which re-scrolled on every render and yanked a dragged strip back.
  // A travelling pill scrolls the strip itself, on its own curve; this is for a change nothing animated.
  useEffect(() => {
    if (lone || selected === null || pill.travelling()) return;
    stripRef.current
      ?.querySelector(`[data-machine="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, lone]);

  // One pixel of slack for rounded scroll metrics; keyed on `lone` because the fade ref is null with one machine.
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
      ref={holdStrip}
      className="relative flex shrink-0 items-center border-b border-edge px-1.5"
    >
      {/* The pill between tabs, first so every label paints over it; three pieces so its ends stay round at any width. */}
      <span ref={pill.travellerRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 hidden">
        <span className="absolute top-0 left-0 h-8 w-8 rounded-full bg-raised" />
        <span className="absolute top-0 left-0 h-8 w-16 origin-left bg-raised" />
        <span className="absolute top-0 left-0 h-8 w-8 rounded-full bg-raised" />
      </span>

      {/* `All` stays outside the scroller so it can never scroll away. */}
      <button
        type="button"
        onClick={() => selectMachine(all.id)}
        aria-pressed={all.selected}
        className={`tap relative flex min-h-11 shrink-0 items-center px-1 text-xs whitespace-nowrap ${
          all.selected ? "text-fg" : "text-muted hover:text-fg"
        }`}
      >
        <TabLabel tab={all} />
      </button>

      {/* Outside the scroller: an absolute child of an overflow box travels with its content. */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={hold}
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
                // A hold reorders and a flick does not: the slop that tells the swipe it is horizontal already killed the hold.
                {...drag.bind(tab.id, index)}
                className={`tap relative flex min-h-11 items-center px-1 text-xs whitespace-nowrap ${
                  lone ? "flex-1 justify-center" : "min-w-22 shrink-0 justify-center"
                } ${tab.selected ? "text-fg" : "text-muted hover:text-fg"} ${
                  // `slides`, not a transition utility: the unlayered `.tap` resets the transition property.
                  drag.sliding && drag.dragging !== tab.id ? "slides" : ""
                } ${drag.dragging === tab.id ? "z-10 bg-ink shadow-lg will-change-transform" : ""}`}
              >
                <TabLabel tab={tab} />
              </button>
            ))}
          </div>
        </div>
        {/* `pointer-events-none` so the half-visible tab under the fade stays selectable. */}
        {!lone && (
          <div
            ref={fade}
            aria-hidden="true"
            className="edge-fade pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink/70 to-transparent"
          />
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {drag.announcement}
      </p>

      {canAdd && (
      <button
        type="button"
        onClick={() => navigate(settingsPath("machines"))}
        aria-label="Add a machine"
        title="Add a machine"
        className="tap flex min-h-11 shrink-0 items-center justify-center px-4 text-muted hover:text-fg"
      >
        <Icon as={Plus} size={14} />
      </button>
      )}
    </div>
  );
}

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
      {/* Not `SETTINGS_HEADING`: the same tracking-wider caps at text-fg, the one band louder than the rows under it. */}
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

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

function ChatSearch({ value }: { value: string }): ReactNode {
  const filter = currentFilter();
  return (
    <>
      <span className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
          <Icon as={Search} size={13} />
        </span>
        {/* Autofill opt-outs: a password manager once filled this box with the account's email. */}
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
      {/* Solid only when the filter is off its default, since the default already withholds ended rows. */}
      <Menu
        align="right"
        panelClassName="w-40"
        className="shrink-0"
        trigger={(open, toggle) => (
          <IconButton
            icon={ListFilter}
            label={`Showing ${FILTERS.find((item) => item.value === filter)?.label ?? "All"}`}
            title={`Showing: ${FILTERS.find((item) => item.value === filter)?.label ?? "All"}`}
            size="chip"
            expanded={open}
            haspopup="menu"
            onClick={toggle}
            // The fill is the whole lit state: an appended `text-fg` loses to the tone's colour in Tailwind's emission order.
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
  // The group joined takes a row's height and the one left gives it back; translating rows alone would overlap what follows.
  space?: number;
  sliding?: boolean;
}): ReactNode {
  // A query overrides collapse, as `foldersOf` does.
  const collapsed = currentQuery().trim().length === 0 && isFolderCollapsed(id);
  return (
    // Animated on the rows' clock while dragging, off at rest so a reflowed layout does not animate back.
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

// Not collapsible: these rows explain a disappearance.
function Section({ name, count, children }: { name: string; count: number; children: ReactNode }): ReactNode {
  return (
    <section>
      <h2 className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs text-faint">
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function FolderSection({
  folder,
  state,
  activeKey,
  drag,
}: {
  folder: Folder;
  state: AppState;
  activeKey: SessionKey | null;
  drag: RowDrag;
}): ReactNode {
  return (
    <section
      className={drag.sliding ? "transition-[margin-bottom]" : ""}
      style={{ marginBottom: `${drag.spaceFor(folder.id)}px` }}
    >
      <h2>
        {/* Two controls rather than one button: a button inside a button is invalid HTML. */}
        <div className="group/folder flex min-h-9 items-center pr-2 hover:bg-raised">
          <button
            type="button"
            onClick={() => toggleFolder(folder.id)}
            aria-expanded={!folder.collapsed}
            title={folder.path.length > 0 ? folder.path : undefined}
            className="tap flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-3 text-left"
          >
          <Icon as={FolderIcon} size={12} className="shrink-0 text-faint" />
          <span className="min-w-0 truncate text-xs text-faint">{folder.name}</span>
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
          {/* `chip` grows vertically only, so its 44px target stays off the collapse button beside it. */}
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
  state: AppState;
  selected: boolean;
  showMachine?: boolean;
  folderPath?: string | null;
  indented?: boolean;
  showPath?: boolean;
  drag?: Record<string, unknown>;
  lifted?: boolean;
  pressed?: boolean;
  sliding?: boolean;
  shift?: number;
}): ReactNode {
  const at = row.snapshot.turnStartedAt ?? row.snapshot.lastEventAt ?? row.snapshot.createdAt;
  const requests = humanRequests(row.snapshot);
  const waiting = requests.length;
  const pending = requests[0];
  const roots = state.rootsByMachine.get(row.ref.machineId) ?? [];
  const label = sessionLabel(row, roots);
  // Only where the row is not already saying it; a folderless row draws `folderLabel`, since cutting a pin against its own folder blanked it. Q3.581.
  const located =
    !showPath
      ? null
      : folderPath === null
        ? folderLabel(row.snapshot.workspace.requestedCwd, roots)
        : rowSubpath(row, folderPath);
  const subpath = located === label ? null : located;
  // Only when the daemon gave up; a session still resuming is an ordinary row.
  const stalled = resumeStalled(row.snapshot)
    ? resumeFailureText(
        row.snapshot.resume?.error?.code ?? "no_agent_session_id",
        row.snapshot.resume?.error?.message ?? "",
        row.snapshot.agent,
        row.machineName,
      )
    : null;
  const [renaming, setRenaming] = useState(false);

  return (
    <div
      {...drag}
      style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
      // Transition only while a drag is live and never on the row under the pointer, or rows overshoot on drop and crawl after the finger. No `.press` here.
      className={`group relative flex items-center ${sliding ? "select-none" : ""} ${
        sliding && !lifted ? "transition-transform" : ""
      } ${
        lifted
          ? "z-10 bg-surface shadow-lg will-change-transform"
          : pressed
            ? // A shadow, never a scale: `measure` reads this row's height when it arms.
              "z-10 bg-raised shadow-md"
            : selected
              ? "bg-raised"
              : "hover:bg-raised/50"
      }`}
    >
      <button
        onClick={() => navigate(sessionPath(row.ref))}
        aria-current={selected ? "page" : undefined}
        className={`tap flex min-w-0 flex-1 items-center gap-2 py-3.5 pr-3 text-left lg:py-2.5 ${
          indented || folderPath !== null ? "pl-8" : "pl-3"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot session={row.snapshot} />
            {renaming ? (
              // `data-no-drag`: otherwise selecting in the field arms the row drag.
              <span data-no-drag className="flex min-w-0 flex-1">
                <RenameField
                  sessionRef={row.ref}
                  current={row.snapshot.title ?? null}
                  placeholder={label}
                  onDone={() => setRenaming(false)}
                  className="-mx-1"
                />
              </span>
            ) : (
              <span className={`min-w-0 truncate text-sm ${waiting > 0 ? "font-semibold" : ""}`}>
                {label}
              </span>
            )}
          </div>
          {waiting > 0 && pending !== undefined ? (
            <div className="mt-0.5 truncate text-xs font-medium text-fg">{pending.title}</div>
          ) : stalled !== null ? (
            <div className="mt-0.5 truncate text-xs text-danger">{stalled}</div>
          ) : (
            // Sans at `text-2xs`: in a row a path is a name (web-typography.md).
            <div className="mt-0.5 truncate text-2xs text-muted">
              {row.snapshot.agent}
              {showMachine && ` · ${machineDisplayName({ id: row.ref.machineId, name: row.machineName }, state.localMachineId)}`}
              {subpath !== null && ` · ${subpath}`}
            </div>
          )}
        </div>
        {/* A fixed slot: the age changes width on the poll, which would move every name's truncation. */}
        <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums">
          {shortDuration(elapsedSince(row, at))}
        </span>
      </button>

      {/* `mr-2.5` so the kebab's grown tap pad ends at the scroller's edge rather than overflowing it. */}
      {/* `data-no-drag`: a mouse drag would otherwise retarget the kebab's click to the row. */}
      <span data-no-drag className="mr-2.5">
        <SessionMenu sessionRef={row.ref} state={state} size="sm" onRename={() => setRenaming(true)} />
      </span>
    </div>
  );
}

function SidebarFoot({ machine }: { machine: MachineId | null }): ReactNode {
  return (
    // `pb-2` inside, not beside `pb-safe`, which is unlayered and would win.
    <div className="pb-safe shrink-0 px-3 pt-3">
      <div className="pb-2">
        <Button
          size="sm"
          className="w-full"
          onClick={() => navigate(machine === null ? newPath() : newPath(machine))}
        >
          <Icon as={Plus} size={16} />
          New session
        </Button>
      </div>
      {/* No plugin rows in the rail: `waitingFloor` is computed by subtraction. */}
    </div>
  );
}

/** `said` keeps its newlines: one host refusal ends with a command somebody retypes. */
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

