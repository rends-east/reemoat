import { Plus } from "lucide-react";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BOARD_COLUMNS, columnOf, shownStatus, STATUS_LABEL, taskGroups, taskHolder, type BoardTask, type TaskHolder } from "../../board";
import { navigate, newTaskInPath, newTaskPath } from "../../router";
import { sessionGroups, type AppState } from "../../store";
import { Button, Icon, IconButton, MachineLabel, shortDuration } from "../bits";
import { currentView, groupsVersion, subscribeGroups } from "../groups";
import { LAYER } from "../overlay";
import { openStarted, openTask, type AssignTo } from "./actions";
import { AgentMenu } from "./AgentMenu";
import { heldRoster, useRosters } from "./assignees";
import { cardKey, dropRefused, laneItems, landsIn, useCardDrag } from "./cardDrag";
import { FlipBoundary } from "./Flip";
import { HolderAvatar } from "./Holder";
import { assignedLabel, assigneeChoiceOf } from "./Pickers";
import { useRostersRead, useTaskDrop } from "./TaskDrop";
import { boardView, TaskMark } from "./TaskList";
import { useBoardWatch, useLiveTasks } from "./useBoard";

/** The name a card's holder goes by: an assembled agent's own where its machine was read. */
export function holderName(entry: BoardTask, holder: TaskHolder): string {
  if (holder.kind === "nobody") return "Not assigned";
  if (holder.kind === "you") return "You";
  const custom = holder.customAgent;
  return assignedLabel(
    { machineId: entry.machineId, kind: custom === null ? "harness" : "custom", id: custom ?? holder.agent, harness: holder.agent },
    heldRoster(entry.machineId),
  );
}

/**
 * Every task as a column, every machine's together, in the pane a conversation would take (Q3.721, Q3.727). A card is dragged
 * between columns, which is a change of status: into Running it starts the agent it was assigned, or asks which (Q3.728). The
 * columns keep their width and the board scrolls sideways past the pane, and each makes a task in itself with its + (Q3.737).
 */
