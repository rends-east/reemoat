import { Check, ChevronRight } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  chatsWithoutTask,
  columnTitle,
  DONE_RECENT_MS,
  cardHolder,
  isFinal,
  leadRef,
  matchesTask,
  meTasks,
  needingYou,
  SESSIONS_VIEW,
  taskGroups,
  PHASE_LABEL,
  STATUS_LABEL,
  taskHolder,
  type Board,
  type BoardTask,
  type BoardView,
  type MeRow,
  type NeedKind,
} from "../../board";
import type { SessionKey } from "../../ids";
import { navigate, sessionPath } from "../../router";
import type { AppState, SessionRow } from "../../store";
import { orderSessions } from "../../sessionOrder";
import { showsAsEnded, type TaskPhase, type TaskStatus } from "../../wire";
import { AgentMark } from "../AgentIcons";
import { Button, Icon, MachineLabel, Skeleton, shortDuration } from "../bits";
import { currentTaskFilter, isFolderCollapsed, matching, setQuery, setTaskFilter, takeRows, toggleFolder, type FolderId, type ListView } from "../groups";
import { LAYER } from "../overlay";
import { openTask } from "./actions";
import { cardKey, dropRefused, laneItems, landsIn, useCardDrag, type DragItem } from "./cardDrag";
import { FlipBoundary } from "./Flip";
import { holderLabel } from "./Holder";
import { useRostersRead, useTaskDrop } from "./TaskDrop";
import { liveStatus, useBoard, useBoardWatch, useLiveTasks } from "./useBoard";

/** The board is every machine's at once: a machine is who does a task, never a page of the board (Q3.724). */
export function boardView(view: ListView): BoardView {
  return { machine: null, query: view.query, done: currentTaskFilter() === "all" ? "all" : "recent" };
}

/** Which task the open screen is: its own page, or the conversation working on it. */
export interface ActiveTask {
  session: SessionKey | null;
  task: { machineId: string; taskId: string } | null;
}

export function isActive(entry: BoardTask, active: ActiveTask): boolean {
  if (active.task !== null) return active.task.machineId === entry.machineId && active.task.taskId === entry.task.id;
  if (active.session === null) return false;
  return entry.task.sessions.some((session) => `${entry.machineId}/${session.id}` === active.session);
}

// A ringed fill waits on you, a fill works, a hollow one is its person's, a dashed one in the backlog.
const MARK: Record<Exclude<TaskStatus, "done">, string> = {
  needs_you: "bg-brand ring-[3px] ring-brand/25",
  running: "bg-fg text-fg animate-blink",
  review: "border border-edge-strong bg-transparent",
  ready: "border border-dashed border-edge-strong bg-transparent",
};

