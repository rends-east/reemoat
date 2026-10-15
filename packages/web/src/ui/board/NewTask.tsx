import { useState, type ReactNode } from "react";
import type { BoardColumn } from "../../board";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { navigate, sessionPath, taskPath, useUnder } from "../../router";
import type { AppState } from "../../store";
import { Button, FIELD, SHEET_FOOT, SHEET_SCREEN } from "../bits";
import { VERBATIM_FIELD } from "../composing";
import { BOARD, selectMachine } from "../groups";
import { Field } from "../kit/Field";
import { createTask } from "./actions";
import { takingMachines, useRosters, type Assignee } from "./assignees";
import { ANOTHER_FOLDER, AssigneeDropdown, folderOn, ProjectDropdown } from "./Pickers";
import { useBoard } from "./useBoard";

// Module state, as New session's nickname is: the sheet unmounts when a finger drags it down, and the words must outlast that.
let titleDraft = "";
let briefDraft = "";

/**
 * The form behind New task, in a tracker's order: what it is, who does it and where, then what to tell them. Nobody does it
 * until somebody is picked, and an agent picked here starts on it at once (Q3.722, Q3.725, Q3.727). Opened by a column's +, it
 * makes the task in that column: Running's starts an agent, every other adds it there whoever is picked (Q3.737).
 */
export function NewTask({ state, machineId: fromRoute, column }: { state: AppState; machineId: MachineId | null; column: BoardColumn | null }): ReactNode {
  const { tasks, supported, read } = useBoard();
  const machines = takingMachines(state, supported, read).filter((machine) => machine.refused === null);
  // The machine the sheet was opened for, else this computer, else the first that can take a task.
  const preferred =
    machines.find((machine) => machine.id === fromRoute)?.id ??
    machines.find((machine) => machine.id === state.localMachineId)?.id ??
    machines[0]?.id ??
    null;
  const under = useUnder();
  // Review and done are their person's, so their + starts as You.
  const [picked, setPicked] = useState<Assignee | "nobody" | "you">(column === "review" || column === "done" ? "you" : "nobody");
  const assignee = typeof picked === "string" ? null : picked;
  // A task no agent holds still lives on a machine: the one the sheet was opened for, else this computer, else the first that can take it.
  const machineId = assignee?.machineId ?? preferred;
  const offers = useRosters(machineId === null ? [] : [machineId]);
  const [project, setProject] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [title, setTitle] = useState(titleDraft);
  const [brief, setBrief] = useState(briefDraft);
  const [busy, setBusy] = useState<"add" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const taskFolders = tasks.filter((entry) => entry.machineId === machineId).map((entry) => entry.task.cwd);
  const chosenProject = machineId === null ? "" : (project ?? folderOn(state, machineId, "", offers.get(machineId) ?? null, taskFolders));
  const cwd = chosenProject === ANOTHER_FOLDER || chosenProject.length === 0 ? typed.trim() : chosenProject;
  // What a later Start takes for a task no agent holds, and Running's + starts until another is picked: the machine's own
  // first agent, as New session would open on it.
  const fallback = machineId === null ? null : (offers.get(machineId)?.agents[0] ?? null);
  const runs = assignee ?? fallback;
  const start = column === "running" || (column === null && assignee !== null);
  const ready = machineId !== null && cwd.length > 0 && brief.trim().length > 0 && (!start || runs !== null);

  const create = (): void => {
    if (busy !== null || machineId === null) return;
    setBusy(start ? "start" : "add");
    setError(null);
    void createTask({
      machineId,
      ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      brief,
      agent: runs === null ? "claude" : runs.kind === "custom" ? "" : runs.id,
      customAgent: runs?.kind === "custom" ? runs.id : null,
      assignee: start || assignee !== null ? "agent" : (picked as "nobody" | "you"),
      ...(column === "review" || column === "done" ? { status: column } : {}),
      cwd,
      start,
    })
      .then(({ task, session }) => {
        titleDraft = "";
        briefDraft = "";
        // The board it was added to is the page to land on: a start opens its conversation, and a column's + goes back to the column.
        selectMachine(BOARD);
        navigate(session !== null ? sessionPath(session) : column !== null ? under : taskPath(machineId, task.id), true);
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <div className={SHEET_SCREEN}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
        <Field label="Title">
          {({ id, describedBy }) => (
            <input
              {...VERBATIM_FIELD}
              id={id}
              aria-describedby={describedBy}
              value={title}
              maxLength={120}
              onChange={(event) => {
                titleDraft = event.target.value;
                setTitle(event.target.value);
              }}
              placeholder="Named after its first line if left empty"
              className={FIELD}
            />
          )}
        </Field>

        <Field label="Assignee" hint={machines.length === 0 ? "No machine can take a task right now." : undefined}>
          {({ id, labelledBy, describedBy }) => (
            <AssigneeDropdown
              state={state}
              value={column === "running" ? runs : picked}
              harness={(column === "running" ? runs : assignee)?.harness ?? null}
              onChange={(next) => {
                setPicked(next);
                // Another machine's folders are another list.
                if ((typeof next === "string" ? preferred : next.machineId) !== machineId) setProject(null);
              }}
              // Running is an agent at work, so its + names one.
              nobody={column !== "running"}
              you={column !== "running"}
              shape={{ variant: "field", id, labelledBy, describedBy }}
            />
          )}
        </Field>

        {machineId !== null && (
          <Field label="Project">
            {({ id, labelledBy, describedBy }) => (
              <ProjectDropdown
                state={state}
                machineId={machineId}
                value={chosenProject.length === 0 ? ANOTHER_FOLDER : chosenProject}
                onChange={setProject}
                another
                shape={{ variant: "field", id, labelledBy, describedBy }}
              />
            )}
          </Field>
        )}

        {machineId !== null && (chosenProject === ANOTHER_FOLDER || chosenProject.length === 0) && (
          <Field label="Folder">
            {({ id, describedBy }) => (
              <input
                {...VERBATIM_FIELD}
                id={id}
                aria-describedby={describedBy}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="/path/to/project"
                className={`font-mono ${FIELD}`}
              />
            )}
          </Field>
        )}

        <Field label="Description" className="min-h-0 flex-1">
          {({ id, describedBy }) => (
            <textarea
              {...VERBATIM_FIELD}
              id={id}
              aria-describedby={describedBy}
              value={brief}
              onChange={(event) => {
                briefDraft = event.target.value;
                setBrief(event.target.value);
              }}
              placeholder="What should be done, and what done looks like"
              // Not FIELD: that is a one-line box, and a vertical padding may not be composed onto it.
              className="min-h-32 flex-1 resize-none rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm leading-5 outline-none"
            />
          )}
        </Field>
      </div>

      <div className={SHEET_FOOT}>
        <span role="status" aria-live="polite" className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}>
          {error !== null ? error : busy === "start" ? "this can take up to 45 seconds" : ""}
        </span>
        {/* One press: an agent picked on New task starts, as Running's + does; anything else is added. */}
        <Button tone="primary" disabled={!ready || busy !== null} onClick={create}>
          {busy === "start" ? "Starting the agent…" : busy === "add" ? "Adding…" : start ? "Start" : "Add"}
        </Button>
      </div>
    </div>
  );
}
