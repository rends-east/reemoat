import { columnById, columnForStatus } from "@reemoat/board";
import { isFinal, shownStatus, taskKey, type AskedAssignee, type Board, type BoardTask } from "../../board";
import { board } from "../../boardStore";
import type { TaskChangeBody } from "../../daemon";
import { ApiError, errorText } from "../../http";
import { refOf, sessionId, type MachineId, type SessionRef } from "../../ids";
import { navigate, sessionPath, taskPath } from "../../router";
import { machinesAsDrawn, store } from "../../store";
import type { SessionSnapshot, TaskAssignee, TaskCommentView, TaskFeed, TaskSnapshot, TaskStatus } from "../../wire";
import { toast } from "../Toast";

const NOT_CONNECTED = "That machine is not connected right now.";

function drawnBoard(): Board {
  return board.getSnapshot().board.board;
}

export interface NewTaskInput {
  machineId: MachineId;
  title?: string;
  brief: string;
  agent: string;
  customAgent?: string | null;
  /** Nobody or its person makes a task no agent holds; `agent` is then only what a later start would launch. */
  assignee?: TaskAssignee;
  /** The column it is made in on an older daemon, where that is not the backlog; never with `start` (Q3.737). */
  status?: "review" | "done";
  /** The column it is made in on a daemon that runs the board; into a work column its run starts by itself. */
  column?: string;
  labels?: string[];
  cwd: string;
  /** A proposal's id, or one minted for this form: the same key sent again makes no second task. */
  key?: string;
  start: boolean;
  /** Files already staged on that machine (`uploadPicked`). */
  attachments?: string[];
}

/** Rejects with what the daemon said, for the form or the card to draw; the caller decides where to go next. */
export async function createTask(input: NewTaskInput): Promise<{ task: TaskSnapshot; session: SessionRef | null }> {
  const daemon = store.daemonFor(input.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const answer = await daemon.createTask({
    ...(input.title === undefined ? {} : { title: input.title }),
    brief: input.brief,
    agent: input.agent,
    ...(input.customAgent === undefined || input.customAgent === null ? {} : { customAgent: input.customAgent }),
    ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.column === undefined ? {} : { column: input.column }),
    ...(input.labels === undefined || input.labels.length === 0 ? {} : { labels: input.labels }),
    cwd: input.cwd,
    key: input.key ?? taskKey(),
    start: input.start,
    ...(input.attachments === undefined || input.attachments.length === 0 ? {} : { attachments: input.attachments }),
  });
  return landed(input.machineId, answer);
}

/** A first start or another attempt with the agent the task holds, then straight to the conversation it made. */
export async function startTask(entry: BoardTask): Promise<void> {
  const session = await startOn(entry, {});
  if (session !== null) navigate(sessionPath(session));
}

/** The agent a task holds starts on it, drawn in the first work column at once; answers the conversation it made (Q3.732). */
export async function startHere(entry: BoardTask, column: string): Promise<SessionRef | null> {
  const release = board.hold(entry.machineId, entry.task.id, { column });
  try {
    return await startOn(entry, {});
  } finally {
    release();
  }
}

/** A start pressed on the board or a task's page opens the conversation it made, unless its person has gone elsewhere since (Q3.737). */
export function openStarted(session: SessionRef | null, from: string): void {
  if (session !== null && window.location.pathname === from) navigate(sessionPath(session));
}

/** Answers the conversation a start made, the one a start that timed out still made included. */
async function startOn(entry: BoardTask, body: { agent?: string; customAgent?: string | null; cwd?: string }): Promise<SessionRef | null> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  try {
    return landed(entry.machineId, await daemon.startTask(entry.task.id, body)).session;
  } catch (cause: unknown) {
    const made = startedAnyway(entry.machineId, cause);
    if (made === null) throw cause;
    board.refresh(entry.machineId);
    return made;
  }
}

/** Where a person moves a task: a column of the board, or one of the exits its card offers. */
export type MoveTo = { to: string } | { exit: string; to: string };

/**
 * A person's move on a daemon that runs the board: from the column they saw it in, drawn there at once until the answer
 * (Q3.728). `stop` stops the agent's turn first, the answer to `409 task_working`. Rejects with the daemon's refusal: the
 * caller offers Stop and move on `task_working`, and reads the board again on `task_moved`.
 */
