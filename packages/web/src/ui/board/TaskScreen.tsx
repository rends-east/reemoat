import { ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { BOARD_COLUMNS, columnOf, leadSession, shownStatus, STATUS_LABEL, taskHolder, type BoardColumn, type BoardTask } from "../../board";
import { errorText } from "../../http";
import { keyOf, refOf, sessionId, type MachineId } from "../../ids";
import { screenAt } from "../../nav";
import { navigate, sessionPath, taskPath, useOrigin } from "../../router";
import type { AppState } from "../../store";
import { AgentMark } from "../AgentIcons";
import { Button, Dropdown, Icon, SETTINGS_HEADING, shortDuration, Spinner, StatusDot, TwoStep } from "../bits";
import { VERBATIM_FIELD } from "../composing";
import { BOARD, selectMachine } from "../groups";
import { Header } from "../Header";
import { Group, ValueRow } from "../kit/List";
import { toast } from "../Toast";
import { assignTask, changeTask, deleteTask, openStarted, setTaskStatus, startHere, startTask } from "./actions";
import { heldRoster, type Assignee } from "./assignees";
import { AssigneeDropdown, assigneeChoiceOf, folderOn, ProjectDropdown } from "./Pickers";
import { TaskMark } from "./TaskList";
import { useBoard, useBoardWatch, useLiveTasks } from "./useBoard";

/** A task's own page, laid out as a tracker's ticket: what was asked and what came of it, beside who does it and where (Q3.725). */
export function TaskScreen({ state, machineId, taskId }: { state: AppState; machineId: MachineId; taskId: string }): ReactNode {
  const { read } = useBoard();
  const tasks = useLiveTasks(state);
  useBoardWatch();
  const entry = tasks.find((one) => one.machineId === machineId && one.task.id === taskId) ?? null;
  const machine = state.machines.find((one) => one.id === machineId);
  // Opened from a conversation, the chevron goes back to it; from the board, to the board (Q3.736).
  const origin = useOrigin();
  const back = origin !== null && screenAt(origin) === "session" ? { to: origin, label: "Back to the conversation" } : null;

  if (entry === null) {
    // Not held and not yet asked is a wait; held nowhere after its machine answered is a task that is gone.
    const asking = machine !== undefined && machine.reach !== "offline" && !read.has(machineId);
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <Header title={<span className="sr-only">Task</span>} close board back={back} />
        {asking ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <p className="p-6 text-center text-sm text-muted">
            {machine === undefined
              ? "That machine is no longer granted to you."
              : machine.reach === "offline"
                ? `${machine.name} is not reachable right now.`
                : "That task is not on this machine any more."}
          </p>
        )}
      </div>
    );
  }

  return <TaskPage key={`${machineId}/${taskId}`} entry={entry} state={state} back={back} />;
}

function ago(at: number | null): string {
  if (at === null || at <= 0) return "";
  const said = shortDuration(Date.now() - at);
  return said === "<1m" ? "just now" : `${said} ago`;
}

type Busy = "start" | "status" | "assignee" | "project" | "title" | "brief" | null;

