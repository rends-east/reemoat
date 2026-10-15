#!/usr/bin/env node
import { parseDocument } from "yaml";
import {
  applyStep,
  boardHash,
  DEFAULT_BOARD_TEXT,
  firstMatch,
  formatBoardError,
  globRegExp,
  humanActed,
  humanExits,
  legacyStatus,
  newerBoard,
  NO_EXECUTOR_ASK_MS,
  parseBoard,
  parseTemplate,
  phase,
  place,
  renderTemplate,
  REVIEW_LOOP_LOCAL_TEXT,
  REVIEW_LOOP_TEXT,
  runMessage,
  runNote,
  simulate,
  step,
  withReport,
  withVerdict,
  type Board,
  type BoardTask,
  type MachineOffer,
  type Phase,
  type ResolvedRole,
  type RuleFacts,
  type Step,
  type TaskRun,
  type World,
  type WorldSession,
} from "@reemoat/board";
import { REFUSALS } from "./boardcheck.cases.js";

/** Regression driver for packages/board: every parseBoard refusal on its own, YAML's strictness, and step, place and phase by table. */

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function parsed(text: string): Board {
  const result = parseBoard(text);
  if (!result.ok) throw new Error(`boardcheck: a fixture does not parse: ${result.errors.map(formatBoardError).join("; ")}`);
  return result.board;
}

function refusals(text: string): string {
  const result = parseBoard(text);
  return result.ok ? "PARSED" : result.errors.map(formatBoardError).join("\n");
}

process.stdout.write("parseBoard: every refusal, one at a time\n");
for (const one of REFUSALS) check(one.name, refusals(one.text), one.want);
check("the refusal table covers each case once", new Set(REFUSALS.map((one) => one.name)).size, REFUSALS.length);

process.stdout.write("\nYAML's strictness\n");
{
  // Each of the four is something the yaml package accepts by itself, which is why each is refused here.
  const alias = "version: 1\ncolumns:\n  - &c { id: a, title: A }\n  - *c\n";
  check("an alias resolves without the refusal", parseDocument(alias).toJS().columns.length, 2);
  check("an alias is refused", refusals(alias).includes("aliases are not allowed"), true);
  const twice = "version: 1\nversion: 1\ncolumns: [{ id: a, title: A }]\n";
  check("a repeated key is an error the parser reports", parseDocument(twice).errors.length > 0, true);
  check("a repeated key is refused", refusals(twice), "2:1 board: a key is written twice");
  const binary = "version: 1\ncolumns: [{ id: a, title: !!binary QQ== }]\n";
  check("the core schema turns !!binary into bytes by itself", parseDocument(binary).toJS().columns[0].title instanceof Uint8Array, true);
  check("a tag is refused", refusals(binary), "2:36 columns[0].title: tags are not allowed (!!binary)");
  const yes = parseBoard("version: 1\ncolumns: [{ id: a, title: yes }, { id: b, title: on }]\n");
  check("yes and on stay words under YAML 1.2", yes.ok ? yes.board.columns.map((column) => column.title) : null, ["yes", "on"]);
  check("final: yes is not a boolean", refusals("version: 1\ncolumns: [{ id: a, title: A, final: yes }]\n"), "2:37 columns[0].final: final is true or false");
  const commented = "# my board\nversion: 1 # one\ncolumns:\n  - { id: a, title: A } # the only one\n";
  check("comments are allowed", parseBoard(commented).ok, true);
  check("the hash is over the text, comments included", boardHash(commented) === boardHash(commented.replace("# one", "# two")), false);
  check("the hash is hex sha-256", /^[0-9a-f]{64}$/.test(boardHash(commented)), true);
  check("a higher revision is newer", newerBoard({ revision: 3, hash: "f" }, { revision: 2, hash: "0" }), true);
  check("one revision: the smaller hash wins", newerBoard({ revision: 3, hash: "0a" }, { revision: 3, hash: "0b" }), true);
  check("one revision: the larger hash does not", newerBoard({ revision: 3, hash: "0b" }, { revision: 3, hash: "0a" }), false);
}

