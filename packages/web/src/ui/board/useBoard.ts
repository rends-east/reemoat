import { useEffect, useMemo, useSyncExternalStore } from "react";
import { liveBoard, type BoardTask } from "../../board";
import { board, type BoardSnapshot } from "../../boardStore";
import { keyOf, refOf, sessionId } from "../../ids";
import type { AppState } from "../../store";

// Its own module, with nothing of the router's behind it: the transcript draws a proposals card, and webcheck imports the transcript with no address bar.

export function useBoard(): BoardSnapshot {
  return useSyncExternalStore(board.subscribe, board.getSnapshot);
}

/** Held by whatever draws a task, so it is read at the list's pace only while somebody is looking. */
export function useBoardWatch(drawn = true): void {
  useEffect(() => (drawn ? board.watch() : undefined), [drawn]);
}

/** The board as drawn: each status settled by what this client last heard of the task's sessions, then by a press still out (Q3.726, Q3.728). */
export function useLiveTasks(state: AppState): BoardTask[] {
  const { tasks, asked } = useBoard();
  return useMemo(
    () => liveBoard(tasks, (machineId, id) => state.rowsByKey.get(keyOf(refOf(machineId, sessionId(id))))?.snapshot.status ?? null, asked),
    [tasks, state.rowsByKey, asked],
  );
}
