import { columnOf, shownStatus, taskKey, type AskedAssignee, type BoardTask } from "../../board";
import { board } from "../../boardStore";
import type { TaskChangeBody } from "../../daemon";
import { ApiError, errorText } from "../../http";
import { refOf, sessionId, type MachineId, type SessionRef } from "../../ids";
import { navigate, sessionPath, taskPath } from "../../router";
import { machinesAsDrawn, store } from "../../store";
import type { SessionSnapshot, TaskAssignee, TaskSnapshot, TaskStatus } from "../../wire";
import { toast } from "../Toast";

const NOT_CONNECTED = "That machine is not connected right now.";

export interface NewTaskInput {
  machineId: MachineId;
  title?: string;
  brief: string;
  agent: string;
  customAgent?: string | null;
  /** Nobody or its person makes a task no agent holds; `agent` is then only what a later start would launch. */
  assignee?: TaskAssignee;
  /** The column it is made in, where that is not the backlog; never with `start` (Q3.737). */
  status?: "review" | "done";
  cwd: string;
  /** A proposal's id, or one minted for this form: the same key sent again makes no second task. */
  key?: string;
  start: boolean;
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
    cwd: input.cwd,
    key: input.key ?? taskKey(),
    start: input.start,
  });
  return landed(input.machineId, answer);
}

/** A first start or another attempt with the agent the task holds, then straight to the conversation it made. */
export async function startTask(entry: BoardTask): Promise<void> {
  const session = await startOn(entry, {});
  if (session !== null) navigate(sessionPath(session));
}

/** The agent a task holds starts on it, drawn in Running at once; answers the conversation it made (Q3.732). */
export async function startHere(entry: BoardTask): Promise<SessionRef | null> {
  const release = board.hold(entry.machineId, entry.task.id, { status: "running" });
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

/** `harness` draws an assembled agent's glyph before its daemon answers. */
export type AssignTo = "nobody" | "you" | { machineId: MachineId; kind: "harness" | "custom"; id: string; harness?: string };

/** Where a task lives after an assignment, and the conversation it started, if it started one. */
export interface Assigned {
  machineId: MachineId;
  taskId: string;
  session: SessionRef | null;
}

/**
 * Hands a task to whoever was picked (Q3.727, Q3.732, Q3.736). In the backlog that names who will do it, an agent or its
 * person, and moves nothing. Anywhere else nobody puts it back in the backlog, its person takes it for review, and an agent
 * starts on it at once. Drawn as it is going to be until its daemon answers, on the machine it is going to (Q3.728). An agent on
 * another machine moves a task nobody has started there.
 */
export async function assignTask(entry: BoardTask, to: AssignTo, cwd: string): Promise<Assigned> {
  const here: Assigned = { machineId: entry.machineId, taskId: entry.task.id, session: null };
  const kept = { agent: entry.task.agent, customAgent: entry.task.customAgent };
  if (columnOf(shownStatus(entry.task.status)) === "ready") {
    if (typeof to === "string") await changeTask(entry, { assignee: to }, { assignee: to, ...kept });
    else if (to.machineId !== entry.machineId) return await drawnMoving(entry, to, false, () => moveTask(entry, to, cwd));
    else await changeTask(entry, { ...agentOf(to), ...(cwd === entry.task.cwd ? {} : { cwd }) }, drawnAs(entry, to));
    return here;
  }
  if (typeof to === "string") {
    await changeTask(entry, to === "you" ? { status: "review", assignee: "you" } : { status: "ready", assignee: "nobody" }, { assignee: to, ...kept });
    return here;
  }
  const run =
    to.machineId === entry.machineId
      ? async (): Promise<Assigned> => ({ ...here, session: await startOn(entry, { ...agentOf(to), ...(cwd === entry.task.cwd ? {} : { cwd }) }) })
      : () => moveTask(entry, to, cwd, true);
  return await drawnMoving(entry, to, true, run);
}

/** Drawn with the agent picked, in Running where it starts, and on its machine where that is another, until the press is answered. */
async function drawnMoving(entry: BoardTask, to: Exclude<AssignTo, string>, starts: boolean, run: () => Promise<Assigned>): Promise<Assigned> {
  const going = to.machineId === entry.machineId ? undefined : machinesAsDrawn(store.getSnapshot()).find((one) => one.machine.id === to.machineId);
  const release = board.hold(entry.machineId, entry.task.id, {
    ...(starts ? { status: "running" } : {}),
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

/** Never `needs_you`: the daemon alone says that. */
export async function setTaskStatus(entry: BoardTask, status: Exclude<TaskStatus, "needs_you">): Promise<void> {
  await changeTask(entry, { status });
}

/**
 * A title, a brief, a folder or who does it next; the conversations already on the task keep their own agent. A status is
 * drawn at once, and so is an assignee the caller says how to draw (Q3.728, Q3.732).
 */
export async function changeTask(entry: BoardTask, change: TaskChangeBody, drawn?: AskedAssignee): Promise<void> {
  const daemon = store.daemonFor(entry.machineId);
  if (daemon === undefined) throw new Error(NOT_CONNECTED);
  const asked = { ...(change.status === undefined ? {} : { status: change.status }), ...(drawn === undefined ? {} : { assignee: drawn }) };
  const release = Object.keys(asked).length === 0 ? null : board.hold(entry.machineId, entry.task.id, asked);
  try {
    board.apply(entry.machineId, (await daemon.changeTask(entry.task.id, change)).task);
  } finally {
    release?.();
  }
}

/**
 * Hands a task nobody has started to an agent on another machine: made there under its key, then taken off this one, so a
 * proposal it came from still finds it (Q3.725). With `start` that agent starts on it there. Answers where it went.
 */
export async function moveTask(
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
  });
  // Drawn once, where it went: the copy left behind leaves the board before its delete is answered.
  board.forget(entry.machineId, entry.task.id);
  await deleteTask(entry);
  return { machineId: to.machineId, taskId: made.task.id, session: made.session };
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

/** A task opens as its own page, which names the conversation doing it and goes there in one press (Q3.725). */
export function openTask(entry: Pick<BoardTask, "machineId" | "task">): void {
  navigate(taskPath(entry.machineId, entry.task.id));
}
