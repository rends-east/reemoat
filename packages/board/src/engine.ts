// What happens to a task next, as one pure function of the task, its board and what the owning daemon sees.
import { columnById, isFlow, roleByName, STAY, type Board, type Exit, type FlowColumn, type Role, type WorkColumn } from "./config.js";
import { firstMatch, type RuleFacts } from "./rules.js";
import { renderTemplate, RETURN_BY_HAND_TEMPLATE, RETURN_TEMPLATE, type TemplateValues } from "./template.js";

/** A machine's id; a daemon that was never enrolled is "". */
export type MachineKey = string;

/** Past it a run nobody can take is a person's to sort out. */
export const NO_EXECUTOR_ASK_MS = 24 * 60 * 60 * 1000;
/** Steps one event may take before the daemon stops and waits for the next. */
export const MAX_STEPS_PER_EVENT = 16;

export interface Executor {
  /** The harness. */
  agent: string;
  /** The assembled agent, where the harness runs one. */
  customAgent: string | null;
  machine: MachineKey;
}

export interface AgentOffer {
  id: string;
  /** An assembled agent's own name; the id otherwise. */
  name: string;
  kind: "harness" | "custom" | "classifier";
  /** The harness an assembled agent runs on. */
  harness: string | null;
}

export interface MachineOffer {
  key: MachineKey;
  name: string;
  online: boolean;
  /** Installed, signed in and switched on. */
  agents: readonly AgentOffer[];
  /** Project identities checked out there; null when it cannot say, which counts as every one. */
  projects: readonly string[] | null;
  /** Live runs there, every column: the last tie-breaker. */
  running: number;
}

export type RunState = "pending" | "working" | "ended" | "failed";

export interface DiffStat {
  files: number;
  lines: number;
  paths: string[];
}

export interface TaskRun {
  /** The entry it belongs to: a report, a turn end or a verdict naming another is late. */
  n: number;
  column: string;
  state: RunState;
  executor: Executor | null;
  session: string | null;
  startedAt: number | null;
  /** Turns the session had ended when this run's message went in: one ended after it is this run's. */
  startSeq: number;
  /** The session log's seq before the run's message: what the run said is read from there. */
  logFrom: number;
  /** The task's head when the run began, which its diff is taken from. */
  startHead: string | null;
  /** A task_update with an outcome or status review in this run. */
  reported: boolean;
  /** The exit the run's own agent named. */
  outcome: string | null;
  report: string | null;
  /** The turn end a stop was raised for, so one turn stops the task once. */
  stoppedAt: number | null;
  endedAt: number | null;
  diff: DiffStat | null;
}

export type AskReason =
  | "no_agent"
  | "judge_only"
  | "no_executor"
  | "run_failed"
  | "no_report"
  | "choose_exit"
  | "budget"
  | "code_dirty"
  | "code_diverged"
  | "code_not_portable"
  | "handoff_failed";

/** Raised by the daemon while applying a step; nothing but a person's act takes one back. */
export const STICKY_ASKS: readonly AskReason[] = ["run_failed", "code_dirty", "code_diverged", "code_not_portable", "handoff_failed"];

export type WaitReason = "no_executor" | "limit" | "code_holder_offline";

export type Actor =
  | { kind: "auto" }
  | { kind: "self" }
  | { kind: "rules"; index: number }
  | { kind: "role"; role: string; confidence: number | null }
  | { kind: "human" }
  | { kind: "config" };

export interface Verdict {
  entry: number;
  judge: string;
  /** An exit's name, stay, or null for an abstention. */
  exit: string | null;
  confidence: number | null;
  at: number;
}

export interface TaskCode {
  /** The project's identity: a normalised origin, else the holder's path. */
  repo: string;
  branch: string;
  base: string;
  head: string | null;
  holder: MachineKey;
}

export interface TaskSessionLink {
  id: string;
  /** The column it last ran a run in; null for a conversation attached by hand. */
  column: string | null;
  executor: Executor;
  attachedAt: number;
}

export interface LastRun {
  column: string;
  outcome: string | null;
  report: string | null;
  diff: DiffStat | null;
  agent: string | null;
  /** The agent's last message, as a judge in a later column reads it. */
  message: string | null;
  /** The commits the run went from and to, for a judge that sees the diff. */
  range: { from: string; to: string } | null;
}

