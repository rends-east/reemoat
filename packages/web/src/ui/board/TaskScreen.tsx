import { ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  columnTitle,
  exitsOf,
  flowColumns,
  followTombstone,
  isFinal,
  leadSession,
  PHASE_LABEL,
  taskHolder,
  type Board,
  type BoardTask,
} from "../../board";
import { errorText } from "../../http";
import { keyOf, refOf, sessionId, type MachineId } from "../../ids";
import { screenAt } from "../../nav";
import { navigate, sessionPath, taskPath, useOrigin } from "../../router";
import type { AppState } from "../../store";
import type { TaskPhase } from "../../wire";
import { AgentMark } from "../AgentIcons";
import { Button, Dropdown, Icon, SETTINGS_HEADING, shortDuration, Spinner, StatusDot, TwoStep } from "../bits";
import { VERBATIM_FIELD } from "../composing";
import { BOARD, selectMachine } from "../groups";
import { Header } from "../Header";
import { DangerRow, Group, TWO_STEP_ROW, ValueRow } from "../kit/List";
import { toast } from "../Toast";
import {
  assignTask,
  changeTask,
  deleteTask,
  legacyTarget,
  movedMeanwhile,
  moveTo,
  openStarted,
  refusedWhileWorking,
  setTaskStatus,
  startHere,
  startTask,
  type MoveTo,
} from "./actions";
import { heldRoster, type Assignee } from "./assignees";
import { FeedComments, FeedHistory, TaskBlock, useTaskFeed } from "./Feed";
import { holderLabel } from "./Holder";
import { AssigneeDropdown, assigneeChoiceOf, folderOn, ProjectDropdown, type AssigneeChoice } from "./Pickers";
import { AttachButton, PickedFiles, TaskFileList, uploadPicked, usePickedFiles, type PickedFile } from "./TaskFiles";
import { useBoard, useBoardWatch, useLiveTasks } from "./useBoard";

