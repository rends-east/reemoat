import { ChevronRight } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { columnTitle, isFinal, PHASE_LABEL, taskOfSession, updatesTask } from "../../board";
import { board } from "../../boardStore";
import { keyOf, type SessionRef } from "../../ids";
import { navigate, taskPath } from "../../router";
import type { AppState } from "../../store";
import { COLUMN, Icon } from "../bits";
import { PhaseMark } from "./TaskList";
import { useBoard, useBoardWatch, useLiveTasks } from "./useBoard";

/**
 * The task this conversation is working on, above the conversation and outside its scroller: its status, what its agent last
 * reported, and the way to its page. Nothing for a conversation attached to no task.
 */
export function TaskBand({ state, sessionRef }: { state: AppState; sessionRef: SessionRef }): ReactNode {
  const tasks = useLiveTasks(state);
  const drawn = useBoard().board.board;
  const entry = taskOfSession(tasks, sessionRef);
  // At the list's pace while a task is drawn here, and at once when this conversation reports on it (Q3.726).
  useBoardWatch(entry !== null);
  const events = state.transcripts.get(keyOf(sessionRef))?.events;
  const seen = useRef<{ seq: number; calls: Set<string> }>({ seq: -1, calls: new Set() });
  useEffect(() => {
    if (events === undefined) return;
    const fresh = events.filter((one) => one.seq > seen.current.seq);
    if (fresh.length === 0) return;
    const first = seen.current.seq === -1;
    seen.current.seq = fresh[fresh.length - 1]?.seq ?? seen.current.seq;
    // A conversation opened on its history has nothing new to report: only what arrives while it is open moves the board.
    if (updatesTask(fresh, seen.current.calls) && !first) board.refresh(sessionRef.machineId);
  }, [events, sessionRef.machineId]);

  if (entry === null) return null;
  const closed = isFinal(drawn, entry.column);
  // The column, and the phase where it says more than that the task waits there.
  const where = entry.phase === "waiting" ? columnTitle(drawn, entry.column) : `${columnTitle(drawn, entry.column)}, ${PHASE_LABEL[entry.phase].toLowerCase()}`;
  return (
    <div className={`${COLUMN} shrink-0 px-4 pb-1`}>
      <button
        type="button"
        onClick={() => navigate(taskPath(entry.machineId, entry.task.id))}
        aria-label={`Task: ${entry.task.title}, ${where}`}
        title={entry.task.title}
        className="tap flex w-full items-start gap-2 rounded-lg bg-raised/50 px-3 py-2 text-left hover:bg-raised"
      >
        <span className="flex h-5 shrink-0 items-center">
          <PhaseMark phase={entry.phase} closed={closed} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs ${entry.phase === "needs_you" ? "font-semibold text-fg" : "text-muted"}`}>
            {where} · {entry.task.title}
          </span>
          {entry.task.summary !== null && <span className="line-clamp-2 text-xs whitespace-pre-wrap text-fg">{entry.task.summary}</span>}
        </span>
        <span className="flex h-5 shrink-0 items-center text-muted">
          <Icon as={ChevronRight} size={13} />
        </span>
      </button>
    </div>
  );
}
