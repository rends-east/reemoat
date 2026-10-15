import { readFileSync } from "node:fs";
import type { BoardMachine, BoardTask, HeldBoard } from "../src/board.js";
import type { MachineId, SessionId } from "../src/ids.js";
import type { TaskSnapshot } from "../src/wire.js";
import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

const {
  BOARD_ABSENT_MS,
  BOARD_COLUMNS,
  BOARD_IDLE_MS,
  BOARD_WATCH_MS,
  DONE_RECENT_MS,
  MAX_REMEMBERED_TASKS,
  REMEMBERED_BRIEF_CHARS,
  STATUS_LABEL,
  STATUS_ORDER,
  boardDue,
  boardSignature,
  boardTasks,
  columnOf,
  leadSession,
  liveBoard,
  liveTaskStatus,
  matchesTask,
  needingYou,
  projectName,
  readTask,
  recallBoards,
  rememberBoards,
  shownStatus,
  taskGroups,
  taskHolder,
  taskKey,
  taskOfProposal,
  taskOfSession,
  taskRefKey,
  updatesTask,
} = await import("../src/board.js");
const { DISPATCH_NICKNAME, dispatchHome, dispatchSession, isDispatcher } = await import("../src/dispatch.js");
const { TASK_STATUSES } = await import("../src/wire.js");
const { meansRouteAbsent, ApiError } = await import("../src/http.js");
const { isSheet, depthOf, sheetKind, sheetTitle, upFrom, originFor, screenAt } = await import("../src/nav.js");
const { isOverlayPath } = await import("../src/ui/overlay.js");
const { buildTail, showsInTranscript } = await import("../src/ui/tail.js");
const { slowRoute } = await import("../src/machine.js");

const daemonSrc = (rel: string): string => stripComments(readFileSync(new URL(`../../../src/${rel}`, import.meta.url), "utf8"));

