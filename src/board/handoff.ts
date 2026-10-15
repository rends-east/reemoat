// A task handed from one machine's daemon to another's: what crosses, and how the receiver reads it (Q2.269).
import { COLUMN_ID } from "@reemoat/board";
import {
  COMMENT_KINDS,
  isTaskAssignee,
  MAX_COMMENT_CHARS,
  MAX_TASK_BRIEF_CHARS,
  MAX_TASK_COMMENTS,
  MAX_TASK_SUMMARY_CHARS,
  MAX_TASK_TITLE_CHARS,
  TASK_EVENT_KINDS,
  type TaskAssignee,
  type TaskComment,
  type TaskEvent,
  type TaskFlow,
} from "../tasks/store.js";

const TASK_ID = /^t_[A-Za-z0-9_-]{1,64}$/;
const MAX_MOVED_EVENTS = 200;
const MAX_FIELD_CHARS = 4_096;

export interface HandoffPayload {
  v: 1;
  id: string;
  epoch: number;
  /** The receiver as the sender's board named it when it placed the run there. */
  placedAs: string;
  boardRevision: number;
  boardHash: string;
  task: {
    title: string;
    brief: string;
    summary: string | null;
    summaryAt: number | null;
    summaryBy: string | null;
    agent: string;
    customAgent: string | null;
    assignee: TaskAssignee;
    cwd: string;
    key: string | null;
    createdAt: number;
  };
  flow: TaskFlow;
  comments: TaskComment[];
  events: Omit<TaskEvent, "seq">[];
}

