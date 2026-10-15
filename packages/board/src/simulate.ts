// A task walked through a board on paper: each line of the script is what an agent, a role or a person does, and every
// step between them is `step` itself, applied as the daemon applies it (Q2.268).
import { applyStep, humanActed, withReport, withVerdict } from "./apply.js";
import { columnById, STAY, type Board } from "./config.js";
import { phase, step, type BoardTask, type MachineOffer, type Phase, type World, type WorldSession } from "./engine.js";

export const MAX_SIMULATED_EVENTS = 64;
const MAX_TRAIL = 400;

export interface Simulated {
  trail: string[];
  column: string;
  phase: Phase;
  /** Lines of the script that did not apply where the task was, each with why. */
  refused: string[];
}

/** One machine that runs every agent the board names, so a walk shows the board and never a machine's absence. */
function everyAgent(board: Board): MachineOffer {
  const ids = [...new Set(["*", ...board.roles.map((role) => role.agent)])];
  return { key: "", name: "this machine", online: true, agents: ids.map((id) => ({ id, name: id, kind: "harness", harness: null })), projects: null, running: 0 };
}

/**
 * Script lines: `report` (the run's agent reports and its turn ends), `outcome <exit>` (it names an exit), `silent` (its turn
 * ends with no report), `<role> <exit|stay|none> [confidence]` (a role's answer when it is asked), `move <column>` and
 * `press <exit>` (a person). A task starts in the intake, owned by an agent every machine runs.
 */
export function simulate(board: Board, script: readonly string[], title = "A task"): Simulated {
  const trail: string[] = [];
  const refused: string[] = [];
  let at = 1;
  let turns = 0;
  let task: BoardTask = {
    id: "t_sim",
    title,
    brief: "The brief.",
    summary: null,
    column: board.intake,
    entry: 1,
    enteredAt: 0,
    epoch: 1,
    budget: board.budget,
    own: { agent: "*", customAgent: null },
    labels: [],
    visits: { [board.intake]: 1 },
    project: null,
    code: null,
    run: null,
    runs: 0,
    verdicts: [],
    ask: null,
    wait: null,
    judging: null,
    moving: null,
    sessions: [],
    from: null,
    last: null,
    notes: [],
  };
  const sessions = new Map<string, WorldSession>();
  const here = everyAgent(board);
  const title_ = (id: string): string => columnById(board, id)?.title ?? id;
  const world = (): World => ({
    now: at,
    self: "",
    sessions,
    machines: [here],
    busy: () => 0,
    ahead: () => 0,
    hasCode: () => true,
  });
  const say = (line: string): void => {
    if (trail.length < MAX_TRAIL) trail.push(line);
  };

  const drive = (): void => {
    for (let i = 0; i < 16; i += 1) {
      const next = step(task, board, world());
      at += 1;
      switch (next.kind) {
        case "nothing":
          return;
        case "wait":
          say(`waits: ${next.detail}`);
          task = applyStep(task, board, next, at);
          return;
        case "ask":
          say(`needs you: ${next.detail}`);
          task = applyStep(task, board, next, at);
          return;
        case "judge":
          say(`asks ${next.judge}`);
          task = applyStep(task, board, next, at);
          return;
        case "start": {
          const id = next.session ?? `s${sessions.size + 1}`;
          sessions.set(id, { id, blocked: false, working: true, lastTurnEnd: turns, settled: false, gone: false });
          say(`${title_(task.column)} runs in ${next.session === null ? "a new conversation" : "its conversation"}: ${next.message.split("\n")[0]}`);
          task = applyStep(task, board, next, at, { session: id, startSeq: turns, logFrom: 0, startHead: null });
          break;
        }
        case "end":
          say(`${title_(task.column)}'s run ends`);
          task = applyStep(task, board, next, at);
          break;
        case "move":
          say(`${title_(task.column)} → ${title_(next.to)}${next.exit !== null && next.exit !== "next" ? ` (${next.exit})` : ""} by ${next.by.kind === "role" ? next.by.role : next.by.kind === "config" ? "the board" : next.by.kind}`);
          task = applyStep(task, board, next, at);
          break;
        case "handoff":
        case "sync":
          say("would go to another machine");
          return;
      }
    }
  };

  const endTurn = (report: { outcome: string | null; review: boolean } | null): void => {
    const run = task.run;
    if (run === null || run.state !== "working" || run.session === null) {
      refused.push("no run is at work here");
      return;
    }
    if (report !== null) task = withReport(task, { session: run.session, summary: "a report", outcome: report.outcome, review: report.review });
    turns += 1;
    sessions.set(run.session, { id: run.session, blocked: false, working: false, lastTurnEnd: turns, settled: true, gone: false });
    drive();
  };

  drive();
  for (const raw of script.slice(0, MAX_SIMULATED_EVENTS)) {
    const line = raw.trim();
    const [word = "", arg = "", extra = ""] = line.split(/\s+/);
    if (word === "report") endTurn({ outcome: null, review: true });
    else if (word === "silent") endTurn(null);
    else if (word === "outcome") {
      const column = columnById(board, task.column);
      if (column === null || column.kind === "view" || !column.exits.some((exit) => exit.name === arg)) refused.push(`${line}: ${title_(task.column)} has no exit ${arg}`);
      else endTurn({ outcome: arg, review: false });
    } else if (word === "move" || word === "press") {
      const column = columnById(board, task.column);
      const exit = word === "press" && column !== null && column.kind !== "view" ? column.exits.find((one) => one.name === arg) : undefined;
      const to = word === "move" ? arg : exit?.to;
      const target = to === undefined ? null : columnById(board, to);
      if (target === null || target.kind === "view") {
        refused.push(`${line}: ${word === "move" ? `there is no column ${arg}` : `${title_(task.column)} has no exit ${arg}`}`);
        continue;
      }
      say(`${title_(task.column)} → ${target.title}${exit !== undefined && exit.name !== "next" ? ` (${exit.name})` : ""} by you`);
      task = humanActed(applyStep(task, board, { kind: "move", to: target.id, exit: exit?.name ?? null, by: { kind: "human" } }, (at += 1)), board);
      drive();
    } else if (task.judging !== null && task.judging.judge === word) {
      const exit = arg === "none" ? null : arg;
      const confidence = extra.length > 0 ? Number(extra) : null;
      const role = board.roles.find((one) => one.name === word);
      const floor = role?.minConfidence ?? null;
      const below = floor !== null && confidence !== null && Number.isFinite(confidence) && confidence < floor;
      say(`${word} answers ${arg}${confidence === null ? "" : ` · ${Math.round(confidence * 100)}%`}${below ? ", below its floor" : ""}`);
      task = withVerdict(task, { entry: task.entry, judge: word, exit: below ? null : exit === STAY ? STAY : exit, confidence, at });
      drive();
    } else {
      refused.push(`${line}: nothing here is waiting for that`);
    }
  }
  return { trail, column: task.column, phase: phase(task, new Map([...sessions].map(([id, one]) => [id, one]))), refused };
}
