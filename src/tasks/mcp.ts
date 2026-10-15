import { BOARD_GUIDE, formatBoardError, parseBoard, simulate, type Board } from "@reemoat/board";
import { machineAddress, type ProjectListing, type TaskDesk, type TaskListing } from "./desk.js";
import {
  BOARD_APPLY_TOOL_NAME,
  BOARD_CHECK_TOOL_NAME,
  BOARD_GET_TOOL_NAME,
  BOARD_GUIDE_TOOL_NAME,
  BOARD_PROPOSE_TOOL_NAME,
  BOARD_SIMULATE_TOOL_NAME,
  LIST_PROJECTS_TOOL_NAME,
  LIST_TASKS_TOOL_NAME,
  PROPOSE_TASKS_TOOL_NAME,
  statusWords,
  TASK_UPDATE_TOOL_NAME,
} from "./tools.js";

const SUMMARY_LINE_CHARS = 240;

/** One of the task and board tools, answered as an MCP tool result; a refusal is a sentence for the model, never an HTTP error. */
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
      const pending = result.working && result.recorded !== null && result.recorded !== result.task.status;
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
    case BOARD_GET_TOOL_NAME: {
      // What the config agent writes over must be the newest any machine holds, or board_apply refuses it a moment later.
      if (desk.isBoardAgent(callerId)) await desk.pullNewestBoard();
      const state = desk.engine.current;
      return {
        content: [{ type: "text", text: `Revision ${state.revision}.\n\n${boardWords(state.board)}\n\nThe YAML:\n${state.text}` }],
        structuredContent: { revision: state.revision, hash: state.hash, text: state.text },
      };
    }
    case BOARD_CHECK_TOOL_NAME: {
      const text = args["text"];
      if (typeof text !== "string") return toolError("text is the whole board, as YAML");
      const parsed = parseBoard(text);
      if (!parsed.ok) {
        const lines = parsed.errors.map(formatBoardError);
        return { content: [{ type: "text", text: `It does not parse:\n${lines.join("\n")}` }], structuredContent: { ok: false, errors: lines } };
      }
      return { content: [{ type: "text", text: `It parses.\n\n${boardWords(parsed.board)}` }], structuredContent: { ok: true, errors: [] } };
    }
    case BOARD_SIMULATE_TOOL_NAME: {
      const script = args["script"];
      if (!Array.isArray(script) || script.some((line) => typeof line !== "string")) return toolError("script is a list of lines");
      const text = args["text"];
      let board = desk.engine.current.board;
      if (text !== undefined) {
        if (typeof text !== "string") return toolError("text is a draft of the whole board, as YAML");
        const parsed = parseBoard(text);
        if (!parsed.ok) return toolError(`the draft does not parse:\n${parsed.errors.map(formatBoardError).join("\n")}`);
        board = parsed.board;
      }
      const walked = simulate(board, script as string[]);
      const lines = [...walked.trail, `Ends in ${board.columns.find((one) => one.id === walked.column)?.title ?? walked.column}, ${walked.phase.replace("_", " ")}.`];
      if (walked.refused.length > 0) lines.push(`Lines that did not apply:\n${walked.refused.map((one) => `- ${one}`).join("\n")}`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: walked };
    }
    case BOARD_PROPOSE_TOOL_NAME: {
      const result = desk.proposeBoard(callerId, args);
      if (!result.ok) return toolError(result.message);
      return {
        content: [
          {
            type: "text",
            text:
              `Shown to your user as a card with the change against revision ${result.revision}. It is applied only when they press Apply: ` +
              "apply none of it yourself, and do not ask whether they pressed.",
          },
        ],
        structuredContent: { status: "shown", revision: result.revision },
      };
    }
    case BOARD_GUIDE_TOOL_NAME:
      return { content: [{ type: "text", text: BOARD_GUIDE }] };
    case BOARD_APPLY_TOOL_NAME: {
      const result = await desk.applyBoard(callerId, args);
      if (!result.ok) return toolError(result.message);
      return {
        content: [
          {
            type: "text",
            text:
              `Applied as revision ${result.revision}, here and sent to ${result.sent === 1 ? "one linked machine" : `${result.sent} linked machines`}. ` +
              "Your user sees it as a card with the change and an Undo.",
          },
        ],
        structuredContent: { status: "applied", revision: result.revision, hash: result.hash },
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

/** The board in words for a model: each column, what runs there, how it ends, and where it leads. */
function boardWords(board: Board): string {
  const lines: string[] = [`New tasks land in ${board.intake}. ${board.budget} automatic moves in a row before a person must act.`];
  for (const role of board.roles) {
    lines.push(
      `Role ${role.name}: ${role.agent}${role.model === null ? "" : ` with ${role.model}`}${role.on === null ? "" : ` on ${role.on.join(", ")}`}` +
        `${role.minConfidence === null ? "" : `, abstaining below ${role.minConfidence}`}.`,
    );
  }
  for (const column of board.columns) {
    if (column.kind === "view") {
      lines.push(`- ${column.id} "${column.title}": a view of the conversations no task holds.`);
      continue;
    }
    const exits = column.exits.map((exit) => `${exit.name} → ${exit.to}`).join(", ");
    const judges = column.decide.map((judge) => (judge.kind === "role" ? judge.role : judge.kind)).join(", ");
    if (column.kind === "work") {
      const run = column.run;
      const what = run.skill !== null ? `/${run.skill}` : run.prompt !== null ? "its own prompt" : "the brief or the return hint";
      lines.push(
        `- ${column.id} "${column.title}": runs ${run.role ?? "the task's own agent"} with ${what} in ${run.conversation === "new" ? "a new" : "its last"} ` +
          `conversation, done on ${run.doneWhen === "turn" ? "its turn's end" : "its report"}${column.limit === null ? "" : `, ${column.limit} at once`}; ` +
          `${exits.length === 0 ? "no exits" : `exits ${exits}, decided by ${judges}`}.`,
      );
    } else {
      lines.push(
        `- ${column.id} "${column.title}": waits${column.holder === "you" ? " for your user" : ""}${column.final ? ", and closes the task" : ""}; ` +
          `${exits.length === 0 ? "no exits" : `exits ${exits}, decided by ${judges}`}.`,
      );
    }
  }
  return lines.join("\n");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_LINE_CHARS ? flat : `${flat.slice(0, SUMMARY_LINE_CHARS - 1)}…`;
}

function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], structuredContent: {}, isError: true };
}