/** A working task's mark breathes as a working session's does, everywhere but on the board, where nothing moves (Q3.731, Q3.733). */
export function TaskMark({ status, still = false }: { status: TaskStatus; still?: boolean }): ReactNode {
  return (
    <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center" title={STATUS_LABEL[status]}>
      {status === "done" ? (
        <Icon as={Check} size={10} className="text-muted" />
      ) : (
        <span className={`inline-block h-2 w-2 rounded-full ${still && status === "running" ? "bg-fg" : MARK[status]}`} />
      )}
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

// The phase's own marks: what needs you is ringed, work is a fill, the daemon deciding or carrying is dashed, a wait hollow.
const PHASE_MARK: Record<TaskPhase, string> = {
  needs_you: "bg-brand ring-[3px] ring-brand/25",
  // `text-fg` beside the fill: the blink's ring is `currentColor`, as on a working session's dot (`StatusDot`).
  working: "bg-fg text-fg animate-blink",
  judging: "border border-dashed border-fg bg-transparent",
  moving: "border border-dashed border-fg bg-transparent",
  queued: "border border-dashed border-edge-strong bg-transparent",
  waiting: "border border-edge-strong bg-transparent",
};

/** A task's phase as a mark: a closed task's is a tick, and a working one blinks as a working session's dot does. `still` is a column's mark. */
export function PhaseMark({ phase, closed = false, still = false }: { phase: TaskPhase; closed?: boolean; still?: boolean }): ReactNode {
  const label = closed && phase === "waiting" ? "Done" : PHASE_LABEL[phase];
  return (
    <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center" title={label}>
      {closed && phase === "waiting" ? (
        <Icon as={Check} size={10} className="text-muted" />
      ) : (
        <span className={`inline-block h-2 w-2 rounded-full ${still && phase === "working" ? "bg-fg" : PHASE_MARK[phase]}`} />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** For the counter: tasks that wait on their person, and conversations no task holds that ask something. */
export function useBoardWaiting(state: AppState): number {
  return needingYou(useLiveTasks(state));
}

/** What a needing row says it waits on, in the row's own words; a daemon's reason, where it gave one, is drawn beside it. */
const NEED_TEXT: Record<NeedKind, string> = {
  question: "A question",
  stop: "Stopped without a report",
  failed: "The run failed",
  exits: "Choose where it goes",
  other: "Needs you",
};

/**
 * For you: the tasks its person has a part in, on every machine and in every column, as one list of lines (the owner's call,
 * 2026-10-15): what needs them first, then what they hold, each oldest first. A line opens the task (Q3.739).
 */
export function MeBody({ state, active, rows }: { state: AppState; active: ActiveTask; rows: number | null }): ReactNode {
  const { read, board: account } = useBoard();
  const tasks = useLiveTasks(state);
  useBoardWatch();
  const list = meTasks(tasks, account.board, liveStatus(state));
  const taken = rows === null ? list : list.slice(0, Math.max(0, rows));
  const asking = tasks.length === 0 && state.machines.some((machine) => machine.reach !== "offline" && !read.has(machine.id));

  return (
    <div>
      {taken.map((row) => (
        <MeLine key={cardKey(row.entry)} row={row} board={account.board} selected={isActive(row.entry, active)} />
      ))}
      {taken.length === 0 && asking && (
        <>
          <Skeleton rows={3} />
          <p role="status" className="sr-only">
            Loading tasks
          </p>
        </>
      )}
      {taken.length === 0 && !asking && (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-muted">Nothing waits on you.</p>
        </div>
      )}
    </div>
  );
}

function MeLine({ row, board, selected }: { row: MeRow; board: Board; selected: boolean }): ReactNode {
  const { entry, need } = row;
  const holder = cardHolder(entry, board);
  return (
    <div className={selected ? "bg-raised" : "hover:bg-raised/50"}>
      <button type="button" onClick={() => openTask(entry)} aria-current={selected ? "page" : undefined} className="tap block w-full text-left">
        <span className="flex min-w-0 items-center gap-2 py-3.5 pr-3 pl-3 lg:py-2.5">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <PhaseMark phase={entry.phase} closed={isFinal(board, entry.column)} />
              <span className={`min-w-0 truncate text-sm ${entry.phase === "needs_you" ? "font-semibold" : ""} ${entry.unavailable ? "text-muted" : ""}`}>
                {entry.task.title}
              </span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-[2em] pl-4.5 text-2xs text-muted">
              <span className="min-w-0 truncate">
                {columnTitle(board, entry.column)}
                {need !== null && <> · {NEED_TEXT[need]}</>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {holder.kind === "agent" && <AgentMark agent={holder.agent} />}
                <span>{holderLabel(holder)}</span>
              </span>
              <MachineLabel name={entry.machine} />
              {entry.unavailable && <span className="shrink-0 text-faint">unavailable</span>}
            </span>
          </span>
          <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums" title={new Date(row.since).toLocaleString()}>
            {shortDuration(Math.max(0, Date.now() - row.since))}
          </span>
        </span>
      </button>
    </div>
  );
}

/** One column of the board as a phone's page: its tasks as lines, each opening the conversation doing it, else its page (Q3.733). */
/** The intake and the closing columns start folded, as the backlog and done did (Q3.733). */
function foldedFirst(board: Board, column: string): boolean {
  return column === board.intake || isFinal(board, column);
}

function columnFolder(board: Board, column: string): FolderId {
  return (foldedFirst(board, column) ? `\u0000column:${column}:open` : `\u0000column:${column}`) as FolderId;
}

function folded(board: Board, column: string): boolean {
  const held = isFolderCollapsed(columnFolder(board, column));
  return foldedFirst(board, column) ? !held : held;
}

/**
 * The board's page of the list: every task by the board's columns, on the session list's own row budget (Q3.719,
 * Q3.740). A line opens the conversation doing it, and is dragged between groups as a card is between columns (Q3.733).
 */
export function TaskListBody({
  state,
  view,
  active,
  rows,
}: {
  state: AppState;
  view: ListView;
  active: ActiveTask;
  /** Cut to one screen on a neighbour's page and under a back swipe, as the session list is. */
  rows: number | null;
}): ReactNode {
  const { read, board: account } = useBoard();
  const board = account.board;
  const tasks = useLiveTasks(state);
  useBoardWatch();
  const [landed, setLanded] = useState<string | null>(null);
  const drops = useTaskDrop(state, setLanded);
  const drag = useCardDrag(drops.drop, SESSIONS_VIEW, "y");
  const { carried } = drag;
  const area = useCallback((node: HTMLElement | null) => {
    drag.boardRef(node);
    drops.areaRef(node);
  }, []);
  useRostersRead(state, carried !== null);
  const shown = boardView(view);
  const now = Date.now();
  const groups = taskGroups(tasks, shown, now, board);
  const any = groups.some((group) => group.tasks.length > 0);
  const left = { rows: rows ?? Number.POSITIVE_INFINITY };
  const searching = view.query.trim().length > 0;
  // Every group once any task is drawn, an empty one included, as the board draws every column: a line has somewhere to go.
  const drawn = groups.flatMap((group) => {
    if (!any || left.rows <= 0) return [];
    // A search opens every group, as it opens every folder.
    const collapsed = !searching && folded(board, group.column.id);
    // A heading costs a row of the page's budget whether or not its group is open.
    const taken = takeRows(collapsed ? [] : group.tasks, left, 1);
    const waiting = group.tasks.some((entry) => entry.phase === "needs_you");
    const cards = taken.map((entry) => ({ kind: "task" as const, entry }));
    return [{ column: group.column, collapsed, waiting, count: group.tasks.length, items: laneItems(group.column.id, cards, collapsed ? null : carried, board, SESSIONS_VIEW) }];
  });
  const order = drawn.map((one) => `${one.column.id}:${one.items.map((item) => `${item.kind[0]}${item.key}`).join(",")}`).join("|");
  const withheld = any ? 0 : taskGroups(tasks, { ...shown, done: "all" }, now, board).reduce((sum, group) => sum + group.tasks.length, 0);
  // Nothing held and nothing answered yet is a wait, never an empty board.
  const asking = tasks.length === 0 && state.machines.some((machine) => machine.reach !== "offline" && !read.has(machine.id));

  return (
    <>
      <div ref={area}>
        <FlipBoundary order={order} className={carried === null ? "" : "[&_[data-flip]]:pointer-events-none"}>
          {drawn.map((group) => {
            const target = carried !== null && carried.settling === null && landsIn(carried, SESSIONS_VIEW) === group.column.id;
            const refused = carried !== null && carried.settling === null && carried.over === group.column.id && dropRefused(SESSIONS_VIEW, group.column.id);
            return (
              <section
                key={group.column.id}
                ref={drag.laneRef(group.column.id)}
                aria-label={group.column.title}
                className={`transition-[background-color,opacity] duration-150 ${target ? "bg-brand/8" : ""} ${refused ? "opacity-45" : ""}`}
              >
                <h2 data-lane-head>
                  <button
                    type="button"
                    onClick={() => toggleFolder(columnFolder(board, group.column.id))}
                    aria-expanded={!group.collapsed}
                    className="tap flex min-h-9 w-full items-center gap-1.5 py-1.5 pr-2 pl-3 text-left hover:bg-raised"
                  >
                    <span className={`min-w-0 truncate text-xs ${target ? "font-semibold text-brand" : group.waiting ? "font-semibold text-fg" : "text-faint"}`}>
                      {group.column.title}
                    </span>
                    <span className="text-xs text-faint tabular-nums">{group.count}</span>
                    <span className={`shrink-0 text-muted transition-transform ${group.collapsed ? "" : "rotate-90"}`}>
                      <Icon as={ChevronRight} size={13} />
                    </span>
                  </button>
                </h2>
                {group.items.map((item) => (
                  <ListItem
                    key={`${item.kind}:${item.key}`}
                    item={item}
                    board={board}
                    selected={item.kind === "card" && item.card.kind === "task" && isActive(item.card.entry, active)}
                    landed={landed === item.key}
                    onLanded={() => setLanded(null)}
                    handlers={item.kind === "card" ? drag.bind(item.card, group.column.id, item.key, item.card.kind === "task" && item.card.entry.unavailable) : null}
                  />
                ))}
              </section>
            );
          })}
        </FlipBoundary>
      </div>

      {carried !== null &&
        carried.card.kind === "task" &&
        createPortal(
          <div
            ref={drag.previewRef}
            aria-hidden="true"
            className={`pointer-events-none fixed top-0 left-0 ${LAYER.overlay}`}
            style={{ width: carried.width, height: carried.height }}
          >
            <div className="animate-lift rounded-lg bg-surface opacity-95 shadow-md">
              <LineFace entry={carried.card.entry} board={board} />
            </div>
          </div>,
          document.body,
        )}

      {drops.menu}

      {drawn.length === 0 && asking && (
        <>
          <Skeleton rows={3} />
          <p role="status" className="sr-only">
            Loading tasks
          </p>
        </>
      )}

      {drawn.length === 0 && !asking && (
        <div className="px-4 py-6 text-center">
          {searching && tasks.length > 0 ? (
            <>
              <p className="text-sm text-muted">Nothing matches.</p>
              <Button className="mt-3" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </>
          ) : withheld > 0 ? (
            <>
              <p className="text-sm text-muted">
                {withheld === 1 ? "One task, closed more than a day ago." : `${withheld} tasks, all closed more than a day ago.`}
              </p>
              <Button className="mt-3" onClick={() => setTaskFilter("all")}>
                Show all
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">No tasks yet.</p>
              <p className="mx-auto mt-2 max-w-xs text-xs text-muted">New task, at the bottom of this list, adds one.</p>
            </>
          )}
        </div>
      )}
    </>
  );
}

function ListItem({
  item,
  board,
  selected,
  landed,
  onLanded,
  handlers,
}: {
  item: DragItem;
  board: Board;
  selected: boolean;
  landed: boolean;
  onLanded: () => void;
  handlers: ReturnType<ReturnType<typeof useCardDrag>["bind"]> | null;
}): ReactNode {
  if (item.card.kind !== "task") return null;
  const entry = item.card.entry;
  if (handlers === null) {
    // Where it was lifted from, or where it will land: the line itself, faded.
    return (
      <div data-flip={item.key} data-slot={item.key} className="pointer-events-none opacity-40">
        <LineFace entry={entry} board={board} />
      </div>
    );
  }
  // Straight to the conversation doing it; a task nobody has started opens its own page (Q3.733).
  const open = (): void => {
    const lead = leadRef(entry);
    if (lead === null) openTask(entry);
    else navigate(sessionPath(lead));
  };
  return (
    <div
      data-flip={cardKey(entry)}
      {...handlers}
      onAnimationEnd={landed ? onLanded : undefined}
      className={`relative select-none ${selected ? "bg-raised" : "hover:bg-raised/50"} ${landed ? "animate-landed-in" : ""}`}
    >
      <button type="button" onClick={open} aria-current={selected ? "page" : undefined} className="tap block w-full text-left">
        <LineFace entry={entry} board={board} />
      </button>
    </div>
  );
}

/** A task's line in the list: its phase and title with its age, then who holds it and, once somebody does, its machine (Q3.732). */
function LineFace({ entry, board }: { entry: BoardTask; board: Board }): ReactNode {
  const holder = taskHolder(entry.task, board);
  return (
    <span className="flex min-w-0 items-center gap-2 py-3.5 pr-3 pl-8 lg:py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <PhaseMark phase={entry.phase} closed={isFinal(board, entry.column)} />
          {/* A waiting task says so with its weight and its mark, in place, as a waiting session does. */}
          <span className={`min-w-0 truncate text-sm ${entry.phase === "needs_you" ? "font-semibold" : ""} ${entry.unavailable ? "text-muted" : ""}`}>
            {entry.task.title}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-[2em] text-2xs text-muted">
          <span className="flex shrink-0 items-center gap-1">
            {holder.kind === "agent" && <AgentMark agent={holder.agent} />}
            <span>{holder.kind === "agent" && holder.nickname !== null ? `@${holder.nickname}` : holderLabel(holder)}</span>
          </span>
          {holder.kind !== "nobody" && <MachineLabel name={entry.machine} />}
          {/* What its machine last said: nothing here can be pressed into being until it is back. */}
          {entry.unavailable && <span className="shrink-0 text-faint">unavailable</span>}
        </span>
      </span>
      {/* A fixed slot, as on a session's row: the age changes width as it grows. */}
      <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums" title={new Date(entry.task.createdAt).toLocaleString()}>
        {shortDuration(Math.max(0, Date.now() - entry.task.createdAt))}
      </span>
    </span>
  );
}

export function ColumnBody({
  state,
  column,
  view,
  active,
  rows,
}: {
  state: AppState;
  column: string;
  view: ListView;
  active: ActiveTask;
  rows: number | null;
}): ReactNode {
  const { read, board: account } = useBoard();
  const tasks = useLiveTasks(state);
  useBoardWatch();
  const shown = boardView(view);
  const now = Date.now();
  const all = tasks
    .filter((entry) => entry.column === column && (shown.machine === null || entry.machineId === shown.machine))
    .filter((entry) => !(shown.done === "recent" && isFinal(account.board, column) && now - entry.task.updatedAt > DONE_RECENT_MS))
    .filter((entry) => matchesTask(entry, view.query))
    .sort((a, b) => b.task.createdAt - a.task.createdAt || (a.task.id < b.task.id ? -1 : 1));
  const taken = rows === null ? all : all.slice(0, Math.max(0, rows));
  const asking = tasks.length === 0 && state.machines.some((machine) => machine.reach !== "offline" && !read.has(machine.id));
  return (
    <>
      {taken.map((entry) => (
        <TaskLine key={cardKey(entry)} entry={entry} board={account.board} selected={isActive(entry, active)} />
      ))}
      {taken.length === 0 && asking && <Skeleton rows={3} />}
      {taken.length === 0 && !asking && (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-muted">{view.query.trim().length > 0 ? "Nothing matches." : `Nothing in ${columnTitle(account.board, column)}.`}</p>
        </div>
      )}
    </>
  );
}

/** A task's line: its phase and title with its age, then who holds it and, once somebody does, the machine it is on (Q3.732). */
function TaskLine({ entry, board, selected }: { entry: BoardTask; board: Board; selected: boolean }): ReactNode {
  const holder = taskHolder(entry.task, board);
  // Straight to the conversation doing it; a task nobody has started opens its own page (Q3.733).
  const open = (): void => {
    const lead = leadRef(entry);
    if (lead === null) openTask(entry);
    else navigate(sessionPath(lead));
  };
  return (
    <div className={`relative select-none ${selected ? "bg-raised" : "hover:bg-raised/50"}`}>
      <button type="button" onClick={open} aria-current={selected ? "page" : undefined} className="tap block w-full text-left">
        <span className="flex min-w-0 items-center gap-2 py-3.5 pr-3 pl-3 lg:py-2.5">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <PhaseMark phase={entry.phase} closed={isFinal(board, entry.column)} />
              {/* A waiting task says so with its weight and its mark, in place, as a waiting session does. */}
              <span className={`min-w-0 truncate text-sm ${entry.phase === "needs_you" ? "font-semibold" : ""} ${entry.unavailable ? "text-muted" : ""}`}>
                {entry.task.title}
              </span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-[2em] pl-4.5 text-2xs text-muted">
              <span className="flex shrink-0 items-center gap-1">
                {holder.kind === "agent" && <AgentMark agent={holder.agent} />}
                <span>{holder.kind === "agent" && holder.nickname !== null ? `@${holder.nickname}` : holderLabel(holder)}</span>
              </span>
              {holder.kind !== "nobody" && <MachineLabel name={entry.machine} />}
              {/* What its machine last said: nothing here can be pressed into being until it is back. */}
              {entry.unavailable && <span className="shrink-0 text-faint">unavailable</span>}
            </span>
          </span>
          {/* A fixed slot, as on a session's row: the age changes width as it grows. */}
          <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums" title={new Date(entry.task.createdAt).toLocaleString()}>
            {shortDuration(Math.max(0, Date.now() - entry.task.createdAt))}
          </span>
        </span>
      </button>
    </div>
  );
}

/** Conversations no task holds, as a page or a lane: the needle and the machine filter applied, the ended ones after. */
export function chatRows(state: AppState, tasks: readonly BoardTask[], view: ListView): { live: SessionRow[]; ended: SessionRow[] } {
  const all = orderSessions(
    matching(
      chatsWithoutTask(state.sessions, tasks).filter((row) => view.machine === null || row.ref.machineId === view.machine),
      view.query,
    ),
  );
  return { live: all.filter((row) => !showsAsEnded(row.snapshot)), ended: all.filter((row) => showsAsEnded(row.snapshot)) };
}