process.stdout.write("\nthe presets\n");
const DEFAULT = parsed(DEFAULT_BOARD_TEXT);
const LOOP = parsed(REVIEW_LOOP_LOCAL_TEXT);
const PINNED = parsed(REVIEW_LOOP_TEXT);
{
  check(
    "the default is today's four columns",
    DEFAULT.columns.map((column) => [column.id, column.kind, column.kind === "wait" ? [column.holder, column.final] : null]),
    [
      ["backlog", "wait", ["nobody", false]],
      ["running", "work", null],
      ["review", "wait", ["you", false]],
      ["done", "wait", ["nobody", true]],
    ],
  );
  check("the default takes new tasks in the backlog", DEFAULT.intake, "backlog");
  const running = DEFAULT.columns[1]!;
  check(
    "Running runs the task's own agent until its report, then goes to Review",
    running.kind === "work" ? [running.run.role, running.run.doneWhen, running.run.conversation, running.exits] : null,
    [null, "report", "continue", [{ name: "next", to: "review", means: null, label: "Review" }]],
  );
  check("the default budget is 8", DEFAULT.budget, 8);
  check("the reference pins the reviewer to the server", PINNED.roles.find((role) => role.name === "reviewer")?.on, ["server"]);
  check("the local fixture pins it nowhere", LOOP.roles.find((role) => role.name === "reviewer")?.on, null);
  check("the reference's intake skips the view", PINNED.intake, "backlog");
  const review = LOOP.columns.find((column) => column.id === "review");
  check(
    "Review asks itself, then the cheap model, then you",
    review !== undefined && review.kind === "work" ? review.decide.map((judge) => (judge.kind === "role" ? judge.role : judge.kind)) : null,
    ["self", "cheap", "human"],
  );
  check("claude@server is claude on server", parsed("version: 1\nroles: { r: { agent: claude@server } }\ncolumns: [{ id: a, title: A }]\n").roles[0], {
    name: "r",
    agent: "claude",
    model: null,
    on: ["server"],
    minConfidence: null,
  });
}

process.stdout.write("\ntemplates\n");
{
  const template = parseTemplate("Fix {{ task.title }} after {{from.exit}}: {{from.report}}");
  check("a template parses", typeof template === "object", true);
  if (typeof template === "object") {
    check(
      "values go in as they are",
      renderTemplate(template, {
        "task.title": "<b>",
        "task.brief": "",
        "task.summary": "",
        "from.column": "Review",
        "from.exit": "fix",
        "from.report": "{{task.title}}",
      }),
      "Fix <b> after fix: {{task.title}}",
    );
  }
  check("a single brace is text", typeof parseTemplate("a { b } c"), "object");
}

process.stdout.write("\nrules\n");
{
  check("* stays in a segment", [globRegExp("src/*.ts").test("src/a.ts"), globRegExp("src/*.ts").test("src/a/b.ts")], [true, false]);
  check("** crosses segments", [globRegExp("src/**/*.ts").test("src/a/b.ts"), globRegExp("src/**/*.ts").test("src/b.ts")], [true, true]);
  check("? is one character", [globRegExp("a?c").test("abc"), globRegExp("a?c").test("a/c")], [true, false]);
  check("a dot is a dot", globRegExp("a.ts").test("abts"), false);
  const board = parsed(
    "version: 1\ncolumns:\n  - { id: a, title: A }\n  - id: w\n    title: W\n    run: {}\n    next: { go: { to: a, means: m }, back: { to: a, means: m } }\n" +
      "    decide:\n      - rules:\n          - { when: { diff.lines: { lte: 20 }, diff.paths: { match: 'docs/**' } }, then: go }\n" +
      "          - { when: { visits.w: { gte: 3 } }, then: stay }\n          - { when: { labels: { has: urgent }, agent: { in: [claude, codex] } }, then: back }\n",
  );
  const column = board.columns[1]!;
  const rules = column.kind === "work" && column.decide[0]!.kind === "rules" ? column.decide[0]!.rules : [];
  const facts = (over: Partial<RuleFacts>): RuleFacts => ({ outcome: null, labels: [], visits: {}, diff: null, agent: null, project: null, ...over });
  check("a small docs diff goes", firstMatch(rules, facts({ diff: { files: 1, lines: 5, paths: ["docs/a/b.md"] } })), { index: 0, then: "go" });
  check("a large one does not", firstMatch(rules, facts({ diff: { files: 1, lines: 50, paths: ["docs/a.md"] } })), null);
  check("no diff makes every diff fact false", firstMatch(rules, facts({ visits: { w: 1 } })), null);
  check("the third visit stays", firstMatch(rules, facts({ visits: { w: 3 } })), { index: 1, then: "stay" });
  check("every condition of a rule must hold", firstMatch(rules, facts({ labels: ["urgent"], agent: "kimi" })), null);
  check("and then it matches", firstMatch(rules, facts({ labels: ["urgent"], agent: "codex" })), { index: 2, then: "back" });
}