export interface BoardTask {
  id: string;
  title: string;
  brief: string;
  summary: string | null;
  column: string;
  /** Grows with every move; a run takes the number of the entry it was made for. */
  entry: number;
  enteredAt: number;
  epoch: number;
  /** Automatic moves left before a person has to act. */
  budget: number;
  /** The task's own agent: what a run with no role launches. */
  own: { agent: string; customAgent: string | null } | null;
  labels: readonly string[];
  visits: Readonly<Record<string, number>>;
  project: string | null;
  code: TaskCode | null;
  run: TaskRun | null;
  /** How many runs this task has had, this one included once it starts. */
  runs: number;
  verdicts: readonly Verdict[];
  ask: { reason: AskReason; entry: number; at: number; detail: string } | null;
  wait: { reason: WaitReason; entry: number; since: number; detail: string } | null;
  judging: { judge: string; entry: number; since: number } | null;
  moving: { kind: "handoff" | "sync"; since: number } | null;
  sessions: readonly TaskSessionLink[];
  from: { column: string; exit: string | null } | null;
  last: LastRun | null;
  /** A person's comments the next run's note carries. */
  notes: readonly string[];
}

export interface WorldSession {
  id: string;
  /** A request waits for a person. */
  blocked: boolean;
  /** A turn, a start, or work nobody prompted. */
  working: boolean;
  /** The seq of the last turn's end. */
  lastTurnEnd: number;
  /** No request, no queued message, no background work: parkable but for the age. */
  settled: boolean;
  /** Stopped by a person, or ended for good. */
  gone: boolean;
}

export interface World {
  now: number;
  self: MachineKey;
  sessions: ReadonlyMap<string, WorldSession>;
  machines: readonly MachineOffer[];
  /** Live runs of a column on a machine, this task's own excepted. */
  busy(column: string, machine: MachineKey, task: string): number;
  /** Tasks waiting for a slot of that column there that entered it first. */
  ahead(task: BoardTask, column: string, machine: MachineKey): number;
  /** Whether this machine holds the head of the task's code, or there is none to hold. */
  hasCode(task: BoardTask): boolean;
}

export type Step =
  | { kind: "nothing" }
  | { kind: "wait"; reason: WaitReason; detail: string }
  | { kind: "handoff"; to: MachineKey; executor: Executor; reason: string }
  | { kind: "sync" }
  | {
      kind: "start";
      executor: Executor;
      /** The conversation it continues, or null for a new one. */
      session: string | null;
      model: string | null;
      message: string;
      note: string;
      reason: string;
      /** Why a continuation asked for was not possible. */
      fresh: string | null;
    }
  | { kind: "end" }
  | { kind: "judge"; judge: string; role: Role; exits: Exit[] }
  | { kind: "move"; to: string; exit: string | null; by: Actor }
  | { kind: "ask"; reason: AskReason; detail: string; turn?: number };

export type Phase = "needs_you" | "working" | "judging" | "moving" | "queued" | "waiting";
export const PHASES: readonly Phase[] = ["needs_you", "working", "judging", "moving", "queued", "waiting"];
export type LegacyStatus = "ready" | "running" | "needs_you" | "review" | "done";

const NOTHING: Step = { kind: "nothing" };

export function step(task: BoardTask, board: Board, world: World): Step {
  const column = columnById(board, task.column);
  if (!isFlow(column)) return { kind: "move", to: board.intake, exit: null, by: { kind: "config" } };
  if (task.ask !== null && task.ask.entry === task.entry && STICKY_ASKS.includes(task.ask.reason)) return NOTHING;
  if (column.kind === "work") {
    const run = task.run;
    // A task that stood here when the board made this a work column gets no run.
    if (run === null || run.n !== task.entry || run.column !== column.id) return NOTHING;
    switch (run.state) {
      case "pending":
        return startStep(task, board, column, world);
      case "working":
        return workingStep(task, column, world) ?? { kind: "end" };
      case "failed":
        return NOTHING;
      case "ended":
        return exitStep(task, board, column);
    }
  }
  if (column.final) return NOTHING;
  return exitStep(task, board, column);
}