export async function moveTo(entry: BoardTask, target: MoveTo, stop = false): Promise<void> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const release = board.hold(entry.machineId, entry.task.id, { column: target.to });
  try {
    const from = entry.task.column ?? entry.column;
    const body = "exit" in target ? { exit: target.exit, from } : { to: target.to, from };
    board.apply(entry.machineId, (await daemon.moveTask(entry.task.id, stop ? { ...body, stop: true } : body)).task);
  } catch (cause: unknown) {
    if (ApiError.isApiError(cause) && cause.code === "task_moved") board.refresh(entry.machineId);
    throw cause;
  } finally {
    release();
  }
}

/** A card put among the others of its column: drawn there at once, until its daemon answers with the place (Q2.278). */
export async function placeTask(entry: BoardTask, rank: number): Promise<void> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const release = board.place(entry.machineId, entry.task.id, rank);
  try {
    board.apply(entry.machineId, (await daemon.changeTask(entry.task.id, { rank })).task);
  } finally {
    release();
  }
}

/** The refusal a move answers while the task's agent works: its person may stop the agent and move it. */
export function refusedWhileWorking(cause: unknown): boolean {
  return ApiError.isApiError(cause) && cause.code === "task_working";
}

/** The task moved on its own between what was drawn and the press: nothing happened, and the board is read again. */
export function movedMeanwhile(cause: unknown): boolean {
  return ApiError.isApiError(cause) && cause.code === "task_moved";
}

/**
 * The status an older daemon takes for a column of the drawn board: its intake is the backlog, a final column done, a work
 * column a start, any other its person's review.
 */
export function legacyTarget(drawn: Board, column: string): Exclude<TaskStatus, "needs_you"> {
  if (column === drawn.intake) return "ready";
  if (isFinal(drawn, column)) return "done";
  return columnById(drawn, column)?.kind === "work" ? "running" : "review";
}

/** A person's word on a task's feed: into the run's conversation while one works, else into the next run's note. */
export async function addComment(entry: Pick<BoardTask, "machineId" | "task">, text: string, attachments: readonly string[] = []): Promise<TaskCommentView> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const { comment } = await daemon.addTaskComment(entry.task.id, text, attachments);
  board.refresh(entry.machineId);
  return comment;
}

export async function readFeed(entry: Pick<BoardTask, "machineId" | "task">): Promise<TaskFeed> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  return await daemon.taskFeed(entry.task.id);
}

/** `harness` draws an assembled agent's glyph before its daemon answers. */
export type AssignTo = "nobody" | "you" | { machineId: MachineId; kind: "harness" | "custom"; id: string; harness?: string };

/** Where a task lives after an assignment, and the conversation it started, if it started one. */
export interface Assigned {
  machineId: MachineId;
  taskId: string;
  session: SessionRef | null;
}

/**
 * Hands a task to whoever was picked (Q3.727, Q3.732, Q3.736). In the intake that names who will do it, an agent or its
 * person, and moves nothing; so does every pick on a daemon that runs the board, where the column says who holds it and a
 * person moves it. On an older daemon anywhere else nobody puts it back in the backlog, its person takes it for review, and
 * an agent starts on it at once. Drawn as it is going to be until its daemon answers, on the machine it is going to (Q3.728).
 * An agent on another machine moves a task nobody has started there.
 */
export async function assignTask(entry: BoardTask, to: AssignTo, cwd: string): Promise<Assigned> {
  const here: Assigned = { machineId: entry.machineId, taskId: entry.task.id, session: null };
  const kept = { agent: entry.task.agent, customAgent: entry.task.customAgent };
  const drawn = drawnBoard();
  if (entry.configured || entry.column === drawn.intake) {
    if (typeof to === "string") await changeTask(entry, { assignee: to }, { assignee: to, ...kept });
    else if (to.machineId !== entry.machineId && entry.task.sessions.length === 0) {
      return await drawnMoving(entry, to, null, () => moveToMachine(entry, to, cwd));
    } else await changeTask(entry, { ...agentOf(to), ...(cwd === entry.task.cwd ? {} : { cwd }) }, drawnAs(entry, to));
    return here;
  }
  if (typeof to === "string") {
    await changeTask(entry, to === "you" ? { status: "review", assignee: "you" } : { status: "ready", assignee: "nobody" }, { assignee: to, ...kept });
    return here;
  }
  const working = columnForStatus(drawn, "running");
  const run =
    to.machineId === entry.machineId
      ? async (): Promise<Assigned> => ({ ...here, session: await startOn(entry, { ...agentOf(to), ...(cwd === entry.task.cwd ? {} : { cwd }) }) })
      : () => moveToMachine(entry, to, cwd, true);
  return await drawnMoving(entry, to, working, run);
}