// The world one daemon sees, on one machine unless a check says otherwise.
const CLAUDE = { id: "claude", name: "claude", kind: "harness", harness: null } as const;
const MAC: MachineOffer = { key: "m-mac", name: "mac", online: true, agents: [CLAUDE], projects: null, running: 0 };
const SERVER: MachineOffer = { key: "m-srv", name: "server", online: true, agents: [CLAUDE], projects: null, running: 0 };

function task(over: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "t1",
    title: "Fix the login",
    brief: "The login button does nothing.",
    summary: null,
    column: "backlog",
    entry: 1,
    enteredAt: 0,
    epoch: 1,
    budget: 8,
    own: { agent: "claude", customAgent: null },
    labels: [],
    visits: {},
    project: "github.com/rends-east/reemoat",
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
    ...over,
  };
}

function run(over: Partial<TaskRun> = {}): TaskRun {
  return {
    n: 1,
    column: "build",
    state: "pending",
    executor: null,
    session: null,
    startedAt: null,
    startSeq: 0,
    logFrom: 0,
    startHead: null,
    reported: false,
    outcome: null,
    report: null,
    stoppedAt: null,
    endedAt: null,
    diff: null,
    ...over,
  };
}

function session(over: Partial<WorldSession> & { id: string }): WorldSession {
  return { blocked: false, working: false, lastTurnEnd: 0, settled: true, gone: false, ...over };
}

function world(over: Partial<World> & { list?: WorldSession[] } = {}): World {
  const { list, ...rest } = over;
  return {
    now: 10_000,
    self: MAC.key,
    sessions: new Map((list ?? []).map((one) => [one.id, one])),
    machines: [MAC],
    busy: () => 0,
    ahead: () => 0,
    hasCode: () => true,
    ...rest,
  };
}

const kindOf = (one: Step): string => (one.kind === "ask" || one.kind === "wait" ? `${one.kind}:${one.reason}` : one.kind);

