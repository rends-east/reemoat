import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { columnTitle, placeAmong, type BoardTask } from "../../board";
import { board } from "../../boardStore";
import { errorText } from "../../http";
import type { SessionRef } from "../../ids";
import type { AppState } from "../../store";
import { sessionLabel } from "../bits";
import { folderPathOf } from "../groups";
import { toast } from "../Toast";
import {
  assignTask,
  legacyTarget,
  movedMeanwhile,
  moveTo,
  openStarted,
  placeTask,
  refusedWhileWorking,
  setTaskStatus,
  startHere,
  taskFromChat,
  type AssignTo,
  type MoveTo,
} from "./actions";
import { AgentMenu, ChoiceMenu } from "./AgentMenu";
import { heldRoster, loadRoster } from "./assignees";
import { cardKey, chatKey, type DragCard, type Slot } from "./cardDrag";
import { folderOn, type AssigneeChoice } from "./Pickers";
import { useBoard, useLiveTasks } from "./useBoard";

/** Read when `now` turns true, a card lifting or the board opening, so a menu of agents is whole by the time it opens. */
export function useRostersRead(state: AppState, now: boolean): void {
  useEffect(() => {
    if (!now) return;
    for (const machine of state.machines) if (machine.reach === "online") loadRoster(machine.id);
  }, [now]);
}

export interface TaskDrop {
  /** A card let go in a column, at a slot among its cards where it can be put among them. */
  drop: (card: DragCard, from: string, to: string, slot: Slot | null) => void;
  /** A move pressed on a card, an exit or a column: drawn at once, and asked again with a stop where its agent works. */
  move: (entry: BoardTask, target: MoveTo) => void;
  /** Hands a task to whoever was picked, with the folder it lands in where that is another machine; answers the conversation a start made. */
  assign: (entry: BoardTask, to: AssignTo) => Promise<SessionRef | null>;
  /** The agent menu a drop into an older daemon's work column opens, or the stop question; null when neither is open. */
  menu: ReactNode;
  /** The box the cards are in, set beside the drag's own: the menu opens by the card in this one. */
  areaRef: (node: HTMLElement | null) => void;
}

/**
 * What a card let go in a column does, on the board (Q3.728, Q3.733): a column said at once, drawn there until its daemon
 * answers. On a daemon that runs the board it is a move from the column it was seen in; one its agent is working on is
 * refused, and the card asks whether to stop the agent and move it. An older daemon's card takes the column's status: its
 * work column starts the agent the backlog named, or asks which. A conversation let go in a column becomes a task holding it.
 */