/** Drawn with the agent picked, in the column it starts in, and on its machine where that is another, until the press is answered. */
async function drawnMoving(entry: BoardTask, to: Exclude<AssignTo, string>, column: string | null, run: () => Promise<Assigned>): Promise<Assigned> {
  const going = to.machineId === entry.machineId ? undefined : machinesAsDrawn(store.getSnapshot()).find((one) => one.machine.id === to.machineId);
  const release = board.hold(entry.machineId, entry.task.id, {
    ...(column === null ? {} : { column }),
    assignee: drawnAs(entry, to),
    ...(going === undefined ? {} : { machine: going.name }),
  });
  try {
    return await run();
  } finally {
    release();
  }
}

function agentOf(to: { kind: "harness" | "custom"; id: string }): { agent: string; customAgent: string | null } {
  return to.kind === "custom" ? { agent: "", customAgent: to.id } : { agent: to.id, customAgent: null };
}

/** An agent picked, as its daemon will answer it: an assembled one's harness in `agent`, where the pick says which. */
function drawnAs(entry: BoardTask, to: Exclude<AssignTo, string>): AskedAssignee {
  return { assignee: "agent", agent: to.harness ?? (to.kind === "harness" ? to.id : entry.task.agent), customAgent: to.kind === "custom" ? to.id : null };
}

function landed(
  machineId: MachineId,
  answer: { task: TaskSnapshot; session?: SessionSnapshot; sent?: boolean },
): { task: TaskSnapshot; session: SessionRef | null } {
  board.apply(machineId, answer.task);
  if (answer.session === undefined) return { task: answer.task, session: null };
  const ref = refOf(machineId, sessionId(answer.session.id));
  store.applySnapshot(ref, answer.session);
  if (answer.sent === false) toast("error", "The agent started, but did not take the brief. Send it from the conversation.");
  return { task: answer.task, session: ref };
}

function startedAnyway(machineId: MachineId, cause: unknown): SessionRef | null {
  if (!ApiError.isApiError(cause) || cause.code !== "agent_start_timeout") return null;
  const detail = cause.detail as { sessionId?: string } | null;
  return typeof detail?.sessionId === "string" ? refOf(machineId, sessionId(detail.sessionId)) : null;
}

/** An older daemon's move, by its status. Never `needs_you`: the daemon alone says that. */
export async function setTaskStatus(entry: BoardTask, status: Exclude<TaskStatus, "needs_you">): Promise<void> {
  await changeTask(entry, { status });
}

/**
 * A title, a brief, a folder or who does it next; the conversations already on the task keep their own agent. A status is
 * drawn at once in its column, and so is an assignee the caller says how to draw (Q3.728, Q3.732).
 */
export async function changeTask(entry: BoardTask, change: TaskChangeBody, drawn?: AskedAssignee): Promise<void> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const asked = {
    ...(change.status === undefined ? {} : { column: columnForStatus(drawnBoard(), change.status) }),
    ...(drawn === undefined ? {} : { assignee: drawn }),
  };
  const release = Object.keys(asked).length === 0 ? null : board.hold(entry.machineId, entry.task.id, asked);
  try {
    const answer = (await daemon.changeTask(entry.task.id, change)).task;
    board.apply(entry.machineId, answer);
    const kept = new Set((answer.files ?? []).map((file) => file.id));
    if ((change.attachments ?? []).some((id) => !kept.has(id))) throw new Error(FILES_NOT_KEPT);
  } finally {
    release?.();
  }
}

/** An older daemon takes a task's files only when it is made, and answers a change that named some without them. */
const FILES_NOT_KEPT = "That machine is too old to add files to a task it already holds. Update it, then attach them again.";

/**
 * Hands a task nobody has started to an agent on another machine: made there under its key, then taken off this one, so a
 * proposal it came from still finds it (Q3.725). With `start` that agent starts on it there. Answers where it went.
 */
