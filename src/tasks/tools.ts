import { isAbsolute } from "node:path";
import { COLUMN_ID, EXIT_NAME, MAX_BOARD_BYTES, MAX_SIMULATED_EVENTS, ROLE_NAME } from "@reemoat/board";
import { MAX_TASK_BRIEF_CHARS, MAX_TASK_SUMMARY_CHARS, MAX_TASK_TITLE_CHARS, TASK_STATUSES, type StoredTaskStatus, type TaskStatus } from "./store.js";

export const LIST_PROJECTS_TOOL_NAME = "list_projects";
export const LIST_TASKS_TOOL_NAME = "list_tasks";
export const PROPOSE_TASKS_TOOL_NAME = "propose_tasks";
export const TASK_UPDATE_TOOL_NAME = "task_update";
export const BOARD_GET_TOOL_NAME = "board_get";
export const BOARD_CHECK_TOOL_NAME = "board_check";
export const BOARD_SIMULATE_TOOL_NAME = "board_simulate";
export const BOARD_PROPOSE_TOOL_NAME = "board_propose";

export const TASK_TOOL_NAMES: readonly string[] = [
  LIST_PROJECTS_TOOL_NAME,
  LIST_TASKS_TOOL_NAME,
  PROPOSE_TASKS_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  BOARD_GET_TOOL_NAME,
  BOARD_CHECK_TOOL_NAME,
  BOARD_SIMULATE_TOOL_NAME,
  BOARD_PROPOSE_TOOL_NAME,
];

/** What an agent says a proposed board changes: one paragraph on the card above the diff. */
export const MAX_BOARD_WHY_CHARS = 600;

export const MAX_PROPOSALS_PER_CALL = 12;
/** Under the log's 128 KiB per event with room for the rest of the row: a proposals card is never clipped. */
export const MAX_PROPOSAL_CHARS_PER_CALL = 96_000;
export const MAX_TASK_PATH_CHARS = 4_096;
export const MAX_TASK_AGENT_CHARS = 65;
export const MAX_TASK_MACHINE_CHARS = 256;

/** The statuses an agent may write: needs_you is this daemon's, ready is the backlog a person puts a task in, and done its person's once they looked (Q2.260). */
export const AGENT_TASK_STATUSES: readonly StoredTaskStatus[] = ["running", "review"];

export const TASK_INSTRUCTIONS =
  "Your user keeps a board of tasks across their machines. list_tasks shows it and list_projects shows where work can run. " +
  "propose_tasks puts tasks in front of your user as a card; a task and its agent start only when they press, so propose and then stop. " +
  "When this conversation is itself working on a task, task_update keeps that task's summary current for them. " +
  "The board's columns, who runs them and where a task goes next are one YAML document: board_get reads it, board_check and " +
  "board_simulate try a draft, and board_propose shows your user a change they apply with a press.";

export const DISPATCH_NICKNAME = "dispatch";

export const DISPATCH_INSTRUCTIONS =
  "You are this user's dispatcher. They describe work in free text; you turn it into tasks and never do the work yourself: " +
  "no edits, no commands beyond what you need to read. Call list_projects to choose the machine, the project folder and an agent it offers, " +
  "then propose_tasks with one task per piece of work, each brief self-contained since its agent sees nothing of this conversation. " +
  "Asked what is pending, answer from list_tasks.";

const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };

export const TASK_TOOLS = [
  {
    name: LIST_PROJECTS_TOOL_NAME,
    description:
      "List where your user's tasks can run: each of their machines, the project folders on it and the agents it offers. " +
      "Pass a row's machine, project and agent to propose_tasks exactly as printed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: ALWAYS_LOAD,
  },
  {
    name: LIST_TASKS_TOOL_NAME,
    description:
      "List the tasks on your user's board, on this machine and their other machines, with each one's status " +
      `(${TASK_STATUSES.join(", ")}; ready is one in the backlog, not started yet), agent (in the backlog: the agent named, your user, or not assigned), project and latest summary.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: ALWAYS_LOAD,
  },
  {
    name: PROPOSE_TASKS_TOOL_NAME,
    description:
      "Propose tasks to your user. They see a card in this chat with one row per task and create the ones they want with a press; " +
      "nothing starts until then, and you start nothing yourself. Each task runs as its own agent session with `brief` as its first message, " +
      "so write the brief to be read alone: the goal, what done looks like, and anything to ask before doing. " +
      `Up to ${MAX_PROPOSALS_PER_CALL} tasks per call.`,
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PROPOSALS_PER_CALL,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: `What the task is, in a few words; at most ${MAX_TASK_TITLE_CHARS} characters.` },
              brief: { type: "string", description: "The whole first message to the agent that will do it." },
              project: { type: "string", description: "The project folder, an absolute path as list_projects printed it." },
              agent: {
                type: "string",
                description: "The agent to run it, one that machine offers in list_projects. Leave it out to let the column's role decide.",
              },
              machine: {
                type: "string",
                description: "The machine as list_projects printed it, `name [id]`. Leave it out for the machine you are on.",
              },
              column: { type: "string", description: "The board column to put it in, by id as board_get shows it. Leave it out for the intake." },
              role: { type: "string", description: "A role from the board whose agent is to run it, by name. Leave it out for the column's own." },
            },
            required: ["title", "brief", "project"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    _meta: ALWAYS_LOAD,
  },
  {
    name: TASK_UPDATE_TOOL_NAME,
    description:
      "Report on the task this conversation is working on, which is the only task it changes. `summary` replaces what your user reads on the " +
      "board: what is done, what is next, and what you need from them, in a few lines. `status` is `review` when the work is ready for " +
      "them to look at, and `running` to take that back; they mark the task done themselves. Where the note on your task lists exits, " +
      "`outcome` names the one this column's work goes out by. Call it when you finish a step and before you stop. Refused in words when " +
      "this conversation is attached to no task.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: `At most ${MAX_TASK_SUMMARY_CHARS} characters.` },
        status: { type: "string", enum: [...AGENT_TASK_STATUSES] },
        outcome: { type: "string", description: "One of the exits the note on your task lists, by name." },
      },
      additionalProperties: false,
    },
    _meta: ALWAYS_LOAD,
  },
  {
    name: BOARD_GET_TOOL_NAME,
    description:
      "Read your user's board: its YAML exactly as written, comments included, its revision, and each column with what runs there " +
      "and where it leads. Read it before writing a change.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: ALWAYS_LOAD,
  },
  {
    name: BOARD_CHECK_TOOL_NAME,
    description: "Check a draft of the board's YAML: every line it fails on, or what it would hold. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: `The whole board, as YAML; at most ${MAX_BOARD_BYTES / 1024} KiB.` } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: ALWAYS_LOAD,
  },
  {
    name: BOARD_SIMULATE_TOOL_NAME,
    description:
      "Walk one task through a board on paper, by the rules the daemons run it by. It starts in the intake; each script line is " +
      "what happens next: `report` (the run's agent reports), `outcome <exit>` (it names an exit), `silent` (its turn ends with no " +
      "report), `<role> <exit|stay|none> [confidence]` (a role's answer when asked), `move <column>` or `press <exit>` (your user). " +
      "Answers every step taken. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "array", items: { type: "string" }, maxItems: MAX_SIMULATED_EVENTS },
        text: { type: "string", description: "A draft of the board to walk; leave it out for the board as it is." },
      },
      required: ["script"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: ALWAYS_LOAD,
  },
  {
    name: BOARD_PROPOSE_TOOL_NAME,
    description:
      "Show your user a new board: a card in this chat with the change against the board as it is, and an Apply they press. " +
      "Nothing changes until then, and you change nothing yourself. Write the whole board, keeping what you do not mean to change, " +
      "comments included; check it with board_check first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The whole board, as YAML." },
        why: { type: "string", description: `What it changes and why, in a few sentences; at most ${MAX_BOARD_WHY_CHARS} characters.` },
      },
      required: ["text", "why"],
      additionalProperties: false,
    },
    _meta: ALWAYS_LOAD,
  },
];

export interface ProposedTask {
  title: string;
  brief: string;
  project: string;
  /** null leaves it to the column's role, or the role named. */
  agent: string | null;
  /** As the model wrote it; null is the machine the caller is on. */
  machine: string | null;
  column: string | null;
  role: string | null;
}

/** The proposals as the model wrote them, or the refusal, worded for the model. */
export function parseProposals(args: Record<string, unknown>): ProposedTask[] | string {
  const tasks = args["tasks"];
  if (!Array.isArray(tasks) || tasks.length === 0) return "tasks must be a list of at least one task";
  if (tasks.length > MAX_PROPOSALS_PER_CALL) {
    return `at most ${MAX_PROPOSALS_PER_CALL} tasks per call; propose the rest in a second call`;
  }
  const out: ProposedTask[] = [];
  let chars = 0;
  for (const [index, raw] of tasks.entries()) {
    const where = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${where} must be an object`;
    const one = raw as Record<string, unknown>;
    const title = cleanTitle(one["title"]);
    if (title === null) return `${where}.title must be a few words, at most ${MAX_TASK_TITLE_CHARS} characters`;
    const brief = cleanBrief(one["brief"]);
    if (brief === null) return `${where}.brief must be the task's first message, at most ${MAX_TASK_BRIEF_CHARS} characters`;
    const project = one["project"];
    if (typeof project !== "string" || !isProjectPath(project.trim())) {
      return `${where}.project must be an absolute path, as list_projects printed it`;
    }
    const agent = one["agent"];
    if (agent !== undefined && agent !== null && (typeof agent !== "string" || !isAgentRef(agent.trim()))) {
      return `${where}.agent must be an agent that machine offers, as list_projects printed it, or left out`;
    }
    const column = one["column"];
    if (column !== undefined && column !== null && (typeof column !== "string" || !COLUMN_ID.test(column))) {
      return `${where}.column must be a column's id, as board_get shows it, or left out`;
    }
    const role = one["role"];
    if (role !== undefined && role !== null && (typeof role !== "string" || !ROLE_NAME.test(role))) {
      return `${where}.role must be a role's name, as board_get shows it, or left out`;
    }
    const machine = one["machine"];
    if (machine !== undefined && machine !== null && (typeof machine !== "string" || machine.length > MAX_TASK_MACHINE_CHARS)) {
      return `${where}.machine must be a machine as list_projects printed it, or left out`;
    }
    const named = typeof machine === "string" ? machine.trim() : "";
    chars += title.length + brief.length + project.length;
    out.push({
      title,
      brief,
      project: project.trim(),
      agent: typeof agent === "string" ? agent.trim() : null,
      machine: named.length === 0 ? null : named,
      column: typeof column === "string" ? column : null,
      role: typeof role === "string" ? role : null,
    });
  }
  if (chars > MAX_PROPOSAL_CHARS_PER_CALL) return "these briefs are too long for one card; propose fewer tasks per call";
  return out;
}