export function useTaskDrop(state: AppState, onLanded: (key: string) => void): TaskDrop {
  const tasks = useLiveTasks(state);
  const { board: account, configured, supported } = useBoard();
  const drawn = account.board;
  const [picking, setPicking] = useState<{ entry: BoardTask; column: string; release: () => void } | null>(null);
  const [stopping, setStopping] = useState<{ entry: BoardTask; target: MoveTo; release: () => void } | null>(null);
  const area = useRef<HTMLElement | null>(null);
  const areaRef = useCallback((node: HTMLElement | null) => void (area.current = node), []);
  const fail = (cause: unknown): void => toast("error", errorText(cause));
  const anchorOf = (key: string) => (): DOMRect | null =>
    area.current?.querySelector(`[data-flip="${CSS.escape(key)}"]:not([data-slot])`)?.getBoundingClientRect() ?? null;

  const assign = async (entry: BoardTask, to: AssignTo): Promise<SessionRef | null> => {
    const elsewhere = typeof to !== "string" && to.machineId !== entry.machineId;
    const folders = elsewhere ? tasks.filter((one) => one.machineId === to.machineId).map((one) => one.task.cwd) : [];
    const cwd = elsewhere ? folderOn(state, to.machineId, entry.task.cwd, heldRoster(to.machineId), folders) : entry.task.cwd;
    return await assignTask(entry, to, cwd).then(
      (landed) => landed.session,
      (cause: unknown) => {
        fail(cause);
        return null;
      },
    );
  };

  const move = (entry: BoardTask, target: MoveTo): void => {
    onLanded(cardKey(entry));
    void moveTo(entry, target).catch((cause: unknown) => {
      if (refusedWhileWorking(cause)) {
        // Held where it was let go while its person decides, so the card does not slide back and out again.
        setStopping({ entry, target, release: board.hold(entry.machineId, entry.task.id, { column: target.to }) });
        return;
      }
      if (movedMeanwhile(cause)) {
        toast("error", "That task moved on its own meanwhile; the board shows where it is now.");
        return;
      }
      fail(cause);
    });
  };

  const dropTask = (entry: BoardTask, to: string): void => {
    if (entry.configured) {
      move(entry, { to });
      return;
    }
    onLanded(cardKey(entry));
    const status = legacyTarget(drawn, to);
    if (status !== "running") {
      void setTaskStatus(entry, status).catch(fail);
      return;
    }
    if (entry.column === drawn.intake && entry.task.assignee === "agent") {
      const where = window.location.pathname;
      void startHere(entry, to).then((session) => openStarted(session, where), fail);
      return;
    }
    setPicking({ entry, column: to, release: board.hold(entry.machineId, entry.task.id, { column: to }) });
  };

  const dropChat = (card: Extract<DragCard, { kind: "chat" }>, to: string): void => {
    const { row } = card;
    if (!supported.has(row.ref.machineId)) {
      toast("error", `${row.machineName}'s daemon keeps no tasks. Update it, then try again.`);
      return;
    }
    onLanded(chatKey(row));
    void taskFromChat(
      { ref: row.ref, title: sessionLabel(row), agent: row.snapshot.agent, cwd: folderPathOf(row) || row.snapshot.workspace.requestedCwd },
      to,
      configured.has(row.ref.machineId),
    ).catch(fail);
  };

  // Its place among the cards it was let go between, written beside any move, each held apart until answered (Q2.278).
  const place = (entry: BoardTask, slot: Slot): void => {
    const byKey = new Map(tasks.map((one) => [cardKey(one), one]));
    const lane = slot.keys.flatMap((key) => byKey.get(key) ?? []);
    const writes = placeAmong(lane, slot.index, entry);
    if (writes.length > 0) onLanded(cardKey(entry));
    for (const write of writes) void placeTask(write.entry, write.rank).catch(fail);
  };

  const drop = (card: DragCard, from: string, to: string, slot: Slot | null): void => {
    if (card.kind === "task" && slot !== null) place(card.entry, slot);
    if (to === from) return;
    if (card.kind === "task") dropTask(card.entry, to);
    else dropChat(card, to);
  };

  let menu: ReactNode = null;
  if (stopping !== null) {
    const { entry, target, release } = stopping;
    const close = (): void => {
      release();
      setStopping(null);
    };
    menu = (
      <ChoiceMenu
        anchor={anchorOf(cardKey(entry))}
        heading="Its agent is working"
        choices={[
          {
            label: "Stop and move",
            description: `Stops the agent's turn, then moves it to ${columnTitle(drawn, target.to)}`,
            onPick: () => {
              setStopping(null);
              void moveTo(entry, target, true).catch(fail).finally(release);
            },
          },
          { label: "Leave it working", onPick: close },
        ]}
        onCancel={close}
      />
    );
  } else if (picking !== null) {
    const { entry, column, release } = picking;
    const close = (): void => {
      release();
      setPicking(null);
    };
    // The agent last on it leads the keys, where one was.
    const last: AssigneeChoice | null =
      entry.task.assignee === "agent"
        ? { machineId: entry.machineId, kind: entry.task.customAgent === null ? "harness" : "custom", id: entry.task.customAgent ?? entry.task.agent }
        : null;
    menu = (
      <AgentMenu
        state={state}
        anchor={anchorOf(cardKey(entry))}
        heading="Who does it"
        // Its conversations live on its machine, so once one exists the task stays there.
        only={entry.task.sessions.length > 0 ? entry.machineId : null}
        value={last}
        onPick={(agent) => {
          if (typeof agent === "string") return;
          setPicking(null);
          onLanded(cardKey(entry));
          const where = window.location.pathname;
          // Read as in that column, where it is drawn, so the pick starts it rather than only naming it.
          void assign({ ...entry, column, task: { ...entry.task, status: "running" } }, agent)
            .then((session) => openStarted(session, where))
            .finally(release);
        }}
        onCancel={close}
      />
    );
  }

  return { drop, move, assign, menu, areaRef };
}
