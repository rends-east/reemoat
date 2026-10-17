import { useState, type ReactNode } from "react";
import { columnById } from "@reemoat/board";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { navigate, sessionPath, taskPath, useUnder } from "../../router";
import type { AppState } from "../../store";
import { Button, FIELD, SHEET_FOOT, SHEET_SCREEN } from "../bits";
import { VERBATIM_FIELD } from "../composing";
import { BOARD, selectMachine } from "../groups";
import { Field } from "../kit/Field";
import { createTask, legacyTarget } from "./actions";
import { takingMachines, useRosters, type Assignee } from "./assignees";
import { ANOTHER_FOLDER, AssigneeDropdown, folderOn, ProjectDropdown } from "./Pickers";
import { AttachButton, PickedFiles, uploadPicked, usePickedFiles, type PickedFile } from "./TaskFiles";
import { useBoard } from "./useBoard";

// Module state, as New session's nickname is: the sheet unmounts when a finger drags it down, and the words must outlast that.
let titleDraft = "";
let briefDraft = "";
let filesDraft: readonly PickedFile[] = [];

/**
 * The form behind New task, in a tracker's order: what it is, who does it and where, then what to tell them. Nobody does it
 * until somebody is picked, and an agent picked here starts on it at once (Q3.722, Q3.725, Q3.727). Opened by a column's +, it
 * makes the task in that column: a column that works starts its run, every other adds it there whoever is picked (Q3.737).
 */
export function NewTask({ state, machineId: fromRoute, column: asked }: { state: AppState; machineId: MachineId | null; column: string | null }): ReactNode {
  const { tasks, supported, read, configured, board: account } = useBoard();
  const drawn = account.board;
  const at = asked === null ? null : columnById(drawn, asked);
  // A column the board no longer has, or a view of conversations, is New task's own.
  const column = at === null || at.kind === "view" ? null : at;
  const works = column?.kind === "work";
  const theirs = column !== null && column.kind === "wait" && (column.holder === "you" || column.final);
  const machines = takingMachines(state, supported, read).filter((machine) => machine.refused === null);
  // The machine the sheet was opened for, else this computer, else the first that can take a task.
  const preferred =
    machines.find((machine) => machine.id === fromRoute)?.id ??
    machines.find((machine) => machine.id === state.localMachineId)?.id ??
    machines[0]?.id ??
    null;
  const under = useUnder();
  // A column its person holds, or one that closes the task, starts as You.
  const [picked, setPicked] = useState<Assignee | "nobody" | "you">(theirs ? "you" : "nobody");
  const assignee = typeof picked === "string" ? null : picked;
  // A task no agent holds still lives on a machine: the one the sheet was opened for, else this computer, else the first that can take it.
  const machineId = assignee?.machineId ?? preferred;
  const offers = useRosters(machineId === null ? [] : [machineId]);
  const [project, setProject] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [title, setTitle] = useState(titleDraft);
  const [brief, setBrief] = useState(briefDraft);
  const [busy, setBusy] = useState<"files" | "add" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attached = usePickedFiles(filesDraft, (files) => {
    filesDraft = files;
  });

  const taskFolders = tasks.filter((entry) => entry.machineId === machineId).map((entry) => entry.task.cwd);
  const chosenProject = machineId === null ? "" : (project ?? folderOn(state, machineId, "", offers.get(machineId) ?? null, taskFolders));
  const cwd = chosenProject === ANOTHER_FOLDER || chosenProject.length === 0 ? typed.trim() : chosenProject;
  // What a later Start takes for a task no agent holds, and Running's + starts until another is picked: the machine's own
  // first agent, as New session would open on it.
  const fallback = machineId === null ? null : (offers.get(machineId)?.agents[0] ?? null);
  const runs = assignee ?? fallback;
  const flows = machineId !== null && configured.has(machineId);
  // A daemon that runs the board starts a work column's run by itself; an older one is started, as Running's + always was.
  const legacy = column === null ? null : legacyTarget(drawn, column.id);
  const start = flows ? column === null && assignee !== null : legacy === "running" || (column === null && assignee !== null);
  const ready = machineId !== null && cwd.length > 0 && brief.trim().length > 0 && (!(start || works) || runs !== null);

  const create = (): void => {
    if (busy !== null || machineId === null) return;
    setBusy(attached.files.length > 0 ? "files" : start || works ? "start" : "add");
    setError(null);
    // Sent to the machine the task is made on, at the press: picking another assignee before it moves nothing.
    void uploadPicked(machineId, attached.files, attached.progress)
      .then((attachments) => {
        setBusy(start || works ? "start" : "add");
        return createTask({
          machineId,
          ...(title.trim().length > 0 ? { title: title.trim() } : {}),
          brief,
          agent: runs === null ? "claude" : runs.kind === "custom" ? "" : runs.id,
          customAgent: runs?.kind === "custom" ? runs.id : null,
          assignee: start || works || assignee !== null ? "agent" : (picked as "nobody" | "you"),
          ...(column !== null && flows ? { column: column.id } : legacy === "review" || legacy === "done" ? { status: legacy } : {}),
          cwd,
          start,
          attachments,
        });
      })
      .then(({ task, session }) => {
        titleDraft = "";
        briefDraft = "";
        attached.clear();
        // The board it was added to is the page to land on: a start opens its conversation, and a column's + goes back to the column.
        selectMachine(BOARD);
        navigate(session !== null ? sessionPath(session) : column !== null ? under : taskPath(machineId, task.id), true);
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <div className={SHEET_SCREEN}>
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          if (files.length === 0) return;
          event.preventDefault();
          attached.add(files);
        }}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
      >
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
              value={works ? runs : picked}
              harness={(works ? runs : assignee)?.harness ?? null}
              onChange={(next) => {
                setPicked(next);
                // Another machine's folders are another list.
                if ((typeof next === "string" ? preferred : next.machineId) !== machineId) setProject(null);
              }}
              // A column that works is an agent at work, so its + names one.
              nobody={!works}
              you={!works}
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
              // Only when there are files: a text paste must fall through untouched.
              onPaste={(event) => {
                const files = [...(event.clipboardData?.files ?? [])];
                if (files.length === 0) return;
                event.preventDefault();
                attached.add(files);
              }}
              placeholder="What should be done, and what done looks like"
              // Not FIELD: that is a one-line box, and a vertical padding may not be composed onto it.
              className="min-h-32 flex-1 resize-none rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm leading-5 outline-none"
            />
          )}
        </Field>

        {/* The agent gets them with the task's first message, in every new conversation on it. */}
        <div className="flex flex-col gap-2">
          <PickedFiles files={attached.files} onRemove={attached.remove} busy={busy !== null} />
          <AttachButton onPick={attached.add} disabled={busy !== null} text="Attach files" />
        </div>
      </div>

      <div className={SHEET_FOOT}>
        <span role="status" aria-live="polite" className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}>
          {error !== null ? error : busy === "start" ? "this can take up to 45 seconds" : busy === "files" ? "sending the files…" : ""}
        </span>
        {/* One press: an agent picked on New task starts, as Running's + does; anything else is added. */}
        <Button tone="primary" disabled={!ready || busy !== null} onClick={create}>
          {busy === "files" ? "Sending files…" : busy === "start" ? "Starting the agent…" : busy === "add" ? "Adding…" : start || works ? "Start" : "Add"}
        </Button>
      </div>
    </div>
  );
}