/** What a flow is missing when it came from a build that did not write it. */
export function flowDefaults(): TaskFlow {
  return {
    column: "",
    entry: 0,
    enteredAt: 0,
    epoch: 0,
    budget: null,
    labels: [],
    visits: {},
    code: null,
    workdir: null,
    run: null,
    runs: 0,
    verdicts: [],
    ask: null,
    wait: null,
    judging: null,
    moving: null,
    from: null,
    last: null,
    notes: [],
    links: {},
  };
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function nullableText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * A handoff as another daemon sent it, read field by field: the task's own words within their bounds, its flow shaped as a
 * flow, the feed and history kept to what this machine keeps. Anything else is refused whole, in words.
 */
export function readHandoff(raw: unknown): HandoffPayload | string {
  if (typeof raw !== "object" || raw === null) return "a handoff is an object";
  const body = raw as Record<string, unknown>;
  if (body["v"] !== 1) return "this machine reads handoffs of version 1";
  const id = body["id"];
  if (typeof id !== "string" || !TASK_ID.test(id)) return "id is a task's id";
  const epoch = body["epoch"];
  if (!count(epoch) || epoch < 1) return "epoch is a whole number from 1";
  const placedAs = body["placedAs"];
  if (!text(placedAs, 256) || placedAs.trim().length === 0) return "placedAs names this machine";
  const boardRevision = body["boardRevision"];
  const boardHash = body["boardHash"];
  if (!count(boardRevision) || typeof boardHash !== "string" || !/^[0-9a-f]{64}$/.test(boardHash)) return "the board is named by its revision and hash";

  const task = body["task"] as Record<string, unknown> | null;
  if (typeof task !== "object" || task === null) return "task is an object";
  if (!text(task["title"], MAX_TASK_TITLE_CHARS) || (task["title"] as string).trim().length === 0) return "task.title is the task's title";
  if (!text(task["brief"], MAX_TASK_BRIEF_CHARS)) return "task.brief is the task's brief";
  if (!nullableText(task["summary"], MAX_TASK_SUMMARY_CHARS)) return "task.summary is text or null";
  if (!(task["summaryAt"] === null || count(task["summaryAt"]))) return "task.summaryAt is a time or null";
  if (!nullableText(task["summaryBy"], 256)) return "task.summaryBy is a session or null";
  if (!text(task["agent"], 65) || !nullableText(task["customAgent"], 65)) return "task.agent names the task's agent";
  if (!isTaskAssignee(task["assignee"])) return "task.assignee is nobody, agent or you";
  if (!text(task["cwd"], MAX_FIELD_CHARS) || !nullableText(task["key"], 64) || !count(task["createdAt"])) return "task.cwd, key and createdAt are the task's";

  const flow = body["flow"] as Record<string, unknown> | null;
  if (typeof flow !== "object" || flow === null || Array.isArray(flow)) return "flow is an object";
  if (typeof flow["column"] !== "string" || !COLUMN_ID.test(flow["column"])) return "flow.column is a column's id";
  if (!count(flow["entry"]) || !count(flow["runs"]) || !count(flow["enteredAt"])) return "flow.entry, runs and enteredAt are whole numbers";
  if (typeof flow["links"] !== "object" || flow["links"] === null || Array.isArray(flow["links"])) return "flow.links is an object";
  if (!Array.isArray(flow["labels"]) || !Array.isArray(flow["verdicts"]) || !Array.isArray(flow["notes"])) return "flow.labels, verdicts and notes are lists";
  const run = flow["run"];
  if (run !== null && (typeof run !== "object" || typeof (run as Record<string, unknown>)["state"] !== "string")) return "flow.run is a run or null";

  const comments: TaskComment[] = [];
  for (const one of Array.isArray(body["comments"]) ? body["comments"].slice(-MAX_TASK_COMMENTS) : []) {
    const comment = one as Record<string, unknown> | null;
    if (comment === null || typeof comment !== "object") continue;
    if (!text(comment["id"], 128) || !count(comment["at"]) || !(COMMENT_KINDS as readonly unknown[]).includes(comment["kind"])) continue;
    if (!text(comment["text"], MAX_COMMENT_CHARS) || !text(comment["author"], 256)) continue;
    comments.push({
      id: comment["id"],
      at: comment["at"],
      kind: comment["kind"] as TaskComment["kind"],
      author: comment["author"],
      text: comment["text"],
      // Another machine's session is no window here: its question is kept as words.
      sessionId: null,
      request: null,
      entry: count(comment["entry"]) ? comment["entry"] : 0,
      delivered: comment["delivered"] === true,
    });
  }
  const events: Omit<TaskEvent, "seq">[] = [];
  for (const one of Array.isArray(body["events"]) ? body["events"].slice(-MAX_MOVED_EVENTS) : []) {
    const event = one as Record<string, unknown> | null;
    if (event === null || typeof event !== "object") continue;
    if (!count(event["at"]) || !(TASK_EVENT_KINDS as readonly unknown[]).includes(event["kind"]) || !text(event["text"], 2_000)) continue;
    const field = (key: string): string | null => (text(event[key], 256) ? (event[key] as string) : null);
    events.push({
      at: event["at"],
      kind: event["kind"] as TaskEvent["kind"],
      entry: count(event["entry"]) ? event["entry"] : 0,
      revision: count(event["revision"]) ? event["revision"] : 0,
      text: event["text"],
      column: field("column"),
      to: field("to"),
      exit: field("exit"),
      by: field("by"),
      confidence: typeof event["confidence"] === "number" ? event["confidence"] : null,
      executor: field("executor"),
      session: field("session"),
    });
  }
  return {
    v: 1,
    id,
    epoch,
    placedAs: placedAs.trim(),
    boardRevision,
    boardHash,
    task: {
      title: (task["title"] as string).trim(),
      brief: task["brief"] as string,
      summary: task["summary"] as string | null,
      summaryAt: task["summaryAt"] as number | null,
      summaryBy: task["summaryBy"] as string | null,
      agent: task["agent"] as string,
      customAgent: task["customAgent"] as string | null,
      assignee: task["assignee"] as TaskAssignee,
      cwd: task["cwd"] as string,
      key: task["key"] as string | null,
      createdAt: task["createdAt"] as number,
    },
    flow: { ...flowDefaults(), ...(flow as Partial<TaskFlow>), epoch },
    comments,
    events,
  };
}