process.stdout.write("\nstep, by table\n");
{
  const building = (over: Partial<TaskRun>): BoardTask =>
    task({ column: "build", run: run({ state: "working", session: "s1", executor: { agent: "claude", customAgent: null, machine: MAC.key }, startSeq: 10, ...over }) });
  const rows: [string, Board, BoardTask, World, string][] = [
    ["a backlog task waits", LOOP, task(), world(), "nothing"],
    ["a done task waits", LOOP, task({ column: "done" }), world(), "nothing"],
    ["a column the board lost sends the task to intake", LOOP, task({ column: "gone" }), world(), "move"],
    ["a view is no place for a task", PINNED, task({ column: "chats" }), world(), "move"],
    ["a work column with no run for this entry waits", LOOP, task({ column: "build", run: null }), world(), "nothing"],
    ["a run from an earlier entry waits", LOOP, task({ column: "build", entry: 3, run: run({ n: 2 }) }), world(), "nothing"],
    ["a pending run starts", LOOP, task({ column: "build", run: run() }), world(), "start"],
    ["no machine offers the agent: wait", LOOP, task({ column: "build", run: run() }), world({ machines: [{ ...MAC, agents: [] }] }), "wait:no_executor"],
    [
      "a day without one: ask", LOOP,
      task({ column: "build", run: run(), wait: { reason: "no_executor", entry: 1, since: 0, detail: "" } }),
      world({ machines: [{ ...MAC, agents: [] }], now: NO_EXECUTOR_ASK_MS }),
      "ask:no_executor",
    ],
    ["a task with no agent and a role with none: ask", DEFAULT, task({ column: "running", run: run({ column: "running" }), own: null }), world(), "ask:no_agent"],
    ["a full column queues", LOOP, task({ column: "build", run: run() }), world({ busy: () => 3 }), "wait:limit"],
    ["so does one with others ahead", LOOP, task({ column: "build", run: run() }), world({ busy: () => 2, ahead: () => 1 }), "wait:limit"],
    ["a slot left starts", LOOP, task({ column: "build", run: run() }), world({ busy: () => 2 }), "start"],
    ["a run another machine is pinned to hands off", PINNED, task({ column: "review", run: run({ column: "review" }) }), world({ machines: [MAC, SERVER] }), "handoff"],
    ["the pinned machine away: wait", PINNED, task({ column: "review", run: run({ column: "review" }) }), world({ machines: [MAC, { ...SERVER, online: false }] }), "wait:no_executor"],
    [
      "code held elsewhere is fetched first", LOOP,
      task({ column: "build", run: run(), code: { repo: "r", branch: "b", base: "c0", head: "c1", holder: SERVER.key } }),
      world({ machines: [MAC, { ...SERVER, agents: [] }], hasCode: () => false }),
      "sync",
    ],
    [
      "with its holder away the run waits", LOOP,
      task({ column: "build", run: run(), code: { repo: "r", branch: "b", base: "c0", head: "c1", holder: SERVER.key } }),
      world({ machines: [MAC, { ...SERVER, online: false }], hasCode: () => false }),
      "wait:code_holder_offline",
    ],
    ["a working session: nothing", LOOP, building({}), world({ list: [session({ id: "s1", working: true })] }), "nothing"],
    ["a question waiting: nothing", LOOP, building({}), world({ list: [session({ id: "s1", blocked: true })] }), "nothing"],
    ["no turn has ended since the start: nothing", LOOP, building({ reported: true }), world({ list: [session({ id: "s1", lastTurnEnd: 10 })] }), "nothing"],
    ["a turn over with a queued message: nothing", LOOP, building({ reported: true }), world({ list: [session({ id: "s1", lastTurnEnd: 12, settled: false })] }), "nothing"],
    ["a turn over with a report ends the run", LOOP, building({ reported: true }), world({ list: [session({ id: "s1", lastTurnEnd: 12 })] }), "end"],
    ["a turn over without one stops", LOOP, building({}), world({ list: [session({ id: "s1", lastTurnEnd: 12 })] }), "ask:no_report"],
    ["that turn stops it once", LOOP, building({ stoppedAt: 12 }), world({ list: [session({ id: "s1", lastTurnEnd: 12 })] }), "nothing"],
    ["the next turn without one stops again", LOOP, building({ stoppedAt: 12 }), world({ list: [session({ id: "s1", lastTurnEnd: 15 })] }), "ask:no_report"],
    [
      "done_when: turn needs no report", LOOP,
      task({ column: "review", run: run({ column: "review", state: "working", session: "s1", startSeq: 10 }) }),
      world({ list: [session({ id: "s1", lastTurnEnd: 11 })] }),
      "end",
    ],
    ["a session a person stopped fails the run", LOOP, building({}), world({ list: [session({ id: "s1", gone: true })] }), "ask:run_failed"],
    ["a session that is gone fails it", LOOP, building({}), world(), "ask:run_failed"],
    ["a failed run waits for a person", LOOP, building({ state: "failed" }), world(), "nothing"],
    ["one exit after the run: move at once", LOOP, building({ state: "ended" }), world(), "move"],
    ["but not past the budget", LOOP, { ...building({ state: "ended" }), budget: 0 }, world(), "ask:budget"],
    ["a budget already asked about: nothing", LOOP, { ...building({ state: "ended" }), budget: 0, ask: { reason: "budget", entry: 1, at: 0, detail: "" } }, world(), "nothing"],
    [
      "a sticky question holds the task", LOOP,
      task({ column: "build", run: run(), ask: { reason: "code_diverged", entry: 1, at: 0, detail: "" } }),
      world(),
      "nothing",
    ],
  ];
  for (const [name, board, one, seen, want] of rows) check(name, kindOf(step(one, board, seen)), want);

  const handoff = step(task({ column: "review", run: run({ column: "review" }) }), PINNED, world({ machines: [MAC, SERVER] }));
  check("the handoff names the pinned machine and why", handoff.kind === "handoff" ? [handoff.to, handoff.reason] : null, [SERVER.key, "the role is pinned there"]);
  const lost = step(task({ column: "gone" }), LOOP, world());
  check("a lost column's task goes to intake by the board's own hand", lost, { kind: "move", to: "backlog", exit: null, by: { kind: "config" } });
}