function TaskPage({ entry, state, back }: { entry: BoardTask; state: AppState; back: { to: string; label: string } | null }): ReactNode {
  const { task } = entry;
  const { tasks } = useBoard();
  // Already settled by its sessions and by a press still out: the entry is useLiveTasks'.
  const status = shownStatus(task.status);
  const working = status === "running" || status === "needs_you";
  const lead = leadSession(task);
  const started = task.sessions.length > 0;
  const [busy, setBusy] = useState<Busy>(null);
  const [deleting, setDeleting] = useState(false);
  const still = entry.unavailable || busy !== null;
  const act = (kind: Exclude<Busy, null>, run: () => Promise<void>): void => {
    if (busy !== null) return;
    setBusy(kind);
    void run()
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(null));
  };
  const openLead = (): void => {
    if (lead !== null) navigate(sessionPath(refOf(entry.machineId, sessionId(lead.id))));
  };

  const holder = taskHolder(task);
  const backlog = status === "ready";
  // In the backlog picking an agent names it and moves nothing; on a task its person holds it starts the agent, whose conversation opens (Q3.727, Q3.737).
  const reassign = (next: Assignee | "nobody" | "you"): void => {
    act("assignee", async () => {
      const where = window.location.pathname;
      const elsewhere = typeof next !== "string" && next.machineId !== entry.machineId;
      const folders = elsewhere ? tasks.filter((one) => one.machineId === next.machineId).map((one) => one.task.cwd) : [];
      const cwd = elsewhere ? folderOn(state, next.machineId, task.cwd, heldRoster(next.machineId), folders) : task.cwd;
      const landed = await assignTask(entry, next, cwd);
      if (landed.session !== null) openStarted(landed.session, where);
      else if (landed.machineId !== entry.machineId || landed.taskId !== task.id) navigate(taskPath(landed.machineId, landed.taskId), true);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <Header title={<span className="sr-only">Task</span>} close board back={back} />
      <div className="w-full px-4 pt-1 pb-10 lg:px-8">
        {/* One grid: on a phone the properties follow the title and its actions, at lg they are a column of their own. */}
        <div className="mx-auto grid w-full max-w-5xl gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
            <TitleField entry={entry} disabled={still} busy={busy === "title"} onSave={(title) => act("title", () => changeTask(entry, { title }))} />
            {entry.unavailable && <p className="text-xs text-muted">{entry.machine} is unavailable; this is what it last said.</p>}
            {/* Above the brief, which may run to pages: what can be done to a task is never under the fold. */}
            <div className="flex flex-wrap items-center gap-2">
              {backlog && holder.kind === "agent" && (
                // With the agent it was assigned; one nobody holds is assigned first, in the row beside.
                <Button tone="primary" size="sm" disabled={still} onClick={() => act("start", () => startTask(entry))}>
                  {busy === "start" ? (
                    "Starting the agent…"
                  ) : (
                    <>
                      <AgentMark agent={holder.agent} />
                      Start
                    </>
                  )}
                </Button>
              )}
              {started && (
                <Button tone={working ? "primary" : "plain"} size="sm" onClick={openLead}>
                  <Icon as={ArrowUpRight} size={14} />
                  Open conversation
                </Button>
              )}
              {status !== "done" && (
                <Button
                  tone={status === "review" ? "primary" : "plain"}
                  size="sm"
                  disabled={still}
                  onClick={() => act("status", () => setTaskStatus(entry, "done"))}
                >
                  Mark done
                </Button>
              )}
              {status === "done" && (
                <Button size="sm" disabled={still} onClick={() => act("status", () => setTaskStatus(entry, started ? "review" : "ready"))}>
                  Reopen
                </Button>
              )}
              {started && status === "review" && (
                <Button size="sm" disabled={still} onClick={() => act("start", () => startTask(entry))}>
                  {busy === "start" ? "Starting the agent…" : "Start another attempt"}
                </Button>
              )}
              <TwoStep
                armed={deleting}
                onArm={setDeleting}
                question={`Delete ${task.title}?`}
                consequence={started ? "Its conversations stay." : undefined}
                act={{ label: "Delete", danger: true, icon: Trash2 }}
                onAct={() =>
                  deleteTask(entry).then(() => {
                    selectMachine(BOARD);
                    navigate("/", true);
                  })
                }
                disabled={entry.unavailable}
                rest={
                  <Button size="sm" tone="ghost" disabled={still} onClick={() => setDeleting(true)}>
                    Delete
                  </Button>
                }
              />
            </div>
          </div>

          <div className="min-w-0 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <Group>
              <Dropdown
                variant="row"
                title="Status"
                items={BOARD_COLUMNS.map((one) => statusItem(one, working, task.assignee === "agent"))}
                value={columnOf(status)}
                onChange={(next) => {
                  const where = window.location.pathname;
                  // Into Running is a start of the agent it holds, as a card let go there is, and opens its conversation.
                  act("status", async () => (next === "running" ? openStarted(await startHere(entry), where) : setTaskStatus(entry, next)));
                }}
                disabled={still}
                busy={busy === "status"}
                trigger={
                  <>
                    <TaskMark status={status} />
                    <span>{STATUS_LABEL[columnOf(status)]}</span>
                    {status === "needs_you" && <span className="font-semibold text-fg">· needs you</span>}
                  </>
                }
              />
              <AssigneeDropdown
                state={state}
                value={assigneeChoiceOf(entry)}
                harness={holder.kind === "agent" ? holder.agent : task.agent}
                onChange={reassign}
                nobody
                you
                // Its conversations live on its machine, so once one exists the task stays there.
                only={started ? entry.machineId : null}
                // An agent is on it: its conversation is where it is stopped, and the task comes back once it is.
                disabled={still || working}
                busy={busy === "assignee"}
                shape={{ variant: "row", title: "Assignee", subline: working ? "while its agent works" : undefined }}
              />
              <ProjectDropdown
                state={state}
                machineId={entry.machineId}
                value={task.cwd}
                onChange={(cwd) => act("project", () => changeTask(entry, { cwd }))}
                disabled={still}
                busy={busy === "project"}
                shape={{ variant: "row", title: "Project" }}
              />
              <ValueRow title="Created" value={ago(task.createdAt)} />
              <ValueRow title="Updated" value={ago(task.updatedAt)} />
            </Group>
          </div>

          <div className="flex min-w-0 flex-col gap-8 lg:col-start-1 lg:row-start-2">
            <Brief entry={entry} disabled={still} busy={busy === "brief"} onSave={(brief) => act("brief", () => changeTask(entry, { brief }))} />
            {task.summary !== null && <Report entry={entry} />}
            <Activity entry={entry} state={state} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Running starts the agent the task holds, so a task no agent holds reaches it through its assignee; while one works only done may be said over it. */
function statusItem(
  column: BoardColumn,
  working: boolean,
  named: boolean,
): { value: BoardColumn; label: string; adornment: ReactNode; disabled?: boolean; description?: string } {
  const set = { value: column, label: STATUS_LABEL[column], adornment: <TaskMark status={column} still /> };
  if (column === "running" && !working && !named) return { ...set, disabled: true, description: "assign an agent first" };
  if (working && column !== "done" && column !== "running") return { ...set, disabled: true, description: "while its agent works" };
  return set;
}

function TitleField({
  entry,
  disabled,
  busy,
  onSave,
}: {
  entry: BoardTask;
  disabled: boolean;
  busy: boolean;
  onSave: (title: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const title = entry.task.title;
  if (draft === null) {
    return (
      <h2 className="min-w-0">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setDraft(title)}
          title="Rename this task"
          className="tap -mx-1 w-full rounded-md px-1 text-left text-lg font-semibold wrap-anywhere hover:bg-raised disabled:hover:bg-transparent"
        >
          {busy ? <Spinner /> : title}
        </button>
      </h2>
    );
  }
  const finish = (): void => {
    const next = draft.trim();
    setDraft(null);
    if (next.length > 0 && next !== title) onSave(next);
  };
  return (
    <input
      {...VERBATIM_FIELD}
      autoFocus
      aria-label="Task title"
      value={draft}
      maxLength={120}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish();
        if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(null);
        }
      }}
      className="-mx-1 w-full rounded-md border border-edge-strong bg-surface px-1 text-lg font-semibold outline-none"
    />
  );
}

function Brief({
  entry,
  disabled,
  busy,
  onSave,
}: {
  entry: BoardTask;
  disabled: boolean;
  busy: boolean;
  onSave: (brief: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const brief = entry.task.brief;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className={SETTINGS_HEADING}>Description</h3>
        {draft === null && (
          <Button size="sm" tone="ghost" disabled={disabled} onClick={() => setDraft(brief)} className="ml-auto">
            {busy ? <Spinner /> : <Icon as={Pencil} size={13} />}
            Edit
          </Button>
        )}
      </div>
      {draft === null ? (
        // A person's or a proposing agent's words, drawn as sent and never parsed; what the next start hands its agent.
        <p className="text-sm whitespace-pre-wrap wrap-anywhere">{brief}</p>
      ) : (
        <>
          <textarea
            {...VERBATIM_FIELD}
            autoFocus
            aria-label="Description"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-40 w-full resize-y rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm leading-5 outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              tone="primary"
              disabled={draft.trim().length === 0}
              onClick={() => {
                const next = draft;
                setDraft(null);
                if (next !== brief) onSave(next);
              }}
            >
              Save
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** What its agent last reported through task_update, or what a person wrote there, with who and when. */
function Report({ entry }: { entry: BoardTask }): ReactNode {
  const { task } = entry;
  const by = task.summaryBy === null ? null : (task.sessions.find((one) => one.id === task.summaryBy) ?? null);
  return (
    <section className="flex flex-col gap-2">
      <h3 className={SETTINGS_HEADING}>Latest report</h3>
      <div className="rounded-lg border border-edge px-3 py-2.5">
        <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
          {by !== null && <AgentMark agent={by.agent} />}
          <span className="min-w-0 truncate">{by !== null ? `@${by.nickname}` : task.summaryBy === null ? "You" : "An earlier conversation"}</span>
          {task.summaryAt !== null && <span className="shrink-0">· {ago(task.summaryAt)}</span>}
        </p>
        <p className="mt-1.5 text-sm whitespace-pre-wrap wrap-anywhere">{task.summary}</p>
      </div>
    </section>
  );
}

/** Every conversation the task has had, newest first, each one press from its transcript; then when it was made. */
function Activity({ entry, state }: { entry: BoardTask; state: AppState }): ReactNode {
  const { task } = entry;
  const sessions = [...task.sessions].sort((a, b) => b.attachedAt - a.attachedAt);
  return (
    <section className="flex flex-col gap-2">
      <h3 className={SETTINGS_HEADING}>Activity</h3>
      <ol className="flex flex-col">
        {sessions.map((one) => {
          const ref = refOf(entry.machineId, sessionId(one.id));
          const row = state.rowsByKey.get(keyOf(ref));
          return (
            <li key={one.id}>
              <button
                type="button"
                onClick={() => navigate(sessionPath(ref))}
                className="tap -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-raised"
              >
                <span className="flex w-4 shrink-0 justify-center">
                  {row === undefined ? <span className="h-2 w-2 rounded-full border border-edge-strong" /> : <StatusDot session={row.snapshot} />}
                </span>
                <AgentMark agent={one.agent} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  @{one.nickname}
                  <span className="text-muted"> worked on it · {(row?.snapshot.status ?? one.status).replace(/_/g, " ")}</span>
                </span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{ago(one.attachedAt)}</span>
                <Icon as={ArrowUpRight} size={14} className="shrink-0 text-faint" />
              </button>
            </li>
          );
        })}
        <li className="flex min-h-9 items-center gap-2.5 py-1.5 text-sm text-muted">
          <span className="flex w-4 shrink-0 justify-center">
            <span className="h-1.5 w-1.5 rounded-full bg-edge-strong" />
          </span>
          <span className="min-w-0 flex-1">Created</span>
          <span className="shrink-0 text-xs tabular-nums">{ago(task.createdAt)}</span>
        </li>
      </ol>
    </section>
  );
}