export function Board({ state }: { state: AppState }): ReactNode {
  const tasks = useLiveTasks(state);
  useBoardWatch();
  // The list's own needle and filter: one view, drawn twice.
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const view = currentView(sessionGroups(state));
  const groups = taskGroups(tasks, boardView(view), Date.now());
  const [assigning, setAssigning] = useState<{ entry: BoardTask; anchor: HTMLElement } | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const me = state.me?.name ?? null;
  // An assembled agent is named by its machine's roster.
  useRosters([...new Set(tasks.filter((entry) => entry.task.customAgent !== null).map((entry) => entry.machineId))]);

  const drops = useTaskDrop(state, setLanded);
  const drag = useCardDrag(drops.drop);
  const { carried } = drag;
  const area = useCallback((node: HTMLElement | null) => {
    drag.boardRef(node);
    drops.areaRef(node);
  }, []);
  useRostersRead(state, true);
  useRostersRead(state, carried !== null);

  const columns = BOARD_COLUMNS.map((column) => {
    const lane = groups.find((group) => group.status === column)?.tasks ?? [];
    return { column, count: lane.length, items: laneItems(column, lane, carried) };
  });
  const order = columns.map((one) => `${one.column}:${one.items.map((item) => `${item.kind[0]}${item.key}`).join(",")}`).join("|");


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-5 pt-4 pb-3">
        <h1 className="text-base font-semibold">Board</h1>
        <span className="ml-auto" />
        <Button size="sm" onClick={() => navigate(newTaskPath())}>
          <Icon as={Plus} size={14} />
          New task
        </Button>
      </div>
      {/* Its own scroller on both axes: four columns do not fit every pane, and a long column must not move the others. */}
      <div ref={area} className="board-scroll flex min-h-0 flex-1 overflow-x-auto px-5 pb-3">
        {/* While a card is carried the others take no pointer: none lights up under the copy, and the drag is followed on window. */}
        <FlipBoundary order={order} className={`flex min-h-0 shrink-0 gap-3 ${carried === null ? "" : "[&_[data-flip]]:pointer-events-none"}`}>
          {columns.map(({ column, count, items }) => {
            const target = carried !== null && carried.settling === null && landsIn(carried) === column;
            const refused = carried !== null && carried.settling === null && dropRefused(carried.from, column);
            return (
              <section
                key={column}
                ref={drag.laneRef(column)}
                aria-label={STATUS_LABEL[column]}
                // A lane of its own colour, as a tracker draws one; the one a card would land in takes the brand's, refused ones fade.
                className={`flex min-h-0 w-76 shrink-0 flex-col rounded-xl transition-[background-color,box-shadow,opacity] duration-150 ${
                  target ? "bg-brand/8 ring-2 ring-brand/35 ring-inset" : "bg-raised/60"
                } ${refused ? "opacity-45" : ""}`}
              >
                <h2 className="flex h-11 shrink-0 items-center gap-2 pr-1.5 pl-3">
                  <TaskMark status={column} still />
                  <span className={`text-xs font-semibold ${target ? "text-brand" : "text-fg"}`}>{STATUS_LABEL[column]}</span>
                  <span className="text-xs text-muted tabular-nums">{count}</span>
                  <IconButton
                    icon={Plus}
                    label={`New task in ${STATUS_LABEL[column]}`}
                    onClick={() => navigate(newTaskInPath(column))}
                    size="nav"
                    className="ml-auto"
                  />
                </h2>
                {/* The top pad is the landed ring's: the first card's would be cut by this scroller's edge. */}
                <div data-lane-scroll className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-2">
                  {items.map((item) =>
                    item.kind === "card" ? (
                      <BoardCard
                        key={item.key}
                        entry={item.entry}
                        me={me}
                        landed={landed === item.key}
                        onLanded={() => setLanded(null)}
                        // A second press on the assignee whose menu is open closes it, as a dropdown's trigger does.
                        onAssignee={(anchor) => setAssigning((open) => (open?.anchor === anchor ? null : { entry: item.entry, anchor }))}
                        handlers={drag.bind(item.entry, column, item.key)}
                      />
                    ) : (
                      // Where it was lifted from, or where it will land: the card itself, faded, so its size is the slot's.
                      <div key={`${item.kind}:${item.key}`} data-flip={item.key} data-slot={item.key} className="pointer-events-none shrink-0 opacity-40">
                        <CardFace entry={item.entry} me={me} holder={item.kind === "slot" ? item.holder : undefined} />
                      </div>
                    ),
                  )}
                </div>
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
            <div className="animate-lift rounded-lg opacity-95">
              <CardFace entry={carried.entry} me={me} />
            </div>
          </div>,
          document.body,
        )}

      {drops.menu}

      {assigning !== null && (
        <AssigneeMenu
          // Another card's press opens the menu over that card, which places itself once, on mount.
          key={cardKey(assigning.entry)}
          state={state}
          entry={assigning.entry}
          anchor={assigning.anchor}
          onPick={(to) => {
            const { entry } = assigning;
            const where = window.location.pathname;
            setAssigning(null);
            if (columnOf(shownStatus(entry.task.status)) !== "ready") setLanded(cardKey(entry));
            void drops.assign(entry, to).then((session) => openStarted(session, where));
          }}
          onCancel={() => setAssigning(null)}
        />
      )}
    </div>
  );
}

/**
 * A card's assignee, pressed (Q3.732, Q3.736): in the backlog who will do it, an agent or its person, which moves nothing; on a
 * task its person holds, nobody puts it back, and an agent starts on it. Never while an agent works: its conversation is where
 * it is stopped.
 */
function AssigneeMenu({
  state,
  entry,
  anchor,
  onPick,
  onCancel,
}: {
  state: AppState;
  entry: BoardTask;
  anchor: HTMLElement;
  onPick: (to: AssignTo) => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <AgentMenu
      state={state}
      anchor={() => (anchor.isConnected ? anchor.getBoundingClientRect() : null)}
      heading="Assignee"
      only={entry.task.sessions.length > 0 ? entry.machineId : null}
      nobody
      you
      value={assigneeChoiceOf(entry)}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

function BoardCard({
  entry,
  me,
  landed,
  onLanded,
  onAssignee,
  handlers,
}: {
  entry: BoardTask;
  me: string | null;
  landed: boolean;
  onLanded: () => void;
  onAssignee: (anchor: HTMLElement) => void;
  handlers: ReturnType<ReturnType<typeof useCardDrag>["bind"]>;
}): ReactNode {
  const working = columnOf(shownStatus(entry.task.status)) === "running";
  return (
    <div
      data-flip={cardKey(entry)}
      {...handlers}
      // The ring a landed card wears once, so the eye finds where it went.
      onAnimationEnd={landed ? onLanded : undefined}
      className={`group relative shrink-0 rounded-lg select-none ${landed ? "animate-landed" : ""}`}
    >
      {/* The card's press, under its face: a press on the assignee is the assignee's own. */}
      <button
        type="button"
        onClick={() => openTask(entry)}
        aria-label={entry.task.title}
        className="tap absolute inset-0 rounded-lg"
      />
      <CardFace entry={entry} me={me} onAssignee={working || entry.unavailable ? undefined : onAssignee} />
    </div>
  );
}

/**
 * A card at one size whatever it holds, laid out as the trackers lay theirs (Q3.731, Q3.732, Q3.737): the title on one line,
 * cut where the line ends, with its age beside it, then who holds it, and under them the machine it is on, which only an
 * assignee makes worth saying.
 */
function CardFace({
  entry,
  me,
  holder = taskHolder(entry.task),
  onAssignee,
}: {
  entry: BoardTask;
  me: string | null;
  holder?: TaskHolder;
  /** Absent, the assignee is drawn and not pressed. */
  onAssignee?: (anchor: HTMLElement) => void;
}): ReactNode {
  const { task } = entry;
  const name = holderName(entry, holder);
  // The machine is a caption of the assignee, right under its name: only somebody holding the task makes it worth saying.
  const who = (
    <>
      <HolderAvatar holder={holder} me={me} />
      <span className="flex min-w-0 flex-col items-start">
        <span className={`max-w-full truncate text-xs leading-4 ${holder.kind === "nobody" ? "text-muted" : "text-fg"}`}>{name}</span>
        {holder.kind !== "nobody" && (
          <span className="flex max-w-full min-w-0 items-center gap-1 leading-3 text-faint">
            <MachineLabel name={entry.machine} small />
            {entry.unavailable && <span className="shrink-0">unavailable</span>}
          </span>
        )}
      </span>
    </>
  );
  return (
    <span
      className={`pointer-events-none relative flex h-25 w-full flex-col rounded-lg border border-edge bg-surface p-3 shadow-sm ${
        onAssignee === undefined ? "" : "group-hover:border-edge-strong"
      }`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className={`min-w-0 flex-1 truncate text-sm leading-5 font-medium ${entry.unavailable ? "text-muted" : ""}`}>{task.title}</span>
        <span className="shrink-0 text-2xs leading-5 text-muted tabular-nums" title={new Date(task.createdAt).toLocaleString()}>
          {shortDuration(Math.max(0, Date.now() - task.createdAt))}
        </span>
      </span>
      <span className="mt-auto flex min-w-0 text-2xs">
        {onAssignee === undefined ? (
          <span className="flex max-w-full min-w-0 items-center gap-1.5">{who}</span>
        ) : (
          <button
            type="button"
            aria-label={`Assignee: ${name}`}
            aria-haspopup="listbox"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onAssignee(event.currentTarget)}
            className="tap pointer-events-auto -mx-1 -my-0.5 flex max-w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-raised"
          >
            {who}
          </button>
        )}
      </span>
    </span>
  );
}
