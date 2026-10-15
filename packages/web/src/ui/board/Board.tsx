import { Plus, SlidersHorizontal } from "lucide-react";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  cardHolder,
  exitsOf,
  flowColumns,
  isFinal,
  PHASE_LABEL,
  SESSIONS_VIEW,
  taskGroups,
  type Board as BoardConfig,
  type BoardTask,
  type Column,
  type TaskHolder,
} from "../../board";
import { boardConfigPath, navigate, newTaskInPath, newTaskPath, sessionPath } from "../../router";
import { elapsedSince, sessionGroups, type AppState, type SessionRow } from "../../store";
import { humanRequests, needsHuman } from "../../wire";
import { AgentMark } from "../AgentIcons";
import { Button, Icon, IconButton, MachineLabel, nicknameLine, sessionLabel, shortDuration, StatusDot } from "../bits";
import { currentView, groupsVersion, subscribeGroups } from "../groups";
import { LAYER } from "../overlay";
import { openStarted, openTask, type AssignTo } from "./actions";
import { AgentMenu } from "./AgentMenu";
import { heldRoster, useRosters } from "./assignees";
import { cardKey, dropRefused, laneItems, landsIn, useCardDrag, type DragCard, type DragItem } from "./cardDrag";
import { FlipBoundary } from "./Flip";
import { HolderAvatar } from "./Holder";
import { assignedLabel, assigneeChoiceOf } from "./Pickers";
import { useRostersRead, useTaskDrop } from "./TaskDrop";
import { boardView, MeBody, PhaseMark } from "./TaskList";
import { useBoard, useBoardWatch, useLiveTasks } from "./useBoard";

/** The name a card's holder goes by: its agent's, an assembled one's own where its machine was read; the machine is drawn under it. */
export function holderName(entry: BoardTask, holder: TaskHolder): string {
  if (holder.kind === "nobody") return "Not assigned";
  if (holder.kind === "you") return "You";
  const custom = holder.customAgent;
  return assignedLabel(
    { machineId: entry.machineId, kind: custom === null ? "harness" : "custom", id: custom ?? holder.agent, harness: holder.agent },
    heldRoster(entry.machineId),
  );
}

/** Which of the two the pane draws: the board, or what needs its person on every machine. Per device, never stored. */
let pane: "board" | "you" = "board";

/**
 * The account's board, every machine's tasks together, in the columns its YAML names (Q3.740); the conversations stay in
 * the list. A card is dragged between columns, which is a move from the column it was seen in (Q3.728). The columns keep
 * their width and the board scrolls sideways past the pane, and each makes a task in itself with its + (Q3.737).
 */