/** The run's session says where it is; null is a run over. */
function workingStep(task: BoardTask, column: WorkColumn, world: World): Step | null {
  const run = task.run!;
  const session = run.session === null ? undefined : world.sessions.get(run.session);
  if (session === undefined || session.gone) return { kind: "ask", reason: "run_failed", detail: "the run's conversation was stopped or cannot come back" };
  if (session.blocked || session.working) return NOTHING;
  if (session.lastTurnEnd <= run.startSeq || !session.settled) return NOTHING;
  if (column.run.doneWhen === "turn" || run.reported) return null;
  if (run.stoppedAt === session.lastTurnEnd) return NOTHING;
  return { kind: "ask", reason: "no_report", detail: "the agent ended its turn without a report", turn: session.lastTurnEnd };
}

export interface ResolvedRole {
  /** null is the task's own agent. */
  name: string | null;
  agent: string;
  customAgent: string | null;
  model: string | null;
  on: string[] | null;
  minConfidence: number | null;
}

/** Who a run is for: the role it names, else the task's own agent, else the role called default. */
export function runRole(task: BoardTask, board: Board, column: WorkColumn): ResolvedRole | null {
  if (column.run.role !== null) {
    const role = roleByName(board, column.run.role);
    return role === null ? null : fromRole(role);
  }
  if (task.own !== null) return { name: null, agent: task.own.agent, customAgent: task.own.customAgent, model: null, on: null, minConfidence: null };
  const fallback = roleByName(board, "default");
  return fallback === null ? null : fromRole(fallback);
}

function fromRole(role: Role): ResolvedRole {
  return { name: role.name, agent: role.agent, customAgent: null, model: role.model, on: role.on, minConfidence: role.minConfidence };
}

function startStep(task: BoardTask, board: Board, column: WorkColumn, world: World): Step {
  const role = runRole(task, board, column);
  if (role === null) return { kind: "ask", reason: "no_agent", detail: "assign an agent" };
  if (isClassifier(role, world)) return { kind: "ask", reason: "judge_only", detail: `${role.agent} only decides; it cannot run a column's work` };
  const placed = place({ role, conversation: column.run.conversation, column: column.id, task, world });
  if (!placed.ok) {
    const waited = task.wait !== null && task.wait.reason === "no_executor" && task.wait.entry === task.entry ? world.now - task.wait.since : 0;
    if (waited >= NO_EXECUTOR_ASK_MS) return { kind: "ask", reason: "no_executor", detail: `nothing could run ${placed.wanted} for a day` };
    return { kind: "wait", reason: "no_executor", detail: `waiting for ${placed.wanted}` };
  }
  if (placed.executor.machine !== world.self) return { kind: "handoff", to: placed.executor.machine, executor: placed.executor, reason: placed.reason };
  if (column.limit !== null) {
    const taken = world.busy(column.id, world.self, task.id) + world.ahead(task, column.id, world.self);
    if (taken >= column.limit) return { kind: "wait", reason: "limit", detail: `${column.title} runs ${column.limit} at once here` };
  }
  if (!world.hasCode(task)) {
    const holder = task.code === null ? undefined : world.machines.find((machine) => machine.key === task.code!.holder);
    if (holder === undefined || !holder.online) return { kind: "wait", reason: "code_holder_offline", detail: `waiting for ${holder?.name ?? "the machine with the code"}` };
    return { kind: "sync" };
  }
  const continues = placed.session !== null;
  return {
    kind: "start",
    executor: placed.executor,
    session: placed.session,
    model: role.model,
    message: runMessage(task, board, column, continues),
    note: runNote(task, board, column, continues),
    reason: placed.reason,
    fresh: placed.fresh,
  };
}

function isClassifier(role: ResolvedRole, world: World): boolean {
  if (role.customAgent !== null) return false;
  const offers = world.machines.flatMap((machine) => machine.agents.filter((agent) => agent.id === role.agent || agent.name === role.agent));
  return offers.length > 0 && offers.every((agent) => agent.kind === "classifier");
}