process.stdout.write("\nthe ladder\n");
{
  const ended = (over: Partial<TaskRun> = {}, rest: Partial<BoardTask> = {}): BoardTask =>
    task({ column: "review", entry: 4, run: run({ n: 4, column: "review", state: "ended", ...over }), ...rest });
  const moveOf = (one: Step): unknown => (one.kind === "move" ? [one.to, one.exit, one.by.kind] : kindOf(one));
  check("self named ship: approve", moveOf(step(ended({ outcome: "ship" }), LOOP, world())), ["approve", "ship", "self"]);
  check("self named nothing: the cheap role is asked", kindOf(step(ended(), LOOP, world())), "judge");
  check(
    "while it is asked, nothing",
    kindOf(step(ended({}, { judging: { judge: "cheap", entry: 4, since: 0 } }), LOOP, world())),
    "nothing",
  );
  check(
    "its fix goes back to build, with its confidence",
    step(ended({}, { verdicts: [{ entry: 4, judge: "cheap", exit: "fix", confidence: 0.7, at: 0 }] }), LOOP, world()),
    { kind: "move", to: "build", exit: "fix", by: { kind: "role", role: "cheap", confidence: 0.7 } },
  );
  check(
    "a verdict for an earlier entry is not this one's",
    kindOf(step(ended({}, { verdicts: [{ entry: 3, judge: "cheap", exit: "fix", confidence: 1, at: 0 }] }), LOOP, world())),
    "judge",
  );
  check(
    "an abstention leaves it to you",
    kindOf(step(ended({}, { verdicts: [{ entry: 4, judge: "cheap", exit: null, confidence: null, at: 0 }] }), LOOP, world())),
    "ask:choose_exit",
  );
  check(
    "so does stay",
    kindOf(step(ended({}, { verdicts: [{ entry: 4, judge: "cheap", exit: "stay", confidence: 0.9, at: 0 }] }), LOOP, world())),
    "ask:choose_exit",
  );
  check(
    "asked once",
    kindOf(
      step(
        ended({}, { verdicts: [{ entry: 4, judge: "cheap", exit: null, confidence: null, at: 0 }], ask: { reason: "choose_exit", entry: 4, at: 0, detail: "" } }),
        LOOP,
        world(),
      ),
    ),
    "nothing",
  );
  const asked = ended({}, { verdicts: [{ entry: 4, judge: "cheap", exit: null, confidence: null, at: 0 }], ask: { reason: "choose_exit", entry: 4, at: 0, detail: "" } });
  check("a work column's buttons appear once it asks you", humanExits(asked, LOOP).map((exit) => exit.name), ["fix", "ship"]);
  check("and not before", humanExits(ended(), LOOP).map((exit) => exit.name), []);
  check("a waiting column's are always there", humanExits(task({ column: "approve" }), LOOP).map((exit) => exit.label), ["Merge", "Request changes"]);
  check("approve waits for you", kindOf(step(task({ column: "approve" }), LOOP, world())), "nothing");

  const rulesBoard = parsed(
    "version: 1\nroles: { quick: { agent: jev, min_confidence: 0.8 } }\ncolumns:\n  - { id: a, title: A }\n  - id: gate\n    title: Gate\n" +
      "    next: { go: { to: a, means: fine }, hold: { to: a, means: not yet } }\n    decide: [{ rules: [{ when: { labels: { has: hold } }, then: hold }, { when: { labels: { has: wait } }, then: stay }] }, quick]\n",
  );
  check("a waiting column's rules run on entry", moveOf(step(task({ column: "gate", labels: ["hold"] }), rulesBoard, world())), ["a", "hold", "rules"]);
  check("their stay leaves it to you, with no question", kindOf(step(task({ column: "gate", labels: ["wait"] }), rulesBoard, world())), "nothing");
  check("no rule matching asks the role next", kindOf(step(task({ column: "gate" }), rulesBoard, world())), "judge");
  const classifier: MachineOffer = { ...MAC, agents: [CLAUDE, { id: "jev", name: "jev", kind: "classifier", harness: null }] };
  const judgeRun = parsed("version: 1\nroles: { quick: { agent: jev } }\ncolumns:\n  - { id: a, title: A }\n  - { id: w, title: W, run: { role: quick } }\n");
  check("a classifier cannot run a column", kindOf(step(task({ column: "w", run: run({ column: "w" }) }), judgeRun, world({ machines: [classifier] }))), "ask:judge_only");
}

