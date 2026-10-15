import { machineAddress, type ProjectListing, type TaskDesk, type TaskListing } from "./desk.js";
import {
  LIST_PROJECTS_TOOL_NAME,
  LIST_TASKS_TOOL_NAME,
  PROPOSE_TASKS_TOOL_NAME,
  statusWords,
  TASK_UPDATE_TOOL_NAME,
} from "./tools.js";

const SUMMARY_LINE_CHARS = 240;

/** One of the four task tools, answered as an MCP tool result; a refusal is a sentence for the model, never an HTTP error. */
export async function callTaskTool(desk: TaskDesk, callerId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case LIST_PROJECTS_TOOL_NAME:
      return projectsResult(await desk.listProjects(callerId));
    case LIST_TASKS_TOOL_NAME:
      return tasksResult(await desk.listTasks(callerId));
    case PROPOSE_TASKS_TOOL_NAME: {
      const result = await desk.propose(callerId, args);
      if (!result.ok) return toolError(result.message);
      const count = result.proposals.length;
      return {
        content: [
          {
            type: "text",
            text:
              `Shown to your user as ${count === 1 ? "one proposed task" : `${count} proposed tasks`}. ` +
              "Each is created, and its agent started, only when they press it: start none of this work yourself, and do not ask whether they pressed.",
          },
        ],
        structuredContent: { status: "shown", proposals: result.proposals.map((one) => ({ id: one.id, title: one.title })) },
      };
    }
    case TASK_UPDATE_TOOL_NAME: {
      const result = desk.update(callerId, args);
      if (!result.ok) return toolError(result.message);
      // The board reads running for as long as this turn does, whatever was just written: said, or the agent reports a failure.
      const pending = result.recorded !== null && result.recorded !== result.task.status;
      return {
        content: [
          {
            type: "text",
            text:
              `Recorded on the task ${JSON.stringify(result.task.title)}.` +
              (pending ? ` It reads ${statusWords(result.task.status)} while you work and ${statusWords(result.recorded ?? "")} once you stop.` : ""),
          },
        ],
        structuredContent: { status: "recorded", task: { id: result.task.id, status: result.recorded ?? result.task.status } },
      };
    }
    default:
      return toolError(`no tool called ${JSON.stringify(name)}`);
  }
}

function projectsResult(listing: ProjectListing): unknown {
  const lines: string[] = [];
  for (const row of listing.machines) {
    const name = row.machine.isThis ? "This machine" : (machineAddress(row.machine) ?? "Another machine");
    lines.push(`${name} · agents: ${row.agents.length === 0 ? "none ready" : row.agents.join(", ")}`);
    if (row.projects.length === 0) lines.push("- (no project has had a session here yet; any absolute folder path works)");
    for (const project of row.projects) lines.push(`- ${project}`);
  }
  for (const one of listing.unreachable) lines.push(`(${one.machine} did not answer: ${one.reason})`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      machines: listing.machines.map((row) => ({
        machine: machineAddress(row.machine),
        isThis: row.machine.isThis,
        agents: row.agents,
        projects: row.projects,
      })),
      unreachable: listing.unreachable,
    },
  };
}

function tasksResult(listing: TaskListing): unknown {
  const lines: string[] = [];
  let heading: string | null = null;
  for (const task of listing.tasks) {
    const name = task.machine.isThis ? "This machine" : (machineAddress(task.machine) ?? "Another machine");
    if (name !== heading) {
      heading = name;
      lines.push(`${name}:`);
    }
    const sessions = task.sessions.length === 0 ? "" : ` · ${task.sessions.map((nickname) => `@${nickname}`).join(" ")}`;
    const summary = task.summary === null ? "" : ` · summary: ${JSON.stringify(oneLine(task.summary))}`;
    const holder = task.status !== "ready" || task.assignee === "agent" ? task.agent : task.assignee === "you" ? "your user" : "not assigned";
    lines.push(`- [${statusWords(task.status)}] ${JSON.stringify(task.title)} · ${holder} · ${task.project}${sessions}${summary}`);
  }
  if (listing.tasks.length === 0) lines.push("There are no tasks on the board.");
  for (const one of listing.unreachable) lines.push(`(${one.machine} did not answer: ${one.reason})`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      tasks: listing.tasks.map((task) => ({ ...task, machine: machineAddress(task.machine) })),
      unreachable: listing.unreachable,
    },
  };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_LINE_CHARS ? flat : `${flat.slice(0, SUMMARY_LINE_CHARS - 1)}…`;
}

function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], structuredContent: {}, isError: true };
}