function exitStep(task: BoardTask, board: Board, column: FlowColumn): Step {
  const exits = column.exits;
  if (exits.length === 0) return NOTHING;
  if (column.kind === "work" && exits.length === 1) return spend(task, { kind: "move", to: exits[0]!.to, exit: exits[0]!.name, by: { kind: "auto" } });
  const named = (name: string | null): Exit | undefined => exits.find((exit) => exit.name === name);
  for (const judge of column.decide) {
    switch (judge.kind) {
      case "self": {
        const exit = named(column.kind === "work" ? (task.run?.outcome ?? null) : null);
        if (exit !== undefined) return spend(task, { kind: "move", to: exit.to, exit: exit.name, by: { kind: "self" } });
        break;
      }
      case "rules": {
        const hit = firstMatch(judge.rules, factsOf(task));
        if (hit === null) break;
        if (hit.then === STAY) return human(task, column);
        const exit = named(hit.then);
        if (exit !== undefined) return spend(task, { kind: "move", to: exit.to, exit: exit.name, by: { kind: "rules", index: hit.index } });
        break;
      }
      case "role": {
        const verdict = task.verdicts.find((one) => one.entry === task.entry && one.judge === judge.role);
        if (verdict === undefined) {
          if (task.judging !== null && task.judging.entry === task.entry && task.judging.judge === judge.role) return NOTHING;
          const role = roleByName(board, judge.role);
          if (role === null) break;
          return { kind: "judge", judge: judge.role, role, exits };
        }
        if (verdict.exit === STAY) return human(task, column);
        const exit = named(verdict.exit);
        if (exit !== undefined) {
          return spend(task, { kind: "move", to: exit.to, exit: exit.name, by: { kind: "role", role: judge.role, confidence: verdict.confidence } });
        }
        break;
      }
      case "human":
        return human(task, column);
    }
  }
  return human(task, column);
}

/** A person picks: in a work column the task needs them, in a waiting one its buttons wait. */
function human(task: BoardTask, column: FlowColumn): Step {
  if (column.kind === "wait") return NOTHING;
  if (task.ask !== null && task.ask.entry === task.entry && task.ask.reason === "choose_exit") return NOTHING;
  return { kind: "ask", reason: "choose_exit", detail: "pick where the task goes next" };
}

function spend(task: BoardTask, move: Step & { kind: "move" }): Step {
  if (task.budget > 0) return move;
  if (task.ask !== null && task.ask.entry === task.entry && task.ask.reason === "budget") return NOTHING;
  return { kind: "ask", reason: "budget", detail: "the board moved this task as many times in a row as it may without you" };
}

export function factsOf(task: BoardTask): RuleFacts {
  const run = task.run !== null && task.run.state === "ended" ? task.run : null;
  return {
    outcome: run?.outcome ?? task.last?.outcome ?? null,
    labels: task.labels,
    visits: task.visits,
    diff: run?.diff ?? task.last?.diff ?? null,
    agent: run?.executor?.agent ?? task.last?.agent ?? null,
    project: task.project,
  };
}

export function templateValues(task: BoardTask, board: Board): TemplateValues {
  const from = task.from === null ? null : columnById(board, task.from.column);
  return {
    "task.title": task.title,
    "task.brief": task.brief,
    "task.summary": task.summary ?? "",
    "from.column": from?.title ?? task.from?.column ?? "",
    "from.exit": task.from?.exit ?? "",
    "from.report": task.last?.report ?? "no report",
  };
}

/**
 * `/<skill> <args>`, else the column's prompt, else the brief where the run opens a conversation and the return hint
 * where it continues one: a new conversation knows nothing of the task, and one that worked on it knows the brief.
 */
export function runMessage(task: BoardTask, board: Board, column: WorkColumn, continues: boolean): string {
  const run = column.run;
  if (run.skill !== null) return run.args === null ? `/${run.skill}` : `/${run.skill} ${run.args}`;
  if (run.prompt !== null) return renderTemplate(run.prompt, templateValues(task, board));
  if (!continues || task.runs === 0) return task.brief;
  return returnHint(task, board);
}

/** The return hint, without the exit's parentheses where a person sent it back by hand and named none. */
function returnHint(task: BoardTask, board: Board): string {
  return renderTemplate(task.from?.exit == null ? RETURN_BY_HAND_TEMPLATE : RETURN_TEMPLATE, templateValues(task, board));
}