process.stdout.write("\nplace, by table\n");
{
  const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({ name: "r", agent: "claude", customAgent: null, model: null, on: null, minConfidence: null, ...over });
  const link = (id: string, column: string | null, machine = MAC.key, attachedAt = 1) => ({
    id,
    column,
    executor: { agent: "claude", customAgent: null, machine },
    attachedAt,
  });
  const where = (input: Parameters<typeof place>[0]): unknown => {
    const placed = place(input);
    return placed.ok ? [placed.executor.machine, placed.session, placed.reason, placed.fresh] : placed.wanted;
  };
  const two = [MAC, SERVER];
  check(
    "continue: the column's last conversation",
    where({ role: role(), conversation: "continue", column: "build", task: task({ sessions: [link("s1", "build"), link("s2", "review", MAC.key, 2)] }), world: world({ list: [session({ id: "s1" }), session({ id: "s2" })] }) }),
    [MAC.key, "s1", "continues its conversation", null],
  );
  check(
    "else the task's last",
    where({ role: role(), conversation: "continue", column: "build", task: task({ sessions: [link("s2", "review")] }), world: world({ list: [session({ id: "s2" })] }) }),
    [MAC.key, "s2", "continues its conversation", null],
  );
  check(
    "a conversation the role does not run starts a new one, and says why",
    where({
      role: role({ on: ["server"] }),
      conversation: "continue",
      column: "build",
      task: task({ sessions: [link("s1", "build")] }),
      world: world({ machines: two, list: [session({ id: "s1" })] }),
    }),
    [SERVER.key, null, "the role is pinned there", "its last conversation is with claude@mac, which this role does not run"],
  );
  check(
    "one a person stopped too",
    where({ role: role(), conversation: "continue", column: "build", task: task({ sessions: [link("s1", "build")] }), world: world({ list: [session({ id: "s1", gone: true })] }) }),
    [MAC.key, null, "the task is here", "its last conversation is over"],
  );
  check("new: never a conversation", where({ role: role(), conversation: "new", column: "build", task: task({ sessions: [link("s1", "build")] }), world: world({ list: [session({ id: "s1" })] }) }), [
    MAC.key,
    null,
    "the task is here",
    null,
  ]);
  check(
    "pinned machines in order, the first that can",
    where({ role: role({ on: ["gone", "SERVER", "mac"] }), conversation: "new", column: "b", task: task(), world: world({ machines: two }) }),
    [SERVER.key, null, "the role is pinned there", null],
  );
  check(
    "work goes to the code",
    where({ role: role(), conversation: "new", column: "b", task: task({ code: { repo: "r", branch: "b", base: "c", head: "d", holder: SERVER.key } }), world: world({ machines: two }) }),
    [SERVER.key, null, "the code is there", null],
  );
  check("else the owner", where({ role: role(), conversation: "new", column: "b", task: task(), world: world({ machines: two }) }), [MAC.key, null, "the task is here", null]);
  const busy = [{ ...MAC, agents: [] }, { ...SERVER, running: 2 }, { ...SERVER, key: "m-b", name: "box", running: 1 }];
  check("else the least busy", where({ role: role(), conversation: "new", column: "b", task: task(), world: world({ machines: busy }) }), ["m-b", null, "it runs the least", null]);
  const tie = [{ ...MAC, agents: [] }, SERVER, { ...SERVER, key: "m-b", name: "box" }];
  check("then by name", where({ role: role(), conversation: "new", column: "b", task: task(), world: world({ machines: tie }) }), ["m-b", null, "the first by name", null]);
  check("a machine away is no candidate", where({ role: role({ on: ["server"] }), conversation: "new", column: "b", task: task(), world: world({ machines: [MAC, { ...SERVER, online: false }] }) }), "claude@server");
  check(
    "nor one without the project",
    where({ role: role({ on: ["server"] }), conversation: "new", column: "b", task: task(), world: world({ machines: [MAC, { ...SERVER, projects: ["github.com/other/repo"] }] }) }),
    "claude@server",
  );
  const custom: MachineOffer = { ...MAC, agents: [CLAUDE, { id: "ca_1", name: "Reviewer", kind: "custom", harness: "codex" }] };
  const byName = place({ role: role({ agent: "reviewer" }), conversation: "new", column: "b", task: task(), world: world({ machines: [custom] }) });
  check("an assembled agent by its name", byName.ok ? byName.executor : null, { agent: "codex", customAgent: "ca_1", machine: MAC.key });
}

