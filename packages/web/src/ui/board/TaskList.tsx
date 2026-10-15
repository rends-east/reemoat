import { Check, ChevronRight } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BOARD_COLUMNS,
  leadRef,
  needingYou,
  shownStatus,
  STATUS_LABEL,
  taskGroups,
  taskHolder,
  type BoardColumn,
  type BoardTask,
  type BoardView,
  type TaskHolder,
} from "../../board";
import type { SessionKey } from "../../ids";
import { navigate, sessionPath } from "../../router";
import type { AppState } from "../../store";
import type { TaskStatus } from "../../wire";
import { AgentMark } from "../AgentIcons";
import { Button, Icon, MachineLabel, Skeleton, shortDuration } from "../bits";
import { currentTaskFilter, isFolderCollapsed, setQuery, setTaskFilter, takeRows, toggleFolder, type FolderId, type ListView } from "../groups";
import { LAYER } from "../overlay";
import { openTask } from "./actions";
import { cardKey, dropRefused, laneItems, landsIn, useCardDrag, type DragItem } from "./cardDrag";
import { FlipBoundary } from "./Flip";
import { holderLabel } from "./Holder";
import { useRostersRead, useTaskDrop } from "./TaskDrop";
import { useBoard, useBoardWatch, useLiveTasks } from "./useBoard";

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

function statusFolder(status: TaskStatus): FolderId {
  return `\u0000status:${status}` as FolderId;
}

// The backlog and done start folded, the groups between open: a folded-first group's id is the one held while it is open (Q3.733, Q3.737).
const FOLDED_FIRST: readonly BoardColumn[] = ["ready", "done"];

function openFolder(column: BoardColumn): FolderId {
  return `\u0000status:${column}:open` as FolderId;
}

function folded(column: BoardColumn): boolean {
  return FOLDED_FIRST.includes(column) ? !isFolderCollapsed(openFolder(column)) : isFolderCollapsed(statusFolder(column));
}

function fold(column: BoardColumn): void {
  toggleFolder(FOLDED_FIRST.includes(column) ? openFolder(column) : statusFolder(column));
}

/** For the board's tab: tasks waiting on their person. */
export function useBoardWaiting(state: AppState): number {
  return needingYou(useLiveTasks(state));
}

