import { randomBytes } from "node:crypto";
import type { Reemoat } from "./client.js";
import { ReemoatError } from "./errors.js";

// The daemon's own task routes, unchanged: this is a thin mirror, every field optional past the few read here,
// since a daemon newer or older than this client answers more or less (compatibility.md rule 2).

export interface Task {
  id: string;
  title: string;
  brief?: string;
  /** ready, running, needs_you, review or done. */
  status: string;
  column?: string;
  phase?: string;
  key?: string | null;
  summary?: string | null;
  agent?: string;
  cwd?: string;
  updatedAt?: number;
  [field: string]: unknown;
}

export interface NewTask {
  brief: string;
  cwd: string;
  agent?: string;
  customAgent?: string;
  title?: string;
  /** Sent again, the same key answers the task it made rather than a second one; one is made when none is given. */
  key?: string;
  start?: boolean;
  assignee?: "nobody" | "agent" | "you";
  status?: "ready" | "review" | "done";
  column?: string;
  labels?: string[];
  worktree?: boolean | "auto" | "require" | "never";
  nickname?: string;
}

export interface Listing {
  tasks: Task[];
  /** Tasks the board handed to another machine: where each went. */
  tombstones: { id: string; movedTo: string; at: number }[];
  boardRevision: number | null;
}

export interface Board {
  revision: number;
  hash: string;
  text: string;
  [field: string]: unknown;
}

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function newTaskKey(): string {
  return `c-${randomBytes(15).toString("base64url")}`;
}

export class Tasks {
  constructor(private readonly client: Reemoat) {}

  async listing(machine: string): Promise<Listing> {
    const answer = (await this.client.request(machine, { method: "GET", path: "/tasks" })).body as Record<string, unknown>;
    return {
      tasks: Array.isArray(answer["tasks"]) ? (answer["tasks"] as Task[]) : [],
      tombstones: Array.isArray(answer["tombstones"]) ? (answer["tombstones"] as Listing["tombstones"]) : [],
      boardRevision: typeof answer["boardRevision"] === "number" ? answer["boardRevision"] : null,
    };
  }

  async list(machine: string): Promise<Task[]> {
    return (await this.listing(machine)).tasks;
  }

  /** By id or by the key it was made with; one the board handed elsewhere is refused with where it went. */
  async get(machine: string, ref: string): Promise<Task> {
    const listing = await this.listing(machine);
    const task = listing.tasks.find((one) => one.id === ref || one.key === ref);
    if (task !== undefined) return task;
    const moved = listing.tombstones.find((one) => one.id === ref);
    if (moved !== undefined) {
      throw new ReemoatError("machine", 404, "task_moved", `the task went to another machine, ${moved.movedTo}`, { movedTo: moved.movedTo }, `ask that machine: --machine ${moved.movedTo}`);
    }
    throw new ReemoatError("machine", 404, "task_not_found", `no task ${ref} on ${machine}`);
  }

  /** The comments, questions and reports, and the history of moves. */
  async history(machine: string, id: string): Promise<{ comments: unknown[]; events: unknown[] }> {
    const answer = (await this.client.request(machine, { method: "GET", path: `/tasks/${encodeURIComponent(id)}/comments` })).body as Record<string, unknown>;
    return { comments: Array.isArray(answer["comments"]) ? answer["comments"] : [], events: Array.isArray(answer["events"]) ? answer["events"] : [] };
  }

  async create(machine: string, input: NewTask): Promise<{ task: Task; existing: boolean; session: unknown }> {
    if (input.agent === undefined && input.customAgent === undefined) {
      throw new ReemoatError("client", 0, "bad_request", "name the agent to run it, as `reemoat machines` shows what a machine offers");
    }
    const key = input.key ?? newTaskKey();
    if (!KEY.test(key)) throw new ReemoatError("client", 0, "bad_request", "a key is 1 to 64 of A-Z, a-z, 0-9, _ and -");
    // The key makes a second copy of this request answer the first task, so a lost answer is safe to ask again.
    const answer = (await this.client.request(machine, { method: "POST", path: "/tasks", body: { ...input, key }, replayable: true })).body as Record<string, unknown>;
    return { task: answer["task"] as Task, existing: answer["existing"] === true, session: answer["session"] ?? null };
  }

