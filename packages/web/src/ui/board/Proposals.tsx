import { useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { columnTitle, taskOfProposal, type BoardTask } from "../../board";
import { errorText, meansRouteAbsent } from "../../http";
import type { MachineId } from "../../ids";
import { store, type AppState } from "../../store";
import type { TaskProposal } from "../../wire";
import { Button } from "../bits";
import { MentionScope } from "../MentionLink";
import { heldRoster } from "./assignees";
import { AssigneeDropdown, folderOn, ProjectDropdown, type Assigned } from "./Pickers";
import { useBoard } from "./useBoard";

const TOO_OLD = "That machine's daemon is too old for tasks. Update it, then press again.";

/** A proposal as its person left it before pressing: who does it and in which folder, which the press sends instead. */
interface Edited {
  /** Null is nobody, which every row starts as: the task is added for somebody to take later (Q3.727). */
  assignee: PickedAgent | "you" | null;
  /** Where it lives while no agent holds it: the machine it was proposed for. */
  machineId: MachineId;
  project: string;
}

type PickedAgent = Assigned & { harness: string };

function pickedAgent(edited: Edited): PickedAgent | null {
  return edited.assignee === null || edited.assignee === "you" ? null : edited.assignee;
}

/**
 * What propose_tasks left in the conversation: one row per task, each created when its person presses and never before, on
 * the machine it was proposed for, unassigned unless an agent is picked, which then starts on it (Q3.725, Q3.727). A row is
 * settled by the board, so another device sees the same task as made (Q3.723).
 */
export function ProposalsCard({ proposals }: { proposals: readonly TaskProposal[] }): ReactNode {
  // The conversation's own machine: a proposal that names none is for it.
  const here = useContext(MentionScope).here as MachineId | null;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { tasks, configured } = useBoard();
  // Which press is out for a row: `true` is a start.
  const [busy, setBusy] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [edits, setEdits] = useState<ReadonlyMap<string, Edited>>(new Map());

  const editedOf = (proposal: TaskProposal): Edited | null => {
    const held = edits.get(proposal.id);
    if (held !== undefined) return held;
    const machineId = (proposal.machineId as MachineId | null) ?? here;
    if (machineId === null) return null;
    return { assignee: null, machineId, project: proposal.project };
  };

  // Nothing navigates on a press: the row says where the task went and offers it after.
  const create = (proposal: TaskProposal): Promise<void> => {
    const edited = editedOf(proposal);
    if (edited === null) return Promise.resolve();
    const { project } = edited;
    const agent = pickedAgent(edited);
    const machineId = agent?.machineId ?? edited.machineId;
    // A column the proposal names is the board's to run: a work column starts its run by itself, so nothing else starts it.
    const column = configured.has(machineId) && typeof proposal.column === "string" ? proposal.column : null;
    const start = agent !== null && column === null;
    setBusy((held) => new Map(held).set(proposal.id, start));
    setErrors((held) => {
      const next = new Map(held);
      next.delete(proposal.id);
      return next;
    });
    // On the press, never at load: the router reads the address bar when it is imported, and the transcript is drawn without one.
    return import("./actions")
      .then(async ({ createTask }) => {
        await createTask({
          machineId,
          title: proposal.title,
          brief: proposal.brief,
          // A task no agent holds keeps the agent its proposer named as what a start would launch (Q2.261, Q2.262); one left to a
          // column's role still names one, the machine's first.
          agent: agent === null ? (proposal.agent ?? heldRoster(machineId)?.agents[0]?.harness ?? "claude") : agent.kind === "custom" ? "" : agent.id,
          ...(column === null ? {} : { column }),
          customAgent: agent?.kind === "custom" ? agent.id : null,
          assignee: agent !== null ? "agent" : edited.assignee === "you" ? "you" : "nobody",
          cwd: project,
          // The proposal's own id: a press whose answer was lost, or one made on another device, finds the same task.
          key: proposal.id,
          start,
        });
      })
      .catch((cause: unknown) => {
        setErrors((held) => new Map(held).set(proposal.id, meansRouteAbsent(cause) ? TOO_OLD : errorText(cause)));
      })
      .finally(() => {
        setBusy((held) => {
          const next = new Map(held);
          next.delete(proposal.id);
          return next;
        });
      });
  };

  const waiting = proposals.filter((proposal) => taskOfProposal(tasks, proposal.id) === null);
  const all = (): void => {
    // One after another: two starts on one machine at once would race its session limit for nothing.
    void waiting.reduce((before, proposal) => before.then(() => create(proposal)), Promise.resolve());
  };

  return (
    <div className="flex flex-col gap-2">
      {proposals.map((proposal) => (
        <ProposalRow
          key={proposal.id}
          state={state}
          proposal={proposal}
          edited={editedOf(proposal)}
          onEdit={(next) => setEdits((held) => new Map(held).set(proposal.id, next))}
          made={taskOfProposal(tasks, proposal.id)}
          busy={busy.get(proposal.id) ?? null}
          error={errors.get(proposal.id) ?? null}
          onCreate={() => void create(proposal)}
        />
      ))}
      {waiting.length > 1 && (
        // Each row as its own press would: one no agent holds is added, one with an agent starts.
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" disabled={busy.size > 0} onClick={all}>
            Add all {waiting.length}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProposalRow({
  state,
  proposal,
  edited,
  onEdit,
  made,
  busy,
  error,
  onCreate,
}: {
  state: AppState;
  proposal: TaskProposal;
  edited: Edited | null;
  onEdit: (next: Edited) => void;
  made: BoardTask | null;
  /** Null at rest; else whether the press that is out was a start. */
  busy: boolean | null;
  error: string | null;
  onCreate: () => void;
}): ReactNode {
  const [whole, setWhole] = useState(false);
  const { tasks, board: account } = useBoard();
  const agent = edited === null ? null : pickedAgent(edited);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-raised/50 px-3 py-2.5">
      <p className="text-sm font-medium wrap-anywhere">{proposal.title}</p>
      {/* Its agent's whole first message, in the words it will be sent; a tap shows the rest of a long one. */}
      <button
        type="button"
        onClick={() => setWhole(!whole)}
        aria-expanded={whole}
        className={`tap text-left text-xs whitespace-pre-wrap text-fg/85 wrap-anywhere ${whole ? "" : "line-clamp-3"}`}
      >
        {proposal.brief}
      </button>
      {made === null && edited !== null && (
        // Who does it and where, as the agent proposed them until somebody changes either.
        <div className="grid gap-2 sm:grid-cols-2">
          <AssigneeDropdown
            state={state}
            value={edited.assignee ?? "nobody"}
            harness={agent?.harness ?? null}
            onChange={(next) => {
              if (next === "nobody" || next === "you") {
                // Back on the machine it was proposed for, in the folder proposed there.
                onEdit({ assignee: next === "you" ? "you" : null, machineId: edited.machineId, project: agent === null ? edited.project : proposal.project });
                return;
              }
              const before = agent?.machineId ?? edited.machineId;
              const folders = tasks.filter((entry) => entry.machineId === next.machineId).map((entry) => entry.task.cwd);
              onEdit({
                assignee: { machineId: next.machineId, kind: next.kind, id: next.id, harness: next.harness },
                machineId: edited.machineId,
                project:
                  next.machineId === before ? edited.project : folderOn(state, next.machineId, edited.project, heldRoster(next.machineId), folders),
              });
            }}
            nobody
            you
            disabled={busy !== null}
            shape={{ variant: "field" }}
          />
          <ProjectDropdown
            state={state}
            machineId={agent?.machineId ?? edited.machineId}
            value={edited.project}
            onChange={(project) => onEdit({ ...edited, project })}
            disabled={busy !== null}
            shape={{ variant: "field" }}
          />
        </div>
      )}
      <div className="flex min-h-9 flex-wrap items-center justify-end gap-2">
        <span role="status" className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}>
          {error ?? (made !== null ? `${columnTitle(account.board, made.column)} on the board` : busy === true ? "this can take up to 45 seconds" : "")}
        </span>
        {made !== null ? (
          <Button size="sm" onClick={() => void import("./actions").then(({ openTask }) => openTask(made))}>
            Open
          </Button>
        ) : (
          <Button size="sm" tone="primary" disabled={busy !== null || edited === null} onClick={onCreate}>
            {busy === true ? "Starting…" : busy === false ? "Adding…" : agent === null ? "Add" : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}