/** The block after a run's message: whose task, which column, how it ends, and what its person wrote since. */
export function runNote(task: BoardTask, board: Board, column: WorkColumn, continues: boolean): string {
  const lines: string[] = [];
  lines.push(
    `Added by Reemoat, not written by your user: this conversation works on the task "${noteText(task.title)}" on their task board, ` +
      `now in its ${noteText(column.title)} column.`,
  );
  if (!continues) {
    const sentBrief = column.run.skill === null && column.run.prompt === null;
    if (!sentBrief) lines.push(`The task's brief:\n${task.brief}`);
    if (task.runs > 0 && task.from !== null) lines.push(returnHint(task, board));
  }
  const chooses = column.exits.length >= 2 && column.decide.some((judge) => judge.kind === "self");
  if (chooses) {
    lines.push(
      "When this column's work is done, call task_update with a short summary and outcome set to the one that fits:\n" +
        column.exits.map((exit) => `- ${exit.name}: ${exit.means ?? exit.label}`).join("\n"),
    );
  } else if (column.run.doneWhen === "report") {
    lines.push("When this column's work is done, call task_update with a short summary and status review; the task waits for that call.");
  }
  if (task.notes.length > 0) lines.push(`Your user wrote on the task since:\n${task.notes.map((note) => `- ${note}`).join("\n")}`);
  lines.push(
    "If you need your user, ask with your question tool and wait for the answer: a question in prose ends your turn, and a turn that ends " +
      "without task_update stops the task until they come.",
  );
  return `<board-task>\n${lines.join("\n")}\n</board-task>`;
}

