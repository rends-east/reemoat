import { BOARD_GUIDE, formatBoardError, LAST_RUN, parseBoard, simulate, type Board, type MachineOffer } from "@reemoat/board";
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
      const machines = await desk.engine.machines();
      return {
        content: [{ type: "text", text: `Revision ${state.revision}.\n\n${boardWords(state.board)}\n\n${machineWords(machines, desk.engine.ownName())}\n\nThe YAML:\n${state.text}` }],
        structuredContent: { revision: state.revision, hash: state.hash, text: state.text, machines: machineRows(machines, desk.engine.ownName()) },
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
      const machines = await desk.engine.machines();
      const warnings = unknownMachines(parsed.board, machines);
      const warned = warnings.length === 0 ? "" : `\n\nIt parses, but a run would wait for ever on these:\n${warnings.map((one) => `- ${one}`).join("\n")}\n${machineWords(machines, desk.engine.ownName())}`;
      return { content: [{ type: "text", text: `It parses.\n\n${boardWords(parsed.board)}${warned}` }], structuredContent: { ok: true, errors: [], warnings } };
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

/** The machines a role may be pinned to, and the names a board gives them: this one's own once its owner has said it (Q2.274). */
function machineWords(machines: readonly MachineOffer[], ownName: string | null): string {
  const [here, ...others] = machines;
  const runs = (machine: MachineOffer): string => {
    const agents = machine.agents.filter((one) => one.kind !== "classifier").map((one) => one.name);
    return agents.length === 0 ? "runs no agent now" : `runs ${agents.join(", ")}`;
  };
  const lines = ["Machines a role may name in on, or as agent@machine:"];
  if (here !== undefined) {
    lines.push(
      ownName === null
        ? `- this machine, which has no name here yet: name it by its id ${here.key}; ${runs(here)}`
        : `- ${here.name}: this machine (${here.key}); ${runs(here)}`,
    );
  }
  for (const machine of others) lines.push(`- ${machine.name} (${machine.key}); ${runs(machine)}`);
  if (others.length === 0) lines.push("No other machine takes this board's runs: none is linked to this one with moving tasks between them switched on.");
  return lines.join("\n");
}

function machineRows(machines: readonly MachineOffer[], ownName: string | null): unknown[] {
  return machines.map((machine, index) => ({
    name: index === 0 && ownName === null ? null : machine.name,
    id: machine.key,
    this: index === 0,
    agents: machine.agents.filter((one) => one.kind !== "classifier").map((one) => one.name),
  }));
}

/** Every machine a role is pinned to that this machine knows by no name or id: its runs would wait for it for ever. */
function unknownMachines(board: Board, machines: readonly MachineOffer[]): string[] {
  const out: string[] = [];
  for (const role of board.roles) {
    for (const name of role.on ?? []) {
      const lower = name.toLowerCase();
      if (!machines.some((machine) => machine.key === name || machine.name.toLowerCase() === lower)) out.push(`roles.${role.name}: no machine is called ${JSON.stringify(name)}`);
    }
  }
  return out;
}

function projectsResult(listing: ProjectListing): unknown {
  const lines: string[] = [];
  for (const row of listing.machines) {
    const name = row.machine.isThis ? thisMachineWords(row.machine.label) : (machineAddress(row.machine) ?? "Another machine");
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
        name: row.machine.label,
        isThis: row.machine.isThis,
        agents: row.agents,
        projects: row.projects,
      })),
      unreachable: listing.unreachable,
    },
  };
}

function thisMachineWords(name: string | null): string {
  return name === null ? "This machine" : `This machine, ${name}`;
}

function tasksResult(listing: TaskListing): unknown {
  const lines: string[] = [];
  let heading: string | null = null;
  for (const task of listing.tasks) {
    const name = task.machine.isThis ? thisMachineWords(task.machine.label) : (machineAddress(task.machine) ?? "Another machine");
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
        `${role.effort === null ? "" : `, effort ${role.effort}`}${role.mode === null ? "" : `, mode ${role.mode}`}` +
        `${role.minConfidence === null ? "" : `, abstaining below ${role.minConfidence}`}${role.instructions === null ? "" : ", with instructions of its own"}.`,
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
          `conversation${run.code === "none" ? " in an empty folder, with no code" : ""}, done on ${run.doneWhen === "turn" ? "its turn's end" : "its report"}${column.limit === null ? "" : `, ${column.limit} at once`}; ` +
          `${exits.length === 0 ? "no exits" : `exits ${exits}, decided by ${judges}`}.`,
      );
    } else {
      const wake = column.wake;
      const target = (to: string): string => (to === LAST_RUN ? "where it last worked" : to);
      const woken =
        wake === null
          ? "a comment stays a note"
          : wake.decide === null
            ? `a comment sends it to ${target(wake.exits[0]!.to)}`
            : `a comment sends it by ${wake.exits.map((exit) => `${exit.name} → ${target(exit.to)}`).join(", ")}, decided by ${wake.decide.map((judge) => (judge.kind === "role" ? judge.role : judge.kind)).join(", ")}`;
      lines.push(
        `- ${column.id} "${column.title}": waits${column.holder === "you" ? " for your user" : ""}${column.final ? ", and closes the task" : ""}; ` +
          `${exits.length === 0 ? "no exits" : `exits ${exits}, decided by ${judges}`}; ${woken}.`,
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