process.stdout.write("\nthe reference loop, walked\n");
{
  // What the daemon does, without the daemon: each step applied, each run ended by its agent's report.
  let at = 100;
  let seq = 0;
  let one = task();
  const sessions = new Map<string, WorldSession>();
  const trail: string[] = [];
  const seen = (): World => world({ list: [...sessions.values()], now: at });
  const drive = (): void => {
    for (let i = 0; i < 16; i += 1) {
      const next = step(one, LOOP, seen());
      if (next.kind === "nothing" || next.kind === "wait" || next.kind === "ask") {
        if (next.kind !== "nothing") one = applyStep(one, LOOP, next, at);
        return;
      }
      at += 1;
      let started = null;
      if (next.kind === "start") {
        const id = next.session ?? `s${sessions.size + 1}`;
        seq += 1;
        sessions.set(id, session({ id, lastTurnEnd: sessions.get(id)?.lastTurnEnd ?? 0, settled: false, working: true }));
        started = { session: id, startSeq: seq, logFrom: 0, startHead: null };
        trail.push(`start ${one.column} in ${id}: ${next.message.split("\n")[0]}`);
      }
      if (next.kind === "move") trail.push(`${one.column} -${next.exit ?? "?"}-> ${next.to} by ${next.by.kind}`);
      if (next.kind === "judge") trail.push(`ask ${next.judge}`);
      one = applyStep(one, LOOP, next, at, started);
    }
  };
  const finishTurn = (outcome: string | null, review = false): void => {
    const id = one.run!.session!;
    one = withReport(one, { session: id, summary: `report ${seq}`, outcome, review });
    seq += 1;
    sessions.set(id, session({ id, lastTurnEnd: seq }));
    drive();
  };
  const press = (to: string, exit: string): void => {
    one = humanActed(applyStep(one, LOOP, { kind: "move", to, exit, by: { kind: "human" } }, (at += 1)), LOOP);
    trail.push(`${exit} by you`);
    drive();
  };

  press("build", "start");
  finishTurn(null, true); // the coder reports; build has one exit
  finishTurn("fix"); // the reviewer names fix
  finishTurn(null, true); // the coder again, in its own conversation
  finishTurn(null); // the reviewer names nothing: the cheap model is asked
  check("the cheap model is being asked", phase(one, new Map()), "judging");
  one = withVerdict(one, { entry: one.entry, judge: "cheap", exit: "ship", confidence: 0.9, at });
  drive();
  check("ship lands in Approve, waiting for you", [one.column, phase(one, new Map()), legacyStatus(phase(one, new Map()), one.column, LOOP)], ["approve", "waiting", "review"]);
  press("done", "merge");
  check("merged is done", [one.column, legacyStatus(phase(one, new Map()), one.column, LOOP)], ["done", "done"]);
  check("the trail", trail, [
    "start by you",
    "start build in s1: The login button does nothing.",
    "build -next-> review by auto",
    "start review in s2: /review",
    "review -fix-> build by self",
    "start build in s1: The task came back from Review (fix): report 3",
    "build -next-> review by auto",
    "start review in s3: /review",
    "ask cheap",
    "review -ship-> approve by role",
    "merge by you",
  ]);
  check("each review was a new conversation, each build the coder's own", one.sessions.map((link) => [link.id, link.column]), [
    ["s1", "build"],
    ["s2", "review"],
    ["s3", "review"],
  ]);
  check("four automatic moves spent four of eight, then you gave them back", one.budget, 8);
  check("visits are counted", one.visits, { build: 2, review: 2, approve: 1, done: 1 });
}

process.stdout.write("\nthe budget stops a loop\n");
{
  const loop = parsed(
    "version: 1\nbudget: 3\ncolumns:\n  - { id: a, title: A }\n  - id: w\n    title: W\n    run: {}\n    next: { again: { to: w, means: m }, out: { to: a, means: m } }\n",
  );
  let one = task({ column: "w", run: run({ column: "w", state: "ended", outcome: "again" }), budget: 3 });
  const moves: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const next = step(one, loop, world());
    moves.push(kindOf(next));
    if (next.kind !== "move") break;
    one = applyStep(one, loop, next, i);
    one = { ...one, run: { ...one.run!, state: "ended", outcome: "again" } };
  }
  check("three moves, then you", moves, ["move", "move", "move", "ask:budget"]);
  check("a person's act gives it back", humanActed(one, loop).budget, 3);
}

process.stdout.write("\nphase and the old status\n");
{
  const live = (blocked: boolean, working: boolean) => new Map([["s1", { blocked, working }]]);
  const withSession = task({ column: "review", sessions: [{ id: "s1", column: null, executor: { agent: "claude", customAgent: null, machine: MAC.key }, attachedAt: 1 }] });
  const rows: [string, Phase, Phase][] = [
    ["a question in a session outranks everything", phase({ ...withSession, judging: { judge: "x", entry: 1, since: 0 } }, live(true, false)), "needs_you"],
    ["a working session in Review is working, and stays in Review", phase(withSession, live(false, true)), "working"],
    ["a stop needs you", phase(task({ ask: { reason: "no_report", entry: 1, at: 0, detail: "" } }), new Map()), "needs_you"],
    ["an old entry's question does not", phase(task({ entry: 2, ask: { reason: "no_report", entry: 1, at: 0, detail: "" } }), new Map()), "waiting"],
    ["a judge at work", phase(task({ judging: { judge: "x", entry: 1, since: 0 } }), new Map()), "judging"],
    ["a handoff", phase(task({ moving: { kind: "handoff", since: 0 } }), new Map()), "moving"],
    ["a pending run is queued", phase(task({ column: "build", run: run() }), new Map()), "queued"],
    ["a waiting column", phase(task(), new Map()), "waiting"],
  ];
  for (const [name, got, want] of rows) check(name, got, want);
  check(
    "the old status by the phase table",
    (["needs_you", "working", "judging", "moving", "queued"] as Phase[]).map((one) => legacyStatus(one, "review", DEFAULT)),
    ["needs_you", "running", "running", "running", "running"],
  );
  check("done is a closed task's word, whatever its sessions do", (["needs_you", "working"] as Phase[]).map((one) => legacyStatus(one, "done", DEFAULT)), ["done", "done"]);
  check("waiting: ready in intake, done in final, review elsewhere", ["backlog", "running", "review", "done"].map((column) => legacyStatus("waiting", column, DEFAULT)), [
    "ready",
    "review",
    "review",
    "done",
  ]);
}