// Q3.719 to Q3.726: tasks live on their own machines, this client is what gathers them, and the board is one page of all of them.
process.stdout.write("\nthe task board: gathered by this client, grouped by what the daemons say\n");
{
  const M = (id: string): MachineId => id as MachineId;
  const task = (id: string, patch: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
    id,
    title: `task ${id}`,
    brief: "brief",
    status: "ready",
    summary: null,
    summaryAt: null,
    summaryBy: null,
    agent: "claude",
    customAgent: null,
    assignee: "nobody",
    cwd: "/w/app",
    key: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    sessions: [],
    ...patch,
  });
  const held = (tasks: TaskSnapshot[], read: HeldBoard["read"] = "known"): HeldBoard => ({ tasks, at: 5, read, daemon: "i_1" });
  const fleet: BoardMachine[] = [
    { id: M("m_b"), name: "local", reach: "online" },
    { id: M("m_a"), name: "atlas", reach: "offline" },
    { id: M("m_old"), name: "old", reach: "online" },
    { id: M("m_new"), name: "new", reach: "probing" },
  ];
  const boards = new Map<MachineId, HeldBoard>([
    [M("m_a"), held([task("t_a1", { status: "needs_you" })])],
    [M("m_b"), held([task("t_b1"), task("t_b2", { status: "done" })])],
    [M("m_old"), held([], "absent")],
    [M("m_new"), held([task("t_n1")], "failed")],
    [M("m_gone"), held([task("t_g1")])],
  ]);
  const drawn = boardTasks(fleet, boards);
  check(
    "every machine's tasks are drawn in the order the machines are, under the names they are drawn with",
    drawn.map((entry) => `${entry.machine}/${entry.task.id}`),
    ["local/t_b1", "local/t_b2", "atlas/t_a1", "new/t_n1"],
  );
  check(
    "a machine that is offline keeps its tasks, marked as what it last said, and no other is marked",
    drawn.filter((entry) => entry.unavailable).map((entry) => entry.task.id),
    ["t_a1"],
  );
  check(
    "one failed read greys nothing: only the drawn reach does, which is held through a short drop",
    drawn.find((entry) => entry.task.id === "t_n1")?.unavailable,
    false,
  );
  check(
    "a daemon too old for tasks is skipped without a word, and a machine no longer granted draws nothing",
    drawn.some((entry) => entry.machineId === "m_old" || entry.machineId === "m_gone"),
    false,
  );
  check(
    "the bare 404 an older daemon answers is what says so, and a refusal with a code is not",
    [meansRouteAbsent(new ApiError(404, "http_404", "Not Found", null)), meansRouteAbsent(new ApiError(503, "tasks_unavailable", "x", null)), meansRouteAbsent(new ApiError(404, "task_not_found", "x", null))],
    [true, false, false],
  );
  const store = stripComments(srcFile("boardStore.ts"));
  check(
    "and the store files that answer as absent, keeping what a machine last said through any other failure",
    [
      /if \(meansRouteAbsent\(cause\)\) \{\s*this\.held\.set\(machine\.id, \{ tasks: \[\], at: Date\.now\(\), read: "absent", daemon: instance \}\);/.test(store),
      /else if \(board !== undefined && board\.read !== "absent"\) \{\s*this\.held\.set\(machine\.id, \{ \.\.\.board, read: "failed" \}\);/.test(store),
      /if \(machine\.reach !== "online" \|\| this\.asking\.has\(machine\.id\)\) continue;/.test(store),
    ],
    [true, true, true],
  );

  const again = boardTasks(fleet, boards);
  const moved = (patch: Partial<TaskSnapshot>): string =>
    boardSignature(boardTasks(fleet, new Map(boards).set(M("m_b"), held([task("t_b1", patch), task("t_b2", { status: "done" })]))));
  check(
    "a read that changed nothing a board shows is the same board, and anything it shows is a different one",
    [
      boardSignature(again) === boardSignature(drawn),
      [{ status: "running" as const }, { updatedAt: 2_000 }, { title: "renamed" }, { sessions: [{ id: "s_1", agent: "claude", nickname: "mira", status: "idle" as const, attachedAt: 1 }] }].map(
        (patch) => moved(patch) === boardSignature(drawn),
      ),
      boardSignature(boardTasks(fleet.map((machine) => (machine.id === "m_b" ? { ...machine, reach: "offline" as const } : machine)), boards)) === boardSignature(drawn),
    ],
    [true, [false, false, false, false], false],
  );
  check(
    "so a poll that brought no news redraws nothing and writes nothing, and a board that is not this account's is forgotten",
    [
      /if \(key === this\.drawnKey\) return;/.test(store),
      /const gone = state\.phase === "signed_out" \|\| \(state\.registry === "known" && !state\.machines\.some\(\(machine\) => machine\.id === id\)\);/.test(store),
    ],
    [true, true],
  );

  process.stdout.write("  the groups\n");
  check("the client's statuses are the daemon's, in the order work moves through them", [[...TASK_STATUSES].sort(), [...STATUS_ORDER]], [
    [...(/TASK_STATUSES = \[([^\]]*)\]/.exec(daemonSrc("tasks/store.ts"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((one) => one[1]).sort(),
    ["ready", "running", "needs_you", "review", "done"],
  ]);
  check("each has its words, and ready is drawn as the backlog (Q3.732)", STATUS_ORDER.map((status) => STATUS_LABEL[status]), [
    "Backlog",
    "Running",
    "Needs you",
    "Review",
    "Done",
  ]);
  check(
    "the board's columns are who holds a task, and one waiting on its person stays in Running, where its agent still is",
    [[...BOARD_COLUMNS], STATUS_ORDER.map(columnOf)],
    [
      ["ready", "running", "review", "done"],
      ["ready", "running", "running", "review", "done"],
    ],
  );
  check(
    "a status from a newer daemon asks to be looked at, the one group that claims nothing about it",
    [shownStatus("blocked_on_ci"), shownStatus(""), shownStatus("done")],
    ["review", "review", "done"],
  );
  const now = 10 * DONE_RECENT_MS;
  const entry = (id: string, machine: string, patch: Partial<TaskSnapshot> = {}): BoardTask => ({
    machineId: M(machine),
    machine,
    task: task(id, patch),
    unavailable: false,
  });
  const all: BoardTask[] = [
    entry("t_1", "m_a", { status: "ready", createdAt: 1 }),
    entry("t_2", "m_a", { status: "needs_you", createdAt: 2, title: "Make webhooks idempotent", sessions: [{ id: "s_1", agent: "claude", nickname: "mira", status: "blocked", attachedAt: 1 }] }),
    entry("t_3", "m_b", { status: "ready", createdAt: 3, cwd: "/srv/ledger", agent: "codex" }),
    entry("t_4", "m_b", { status: "done", updatedAt: now - 1_000 }),
    entry("t_5", "m_b", { status: "done", updatedAt: now - DONE_RECENT_MS - 1 }),
    entry("t_6", "m_b", { status: "later_than_this_build" as never, createdAt: 9 }),
    entry("t_7", "m_a", { status: "ready", createdAt: 3 }),
  ];
  const shape = (view: Parameters<typeof taskGroups>[1]): string[] =>
    taskGroups(all, view, now).map((group) => `${group.status}: ${group.tasks.map((one) => one.task.id).join(" ")}`);
  check(
    "one group per column that holds a task, in the board's order; inside one the newest leads and a tie is settled by id",
    shape({ machine: null, query: "", done: "recent" }),
    ["ready: t_3 t_7 t_1", "running: t_2", "review: t_6", "done: t_4"],
  );
  check("a task done more than a day ago is withheld until asked for", shape({ machine: null, query: "", done: "all" }).at(-1), "done: t_4 t_5");
  check("a view that names a machine is cut to it", shape({ machine: M("m_a"), query: "", done: "recent" }), ["ready: t_7 t_1", "running: t_2"]);
  check(
    "and the board's names none: a machine is who does a task, never a page of the board (Q3.724)",
    /return \{ machine: null, query: view\.query, done: currentTaskFilter\(\) === "all" \? "all" : "recent" \};/.test(stripComments(srcFile("ui/board/TaskList.tsx"))),
    true,
  );
  check(
    "the search finds a task by its title, its project, its agent, or its session's name with or without the @",
    ["webhooks", "LEDGER", "codex", "@mira", "mira", "nothing-here"].map((query) =>
      taskGroups(all, { machine: null, query, done: "all" }, now)
        .flatMap((group) => group.tasks.map((one) => one.task.id))
        .join(" "),
    ),
    ["t_2", "t_3", "t_3", "t_2", "t_2", ""],
  );
  check("an empty needle matches everything", matchesTask(all[0]!, "   "), true);
  check(
    "what waits on you is counted where the list is looking, an unavailable machine's included",
    [needingYou(all), needingYou(all, M("m_a")), needingYou(all, M("m_b")), needingYou(drawn)],
    [1, 1, 0, 1],
  );
  check("a project is named as its folder is", [projectName("/srv/billing-api"), projectName("/srv/app/"), projectName("~")], ["billing-api", "app", "~"]);

  process.stdout.write("  which task a conversation or a proposal is\n");
  check(
    "a conversation's task is found on its own machine only: the same session id elsewhere is another session",
    [
      taskOfSession(all, { machineId: M("m_a"), sessionId: "s_1" as SessionId })?.task.id ?? null,
      taskOfSession(all, { machineId: M("m_b"), sessionId: "s_1" as SessionId }),
      taskOfSession(all, { machineId: M("m_a"), sessionId: "s_none" as SessionId }),
    ],
    ["t_2", null, null],
  );
  const proposed = [...all, entry("t_p", "m_b", { key: "tp_abc" })];
  check(
    "a proposal's row is settled by the board, on whichever machine holds the task it became",
    [taskOfProposal(proposed, "tp_abc")?.machineId ?? null, taskOfProposal(proposed, "tp_other")],
    ["m_b", null],
  );
  const session = (id: string, status: string, attachedAt: number) => ({ id, agent: "claude", nickname: id, status: status as never, attachedAt });
  check(
    "a task's page leads with the conversation waiting on you, else the one working, else the newest; with none before any start",
    [
      leadSession(task("t", { sessions: [session("a", "idle", 3), session("b", "running", 1), session("c", "blocked", 2)] }))?.id,
      leadSession(task("t", { sessions: [session("a", "idle", 3), session("b", "starting", 1)] }))?.id,
      leadSession(task("t", { sessions: [session("a", "exited", 1), session("b", "idle", 3), session("c", "parked", 2)] }))?.id,
      leadSession(task("t")),
    ],
    ["c", "b", "b", null],
  );

  process.stdout.write("  a status as fresh as the sessions it is read from\n");
  const live = (statuses: Record<string, string>) => (id: string): string | null => statuses[id] ?? null;
  const worked = task("t", { status: "running", sessions: [session("a", "running", 1), session("b", "idle", 2)] });
  check(
    "what this client last heard of a task's own sessions settles the status the board read (Q3.726)",
    [
      liveTaskStatus(worked, live({ a: "idle" })),
      liveTaskStatus(worked, live({ b: "blocked" })),
      liveTaskStatus(worked, live({ a: "idle", b: "starting" })),
      liveTaskStatus(worked, live({})),
    ],
    ["review", "needs_you", "running", "running"],
  );
  check(
    "done is its person's word, and a task no session has stays what its board said",
    [
      liveTaskStatus({ ...worked, status: "done" }, live({ a: "running" })),
      liveTaskStatus(task("t", { status: "ready" }), live({})),
      liveTaskStatus(task("t", { status: "review" }), live({})),
      liveTaskStatus({ ...worked, status: "later" as never }, live({ a: "exited", b: "exited" })),
    ],
    ["done", "ready", "review", "review"],
  );
  check(
    "a task put back in the backlog stays there whatever its old conversations did, until one works again (Q3.727)",
    [liveTaskStatus({ ...worked, status: "ready" }, live({ a: "idle" })), liveTaskStatus({ ...worked, status: "ready" }, live({ a: "running" }))],
    ["ready", "running"],
  );
  const settled = liveBoard(all, (machine, id) => (machine === "m_a" && id === "s_1" ? "idle" : null));
  check(
    "the board as drawn moves only what changed, and keeps every other entry as it was",
    [settled.find((one) => one.task.id === "t_2")?.task.status, settled.filter((one, at) => one === all[at]).length],
    ["review", all.length - 1],
  );
  const pressed = liveBoard(all, () => "blocked", new Map([[taskRefKey("m_b", "t_5"), { status: "ready" as const, at: now }]]));
  const lifted = pressed.find((one) => one.task.id === "t_5")!;
  check(
    "a status a press asked for wins over the board and the sessions until it is answered, and is as new as the press (Q3.728)",
    [lifted.task.status, lifted.task.updatedAt, pressed.find((one) => one.task.id === "t_2")?.task.status],
    ["ready", now, "needs_you"],
  );
  const naming = { assignee: { assignee: "agent" as const, agent: "codex", customAgent: null }, at: now };
  const named = liveBoard(all, () => null, new Map([[taskRefKey("m_a", "t_1"), naming]])).find((one) => one.task.id === "t_1")!;
  const answered = [{ ...all[0]!, task: { ...all[0]!.task, assignee: "agent" as const, agent: "codex", updatedAt: now } }];
  check(
    "an assignee a press named is drawn at once, in the column it was in, and an answer that says the same keeps the entry as it was (Q3.732)",
    [[named.task.assignee, named.task.agent, named.task.status], liveBoard(answered, () => null, new Map([[taskRefKey("m_a", "t_1"), naming]]))[0] === answered[0]],
    [["agent", "codex", "ready"], true],
  );
  const moving = { ...naming, machine: "studio" };
  const drawnMoving = liveBoard(answered, () => null, new Map([[taskRefKey("m_a", "t_1"), moving]]))[0]!;
  check(
    "a pick on another machine draws that machine at once, and nothing the task here says answers it, since it is deleted once made there (Q3.736)",
    [drawnMoving.machine, drawnMoving.machineId, drawnMoving === answered[0], liveBoard(answered, () => null)[0]!.machine],
    ["studio", "m_a", false, answered[0]!.machine],
  );
  check(
    "who holds a task is read off it: in the backlog the agent named, its person or nobody, the agent on it while one works, its person otherwise (Q3.727, Q3.736)",
    [
      taskHolder(task("t", { status: "ready", sessions: [session("a", "idle", 1)] })),
      taskHolder(task("t", { status: "ready", assignee: "agent", agent: "codex" })),
      taskHolder(task("t", { status: "ready", assignee: "you", agent: "codex" })),
      taskHolder({ ...worked, status: "running" }),
      taskHolder(task("t", { status: "needs_you", agent: "codex", sessions: [session("c", "blocked", 2)] })),
      taskHolder(task("t", { status: "running", agent: "codex", assignee: "agent" })),
      taskHolder(task("t", { status: "running", agent: "codex", assignee: "you" })),
      taskHolder(task("t", { status: "review", assignee: "agent" })),
      taskHolder(task("t", { status: "done" })),
    ],
    [
      { kind: "nobody" },
      { kind: "agent", agent: "codex", customAgent: null, nickname: null },
      { kind: "you" },
      { kind: "agent", agent: "claude", customAgent: null, nickname: "a" },
      { kind: "agent", agent: "claude", customAgent: null, nickname: "c" },
      { kind: "agent", agent: "codex", customAgent: null, nickname: null },
      { kind: "nobody" },
      { kind: "you" },
      { kind: "you" },
    ],
  );
  const call = (seq: number, event: Record<string, unknown>) => ({ seq, event: { type: "tool_call_update", toolCallId: "c1", title: null, status: null, ...event } });
  const calls = new Set<string>();
  check(
    "a task_update the agent finished is the moment its board says something new, in any harness's spelling of the name",
    [
      updatesTask([call(1, { type: "tool_call", title: "mcp__reemoat__task_update", status: "pending" })], calls),
      updatesTask([call(2, {}), call(3, { status: "completed" })], calls),
      updatesTask([call(4, { type: "tool_call", toolCallId: "c2", title: "reemoat.task_update", status: "pending" }), call(5, { toolCallId: "c2", status: "failed" })], new Set()),
      updatesTask([call(6, { type: "tool_call", toolCallId: "c3", title: "Edit", status: "pending" }), call(7, { toolCallId: "c3", status: "completed" })], new Set()),
      updatesTask([call(8, { type: "tool_call", toolCallId: "c4", title: "my_task_update", status: "completed" })], new Set()),
    ],
    [false, true, true, false, false],
  );
  const band = stripComments(srcFile("ui/board/TaskBand.tsx"));
  check(
    "so the band above a conversation reads its board at once when that happens, and at the list's pace while a task is drawn",
    [
      /if \(updatesTask\(fresh, seen\.current\.calls\) && !first\) board\.refresh\(sessionRef\.machineId\);/.test(band),
      /useBoardWatch\(entry !== null\);/.test(band),
      /const tasks = useLiveTasks\(state\);/.test(band),
    ],
    [true, true, true],
  );
  check(
    "and a turn that ended or a request that came asks that machine's board again, without waiting for its pace",
    /if \(last !== undefined && last !== heard\) \{\s*this\.askedAt\.delete\(machine\);\s*moved = true;/.test(store),
    true,
  );

  process.stdout.write("  when a machine is asked\n");
  const known = { read: "known" as const, daemon: "i_1" };
  check(
    "while the board is on screen it is read at the session list's pace, and seldom otherwise",
    [
      boardDue(known, 0, BOARD_WATCH_MS - 1, true, "i_1"),
      boardDue(known, 0, BOARD_WATCH_MS, true, "i_1"),
      boardDue(known, 0, BOARD_IDLE_MS - 1, false, "i_1"),
      boardDue(known, 0, BOARD_IDLE_MS, false, "i_1"),
      boardDue(undefined, 0, BOARD_WATCH_MS, true, null),
    ],
    [false, true, false, true, true],
  );
  const absent = { read: "absent" as const, daemon: "i_1" };
  check(
    "a daemon with no such route is asked again when another instance answers its health, which is the only news that could change it",
    [boardDue(absent, 0, 10 * BOARD_ABSENT_MS, true, "i_1"), boardDue(absent, 0, 1, true, "i_2")],
    [false, true],
  );
  check(
    "and where it names no instance, the lifetime stands in",
    [boardDue({ read: "absent", daemon: null }, 0, BOARD_ABSENT_MS - 1, true, null), boardDue({ read: "absent", daemon: null }, 0, BOARD_ABSENT_MS, true, null)],
    [false, true],
  );

  process.stdout.write("  what is believed of a row, and what is remembered\n");
  check(
    "a row that names nothing is dropped, and one that does is held to its shape",
    [
      readTask(null),
      readTask({ title: "no id" }),
      readTask({ id: "", title: "x" }),
      readTask({ id: "t_1", title: "x", status: "soon", sessions: [{ id: "s_1", status: "queued_somewhere" }, { nickname: "no id" }, 7], summary: 4 }),
    ],
    [
      null,
      null,
      null,
      { ...task("t_1", { title: "x", brief: "", agent: "", cwd: "", createdAt: 0, updatedAt: 0 }), status: "soon", sessions: [{ id: "s_1", agent: "", nickname: "", status: "idle", attachedAt: 0 }] },
    ],
  );
  check(
    "an assignee is believed only as one of the three, so a daemon older than one, or a word this build never heard, reads as nobody's (Q2.261, Q2.262)",
    [
      readTask({ id: "t_1", title: "x", assignee: "agent" })?.assignee,
      readTask({ id: "t_1", title: "x", assignee: "you" })?.assignee,
      readTask({ id: "t_1", title: "x" })?.assignee,
      readTask({ id: "t_1", title: "x", assigned: true })?.assignee,
      readTask({ id: "t_1", title: "x", assignee: "team" })?.assignee,
    ],
    ["agent", "you", "nobody", "nobody", "nobody"],
  );
  const many = Array.from({ length: MAX_REMEMBERED_TASKS + 5 }, (_, index) => task(`t_${index}`, { brief: "b".repeat(REMEMBERED_BRIEF_CHARS * 3) }));
  const remembered = recallBoards(
    rememberBoards(
      new Map<MachineId, HeldBoard>([
        [M("m_a"), held(many)],
        [M("m_old"), held([], "absent")],
        [M("m_empty"), held([])],
      ]),
    ),
  );
  check(
    "a machine's board is written down bounded, each brief cut to enough to recognise it, and an absent or empty one not at all",
    [[...remembered.keys()], remembered.get(M("m_a"))?.tasks.length, remembered.get(M("m_a"))?.tasks[0]?.brief.length],
    [["m_a"], MAX_REMEMBERED_TASKS, REMEMBERED_BRIEF_CHARS],
  );
  check("read back, it is what the machine last said and nothing has confirmed since", [remembered.get(M("m_a"))?.read, remembered.get(M("m_a"))?.daemon], ["failed", null]);
  check(
    "so a machine that is away after a relaunch still shows its tasks, as unavailable",
    boardTasks([{ id: M("m_a"), name: "atlas", reach: "offline" }], remembered).slice(0, 1).map((one) => [one.task.id, one.unavailable]),
    [["t_0", true]],
  );
  check("a value that is not this build's is no memory, never a crash", [recallBoards("{not json").size, recallBoards("[]").size, recallBoards(null).size, recallBoards('{"m_a":{"tasks":"x"}}').size], [0, 0, 0, 0]);

  const keyRule = /TASK_KEY = new RegExp\(`\^\[A-Za-z0-9_-\]\{1,\$\{MAX_TASK_KEY_CHARS\}\}\$`\)/.test(daemonSrc("server.ts"));
  const keyMax = Number(/MAX_TASK_KEY_CHARS = (\d+)/.exec(daemonSrc("tasks/store.ts"))?.[1] ?? "NaN");
  report("the daemon's rule for a key was found to compare", keyRule && Number.isFinite(keyMax), `1 to ${String(keyMax)} of [A-Za-z0-9_-]`);
  const keys = Array.from({ length: 50 }, () => taskKey());
  check(
    "a key this client mints is one the daemon takes, and two are not one",
    [keys.every((key) => new RegExp(`^[A-Za-z0-9_-]{1,${String(keyMax)}}$`).test(key)), new Set(keys).size],
    [true, 50],
  );

  process.stdout.write("  the dispatcher, parked: a session known by its nickname, which nothing draws now (Q3.735)\n");
  check(
    "the nickname is the daemon's own literal, which is what tells that session what it is for",
    [DISPATCH_NICKNAME, /DISPATCH_NICKNAME = "(\w+)"/.exec(daemonSrc("tasks/tools.ts"))?.[1]],
    ["dispatch", "dispatch"],
  );
  const cand = (machine: string, id: string, nickname: string | null, ended: boolean, createdAt: number) => ({
    ref: { machineId: M(machine), sessionId: id as SessionId },
    nickname,
    ended,
    createdAt,
  });
  const rows = [
    cand("m_a", "s_old", "dispatch", false, 1),
    cand("m_a", "s_new", "dispatch", false, 5),
    cand("m_b", "s_ended", "dispatch", true, 9),
    cand("m_b", "s_other", "mira", false, 9),
    cand("m_b", "s_none", null, false, 9),
  ];
  check(
    "it is the session of that name: on the chosen machine before any other, live before ended, newest before older",
    [dispatchSession(rows, null)?.ref.sessionId, dispatchSession(rows, M("m_b"))?.ref.sessionId, dispatchSession(rows, M("m_c"))?.ref.sessionId, dispatchSession(rows.slice(3), null)],
    ["s_new", "s_ended", "s_new", null],
  );
  check(
    "one is started on the machine Settings names, else this computer's, else the first that can start anything; never on a named machine that cannot",
    [
      dispatchHome(M("m_b"), M("m_a"), [M("m_a"), M("m_b")]),
      dispatchHome(null, M("m_a"), [M("m_b"), M("m_a")]),
      dispatchHome(null, M("m_x"), [M("m_b"), M("m_a")]),
      dispatchHome(M("m_off"), M("m_a"), [M("m_a")]),
      dispatchHome(null, null, []),
    ],
    ["m_b", "m_a", "m_b", null, null],
  );
  const dispatchSrc = stripComments(srcFile("ui/board/Dispatch.tsx"));
  check(
    "starting one is a session create under that nickname with the machine's own default agent, named and never pinned: nothing the daemon has to be told",
    [
      /nickname: DISPATCH_NICKNAME/.test(dispatchSrc),
      /defaultRow\(rows, \(row\) => startableHere\(row, agents\.agents, presets\.customAgents\)\)/.test(dispatchSrc),
      /store\.setSessionMeta\(ref, \{ title: "Dispatch" \}/.test(dispatchSrc),
      /pinned: true|createTask|listTasks/.test(dispatchSrc),
    ],
    [true, true, true, false],
  );
  check("any session under the nickname is one, and no other is", [isDispatcher("dispatch"), isDispatcher("dispatch-2"), isDispatcher(null), isDispatcher(undefined)], [true, false, false, false]);
  const { sessionGroups } = await import("../src/store.js");
  const sessionRow = (id: string, nickname: string, pinned = false) => ({
    key: `m_a/${id}`,
    ref: { machineId: M("m_a"), sessionId: id as SessionId },
    machineName: "atlas",
    snapshot: { id, nickname, pinned, status: "idle", createdAt: 1, pendingPermissions: [], workspace: { requestedCwd: "/w", git: null } },
    daemonNow: 0,
    fetchedAt: 0,
  });
  const listed = sessionGroups({
    sessions: [sessionRow("s_d", "dispatch", true), sessionRow("s_m", "mira")],
    machines: [{ id: M("m_a"), name: "atlas", reach: "online", offlineReason: null, route: null, tokenDegraded: false, overLimit: false, ownerDisabled: false }],
  } as never);
  check(
    "so a session under its nickname is an ordinary conversation again, listed and pinned as any is",
    [listed.pinned.map((one) => one.key), listed.groups[0]?.active.map((one) => one.key), listed.orphans.length],
    [["m_a/s_d"], ["m_a/s_m"], 0],
  );
  const mounted = ["App.tsx", "store.ts", "ui/SessionView.tsx", "ui/board/Board.tsx", "ui/board/TaskList.tsx", "ui/settings/MachinesSection.tsx"].map((rel) => stripComments(srcFile(rel)));
  check(
    "nothing mounts it: no row, no button, no setting and no conversation drawn as one, while the MCP tools stay the daemon's",
    [
      mounted.filter((one) => /isDispatcher|DispatchRow|openDispatcher|useDispatch|DispatchSetting|dispatch=\{/.test(one)).length,
      /export function DispatchSetting/.test(stripComments(srcFile("ui/settings/DispatchSetting.tsx"))),
      /PROPOSE_TASKS_TOOL_NAME/.test(daemonSrc("tasks/tools.ts")),
    ],
    [0, true, true],
  );

  process.stdout.write("  the proposals card\n");
  const ev = (seq: number, event: unknown): any => ({ seq, ts: seq, event });
  const proposals = { type: "tasks_proposed", proposals: [{ id: "tp_1", machineId: null, machine: null, project: "/w/app", agent: "claude", title: "t", brief: "b" }] };
  check("what an agent proposed is drawn", showsInTranscript(proposals as never), true);
  const read = (id: string): unknown => ev(0, { type: "tool_call", toolCallId: id, title: "Read", kind: "read", status: "completed", locations: [], rawInput: null });
  const tail = buildTail(
    [read("a"), read("b"), ev(3, proposals), read("c"), read("d")].map((stored: any, index) => ({ ...stored, seq: index + 1, ts: index + 1 })),
    [],
    0,
  );
  check(
    "as a row of its own, never folded into the run of tool calls around it: it is what its person acts on",
    tail.rows.map((row: any) => (row.kind === "event" ? row.stored.event.type : row.kind)),
    ["group", "tasks_proposed", "group"],
  );
  const eventList = stripComments(srcFile("ui/EventList.tsx"));
  check("the transcript hands it to the card", /case "tasks_proposed":\s*return <ProposalsCard proposals=\{event\.proposals\} \/>;/.test(eventList), true);
  const card = stripComments(srcFile("ui/board/Proposals.tsx"));
  const hooks = stripComments(srcFile("ui/board/useBoard.ts"));
  const staticImports = (source: string): string[] => [...source.matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((one) => one[1] ?? "");
  report("the card's static imports were found", staticImports(card).length > 4, staticImports(card).join(", "));
  check(
    "the card reaches the router only on a press: the transcript is drawn where there is no address bar to read",
    [
      [card, hooks, stripComments(srcFile("ui/board/Pickers.tsx")), stripComments(srcFile("ui/board/assignees.ts"))]
        .flatMap(staticImports)
        .filter((spec) => /router|\/actions$|TaskList|Dispatch|NewSession/.test(spec)),
      (card.match(/import\("\.\/actions"\)/g) ?? []).length,
    ],
    [[], 2],
  );
  check(
    "a press creates the task on the machine the proposal names, or this conversation's own, under the proposal's id",
    [
      /const machineId = \(proposal\.machineId as MachineId \| null\) \?\? here;/.test(card),
      /const here = useContext\(MentionScope\)\.here as MachineId \| null;/.test(card),
      /key: proposal\.id,/.test(card),
      /made=\{taskOfProposal\(tasks, proposal\.id\)\}/.test(card),
    ],
    [true, true, true, true],
  );
  check(
    "and who does it and in which folder are its person's to change before the press, which sends what they left (Q3.725)",
    [/<AssigneeDropdown/.test(card), /<ProjectDropdown/.test(card), /machineId: agent\?\.machineId \?\? edited\.machineId,/.test(card), /cwd: project,/.test(card)],
    [true, true, true, true],
  );
  check(
    "every row starts nobody's, keeping the agent proposed for a later Start, offers its person too, and one press adds it or, with an agent picked, starts it (Q3.727, Q3.736)",
    [
      /return \{ assignee: null, machineId, project: proposal\.project \};/.test(card),
      /agent: agent === null \? proposal\.agent : agent\.kind === "custom" \? "" : agent\.id,/.test(card),
      /const start = agent !== null;/.test(card),
      /\bnobody\s+you\s+disabled=\{busy !== null\}/.test(card),
      /assignee: agent !== null \? "agent" : edited\.assignee === "you" \? "you" : "nobody",/.test(card),
    ],
    [true, true, true, true, true],
  );
  check(
    "a machine whose daemon is too old says so on the row, with what to do, rather than a 404",
    [/meansRouteAbsent\(cause\) \? TOO_OLD : errorText\(cause\)/.test(card), /Update it, then press again/.test(card)],
    [true, true],
  );
  check("nothing is created until a press: the card calls nothing on mount", /useEffect\(/.test(card), false);

  process.stdout.write("  the board's page, and the shell\n");
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  check(
    "the board is the pager's first page, where All stood, and its list is drawn on that page and on a neighbour's cut to the same rows",
    [
      /const board = boardTab\(view, useBoardWaiting\(state\)\);/.test(browser),
      /tabs: \[board, \.\.\.tabs\],/.test(browser),
      /\{view\.board \? \(\s*<TaskListBody state=\{state\} view=\{view\} active=\{active\} rows=\{rows\} \/>/.test(browser),
      /\{beside\.id === BOARD \? \(\s*<TaskListBody state=\{state\} view=\{pageView\(beside\.id\)\} active=\{active\} rows=\{beside\.rows\} \/>/.test(browser),
    ],
    [true, true, true, true],
  );
  check(
    "and no switch says what the list holds: the page does, so nothing sits above the list and nothing leads the strip but the board",
    [/setMode|ModeSwitch|ListMode|currentMode/.test(browser + stripComments(srcFile("ui/groups.ts"))), /<TabLabel tab=\{board\} \/>/.test(browser), /<TabLabel tab=\{all\} \/>|Tasks\s*<TasksWaiting/.test(browser)],
    [false, true, false],
  );
  const groupsSrc = stripComments(srcFile("ui/groups.ts"));
  check(
    "a tab stored as All before the board took its place reads as the board, and the board walks no conversation",
    [/return \(raw === "all" \? BOARD : raw\) as MachineTabId \| null;/.test(groupsSrc), /if \(view\.board\) return \[\];\s*const searching/.test(groupsSrc)],
    [true, true],
  );
  const column = stripComments(srcFile("ui/MachineColumn.tsx"));
  check(
    "at lg the board's entry leads the column and is the way back to the board from a conversation or a task's page",
    [/const board = boardTab\(view, useBoardWaiting\(state\)\);/.test(column), /selectMachine\(BOARD\);\s*if \(path !== "\/"\) navigate\("\/"\);/.test(column)],
    [true, true],
  );
  const taskList = stripComments(srcFile("ui/board/TaskList.tsx"));
  check(
    "a waiting task says so in place, with its weight and its mark, and a row is one button with nothing mounting into it",
    [/status === "needs_you" \? "font-semibold" : ""/.test(taskList), /needs_you: "bg-brand ring-\[3px\] ring-brand\/25"/.test(taskList), /<SessionMenu|RowMenu/.test(taskList)],
    [true, true, false],
  );
  check(
    "a page's row budget is the session list's own, a heading costing a row, and every group is drawn once any task is",
    [/const taken = takeRows\(collapsed \? \[\] : all, left, 1\);/.test(taskList), /if \(groups\.length === 0 \|\| left\.rows <= 0\) return \[\];/.test(taskList)],
    [true, true],
  );
  check("the board's tab counts the tasks that wait on their person", /return needingYou\(useLiveTasks\(state\)\);/.test(taskList), true);
  check(
    "the backlog and done start folded and the groups between open, and a line opens the conversation doing it, else its page (Q3.733, Q3.737)",
    [
      /const FOLDED_FIRST: readonly BoardColumn\[\] = \["ready", "done"\];/.test(taskList) &&
        /return FOLDED_FIRST\.includes\(column\) \? !isFolderCollapsed\(openFolder\(column\)\) : isFolderCollapsed\(statusFolder\(column\)\);/.test(taskList),
      /const lead = leadRef\(entry\);\s*if \(lead === null\) openTask\(entry\);\s*else navigate\(sessionPath\(lead\)\);/.test(taskList),
    ],
    [true, true],
  );
  check(
    "a line is dragged between groups on the list's own axis, by the board's drop, and a working one's mark breathes there and only there",
    [
      /const drag = useCardDrag\(drops\.drop, "y"\);/.test(taskList),
      /const drops = useTaskDrop\(state, setLanded\);/.test(taskList),
      /running: "bg-fg text-fg animate-blink",/.test(taskList),
      /still && status === "running" \? "bg-fg" : MARK\[status\]/.test(taskList),
    ],
    [true, true, true, true],
  );
  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check(
    "a task's conversation says which task it is above the conversation, outside its scroller",
    view.indexOf("<TaskBand state={state} sessionRef={sessionRef} />") > view.indexOf("<ExitNotice ") &&
      view.indexOf("<TaskBand state={state} sessionRef={sessionRef} />") < view.indexOf("<MentionScope.Provider"),
    true,
  );
  const menu = stripComments(srcFile("ui/SessionMenu.tsx"));
  check(
    "attaching is offered only where that machine's daemon keeps tasks, and lists that machine's open tasks alone",
    [
      /const attachable = tasks\.supported\.has\(sessionRef\.machineId\);/.test(menu),
      /\{attachable && \(\s*<MenuItem icon=\{ClipboardList\} label="Attach to task"/.test(menu),
      /entry\.machineId === sessionRef\.machineId && shownStatus\(entry\.task\.status\) !== "done"/.test(menu),
    ],
    [true, true, true],
  );

  const { parsePath, taskPath, newTaskPath, newTaskInPath, sessionPath } = await import("../src/router.js");
  const page = parsePath(taskPath(M("m_a b"), "t_x/y"));
  const form = parsePath(newTaskPath(M("m_a")));
  const inReview = parsePath(newTaskInPath("review"));
  check(
    "a task's page and the form behind New task and each column's + are addresses that survive a reload (Q3.737)",
    [page, form, parsePath(newTaskPath(null)), inReview, parsePath("/task/new/in/later")],
    [
      { name: "task", machineId: "m_a b", taskId: "t_x/y" },
      { name: "newTask", machineId: "m_a", column: null },
      { name: "newTask", machineId: null, column: null },
      { name: "newTask", machineId: null, column: "review" },
      { name: "newTask", machineId: null, column: null },
    ],
  );
  check(
    "the page is a screen beside the list and the form a pop-up over it, named for its column, and the path rule agrees with the route rule",
    [
      isSheet(page),
      isSheet(form),
      isOverlayPath(taskPath(M("m_a"), "t_1")),
      isOverlayPath(newTaskPath(M("m_a"))),
      isOverlayPath(newTaskInPath("done")),
      depthOf(page),
      sheetKind(form),
      sheetTitle(form),
      sheetTitle(inReview),
      upFrom(page, "/x"),
      upFrom(form, "/x"),
    ],
    [false, true, false, true, true, 1, "task", "New task", "New task in Review", "/", "/x"],
  );
  const newTask = stripComments(srcFile("ui/board/NewTask.tsx"));
  check(
    "a column's + makes the task there: Running's starts an agent, offering agents alone, and the others add it whoever is picked, back on the board (Q3.737)",
    [
      /const start = column === "running" \|\| \(column === null && assignee !== null\);/.test(newTask),
      /\.\.\.\(column === "review" \|\| column === "done" \? \{ status: column \} : \{\}\),/.test(newTask),
      /nobody=\{column !== "running"\}\s+you=\{column !== "running"\}/.test(newTask),
      /navigate\(session !== null \? sessionPath\(session\) : column !== null \? under : taskPath\(machineId, task\.id\), true\);/.test(newTask),
      /<NewTask state=\{state\} machineId=\{route\.machineId\} column=\{route\.column\} \/>/.test(stripComments(srcFile("App.tsx"))),
    ],
    [true, true, true, true, true],
  );
  const conversation = sessionPath({ machineId: M("m_a"), sessionId: "s_1" as never });
  const ticket = taskPath(M("m_a"), "t_1");
  check(
    "a task's page opened from a conversation remembers it, through a move to another machine, and from anywhere else remembers nothing (Q3.736)",
    [
      originFor(conversation, ticket, null),
      originFor(ticket, taskPath(M("m_b"), "t_2"), conversation),
      originFor("/", ticket, null),
      originFor(newTaskPath(null), ticket, null),
      originFor(conversation, "/", null),
      [screenAt(conversation), screenAt(ticket), screenAt("/m/m_a"), screenAt("/task/new")],
    ],
    [conversation, conversation, null, null, null, ["session", "task", null, null]],
  );
  check(
    "a create that starts an agent is given the time a session create is, and one that only lists is not",
    [slowRoute("POST", "/tasks"), slowRoute("POST", "/tasks/t_1/start"), slowRoute("GET", "/tasks"), slowRoute("PATCH", "/tasks/t_1")],
    [true, true, false, false],
  );
  const app = stripComments(srcFile("App.tsx"));
  check(
    "at lg the pane with nothing open in it is the board while the board is the list's page, and what it always said otherwise",
    [/if \(currentView\(sessionGroups\(state\)\)\.board && state\.machines\.length > 0\)/.test(app), /<HomePane key="nothing" state=\{state\} \/>/.test(app), /<NothingSelected state=\{state\} \/>/.test(app)],
    [true, true, true],
  );
  const header = stripComments(srcFile("ui/Header.tsx"));
  check(
    "every screen opened from the board leads back to it from its top left, at lg too, and no crumb names it (Q3.734)",
    [
      /const board = boardSelected\(\);/.test(view),
      /close\s+board=\{board\}\s+backRef=\{back\.gate\}/.test(view),
      /<Header title=\{<span className="sr-only">Task<\/span>\} close board back=\{back\} \/>/.test(stripComments(srcFile("ui/board/TaskScreen.tsx"))),
      /\{close && board && \(\s*<span className="-ml-1 hidden lg:flex">\s*<IconButton icon=\{ChevronLeft\} label=\{label\} onClick=\{leave\} size="bar" \/>/.test(header),
      /function Crumbs/.test(stripComments(srcFile("ui/board/TaskScreen.tsx"))),
    ],
    [true, true, true, true, false],
  );
  check(
    "and one opened from a conversation leads back to that conversation instead, at every width (Q3.736)",
    [
      /const back = origin !== null && screenAt\(origin\) === "session" \? \{ to: origin, label: "Back to the conversation" \} : null;/.test(
        stripComments(srcFile("ui/board/TaskScreen.tsx")),
      ),
      /const leave = back !== null \? \(\) => navigate\(back\.to\) : board \? toBoard : \(\) => navigate\("\/"\);/.test(header),
      /const label = back !== null \? back\.label : board \? "Back to the board" : "Back to sessions";/.test(header),
    ],
    [true, true, true],
  );
  const boardSrc = stripComments(srcFile("ui/board/Board.tsx"));
  check(
    "the board is the list's own view drawn a second time: one needle, one filter, and no state but an assignee's menu and a landing",
    [
      /const view = currentView\(sessionGroups\(state\)\);/.test(boardSrc),
      /taskGroups\(tasks, boardView\(view\), Date\.now\(\)\)/.test(boardSrc),
      [...boardSrc.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((one) => one[1]),
    ],
    [true, true, ["assigning", "landed"]],
  );
  check(
    "four columns of who holds a task, each a lane of its own, the one a card would land in drawn so and a refused one faded (Q3.731)",
    [
      /const columns = BOARD_COLUMNS\.map\(/.test(boardSrc),
      /target \? "bg-brand\/8 ring-2 ring-brand\/35 ring-inset" : "bg-raised\/60"/.test(boardSrc),
      /\$\{refused \? "opacity-45" : ""\}/.test(boardSrc),
    ],
    [true, true, true],
  );
  check(
    "the columns keep their width and the board scrolls sideways past the pane, each column making a task in itself with its + (Q3.737)",
    [
      /className=\{`flex min-h-0 w-76 shrink-0 flex-col rounded-xl/.test(boardSrc),
      /<FlipBoundary order=\{order\} className=\{`flex min-h-0 shrink-0 gap-3/.test(boardSrc),
      /<div ref=\{area\} className="board-scroll flex min-h-0 flex-1 overflow-x-auto px-5 pb-3">/.test(boardSrc),
      /label=\{`New task in \$\{STATUS_LABEL\[column\]\}`\}\s*onClick=\{\(\) => navigate\(newTaskInPath\(column\)\)\}/.test(boardSrc),
      /flex-1 basis-0|min-w-52/.test(boardSrc),
    ],
    [true, true, true, true, false],
  );
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check(
    "the board's sideways bar is drawn always and wide enough to grab, in the palette's own inks, past the thin rule every scroller takes (Q3.738)",
    [
      /\.board-scroll \{\s*scrollbar-width: auto;\s*scrollbar-color: auto;\s*\}/.test(css),
      /\.board-scroll::-webkit-scrollbar \{\s*height: 14px;\s*\}/.test(css),
      /\.board-scroll::-webkit-scrollbar-thumb \{[^}]*background: var\(--color-edge-strong\);/.test(css),
      /\.board-scroll::-webkit-scrollbar-track \{[^}]*background: var\(--color-raised\);/.test(css),
    ],
    [true, true, true, true],
  );
  check(
    "a card is one size whatever it holds: its title on one line cut where it ends, its age beside it, who holds it, and the machine small under their name (Q3.731, Q3.737)",
    [
      /pointer-events-none relative flex h-25 w-full flex-col rounded-lg border border-edge bg-surface p-3 shadow-sm/.test(boardSrc),
      /min-w-0 flex-1 truncate text-sm leading-5 font-medium/.test(boardSrc) && !/line-clamp/.test(boardSrc),
      /\{shortDuration\(Math\.max\(0, Date\.now\(\) - task\.createdAt\)\)\}/.test(boardSrc),
      /<HolderAvatar holder=\{holder\} me=\{me\} \/>/.test(boardSrc),
      /\{holder\.kind !== "nobody" && \(\s*<span className="flex max-w-full min-w-0 items-center gap-1 leading-3 text-faint">\s*<MachineLabel name=\{entry\.machine\} small \/>/.test(boardSrc),
      /Needs you|projectName|animate-blink/.test(boardSrc),
      /<TaskMark status=\{column\} still \/>/.test(boardSrc),
    ],
    [true, true, true, true, true, false, true],
  );
  check(
    "its assignee is a control of its own over the card's press, never while an agent works, and opens the agent menu there (Q3.732)",
    [
      /onAssignee=\{working \|\| entry\.unavailable \? undefined : onAssignee\}/.test(boardSrc) &&
        /onAssignee=\{\(anchor\) => setAssigning\(\(open\) => \(open\?\.anchor === anchor \? null : \{ entry: item\.entry, anchor \}\)\)\}/.test(boardSrc) &&
        /<AssigneeMenu\s+key=\{cardKey\(assigning\.entry\)\}/.test(boardSrc),
      /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}\s*onClick=\{\(event\) => onAssignee\(event\.currentTarget\)\}/.test(boardSrc),
      /heading="Assignee"[\s\S]{0,120}?nobody\s+you\s+value=\{assigneeChoiceOf\(entry\)\}/.test(boardSrc),
      /createPortal\(/.test(stripComments(srcFile("ui/board/AgentMenu.tsx"))),
    ],
    [true, true, true, true],
  );

  process.stdout.write("  a task's page, and who does it\n");
  const screen = stripComments(srcFile("ui/board/TaskScreen.tsx"));
  check(
    "a task opens as its own page, laid out as a tracker's ticket: status, assignee and project beside what was asked (Q3.725)",
    [
      /export function openTask\(entry: Pick<BoardTask, "machineId" \| "task">\): void \{\s*navigate\(taskPath\(entry\.machineId, entry\.task\.id\)\);/.test(stripComments(srcFile("ui/board/actions.ts"))),
      /variant="row"\s*title="Status"/.test(screen),
      /shape=\{\{ variant: "row", title: "Assignee",/.test(screen),
      /shape=\{\{ variant: "row", title: "Project" \}\}/.test(screen),
    ],
    [true, true, true, true],
  );
  check(
    "who does it is nobody, its person, or a machine and an agent in one choice, and a task with a conversation stays on its machine",
    [
      /only=\{started \? entry\.machineId : null\}/.test(screen),
      /onChange=\{reassign\}\s*nobody\s*you/.test(screen),
      /group: machine\.name,/.test(stripComments(srcFile("ui/board/Pickers.tsx"))),
    ],
    [true, true, true],
  );
  check(
    "in the backlog an agent or its person picked is named and moves nothing, Start is its own, and while one works neither control hands the task to anybody else (Q3.732, Q3.736)",
    [
      /const landed = await assignTask\(entry, next, cwd\);/.test(screen),
      /disabled=\{still \|\| working\}/.test(screen),
      /\{backlog && holder\.kind === "agent" && \(/.test(screen),
      /if \(column === "running" && !working && !named\) return \{ \.\.\.set, disabled: true, description: "assign an agent first" \};/.test(screen),
      /if \(columnOf\(shownStatus\(entry\.task\.status\)\) === "ready"\) \{\s*if \(typeof to === "string"\) await changeTask\(entry, \{ assignee: to \}, \{ assignee: to, \.\.\.kept \}\);/.test(
        stripComments(srcFile("ui/board/actions.ts")),
      ),
    ],
    [true, true, true, true, true],
  );
  const actionsSrc = stripComments(srcFile("ui/board/actions.ts"));
  check(
    "handing one nobody started to another machine makes it there under its key first, then takes it off this one",
    /key: entry\.task\.key \?\? taskKey\(\),\s*start,\s*\}\);\s*board\.forget\(entry\.machineId, entry\.task\.id\);\s*await deleteTask\(entry\);/.test(actionsSrc),
    true,
  );
  check(
    "a status a press asks for is drawn at once and held until its answer, for a change and for an agent picked to start (Q3.728)",
    [
      /const release = Object\.keys\(asked\)\.length === 0 \? null : board\.hold\(entry\.machineId, entry\.task\.id, asked\);/.test(actionsSrc),
      /const release = board\.hold\(entry\.machineId, entry\.task\.id, \{\s*\.\.\.\(starts \? \{ status: "running" \} : \{\}\),\s*assignee: drawnAs\(entry, to\),\s*\.\.\.\(going === undefined \? \{\} : \{ machine: going\.name \}\),\s*\}\);/.test(actionsSrc),
      /setPicking\(\{ entry, release: board\.hold\(entry\.machineId, entry\.task\.id, \{ status: "running" \}\) \}\);/.test(stripComments(srcFile("ui/board/TaskDrop.tsx"))),
    ],
    [true, true, true],
  );
  const dropSrc = stripComments(srcFile("ui/board/TaskDrop.tsx"));
  check(
    "let go in Running, a card the backlog named an agent for starts it at once, and any other asks who (Q3.732)",
    /if \(from === "ready" && entry\.task\.assignee === "agent"\) \{\s*const where = window\.location\.pathname;\s*void startHere\(entry\)\.then\(\(session\) => openStarted\(session, where\), fail\);\s*return;\s*\}\s*setPicking\(/.test(dropSrc),
    true,
  );
  check(
    "every start pressed on the board, the list or a task's page opens the conversation it made, unless its person went elsewhere meanwhile (Q3.737)",
    [
      /export function openStarted\(session: SessionRef \| null, from: string\): void \{\s*if \(session !== null && window\.location\.pathname === from\) navigate\(sessionPath\(session\)\);/.test(actionsSrc),
      /void assign\(\{ \.\.\.entry, task: \{ \.\.\.entry\.task, status: "running" \} \}, agent\)\s*\.then\(\(session\) => openStarted\(session, where\)\)/.test(dropSrc),
      /void drops\.assign\(entry, to\)\.then\(\(session\) => openStarted\(session, where\)\);/.test(boardSrc),
      /next === "running" \? openStarted\(await startHere\(entry\), where\) : setTaskStatus\(entry, next\)/.test(screen),
      /if \(landed\.session !== null\) openStarted\(landed\.session, where\);/.test(screen),
    ],
    [true, true, true, true, true],
  );
  check(
    "the agents offered are the ones New session would offer there, in that machine's order",
    /\.filter\(\(row\) => !row\.hidden && startableHere\(row, agents, presets\)\)/.test(stripComments(srcFile("ui/board/assignees.ts"))),
    true,
  );

  process.stdout.write("  dragging a card between columns\n");
  const { dropRefused, landsIn, LIFTED } = await import("../src/ui/board/cardDrag.js");
  check(
    "any column takes a card, unless an agent is on it: that one may only be marked done (Q3.728)",
    BOARD_COLUMNS.map((from) => BOARD_COLUMNS.filter((to) => dropRefused(from, to)).join(",")),
    ["", "ready,review", "", ""],
  );
  const carriedCard = { entry: all[0]!, key: "m_a/t_1", from: "ready" as const, width: 1, height: 1, settling: null };
  check(
    "it lands only in another column that takes it; its own, none and a refused one all send it back",
    [
      landsIn({ ...carriedCard, over: "review" }),
      landsIn({ ...carriedCard, over: "ready" }),
      landsIn({ ...carriedCard, over: null }),
      landsIn({ ...carriedCard, from: "running", over: "review" }),
      landsIn({ ...carriedCard, from: "running", over: "done" }),
    ],
    ["review", null, null, null, "done"],
  );
  const dragSrc = stripComments(srcFile("ui/board/cardDrag.ts"));
  check(
    "a mouse arms on movement and never on the press, a finger drags nothing, and once armed the pointer is followed on window",
    [
      /event\.pointerType === "touch"/.test(dragSrc),
      /Math\.hypot\(event\.clientX - at\.x, event\.clientY - at\.y\) < MOUSE_SLOP/.test(dragSrc),
      /window\.addEventListener\("pointermove", move\);/.test(dragSrc),
      /setPointerCapture/.test(dragSrc),
    ],
    [true, true, true, false],
  );
  check(
    "Escape puts it back through overlay.ts, and the click a drag leaves behind opens nothing",
    [
      /useDismissible\("menu", \(\) => settle\(true\), carried !== null && carried\.settling === null\);/.test(dragSrc),
      /onClickCapture: \(event\) => \{\s*if \(!suppress\.current\) return;/.test(dragSrc),
    ],
    [true, true],
  );
  const flipSrc = stripComments(srcFile("ui/board/Flip.tsx"));
  check(
    "cards slide to where the next render puts them, measured only when the order changed, and nothing moves under reduced motion",
    [
      /if \(previous\.order === this\.props\.order \|\| this\.node === null\) return null;/.test(flipSrc),
      /if \(before === null \|\| this\.node === null \|\| reducedMotion\(\)\) return;/.test(flipSrc),
      /if \(node === null \|\| target === null \|\| reducedMotion\(\)\) \{\s*land\(\);/.test(dragSrc),
    ],
    [true, true, true],
  );
  const { laneItems } = await import("../src/ui/board/cardDrag.js");
  const backlogCard = { ...carriedCard, entry: all[0]!, key: "m_a/t_1" };
  const kinds = (items: ReturnType<typeof laneItems>) => items.map((item) => `${item.kind}:${item.entry.task.id}${item.kind === "slot" ? `:${item.holder.kind}` : ""}`);
  const namedCard = { ...backlogCard, entry: { ...all[0]!, task: { ...all[0]!.task, assignee: "agent" as const } } };
  check(
    "the slot opens where the board's own order puts the card, as it will be there: Running shows nobody until one is picked, unless the backlog named who starts (Q3.732)",
    [
      kinds(laneItems("running", [all[1]!], { ...backlogCard, over: "running" })),
      kinds(laneItems("running", [], { ...namedCard, over: "running" })),
      kinds(laneItems("review", [entry("t_9", "m_a", { status: "review", createdAt: 9 })], { ...backlogCard, over: "review" })),
      kinds(laneItems("ready", all.filter((one) => one.task.id === "t_1"), { ...backlogCard, over: null })),
    ],
    [["card:t_2", "slot:t_1:nobody"], ["slot:t_1:agent"], ["card:t_9", "slot:t_1:you"], ["ghost:t_1"]],
  );
  check(
    "a press that moved its own card, as one closing the agent menu does, carries nothing: no copy is measured off a card that is gone",
    /if \(!at\.node\.isConnected\) \{\s*stopFollowing\(\);\s*press\.current = null;\s*return;\s*\}/.test(dragSrc),
    true,
  );
  check(
    "the agent menu a drop opens is placed by the card in the area that took it: the list and the board draw one task twice",
    /anchor=\{\(\) => area\.current\?\.querySelector\(/.test(dropSrc),
    true,
  );
  check(
    "a landed card's ring has room above the first card of a column, and a list line's is drawn inside it",
    [/overflow-y-auto px-2 pt-0\.5 pb-2/.test(boardSrc), /animate-landed-in/.test(taskList)],
    [true, true],
  );
  check(
    "the tilt a copy lifts with is the one it settles back from",
    readFileSync(new URL("../src/index.css", import.meta.url), "utf8").includes(`transform: ${LIFTED};`),
    true,
  );
}