/** One line, no controls; null when nothing is left or it is too long to be a title. */
export function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length === 0 || collapsed.length > MAX_TASK_TITLE_CHARS ? null : collapsed;
}

export function cleanBrief(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > MAX_TASK_BRIEF_CHARS ? null : trimmed;
}

/** `""` clears it; null is a refusal. */
export function cleanSummary(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const trimmed = value.trim();
  return trimmed.length > MAX_TASK_SUMMARY_CHARS ? null : trimmed;
}

/** Shape only: whether the folder exists is the launch's to say, on the machine that has it. */
export function isProjectPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_TASK_PATH_CHARS || value.includes("\0")) return false;
  return isAbsolute(value) || value === "~" || value.startsWith("~/");
}

const AGENT_REF = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

export function isAgentRef(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_AGENT_CHARS && AGENT_REF.test(value);
}

export interface TaskUpdateArgs {
  summary: string | null;
  status: StoredTaskStatus | null;
  /** An exit's name, checked against the task's column by the desk. */
  outcome: string | null;
}

export function parseTaskUpdate(args: Record<string, unknown>): TaskUpdateArgs | string {
  const summary = args["summary"];
  const status = args["status"];
  const outcome = args["outcome"];
  if (summary === undefined && status === undefined && outcome === undefined) return "give a summary, a status, an outcome, or some of them";
  if (outcome !== undefined && (typeof outcome !== "string" || !EXIT_NAME.test(outcome.trim()))) {
    return "outcome is the name of one of the exits the note on your task lists";
  }
  let cleaned: string | null = null;
  if (summary !== undefined) {
    cleaned = cleanSummary(summary);
    if (cleaned === null) return `summary must be text of at most ${MAX_TASK_SUMMARY_CHARS} characters`;
  }
  if (status === "done") return "your user marks a task done once they have looked at it; say review when the work is ready";
  if (status !== undefined && !(AGENT_TASK_STATUSES as readonly unknown[]).includes(status)) {
    return `status must be one of ${AGENT_TASK_STATUSES.join(", ")}`;
  }
  return {
    summary: cleaned,
    status: status === undefined ? null : (status as StoredTaskStatus),
    outcome: typeof outcome === "string" ? outcome.trim() : null,
  };
}

export function statusWords(status: TaskStatus | string): string {
  return status.replace(/_/g, " ");
}