process.stdout.write("\nthe message a run sends\n");
{
  const build = LOOP.columns.find((column) => column.id === "build")!;
  const review = LOOP.columns.find((column) => column.id === "review")!;
  if (build.kind === "work" && review.kind === "work") {
    const back = task({ runs: 2, from: { column: "review", exit: "fix" }, last: { column: "review", outcome: "fix", report: "two bugs", diff: null, agent: "claude", message: null, range: null } });
    check("the first run sends the brief", runMessage(task(), LOOP, build, false), "The login button does nothing.");
    check("a return into the same conversation sends the hint", runMessage(back, LOOP, build, true), "The task came back from Review (fix): two bugs");
    check(
      "one a person sent back by hand names no exit, and no empty parentheses",
      runMessage({ ...back, from: { column: "review", exit: null } }, LOOP, build, true),
      "The task came back from Review: two bugs",
    );
    check("a return into a new one sends the brief", runMessage(back, LOOP, build, false), "The login button does nothing.");
    check("and says where it came back from in the note", runNote(back, LOOP, build, false).includes("The task came back from Review (fix): two bugs"), true);
    check("a continued one's note does not repeat it", runNote(back, LOOP, build, true).includes("came back"), false);
    check("a skill is sent as a slash command", runMessage(task(), LOOP, review, false), "/review");
    check("and the brief rides in its note", runNote(task(), LOOP, review, false).includes("The login button does nothing."), true);
    check("a column whose own agent picks lists its exits with what each means", runNote(task(), LOOP, review, false).includes("- fix: the review found problems that need code"), true);
    check("the note cannot be closed by the title it quotes", runNote(task({ title: 'a "</board-task>" b' }), LOOP, build, false).split("</board-task>").length, 2);
  }
}

process.stdout.write("\nthe walk on paper is step's own\n");
{
  const walked = simulate(LOOP, ["move build", "report", "outcome fix", "report", "silent", "cheap ship 0.9", "press merge"]);
  check("the reference loop, walked by script", walked.trail.filter((line) => line.includes("→")), [
    "Backlog → Build by you",
    "Build → Review by auto",
    "Review → Build (fix) by self",
    "Build → Review by auto",
    "Review → Approve (ship) by cheap",
    "Approve → Done (merge) by you",
  ]);
  check("ends where the walk by hand ended", [walked.column, walked.phase], ["done", "waiting"]);
  check(
    "a line that does not apply where the task is is named, and changes nothing",
    simulate(LOOP, ["press merge", "outcome ship", "cheap fix"]).refused,
    ["press merge: Backlog has no exit merge", "outcome ship: Backlog has no exit ship", "cheap fix: nothing here is waiting for that"],
  );
  const floor = parsed(REVIEW_LOOP_LOCAL_TEXT.replace("cheap:    { agent: claude, model: haiku }", "cheap:    { agent: claude, model: haiku, min_confidence: 0.8 }"));
  check(
    "an answer under a role's floor is no answer, and the pick is yours",
    simulate(floor, ["move build", "report", "silent", "cheap ship 0.5"]).trail.slice(-2),
    ["cheap answers ship · 50%, below its floor", "needs you: pick where the task goes next"],
  );
  const looping = parsed(REVIEW_LOOP_LOCAL_TEXT.replace("budget: 8", "budget: 2"));
  check("the budget stops a walk too", simulate(looping, ["move build", "report", "outcome fix", "report", "outcome fix"]).trail.at(-1), "needs you: the board moved this task as many times in a row as it may without you");
}

process.stdout.write(failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
