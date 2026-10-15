import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BoardColumn, BoardTask } from "../../board";
import { board } from "../../boardStore";
import { errorText } from "../../http";
import type { SessionRef } from "../../ids";
import type { AppState } from "../../store";
import { toast } from "../Toast";
import { assignTask, openStarted, setTaskStatus, startHere, type AssignTo } from "./actions";
import { AgentMenu } from "./AgentMenu";
import { heldRoster, loadRoster } from "./assignees";
import { cardKey } from "./cardDrag";
import { folderOn, type AssigneeChoice } from "./Pickers";
import { useLiveTasks } from "./useBoard";

/** Read when `now` turns true, a card lifting or the board opening, so a menu of agents is whole by the time it opens. */
export function useRostersRead(state: AppState, now: boolean): void {
  useEffect(() => {
    if (!now) return;
    for (const machine of state.machines) if (machine.reach === "online") loadRoster(machine.id);
  }, [now]);
}

export interface TaskDrop {
  /** A task let go in a column. */
  drop: (entry: BoardTask, from: BoardColumn, to: BoardColumn) => void;
  /** Hands a task to whoever was picked, with the folder it lands in where that is another machine; answers the conversation a start made. */
  assign: (entry: BoardTask, to: AssignTo) => Promise<SessionRef | null>;
  /** The agent menu a drop into Running opens, or null. */
  menu: ReactNode;
  /** The box the cards are in, set beside the drag's own: the list and the board draw one task twice, and the menu opens by this one's. */
  areaRef: (node: HTMLElement | null) => void;
}

/**
 * What a task let go in a column does, on the board and in the list alike (Q3.728, Q3.733): a status said at once, drawn
 * there until its daemon answers. Into Running the agent the backlog named starts, and otherwise one is asked for, the card
 * waiting in Running until it is picked; a cancel lets it slide back. A start opens its conversation (Q3.737). `onLanded`
 * marks where it went.
 */
export function useTaskDrop(state: AppState, onLanded: (key: string) => void): TaskDrop {
  const tasks = useLiveTasks(state);
  const [picking, setPicking] = useState<{ entry: BoardTask; release: () => void } | null>(null);
  const area = useRef<HTMLElement | null>(null);
  const areaRef = useCallback((node: HTMLElement | null) => void (area.current = node), []);
  const fail = (cause: unknown): void => toast("error", errorText(cause));

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

  const drop = (entry: BoardTask, from: BoardColumn, to: BoardColumn): void => {
    onLanded(cardKey(entry));
    if (to !== "running") {
      void setTaskStatus(entry, to).catch(fail);
      return;
    }
    if (from === "ready" && entry.task.assignee === "agent") {
      const where = window.location.pathname;
      void startHere(entry).then((session) => openStarted(session, where), fail);
      return;
    }
    setPicking({ entry, release: board.hold(entry.machineId, entry.task.id, { status: "running" }) });
  };

  let menu: ReactNode = null;
  if (picking !== null) {
    const { entry, release } = picking;
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
        anchor={() => area.current?.querySelector(`[data-flip="${CSS.escape(cardKey(entry))}"]:not([data-slot])`)?.getBoundingClientRect() ?? null}
        heading="Who does it"
        // Its conversations live on its machine, so once one exists the task stays there.
        only={entry.task.sessions.length > 0 ? entry.machineId : null}
        value={last}
        onPick={(agent) => {
          if (typeof agent === "string") return;
          setPicking(null);
          onLanded(cardKey(entry));
          const where = window.location.pathname;
          // Read as in Running, where it is drawn, so the pick starts it rather than only naming it.
          void assign({ ...entry, task: { ...entry.task, status: "running" } }, agent)
            .then((session) => openStarted(session, where))
            .finally(release);
        }}
        onCancel={close}
      />
    );
  }

  return { drop, assign, menu, areaRef };
}