function noteText(value: string): string {
  return value.replace(/[<>"\r\n\t]/g, " ");
}

export interface PlaceInput {
  role: ResolvedRole;
  conversation: "continue" | "new";
  column: string;
  task: BoardTask;
  world: World;
}

export type Placement =
  | { ok: true; executor: Executor; session: string | null; reason: string; fresh: string | null }
  | { ok: false; wanted: string };

function offerFor(machine: MachineOffer, role: ResolvedRole): AgentOffer | null {
  const want = role.customAgent ?? role.agent;
  const lower = want.toLowerCase();
  const runnable = machine.agents.filter((agent) => agent.kind !== "classifier");
  return (
    runnable.find((agent) => agent.id === want) ??
    runnable.find((agent) => agent.kind === "custom" && agent.name.toLowerCase() === lower) ??
    null
  );
}

function executorOf(machine: MachineOffer, offer: AgentOffer): Executor {
  return offer.kind === "custom"
    ? { agent: offer.harness ?? offer.id, customAgent: offer.id, machine: machine.key }
    : { agent: offer.id, customAgent: null, machine: machine.key };
}

function machineNamed(machines: readonly MachineOffer[], name: string): MachineOffer | undefined {
  const lower = name.toLowerCase();
  return machines.find((machine) => machine.key === name) ?? machines.find((machine) => machine.name.toLowerCase() === lower);
}

export function executorName(executor: Executor, machines: readonly MachineOffer[]): string {
  const machine = machines.find((one) => one.key === executor.machine);
  return `${executor.customAgent ?? executor.agent}@${machine?.name ?? (executor.machine || "this machine")}`;
}

/**
 * One executor for a run, deterministically: the conversation it continues, else the first machine the role is
 * pinned to (code goes to work), else where the code is (work goes to code), else the owner, the least busy, by name.
 */
export function place(input: PlaceInput): Placement {
  const { role, task, world } = input;
  const allowed = role.on === null ? null : role.on.map((name) => machineNamed(world.machines, name)).filter((one): one is MachineOffer => one !== undefined);
  const candidate = (machine: MachineOffer): AgentOffer | null => {
    if (!machine.online) return null;
    if (allowed !== null && !allowed.includes(machine)) return null;
    const project = task.project;
    const hasProject = project === null || machine.projects === null || machine.projects.includes(project) || task.code?.holder === machine.key;
    return hasProject ? offerFor(machine, role) : null;
  };

  let fresh: string | null = null;
  if (input.conversation === "continue") {
    const mine = [...task.sessions].sort((a, b) => b.attachedAt - a.attachedAt);
    const last = mine.find((one) => one.column === input.column) ?? mine[0];
    if (last !== undefined) {
      const machine = world.machines.find((one) => one.key === last.executor.machine);
      const offer = machine === undefined ? null : candidate(machine);
      const live = world.sessions.get(last.id);
      const same = offer !== null && executorOf(machine!, offer);
      if (live !== undefined && !live.gone && same && same.agent === last.executor.agent && same.customAgent === last.executor.customAgent) {
        return { ok: true, executor: last.executor, session: last.id, reason: "continues its conversation", fresh: null };
      }
      fresh =
        live === undefined || live.gone
          ? "its last conversation is over"
          : `its last conversation is with ${executorName(last.executor, world.machines)}, which this role does not run`;
    }
  }

  const pick = (machine: MachineOffer | undefined, reason: string): Placement | null => {
    if (machine === undefined) return null;
    const offer = candidate(machine);
    return offer === null ? null : { ok: true, executor: executorOf(machine, offer), session: null, reason, fresh };
  };

  if (allowed !== null) {
    for (const machine of allowed) {
      const placed = pick(machine, "the role is pinned there");
      if (placed !== null) return placed;
    }
  } else if (task.code !== null) {
    const placed = pick(world.machines.find((machine) => machine.key === task.code!.holder), "the code is there");
    if (placed !== null) return placed;
  }
  const owner = pick(world.machines.find((machine) => machine.key === world.self), "the task is here");
  if (owner !== null) return owner;
  const rest = world.machines
    .filter((machine) => candidate(machine) !== null)
    .sort((a, b) => a.running - b.running || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1));
  if (rest.length > 0) return pick(rest[0], rest.length > 1 && rest[0]!.running < rest[1]!.running ? "it runs the least" : "the first by name")!;
  const agent = role.customAgent ?? role.agent;
  return { ok: false, wanted: role.on === null ? agent : `${agent}@${role.on.join("|")}` };
}

/** Sessions first, then the run, then the column. */
export function phase(task: BoardTask, sessions: ReadonlyMap<string, Pick<WorldSession, "blocked" | "working">>): Phase {
  const live = task.sessions.map((link) => sessions.get(link.id)).filter((one) => one !== undefined);
  if (live.some((session) => session.blocked)) return "needs_you";
  if (live.some((session) => session.working)) return "working";
  if (task.ask !== null && task.ask.entry === task.entry) return "needs_you";
  if (task.judging !== null && task.judging.entry === task.entry) return "judging";
  if (task.moving !== null) return "moving";
  const run = task.run !== null && task.run.n === task.entry ? task.run : null;
  if (run?.state === "pending") return "queued";
  if (run?.state === "working") return "working";
  return "waiting";
}

/** The status a client from before the board reads, by the phase table; a closed task is done whatever its sessions do. */
export function legacyStatus(taskPhase: Phase, column: string, board: Board): LegacyStatus {
  const at = columnById(board, column);
  if (at !== null && at.kind === "wait" && at.final) return "done";
  if (taskPhase === "needs_you") return "needs_you";
  if (taskPhase !== "waiting") return "running";
  return column === board.intake ? "ready" : "review";
}

/** Who holds the task while it waits: a column's holder, or nobody where it names none. */
export function columnHolder(board: Board, column: string): "you" | "nobody" {
  const at = columnById(board, column);
  return at !== null && at.kind === "wait" ? at.holder : "nobody";
}

/** The exits a person may press now: a waiting column's, and a work column's once its run asks them to pick. */
export function humanExits(task: BoardTask, board: Board): Exit[] {
  const column = columnById(board, task.column);
  if (!isFlow(column)) return [];
  if (column.kind === "wait") return column.exits;
  return task.ask !== null && task.ask.entry === task.entry && task.ask.reason === "choose_exit" ? column.exits : [];
}

/** Where an older client's status puts a task: the intake, the first work column, a column its person holds, a final one. */
export function columnForStatus(board: Board, status: "ready" | "running" | "review" | "done"): string {
  const flow = board.columns.filter(isFlow);
  const pick = (test: (column: (typeof flow)[number]) => boolean): string | undefined => flow.find(test)?.id;
  switch (status) {
    case "ready":
      return board.intake;
    case "running":
      return pick((column) => column.kind === "work") ?? board.intake;
    case "review":
      return pick((column) => column.id === "review") ?? pick((column) => column.kind === "wait" && column.holder === "you" && !column.final) ?? board.intake;
    case "done":
      return pick((column) => column.kind === "wait" && column.final) ?? flow.at(-1)?.id ?? board.intake;
  }
}