/**
 * The board's page of the list: every task by status, on the session list's own row budget (Q3.719). A line opens the
 * conversation doing it, and is dragged between groups as a card is between columns (Q3.733).
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
  const { read } = useBoard();
  const tasks = useLiveTasks(state);
  useBoardWatch();
  const [landed, setLanded] = useState<string | null>(null);
  const drops = useTaskDrop(state, setLanded);
  const drag = useCardDrag(drops.drop, "y");
  const { carried } = drag;
  const area = useCallback((node: HTMLElement | null) => {
    drag.boardRef(node);
    drops.areaRef(node);
  }, []);
  useRostersRead(state, carried !== null);
  const shown = boardView(view);
  const groups = taskGroups(tasks, shown, Date.now());
  const left = { rows: rows ?? Number.POSITIVE_INFINITY };
  const searching = view.query.trim().length > 0;
  // Every group once any task is drawn, an empty one included, as the board draws every column: a line has somewhere to go.
  const drawn = BOARD_COLUMNS.flatMap((column) => {
    const all = groups.find((group) => group.status === column)?.tasks ?? [];
    if (groups.length === 0 || left.rows <= 0) return [];
    // A search opens every group, as it opens every folder.
    const collapsed = !searching && folded(column);
    // A heading costs a row of the page's budget whether or not its group is open.
    const taken = takeRows(collapsed ? [] : all, left, 1);
    const waiting = all.some((entry) => shownStatus(entry.task.status) === "needs_you");
    return [{ column, collapsed, waiting, count: all.length, items: laneItems(column, taken, collapsed ? null : carried) }];
  });
  const order = drawn.map((one) => `${one.column}:${one.items.map((item) => `${item.kind[0]}${item.key}`).join(",")}`).join("|");
  const withheld = groups.length === 0 ? taskGroups(tasks, { ...shown, done: "all" }, Date.now()).reduce((sum, group) => sum + group.tasks.length, 0) : 0;
  // Nothing held and nothing answered yet is a wait, never an empty board.
  const asking = tasks.length === 0 && state.machines.some((machine) => machine.reach !== "offline" && !read.has(machine.id));

  return (
    <>
      <div ref={area}>
        <FlipBoundary order={order} className={carried === null ? "" : "[&_[data-flip]]:pointer-events-none"}>
          {drawn.map((group) => {
            const target = carried !== null && carried.settling === null && landsIn(carried) === group.column;
            const refused = carried !== null && carried.settling === null && dropRefused(carried.from, group.column);
            return (
              <section
                key={group.column}
                ref={drag.laneRef(group.column)}
                aria-label={STATUS_LABEL[group.column]}
                className={`transition-[background-color,opacity] duration-150 ${target ? "bg-brand/8" : ""} ${refused ? "opacity-45" : ""}`}
              >
                <h2 data-lane-head>
                  <button
                    type="button"
                    onClick={() => fold(group.column)}
                    aria-expanded={!group.collapsed}
                    className="tap flex min-h-9 w-full items-center gap-1.5 py-1.5 pr-2 pl-3 text-left hover:bg-raised"
                  >
                    <span
                      className={`min-w-0 truncate text-xs ${
                        target ? "font-semibold text-brand" : group.waiting ? "font-semibold text-fg" : "text-faint"
                      }`}
                    >
                      {STATUS_LABEL[group.column]}
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
                    selected={item.kind === "card" && isActive(item.entry, active)}
                    landed={landed === item.key}
                    onLanded={() => setLanded(null)}
                    handlers={item.kind === "card" ? drag.bind(item.entry, group.column, item.key) : null}
                  />
                ))}
              </section>
            );
          })}
        </FlipBoundary>
      </div>

      {carried !== null &&
        createPortal(
          <div
            ref={drag.previewRef}
            aria-hidden="true"
            className={`pointer-events-none fixed top-0 left-0 ${LAYER.overlay}`}
            style={{ width: carried.width, height: carried.height }}
          >
            <div className="animate-lift rounded-lg bg-surface opacity-95 shadow-md">
              <LineFace entry={carried.entry} />
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
                {withheld === 1 ? "One task, done more than a day ago." : `${withheld} tasks, all done more than a day ago.`}
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
  selected,
  landed,
  onLanded,
  handlers,
}: {
  item: DragItem;
  selected: boolean;
  landed: boolean;
  onLanded: () => void;
  handlers: ReturnType<ReturnType<typeof useCardDrag>["bind"]> | null;
}): ReactNode {
  const { entry } = item;
  if (handlers === null) {
    // Where it was lifted from, or where it will land: the line itself, faded.
    return (
      <div data-flip={item.key} data-slot={item.key} className="pointer-events-none opacity-40">
        <LineFace entry={entry} holder={item.kind === "slot" ? item.holder : undefined} />
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
        <LineFace entry={entry} />
      </button>
    </div>
  );
}

/** A task's line: its mark and title with its age, then who holds it and, once somebody does, the machine it is on (Q3.732). */
function LineFace({ entry, holder = taskHolder(entry.task) }: { entry: BoardTask; holder?: TaskHolder }): ReactNode {
  const status = shownStatus(entry.task.status);
  return (
    <span className="flex min-w-0 items-center gap-2 py-3.5 pr-3 pl-8 lg:py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <TaskMark status={status} />
          {/* A waiting task says so with its weight and its mark, in place, as a waiting session does. */}
          <span className={`min-w-0 truncate text-sm ${status === "needs_you" ? "font-semibold" : ""} ${entry.unavailable ? "text-muted" : ""}`}>
            {entry.task.title}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-[2em] text-2xs text-muted">
          <span className="flex shrink-0 items-center gap-1">
            {holder.kind === "agent" ? (
              <>
                <AgentMark agent={holder.agent} />
                <span>{holder.nickname !== null && holder.nickname.length > 0 ? `@${holder.nickname}` : holderLabel(holder)}</span>
              </>
            ) : (
              <span>{holderLabel(holder)}</span>
            )}
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