export async function moveToMachine(
  entry: BoardTask,
  to: { machineId: MachineId; kind: "harness" | "custom"; id: string },
  cwd: string,
  start = false,
): Promise<Assigned> {
  const made = await createTask({
    machineId: to.machineId,
    title: entry.task.title,
    brief: entry.task.brief,
    ...agentOf(to),
    assignee: "agent",
    cwd,
    key: entry.task.key ?? taskKey(),
    start,
    attachments: await carryFiles(entry, to.machineId),
  });
  // Drawn once, where it went: the copy left behind leaves the board before its delete is answered.
  board.forget(entry.machineId, entry.task.id);
  await deleteTask(entry);
  return { machineId: to.machineId, taskId: made.task.id, session: made.session };
}

/** The task's files fetched from its machine and staged on another, for the copy made there: the daemons never move them (Q2.273). */
async function carryFiles(entry: BoardTask, to: MachineId): Promise<string[]> {
  const files = entry.task.files ?? [];
  if (files.length === 0) return [];
  const from = store.daemonFor(entry.machineId);
  const there = store.daemonFor(to);
  if (from === undefined || there === undefined) throw new Error(NOT_CONNECTED);
  const ids: string[] = [];
  for (const file of files) {
    const blob = await from.downloadTaskFile(entry.task.id, file.id);
    const staged = await there.uploadTaskFile(new File([blob], file.name, { type: file.mime ?? "" }), file.name, () => {}, new AbortController().signal);
    ids.push(staged.upload.uploadId);
  }
  return ids;
}

export async function deleteTask(entry: BoardTask): Promise<void> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  await daemon.deleteTask(entry.task.id);
  board.forget(entry.machineId, entry.task.id);
}

/** Resolves either way, as a menu's act does: a refusal is toasted. */
export function attachSession(entry: BoardTask, ref: SessionRef): Promise<void> {
  const daemon = store.daemonFor(ref.machineId);
  if (daemon === undefined) return Promise.resolve(toast("error", NOT_CONNECTED));
  return daemon.attachSession(entry.task.id, ref.sessionId).then(
    (answer) => {
      board.apply(ref.machineId, answer.task);
      // The task it left still lists it until that machine is read again.
      board.refresh(ref.machineId);
    },
    (cause: unknown) => toast("error", errorText(cause)),
  );
}

export function detachSession(entry: BoardTask, ref: SessionRef): Promise<void> {
  const daemon = store.daemonFor(ref.machineId);
  if (daemon === undefined) return Promise.resolve(toast("error", NOT_CONNECTED));
  return daemon.detachSession(entry.task.id, ref.sessionId).then(
    (answer) => board.apply(ref.machineId, answer.task),
    (cause: unknown) => toast("error", errorText(cause)),
  );
}

/**
 * A conversation with no task, let go in a column, becomes a task holding it (stage 7). Made where it is, attached, then moved:
 * a column that works starts a run on its own, which would open a conversation of its own were the chat not on the task first.
 * An older daemon takes the column's status.
 */
export async function taskFromChat(
  chat: { ref: SessionRef; title: string; agent: string; cwd: string },
  column: string,
  configured: boolean,
): Promise<{ machineId: MachineId; taskId: string }> {
  const daemon = store.daemonFor(chat.ref.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const drawn = drawnBoard();
  const works = columnById(drawn, column)?.kind === "work";
  const legacy = legacyTarget(drawn, column);
  const made = await createTask({
    machineId: chat.ref.machineId,
    title: chat.title.slice(0, 120),
    brief: chat.title,
    agent: chat.agent,
    assignee: "agent",
    ...(configured ? { column: works ? drawn.intake : column } : legacy === "review" || legacy === "done" ? { status: legacy } : {}),
    cwd: chat.cwd,
    start: false,
  });
  const attached = await daemon.attachSession(made.task.id, chat.ref.sessionId);
  board.apply(chat.ref.machineId, attached.task);
  if (configured && works) {
    const entry = board.getSnapshot().tasks.find((one) => one.machineId === chat.ref.machineId && one.task.id === made.task.id);
    if (entry !== undefined) await moveTo(entry, { to: column });
  }
  return { machineId: chat.ref.machineId, taskId: made.task.id };
}

/** A task opens as its own page, which names the conversation doing it and goes there in one press (Q3.725). */
export function openTask(entry: Pick<BoardTask, "machineId" | "task">): void {
  navigate(taskPath(entry.machineId, entry.task.id));
}

/** Whether a task stands in a column that closes it; an older daemon's by its status. */
export function closed(entry: BoardTask): boolean {
  return isFinal(drawnBoard(), entry.column) || (!entry.configured && shownStatus(entry.task.status) === "done");
}