/** A task's own page, laid out as a tracker's ticket: what was asked and what came of it, beside who does it and where (Q3.725). */
export function TaskScreen({ state, machineId, taskId }: { state: AppState; machineId: MachineId; taskId: string }): ReactNode {
  const { read, held } = useBoard();
  const tasks = useLiveTasks(state);
  useBoardWatch();
  const entry = tasks.find((one) => one.machineId === machineId && one.task.id === taskId) ?? null;
  const machine = state.machines.find((one) => one.id === machineId);
  // Opened from a conversation, the chevron goes back to it; from the board, to the board (Q3.736).
  const origin = useOrigin();
  const back = origin !== null && screenAt(origin) === "session" ? { to: origin, label: "Back to the conversation" } : null;
  // Gone from this machine to another (stage 6's handoff): its page there, in this one's place.
  const movedTo = entry === null ? followTombstone(held, machineId, taskId) : null;
  useEffect(() => {
    if (movedTo !== null && movedTo !== machineId) navigate(taskPath(movedTo, taskId), true);
  }, [movedTo, machineId, taskId]);

  if (entry === null) {
    // Not held and not yet asked is a wait; held nowhere after its machine answered is a task that is gone.
    const asking = movedTo !== null || (machine !== undefined && machine.reach !== "offline" && !read.has(machineId));
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

type Busy = "start" | "column" | "exit" | "assignee" | "project" | "title" | "brief" | null;

// A ringed fill waits on you, a blinking fill works, a hollow one waits; the board's own marks.
const PHASE_MARK: Record<TaskPhase, string> = {
  needs_you: "bg-brand ring-[3px] ring-brand/25",
  working: "bg-fg text-fg animate-blink",
  judging: "bg-fg/60",
  moving: "bg-fg/60",
  queued: "border border-dashed border-edge-strong bg-transparent",
  waiting: "border border-edge-strong bg-transparent",
};

function PhaseMark({ phase }: { phase: TaskPhase }): ReactNode {
  return (
    <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center" title={PHASE_LABEL[phase]}>
      <span className={`inline-block h-2 w-2 rounded-full ${PHASE_MARK[phase]}`} />
    </span>
  );
}

/** What a configured task holds for its next run with no role: its own agent, else its person or nobody; not who holds it now. */
function ownChoice(entry: BoardTask): AssigneeChoice {
  const { task } = entry;
  if (task.assignee !== "agent") return task.assignee;
  const custom = task.customAgent;
  return { machineId: entry.machineId, kind: custom === null ? "harness" : "custom", id: custom ?? task.agent };
}

/** A move a person asked for that its daemon refused while the agent works, held so Stop and move can send it again. */
type Refused = { target: MoveTo; title: string } | null;

function TaskPage({ entry, state, back }: { entry: BoardTask; state: AppState; back: { to: string; label: string } | null }): ReactNode {
  const { task } = entry;
  const { tasks, board: account } = useBoard();
  const drawn = account.board;
  const working = entry.phase === "working";
  const lead = leadSession(task);
  const started = task.sessions.length > 0;
  const final = isFinal(drawn, entry.column);
  const [busy, setBusy] = useState<Busy>(null);
  const [deleting, setDeleting] = useState(false);
  const feed = useTaskFeed(entry);
  const [refused, setRefused] = useState<Refused>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const still = entry.unavailable || busy !== null;
  const act = (kind: Exclude<Busy, null>, run: () => Promise<void>): void => {
    if (busy !== null) return;
    setBusy(kind);
    void run()
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(null));
  };
  // The files go to the task's machine first, then the words and their ids in one change (Q2.277).
  const saveBrief = (next: string | null, files: readonly PickedFile[], progress: (localId: string, fraction: number) => void): Promise<void> => {
    if (busy !== null) return Promise.reject(new Error("busy"));
    setBusy("brief");
    return uploadPicked(entry.machineId, files, progress)
      .then((attachments) => changeTask(entry, { ...(next === null ? {} : { brief: next }), ...(attachments.length === 0 ? {} : { attachments }) }))
      .catch((cause: unknown) => {
        toast("error", errorText(cause));
        throw cause;
      })
      .finally(() => setBusy(null));
  };
  const openLead = (): void => {
    if (lead !== null) navigate(sessionPath(refOf(entry.machineId, sessionId(lead.id))));
  };

  // A configured task is moved by its daemon, from the column it was seen in; a refusal while its agent works asks once more (spec: Stop and move).
  const move = (kind: "column" | "exit", target: MoveTo, stop = false): void => {
    setRefused(null);
    setPressed("exit" in target ? target.exit : null);
    act(kind, async () => {
      try {
        await moveTo(entry, target, stop);
      } catch (cause: unknown) {
        if (refusedWhileWorking(cause)) {
          setRefused({ target, title: columnTitle(drawn, target.to) });
          return;
        }
        if (movedMeanwhile(cause)) {
          toast("error", "It moved meanwhile; this is where it is now.");
          return;
        }
        throw cause;
      }
    });
  };

  // An older daemon is moved by its status: the intake, done, a start of the agent it holds, or its person's review.
  const moveLegacy = (column: string): void => {
    const where = window.location.pathname;
    const status = legacyTarget(drawn, column);
    act("column", async () => (status === "running" ? openStarted(await startHere(entry, column), where) : setTaskStatus(entry, status)));
  };

  const moveToColumn = (column: string): void => {
    if (column === entry.column) return;
    if (entry.configured) move("column", { to: column });
    else moveLegacy(column);
  };

  const holder = taskHolder(task, drawn);
  const intake = entry.column === drawn.intake;
  const named = task.assignee === "agent";
  // Picking who does it names the task's own agent and moves nothing on a configured board; an older one keeps its old rule (Q3.727, Q3.737).
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

  const exits = exitsOf(task);
  const failed = entry.configured && task.run?.state === "failed" && task.run.column === entry.column;
  const said = entry.phase === "needs_you" || entry.phase === "queued" || entry.phase === "waiting" ? (task.reason ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <Header title={<span className="sr-only">Task</span>} close board back={back} />
      <div className="w-full px-4 pt-1 pb-10 lg:px-8">
        {/* One grid: on a phone the properties follow the title and its actions, at lg they are a column of their own. */}
        <div className="mx-auto grid w-full max-w-5xl gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
            <TitleField entry={entry} disabled={still} busy={busy === "title"} onSave={(title) => act("title", () => changeTask(entry, { title }))} />
            {entry.unavailable && <p className="text-xs text-muted">{entry.machine} is unavailable; this is what it last said.</p>}
            {/* Where it stands and why, before anything can be pressed: a reason is the daemon's own sentence. */}
            <p className="flex min-w-0 items-start gap-2 text-xs">
              <span className="flex h-4 shrink-0 items-center">
                <PhaseMark phase={entry.phase} />
              </span>
              <span className={`min-w-0 wrap-anywhere ${entry.phase === "needs_you" ? "font-semibold text-fg" : "text-muted"}`}>
                {columnTitle(drawn, entry.column)} · {PHASE_LABEL[entry.phase]}
                {said !== null && said.length > 0 && <span className="font-normal text-muted"> · {said}</span>}
              </span>
            </p>
            {/* Above the brief, which may run to pages: what can be done to a task is never under the fold. */}
            <div className="flex flex-wrap items-center gap-2">
              {exits.map((exit) => (
                <Button key={exit.name} tone="primary" size="sm" disabled={still} onClick={() => move("exit", { exit: exit.name, to: exit.to })}>
                  {busy === "exit" && pressed === exit.name ? <Spinner /> : exit.label}
                </Button>
              ))}
              {failed && (
                <Button tone="primary" size="sm" disabled={still} onClick={() => move("column", { to: entry.column })}>
                  Retry
                </Button>
              )}
              {intake && holder.kind === "agent" && !working && (
                // With the agent it was assigned; one nobody holds is assigned first, in the row beside.
                <Button tone={exits.length === 0 ? "primary" : "plain"} size="sm" disabled={still} onClick={() => act("start", () => startTask(entry))}>
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
                <Button tone={working || entry.phase === "needs_you" ? "primary" : "plain"} size="sm" onClick={openLead}>
                  <Icon as={ArrowUpRight} size={14} />
                  Open conversation
                </Button>
              )}
              {final && (
                <Button size="sm" disabled={still} onClick={() => moveToColumn(entry.configured || !started ? drawn.intake : reviewColumn(drawn))}>
                  Reopen
                </Button>
              )}
            </div>
            {refused !== null && (
              // The daemon refused the move while the agent works: one more press stops its turn and moves it (spec: Stop and move).
              <TwoStep
                armed
                onArm={(next) => {
                  if (!next) setRefused(null);
                }}
                question={`The agent is working on it. Stop it and move the task to ${refused.title}?`}
                act={{ label: "Stop and move" }}
                onAct={() => {
                  const target = refused.target;
                  move("exit" in target ? "exit" : "column", target, true);
                }}
              />
            )}
          </div>

          <div className="min-w-0 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <Group>
              <Dropdown
                variant="row"
                title="Column"
                items={flowColumns(drawn).map((column) => columnItem(drawn, column.id, entry, named))}
                value={entry.column}
                onChange={moveToColumn}
                disabled={still}
                busy={busy === "column"}
                trigger={
                  <>
                    <PhaseMark phase={entry.phase} />
                    <span>{columnTitle(drawn, entry.column)}</span>
                    {entry.phase === "needs_you" && <span className="font-semibold text-fg">· needs you</span>}
                  </>
                }
              />
              {entry.configured && (
                <ValueRow
                  title="Holder"
                  value={holder.kind === "nobody" ? "Nobody" : holderLabel(holder)}
                />
              )}
              <AssigneeDropdown
                state={state}
                value={entry.configured ? ownChoice(entry) : assigneeChoiceOf(entry)}
                harness={holder.kind === "agent" && !entry.configured ? holder.agent : task.agent}
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
              {(task.labels ?? []).length > 0 && <ValueRow title="Labels" value={(task.labels ?? []).join(", ")} />}
              <ValueRow title="Created" value={ago(task.createdAt)} />
              <ValueRow title="Updated" value={ago(task.updatedAt)} />
            </Group>
            {/* The project's lone destructive row, under what it would destroy (Q3.738): its box as wide as its button. */}
            <Group fit>
              <TwoStep
                armed={deleting}
                onArm={setDeleting}
                align="end"
                className={deleting ? TWO_STEP_ROW : ""}
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
                rest={<DangerRow label="Delete task" icon={Trash2} whole disabled={still} onClick={() => setDeleting(true)} />}
              />
            </Group>
          </div>

          <div className="flex min-w-0 flex-col gap-8 lg:col-start-1 lg:row-start-2">
            <Brief entry={entry} disabled={still} busy={busy === "brief"} onSave={saveBrief} />
            <FeedHistory read={feed.read} />
            <Activity entry={entry} state={state} />
            <FeedComments read={feed.read} reload={feed.reload} entry={entry} state={state} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The column an older daemon's reopened task goes back to: its person's, where the board has one. */
function reviewColumn(drawn: Board): string {
  return flowColumns(drawn).find((column) => column.kind === "wait" && column.holder === "you" && !column.final)?.id ?? drawn.intake;
}

/**
 * Every column that holds tasks. A configured daemon weighs a move itself, so none is refused here: one it refuses while the
 * agent works is offered again as Stop and move. An older daemon's rules stay: a column that works starts the agent the task
 * holds, so a task no agent holds reaches it through its assignee, and while one works only a closing column may be said over it.
 */
function columnItem(
  drawn: Board,
  column: string,
  entry: BoardTask,
  named: boolean,
): { value: string; label: string; disabled?: boolean; description?: string } {
  const item = { value: column, label: columnTitle(drawn, column) };
  if (entry.configured) return item;
  const works = drawn.columns.find((one) => one.id === column)?.kind === "work";
  const busy = entry.phase === "working" || entry.phase === "needs_you";
  if (works && !busy && !named) return { ...item, disabled: true, description: "assign an agent first" };
  if (busy && !works && !isFinal(drawn, column)) return { ...item, disabled: true, description: "while its agent works" };
  return item;
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
  /** `null` where the words did not change; rejects on a refusal, which keeps the editor open with what was typed and picked. */
  onSave: (brief: string | null, files: readonly PickedFile[], progress: (localId: string, fraction: number) => void) => Promise<void>;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const picked = usePickedFiles();
  const brief = entry.task.brief;
  const save = (text: string): void => {
    const next = text === brief ? null : text;
    if (picked.files.length === 0) {
      setDraft(null);
      // The toast said why.
      if (next !== null) onSave(next, [], () => {}).catch(() => {});
      return;
    }
    onSave(next, picked.files, picked.progress).then(
      () => {
        picked.clear();
        setDraft(null);
      },
      // The toast said why; what was typed and picked stays.
      () => {},
    );
  };
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
        <p className="sel-root text-sm whitespace-pre-wrap wrap-anywhere select-text">{brief}</p>
      ) : (
        <div
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            picked.add(files);
          }}
          className="flex flex-col gap-2"
        >
          <textarea
            {...VERBATIM_FIELD}
            autoFocus
            aria-label="Description"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            // Only when there are files: a text paste must fall through untouched.
            onPaste={(event) => {
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length === 0) return;
              event.preventDefault();
              picked.add(files);
            }}
            className="min-h-40 w-full resize-y rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm leading-5 outline-none"
          />
          <PickedFiles files={picked.files} onRemove={picked.remove} busy={busy} />
          <div className="flex items-center gap-2">
            <AttachButton onPick={picked.add} disabled={busy} text="Attach files" />
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                picked.clear();
                setDraft(null);
              }}
              className="ml-auto"
            >
              Cancel
            </Button>
            <Button size="sm" tone="primary" disabled={busy || draft.trim().length === 0} onClick={() => save(draft)}>
              {busy && <Spinner />}
              Save
            </Button>
          </div>
        </div>
      )}
      {/* What it was made with; a comment's files are on the comment. */}
      <TaskFileList machineId={entry.machineId} taskId={entry.task.id} files={entry.task.files ?? []} />
    </section>
  );
}

/** Every conversation the task has had, newest first, each one press from its transcript; then when it was made. */
function Activity({ entry, state }: { entry: BoardTask; state: AppState }): ReactNode {
  const { task } = entry;
  const sessions = [...task.sessions].sort((a, b) => b.attachedAt - a.attachedAt);
  return (
    <TaskBlock title="Activity" count={sessions.length + 1}>
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
    </TaskBlock>
  );
}