  async update(machine: string, id: string, change: Record<string, unknown>): Promise<Task> {
    return taskOf(await this.client.request(machine, { method: "PATCH", path: `/tasks/${encodeURIComponent(id)}`, body: change }));
  }

  async start(machine: string, id: string, options: { agent?: string; customAgent?: string; cwd?: string } = {}): Promise<{ task: Task; session: unknown }> {
    const answer = (await this.client.request(machine, { method: "POST", path: `/tasks/${encodeURIComponent(id)}/start`, body: options })).body as Record<string, unknown>;
    return { task: answer["task"] as Task, session: answer["session"] ?? null };
  }

  /** To a column by id, or out by one of its column's exits; `stop` ends the turn of an agent at work on it first. */
  async move(machine: string, id: string, target: { to?: string; exit?: string; from?: string; stop?: boolean }): Promise<Task> {
    return taskOf(await this.client.request(machine, { method: "POST", path: `/tasks/${encodeURIComponent(id)}/move`, body: target }));
  }

  /** Reaches a run at work on it now, else the next run's agent. */
  async comment(machine: string, id: string, text: string): Promise<unknown> {
    return (await this.client.request(machine, { method: "POST", path: `/tasks/${encodeURIComponent(id)}/comments`, body: { text } })).body;
  }

  async delete(machine: string, id: string): Promise<void> {
    await this.client.request(machine, { method: "DELETE", path: `/tasks/${encodeURIComponent(id)}` });
  }

  /**
   * Asks until the task's status, column or phase is one of `until`, following it to the machine the board hands it to.
   * Polling, since the daemon tells nobody outside it when a task moves.
   */
  async wait(
    machine: string,
    id: string,
    options: { until: readonly string[]; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<{ task: Task; machine: string }> {
    const deadline = Date.now() + (options.timeoutMs ?? 60 * 60_000);
    const interval = Math.max(2_000, options.intervalMs ?? 5_000);
    let where = machine;
    for (;;) {
      if (options.signal?.aborted === true) throw new ReemoatError("client", 0, "aborted", "the wait was cancelled");
      let task: Task | null = null;
      try {
        task = await this.get(where, id);
      } catch (error) {
        if (!(error instanceof ReemoatError) || error.code !== "task_moved") throw error;
        // Asked there after the same pause: two machines naming each other mid-handoff must not spin.
        where = String((error.detail as { movedTo: string }).movedTo);
      }
      if (task !== null && options.until.some((wanted) => wanted === task.status || wanted === task.column || wanted === task.phase)) {
        return { task, machine: where };
      }
      if (Date.now() + interval > deadline) {
        const still = task === null ? "on its way to another machine" : `still ${task.status} in ${task.column ?? "its column"}`;
        throw new ReemoatError("client", 0, "wait_timeout", `the task is ${still}`, { task, machine: where });
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

export class Boards {
  constructor(private readonly client: Reemoat) {}

  async get(machine: string): Promise<Board> {
    return (await this.client.request(machine, { method: "GET", path: "/board" })).body as Board;
  }

  /** The whole board as YAML, written over the revision it was read at; a board that moved since is refused with the newer one. */
  async put(machine: string, text: string, options: { revision?: number } = {}): Promise<Board & { changed: boolean }> {
    const headers: Record<string, string> = options.revision === undefined ? {} : { "if-match": String(options.revision) };
    return (await this.client.request(machine, { method: "PUT", path: "/board", text: { value: text, type: "application/yaml" }, headers })).body as Board & { changed: boolean };
  }
}

function taskOf(answer: { body: unknown }): Task {
  return (answer.body as { task: Task }).task;
}