export function Board({ state }: { state: AppState }): ReactNode {
  const tasks = useLiveTasks(state);
  const { board: account, configured } = useBoard();
  const drawn = account.board;
  useBoardWatch();
  // The list's own needle and filters: one view, drawn twice.
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const view = currentView(sessionGroups(state));
  const groups = taskGroups(tasks, boardView(view), Date.now(), drawn);
  const columns = flowColumns(drawn);
  const viewId = SESSIONS_VIEW;
  const [shown, setShown] = useState(pane);
  const show = (next: "board" | "you"): void => {
    pane = next;
    setShown(next);
  };
  const [assigning, setAssigning] = useState<{ entry: BoardTask; anchor: HTMLElement } | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const me = state.me?.name ?? null;
  // An assembled agent is named by its machine's roster.
  useRosters([...new Set(tasks.filter((entry) => entry.task.customAgent !== null).map((entry) => entry.machineId))]);

  const drops = useTaskDrop(state, setLanded);
  const drag = useCardDrag(drops.drop, viewId);
  const { carried } = drag;
  const area = useCallback((node: HTMLElement | null) => {
    drag.boardRef(node);
    drops.areaRef(node);
  }, []);
  useRostersRead(state, true);
  useRostersRead(state, carried !== null);

  const lanes = columns.map((column) => {
    const lane = groups.find((group) => group.column.id === column.id)?.tasks ?? [];
    const cards: DragCard[] = lane.map((entry) => ({ kind: "task", entry }));
    return { column, count: lane.length, items: laneItems(column.id, cards, carried, drawn, viewId) };
  });
  const order = lanes.map((one) => `${one.column.id}:${one.items.map((item) => `${item.kind[0]}${item.key}`).join(",")}`).join("|");
  const writable = configured.size > 0;
  // Its conversation is drawn in no list, so a question from it is said here, on the one way in (Q3.743).
  const agentWaits = state.sessions.some((row) => row.snapshot.purpose === "board" && needsHuman(row.snapshot));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-5 pt-4 pb-3">
        <div role="tablist" aria-label="What this pane shows" className="flex items-center gap-1">
          {(
            [
              ["board", "Board"],
              ["you", "For you"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shown === id}
              onClick={() => show(id)}
              className={`tap inline-flex h-8 items-center rounded-full px-3 text-sm ${shown === id ? "bg-raised font-semibold text-fg" : "text-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto" />
        <Button size="sm" tone="ghost" onClick={() => navigate(boardConfigPath())}>
          <Icon as={SlidersHorizontal} size={14} />
          {writable ? "Edit board" : "Board settings"}
          {agentWaits && <span className="h-1.5 w-1.5 rounded-full bg-fg" title="The config agent is waiting for you" />}
        </Button>
        <Button size="sm" onClick={() => navigate(newTaskPath())}>
          <Icon as={Plus} size={14} />
          New task
        </Button>
      </div>
      {shown === "you" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <MeBody state={state} active={{ session: null, task: null }} rows={null} />
        </div>
      )}
      {/* Its own scroller on both axes, with no bar drawn (the owner's call, 2026-10-15): a long column must not move the others. */}
      <div ref={area} className={`no-scrollbar min-h-0 flex-1 overflow-x-auto px-5 pb-3 ${shown === "board" ? "flex" : "hidden"}`}>
        {/* While a card is carried the others take no pointer: none lights up under the copy, and the drag is followed on window. */}
        <FlipBoundary order={order} className={`flex min-h-0 shrink-0 gap-3 ${carried === null ? "" : "[&_[data-flip]]:pointer-events-none"}`}>
          {lanes.map(({ column, count, items }) => {
            const target = carried !== null && carried.settling === null && landsIn(carried, viewId) === column.id;
            const refused = carried !== null && carried.settling === null && dropRefused(viewId, column.id) && carried.from !== column.id;
            return (
              <section
                key={column.id}
                ref={drag.laneRef(column.id)}
                aria-label={column.title}
                // A lane of its own colour, as a tracker draws one; the one a card would land in takes the brand's, refused ones fade.
                className={`flex min-h-0 w-76 shrink-0 flex-col rounded-xl transition-[background-color,box-shadow,opacity] duration-150 ${
                  target ? "bg-brand/8 ring-2 ring-brand/35 ring-inset" : "bg-raised/60"
                } ${refused ? "opacity-45" : ""}`}
              >
                <h2 className="flex h-11 shrink-0 items-center gap-2 pr-1.5 pl-3">
                  <ColumnMark column={column} />
                  <span className={`truncate text-xs font-semibold ${target ? "text-brand" : "text-fg"}`}>{column.title}</span>
                  <span className="text-xs text-muted tabular-nums">{count}</span>
                  <IconButton
                    icon={Plus}
                    label={`New task in ${column.title}`}
                    onClick={() => navigate(newTaskInPath(column.id))}
                    size="nav"
                    className="ml-auto"
                  />
                </h2>
                {/* The top pad is the landed ring's: the first card's would be cut by this scroller's edge. */}
                <div data-lane-scroll className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-2">
                  {items.map((item) => (
                    <LaneItem
                      key={`${item.kind}:${item.key}`}
                      item={item}
                      column={column.id}
                      state={state}
                      board={drawn}
                      me={me}
                      landed={landed === item.key}
                      onLanded={() => setLanded(null)}
                      // A second press on the assignee whose menu is open closes it, as a dropdown's trigger does.
                      onAssignee={(entry, anchor) => setAssigning((open) => (open?.anchor === anchor ? null : { entry, anchor }))}
                      onExit={(entry, exit) => drops.move(entry, exit)}
                      handlers={item.kind === "card" ? drag.bind(item.card, column.id, item.key, item.card.kind === "task" && item.card.entry.unavailable) : null}
                    />
                  ))}
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
              <Face card={carried.card} state={state} board={drawn} me={me} />
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
          board={drawn}
          anchor={assigning.anchor}
          onPick={(to) => {
            const { entry } = assigning;
            const where = window.location.pathname;
            setAssigning(null);
            if (entry.column !== drawn.intake && !entry.configured) setLanded(cardKey(entry));
            void drops.assign(entry, to).then((session) => openStarted(session, where));
          }}
          onCancel={() => setAssigning(null)}
        />
      )}
    </div>
  );
}

/** A column's kind as its mark: the view of conversations a session's dot, work a fill, the intake dashed, a closing one a tick, any other wait hollow. */
function ColumnMark({ column }: { column: Column }): ReactNode {
  if (column.kind === "view") return <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-fg" />;
  if (column.kind === "work") return <PhaseMark phase="working" still />;
  return <PhaseMark phase="waiting" closed={column.final} />;
}

function LaneItem({
  item,
  column,
  state,
  board,
  me,
  landed,
  onLanded,
  onAssignee,
  onExit,
  handlers,
}: {
  item: DragItem;
  column: string;
  state: AppState;
  board: BoardConfig;
  me: string | null;
  landed: boolean;
  onLanded: () => void;
  onAssignee: (entry: BoardTask, anchor: HTMLElement) => void;
  onExit: (entry: BoardTask, exit: { exit: string; to: string }) => void;
  handlers: ReturnType<ReturnType<typeof useCardDrag>["bind"]> | null;
}): ReactNode {
  if (item.kind !== "card" || handlers === null) {
    // Where it was lifted from, or where it will land: the card itself, faded, so its size is the slot's.
    return (
      <div data-flip={item.key} data-slot={item.kind === "slot" ? item.key : undefined} className="pointer-events-none shrink-0 opacity-40">
        <Face card={item.card} state={state} board={board} me={me} holder={item.kind === "slot" ? item.holder : undefined} />
      </div>
    );
  }
  const { card } = item;
  if (card.kind === "chat") {
    return (
      <div data-flip={item.key} {...handlers} onAnimationEnd={landed ? onLanded : undefined} className={`group relative shrink-0 rounded-lg select-none ${landed ? "animate-landed" : ""}`}>
        <button type="button" onClick={() => navigate(sessionPath(card.row.ref))} aria-label={sessionLabel(card.row)} className="tap absolute inset-0 rounded-lg" />
        <ChatFace row={card.row} state={state} pressable />
      </div>
    );
  }
  const { entry } = card;
  const holder = cardHolder(entry, board);
  // Who does it is pressed in every column, never while an agent works: its conversation is where it is stopped.
  const assignable = !entry.unavailable && entry.phase !== "working";
  return (
    <div
      data-flip={cardKey(entry)}
      {...handlers}
      // The ring a landed card wears once, so the eye finds where it went.
      onAnimationEnd={landed ? onLanded : undefined}
      className={`group relative shrink-0 rounded-lg select-none ${landed ? "animate-landed" : ""}`}
    >
      {/* The card's press, under its face: a press on the assignee or an exit is that control's own. */}
      <button type="button" onClick={() => openTask(entry)} aria-label={entry.task.title} className="tap absolute inset-0 rounded-lg" />
      <CardFace
        entry={entry}
        board={board}
        me={me}
        holder={holder}
        column={column}
        onAssignee={assignable ? (anchor) => onAssignee(entry, anchor) : undefined}
        onExit={entry.unavailable ? undefined : (exit) => onExit(entry, exit)}
      />
    </div>
  );
}

function Face({ card, state, board, me, holder }: { card: DragCard; state: AppState; board: BoardConfig; me: string | null; holder?: TaskHolder }): ReactNode {
  return card.kind === "task" ? (
    <CardFace entry={card.entry} board={board} me={me} holder={holder ?? cardHolder(card.entry, board)} column={card.entry.column} />
  ) : (
    <ChatFace row={card.row} state={state} />
  );
}

/**
 * Who does a task, pressed on its card (Q3.732, Q3.736): in the intake who will do it, an agent or its person, which moves
 * nothing. Never while an agent works: its conversation is where it is stopped.
 */
function AssigneeMenu({
  state,
  entry,
  board,
  anchor,
  onPick,
  onCancel,
}: {
  state: AppState;
  entry: BoardTask;
  board: BoardConfig;
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
      value={assigneeChoiceOf(entry, board)}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

/** At most this many exits are buttons on a card; the rest are on the task's page. */
const CARD_EXITS = 2;

/**
 * A card at one size whatever it holds, laid out as the trackers lay theirs (Q3.731, Q3.732, Q3.737): the title on one line with
 * its age, the phase in words, or why it waits where its daemon said; then who holds it, the executor as `claude@mac`, with the
 * machine under, and the exits a person may press now on the right.
 */
function CardFace({
  entry,
  board,
  me,
  holder,
  column,
  onAssignee,
  onExit,
}: {
  entry: BoardTask;
  board: BoardConfig;
  me: string | null;
  holder: TaskHolder;
  column: string;
  /** Absent, the assignee is drawn and not pressed. */
  onAssignee?: (anchor: HTMLElement) => void;
  onExit?: (exit: { exit: string; to: string }) => void;
}): ReactNode {
  const { task } = entry;
  const name = holderName(entry, holder);
  const closed = isFinal(board, column);
  const reason = task.reason ?? null;
  const said = entry.phase !== "waiting" && reason !== null && reason.length > 0 ? reason : entry.phase === "waiting" ? null : PHASE_LABEL[entry.phase];
  const exits = exitsOf(task).slice(0, CARD_EXITS);
  // The machine is a caption of the holder, right under its name: only somebody holding the task makes it worth saying.
  // Pressable, it answers a pointer with a ring on the mark and a line under the name, never a box (the owner's call, 2026-10-15).
  const who = (
    <>
      <span className="inline-flex shrink-0 rounded-full transition-shadow group-hover/assignee:ring-2 group-hover/assignee:ring-edge-strong">
        <HolderAvatar holder={holder} me={me} />
      </span>
      <span className="flex min-w-0 flex-col items-start">
        <span
          className={`max-w-full truncate text-xs leading-4 decoration-edge-strong underline-offset-2 group-hover/assignee:text-fg group-hover/assignee:underline ${holder.kind === "nobody" ? "text-muted" : "text-fg"}`}
        >
          {name}
        </span>
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
      className="pointer-events-none relative flex h-28 w-full flex-col rounded-lg border border-edge bg-surface p-3 shadow-sm group-hover:border-edge-strong"
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className={`min-w-0 flex-1 truncate text-sm leading-5 font-medium ${entry.unavailable ? "text-muted" : ""}`}>{task.title}</span>
        <span className="shrink-0 text-2xs leading-5 text-muted tabular-nums" title={new Date(task.createdAt).toLocaleString()}>
          {shortDuration(Math.max(0, Date.now() - task.createdAt))}
        </span>
      </span>
      <span className="mt-1 flex min-h-4 min-w-0 items-center gap-1.5 text-2xs">
        {(said !== null || closed) && <PhaseMark phase={entry.phase} closed={closed} />}
        {said !== null && <span className={`min-w-0 truncate ${entry.phase === "needs_you" ? "font-semibold text-fg" : "text-muted"}`}>{said}</span>}
      </span>
      <span className="mt-auto flex min-w-0 items-end gap-2 text-2xs">
        {onAssignee === undefined ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">{who}</span>
        ) : (
          <span className="flex min-w-0 flex-1">
            <button
              type="button"
              aria-label={`Assignee: ${name}`}
              aria-haspopup="listbox"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => onAssignee(event.currentTarget)}
              className="group/assignee tap pointer-events-auto flex max-w-full min-w-0 items-center gap-1.5 text-left"
            >
              {who}
            </button>
          </span>
        )}
        {exits.length > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            {exits.map((exit) => (
              <button
                key={exit.name}
                type="button"
                disabled={onExit === undefined}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onExit?.({ exit: exit.name, to: exit.to })}
                className="tap pointer-events-auto max-w-24 truncate rounded-md border border-edge-strong bg-surface px-2 py-1 text-2xs font-medium text-fg hover:bg-raised disabled:text-faint"
              >
                {exit.label}
              </button>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

/** A conversation no task holds, as a card in the view of them: its dot and name with its age, then its address, harness and machine. */
function ChatFace({ row, state, pressable = false }: { row: SessionRow; state: AppState; pressable?: boolean }): ReactNode {
  const asks = humanRequests(row.snapshot).length > 0;
  const nickname = nicknameLine(row.snapshot);
  const at = row.snapshot.turnStartedAt ?? row.snapshot.lastEventAt ?? row.snapshot.createdAt;
  return (
    <span
      className={`pointer-events-none relative flex h-17 w-full flex-col rounded-lg border border-edge bg-surface px-3 py-2.5 shadow-sm ${pressable ? "group-hover:border-edge-strong" : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot session={row.snapshot} />
        <span className={`min-w-0 flex-1 truncate text-sm leading-5 ${asks ? "font-semibold" : ""}`}>
          {sessionLabel(row, state.rootsByMachine.get(row.ref.machineId) ?? [])}
        </span>
        <span className="shrink-0 text-2xs leading-5 text-muted tabular-nums">{shortDuration(elapsedSince(row, at))}</span>
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-[2em] text-2xs text-muted">
        {nickname !== null && <span className="shrink-0">{nickname}</span>}
        <AgentMark agent={row.snapshot.agent} />
        <MachineLabel name={row.machineName} />
      </span>
    </span>
  );
}
