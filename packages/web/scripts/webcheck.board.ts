import { readFileSync } from "node:fs";
import { boardHash, DEFAULT_BOARD, DEFAULT_BOARD_TEXT, parseBoard, REVIEW_LOOP_LOCAL_TEXT, type Board } from "@reemoat/board";
import type { BoardMachine, BoardTask, HeldBoard, HeldConfig } from "../src/board.js";
import type { MachineId, SessionId } from "../src/ids.js";
import type { SessionRow } from "../src/store.js";
import type { TaskSnapshot } from "../src/wire.js";
import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

const {
  BOARD_ABSENT_MS,
  BOARD_IDLE_MS,
  BOARD_WATCH_MS,
  DEFAULT_ACCOUNT_BOARD,
  DONE_RECENT_MS,
  MAX_REMEMBERED_TASKS,
  PHASE_LABEL,
  REMEMBERED_BRIEF_CHARS,
  SESSIONS_VIEW,
  STATUS_ORDER,
  accountBoard,
  boardDue,
  boardSignature,
  boardTasks,
  columnOn,
  columnTitle,
  drawnColumns,
  exitsOf,
  followTombstone,
  leadSession,
  liveBoard,
  liveTaskStatus,
  matchesTask,
  meTasks,
  needingYou,
  needOf,
  phaseOf,
  projectName,
  readBoardDocument,
  readStamp,
  readTask,
  recallAccountBoard,
  recallBoards,
  rememberAccountBoard,
  rememberBoards,
  shownStatus,
  taskGroups,
  cardHolder,
  taskHolder,
  taskKey,
  taskOfProposal,
  taskOfSession,
  taskRefKey,
  updatesTask,
  waitingSince,
} = await import("../src/board.js");
const { DISPATCH_NICKNAME, dispatchHome, dispatchSession, isDispatcher } = await import("../src/dispatch.js");
const { TASK_STATUSES } = await import("../src/wire.js");
const { meansRouteAbsent, ApiError } = await import("../src/http.js");
const { isSheet, depthOf, sheetKind, sheetTitle, upFrom, originFor, screenAt } = await import("../src/nav.js");
const { isOverlayPath } = await import("../src/ui/overlay.js");
const { buildTail, showsInTranscript } = await import("../src/ui/tail.js");
const { slowRoute } = await import("../src/machine.js");

const daemonSrc = (rel: string): string => stripComments(readFileSync(new URL(`../../../src/${rel}`, import.meta.url), "utf8"));

const parsed = (text: string): Board => {
  const result = parseBoard(text);
  if (!result.ok) throw new Error("a fixture board does not parse");
  return result.board;
};
const LOOP = parsed(REVIEW_LOOP_LOCAL_TEXT);

// Q3.719 to Q3.738, and the board from config (stage 3, stage 7): tasks live on their own machines, this client gathers them,
// and draws them in the columns the account's YAML names.
process.stdout.write("\nthe task board: gathered by this client, drawn in the columns the account's board names\n");
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
  const held = (tasks: TaskSnapshot[], read: HeldBoard["read"] = "known", config: HeldBoard["config"] = null, tombstones: HeldBoard["tombstones"] = []): HeldBoard => ({
    tasks,
    at: 5,
    read,
    daemon: "i_1",
    config,
    tombstones,
  });
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
      /if \(meansRouteAbsent\(cause\)\) \{\s*this\.held\.set\(machine\.id, \{ tasks: \[\], at: Date\.now\(\), read: "absent", daemon: instance, config: null, tombstones: \[\] \}\);/.test(store),
      /else if \(board !== undefined && board\.read !== "absent"\) \{\s*this\.held\.set\(machine\.id, \{ \.\.\.board, read: "failed" \}\);/.test(store),
      /if \(machine\.reach !== "online" \|\| this\.asking\.has\(machine\.id\)\) continue;/.test(store),
    ],
    [true, true, true],
  );

  process.stdout.write("  an older daemon's tasks, on the default columns\n");
  check("the default preset is today's four columns, the intake first", DEFAULT_BOARD.columns.map((column) => `${column.id}:${column.kind}`), [
    "backlog:wait",
    "running:work",
    "review:wait",
    "done:wait",
  ]);
  const legacy = (status: string): string => columnOn(DEFAULT_BOARD, { status: status as TaskSnapshot["status"] });
  check(
    "a daemon with no board: 1 is drawn by its status, one waiting on its person in Running where its agent still is, and a status this build never heard of in Review",
    [...STATUS_ORDER, "blocked_on_ci"].map(legacy),
    ["backlog", "running", "running", "review", "done", "review"],
  );
  check(
    "on another board an older daemon's statuses take the intake, the first work column, a column called review, and a closing one",
    ["ready", "running", "review", "done"].map((status) => columnOn(LOOP, { status: status as TaskSnapshot["status"] })),
    ["backlog", "build", "review", "done"],
  );
  check(
    "its phase is read off its status the same way, and the client's statuses are still the daemon's",
    [
      STATUS_ORDER.map((status) => phaseOf({ status })),
      [...TASK_STATUSES].sort(),
    ],
    [
      ["waiting", "working", "needs_you", "waiting", "waiting"],
      [...(/TASK_STATUSES = \[([^\]]*)\]/.exec(daemonSrc("tasks/store.ts"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((one) => one[1]).sort(),
    ],
  );
  check(
    "a status from a newer daemon asks to be looked at, the one group that claims nothing about it",
    [shownStatus("blocked_on_ci"), shownStatus(""), shownStatus("done")],
    ["review", "review", "done"],
  );
  check(
    "boardTasks marks which machines run the board: one whose list said board: 1, and no other",
    boardTasks([{ id: M("m_b"), name: "b", reach: "online" }, { id: M("m_c"), name: "c", reach: "online" }], new Map([
      [M("m_b"), held([task("t_1")], "known", { revision: 1, hash: "h" })],
      [M("m_c"), held([task("t_2")])],
    ])).map((entry) => entry.configured),
    [true, false],
  );

  process.stdout.write("  a configured daemon's tasks, on the account's board\n");
  check(
    "a task stands in the column its daemon names, and in the intake where the drawn board has no such column or only a view of it",
    [
      columnOn(LOOP, { column: "review", status: "running" }),
      columnOn(LOOP, { column: "qa", status: "review" }),
      columnOn(LOOP, { column: "chats", status: "review" }),
      columnOn(DEFAULT_BOARD, { column: "approve", status: "review" }),
    ],
    ["review", "backlog", "backlog", "backlog"],
  );
  check(
    "its phase is its daemon's, and a phase this build has never heard of claims nothing",
    [phaseOf({ phase: "judging", status: "running" }), phaseOf({ phase: "rehearsing" as never, status: "running" }), PHASE_LABEL.needs_you],
    ["judging", "waiting", "Needs you"],
  );
  check(
    "the board's own columns are drawn in its order, with a view of conversations first where it has none, and its own where it has one",
    [drawnColumns(DEFAULT_BOARD).map((column) => column.id), drawnColumns(LOOP).map((column) => column.id), columnTitle(DEFAULT_BOARD, SESSIONS_VIEW)],
    [[SESSIONS_VIEW, "backlog", "running", "review", "done"], ["chats", "backlog", "build", "review", "approve", "done"], "Chats"],
  );

  process.stdout.write("  the account's board: the newest copy any daemon holds\n");
  const copy = (revision: number, text: string): HeldConfig => ({ revision, hash: boardHash(text), text, board: parsed(text) });
  const a = copy(3, DEFAULT_BOARD_TEXT);
  const b = copy(4, REVIEW_LOOP_LOCAL_TEXT);
  const tieText = `${DEFAULT_BOARD_TEXT}# a comment\n`;
  const tie = copy(3, tieText);
  check(
    "of every daemon's copy the higher revision wins, and at one revision the smaller hash, so every client settles on the same board",
    [
      accountBoard([a, b]).revision,
      accountBoard([b, a]).revision,
      accountBoard([a, tie]).hash === (a.hash < tie.hash ? a.hash : tie.hash),
      accountBoard([tie, a]).hash === accountBoard([a, tie]).hash,
    ],
    [4, 4, true, true],
  );
  check("with no copy read the default preset stands, and is nothing this device writes down", [accountBoard([]) === DEFAULT_ACCOUNT_BOARD, rememberAccountBoard(DEFAULT_ACCOUNT_BOARD)], [
    true,
    null,
  ]);
  check(
    "a daemon's GET /board is read with this build's parser: a board it cannot read is no copy, and a malformed answer neither",
    [
      readBoardDocument({ version: 1, revision: 2, hash: "h", text: DEFAULT_BOARD_TEXT, board: {} })?.board.intake,
      readBoardDocument({ version: 1, revision: 2, hash: "h", text: "version: 2\ncolumns: []\n" }),
      readBoardDocument({ revision: "2", hash: "h", text: DEFAULT_BOARD_TEXT }),
      readBoardDocument(null),
    ],
    ["backlog", null, null, null],
  );
  const written = rememberAccountBoard(accountBoard([b]));
  check(
    "the board drawn is remembered whole and read back on a relaunch; a copy whose hash is not its text's, or a cut value, is the default",
    [
      recallAccountBoard(written).revision,
      recallAccountBoard(written).board.columns.length,
      recallAccountBoard(JSON.stringify({ revision: 9, hash: "0", text: REVIEW_LOOP_LOCAL_TEXT })) === DEFAULT_ACCOUNT_BOARD,
      recallAccountBoard("{cut") === DEFAULT_ACCOUNT_BOARD,
      recallAccountBoard(null) === DEFAULT_ACCOUNT_BOARD,
    ],
    [4, 6, true, true, true],
  );
  check(
    "a list's board stamp is believed only as board: 1 with both a revision and a hash",
    [
      readStamp({ board: 1, boardRevision: 3, boardHash: "h" }),
      readStamp({ board: 2, boardRevision: 3, boardHash: "h" }),
      readStamp({ board: 1, boardRevision: "3", boardHash: "h" }),
      readStamp({}),
    ],
    [{ revision: 3, hash: "h" }, null, null, null],
  );
  check(
    "the store reads a configured machine's board only when the revision or hash its list names is not the copy held",
    /if \(\(copy !== undefined && copy\.revision === stamp\.revision && copy\.hash === stamp\.hash\) \|\| this\.fetchingCopy\.has\(machine\)\) return;/.test(store),
    true,
  );

  process.stdout.write("  one task on two machines: the greater epoch, and the tombstones\n");
  const two = new Map<MachineId, HeldBoard>([
    [M("m_b"), held([task("t_x", { epoch: 1, column: "review" })], "known", { revision: 1, hash: "h" })],
    [M("m_a"), held([task("t_x", { epoch: 2, column: "running" })], "known", { revision: 1, hash: "h" })],
  ]);
  const both = boardTasks(fleet, two);
  check("a task two machines hold is drawn once, the copy of the greater epoch, wherever its machine stands in the order", [both.length, both[0]?.machineId, both[0]?.column], [1, "m_a", "running"]);
  check(
    "of two copies at one epoch, one whose machine is being read wins over what an away machine last said",
    boardTasks(fleet, new Map([
      [M("m_a"), held([task("t_x", { epoch: 2 })])],
      [M("m_b"), held([task("t_x", { epoch: 2 })])],
    ])).map((entry) => entry.machineId),
    ["m_b"],
  );
  const stones = new Map<MachineId, HeldBoard>([
    [M("m_b"), held([task("t_x", { epoch: 1 }), task("t_y", { epoch: 4 })], "known", { revision: 1, hash: "h" }, [
      { id: "t_x", epoch: 1, movedTo: "m_a", at: 9 },
      { id: "t_y", epoch: 3, movedTo: "m_a", at: 9 },
    ])],
  ]);
  check(
    "a copy its own machine's tombstone names at its epoch or later is not drawn, and a later copy there still is",
    boardTasks(fleet, stones).map((entry) => entry.task.id),
    ["t_y"],
  );
  check("and a task's page follows the tombstone to the machine it went to", [followTombstone(stones, M("m_b"), "t_x"), followTombstone(stones, M("m_b"), "t_z"), followTombstone(stones, M("m_c"), "t_x")], [
    "m_a",
    null,
    null,
  ]);

  const again = boardTasks(fleet, boards);
  const moved = (patch: Partial<TaskSnapshot>): string =>
    boardSignature(boardTasks(fleet, new Map(boards).set(M("m_b"), held([task("t_b1", patch), task("t_b2", { status: "done" })]))));
  check(
    "a read that changed nothing a board shows is the same board, and anything it shows is a different one",
    [
      boardSignature(again) === boardSignature(drawn),
      [
        { status: "running" as const },
        { updatedAt: 2_000 },
        { title: "renamed" },
        { sessions: [{ id: "s_1", agent: "claude", nickname: "mira", status: "idle" as const, attachedAt: 1 }] },
        { column: "review" },
        { phase: "queued" as const },
        { exits: [{ name: "ship", label: "Ship", to: "done" }] },
        { holder: "claude@mac" },
        { reason: "waiting for claude@server" },
        { epoch: 3 },
      ].map((patch) => moved(patch) === boardSignature(drawn)),
      boardSignature(boardTasks(fleet.map((machine) => (machine.id === "m_b" ? { ...machine, reach: "offline" as const } : machine)), boards)) === boardSignature(drawn),
    ],
    [true, [false, false, false, false, false, false, false, false, false, false], false],
  );
  check(
    "so a poll that brought no news redraws nothing and writes nothing, and a board that is not this account's is forgotten",
    [
      /if \(key === this\.drawnKey\) return;/.test(store),
      /const gone = state\.phase === "signed_out" \|\| \(state\.registry === "known" && !state\.machines\.some\(\(machine\) => machine\.id === id\)\);/.test(store),
    ],
    [true, true],
  );

  process.stdout.write("  the columns\n");
  const now = 10 * DONE_RECENT_MS;
  const entry = (id: string, machine: string, patch: Partial<TaskSnapshot> = {}, board: Board = DEFAULT_BOARD, configured = false): BoardTask =>
    boardTasks([{ id: M(machine), name: machine, reach: "online" }], new Map([[M(machine), held([task(id, patch)], "known", configured ? { revision: 1, hash: "h" } : null)]]), board)[0]!;
  const all: BoardTask[] = [
    entry("t_1", "m_a", { status: "ready", createdAt: 1 }),
    entry("t_2", "m_a", { status: "needs_you", createdAt: 2, title: "Make webhooks idempotent", sessions: [{ id: "s_1", agent: "claude", nickname: "mira", status: "blocked", attachedAt: 1 }] }),
    entry("t_3", "m_b", { status: "ready", createdAt: 3, cwd: "/srv/ledger", agent: "codex", labels: ["billing"] }),
    entry("t_4", "m_b", { status: "done", updatedAt: now - 1_000 }),
    entry("t_5", "m_b", { status: "done", updatedAt: now - DONE_RECENT_MS - 1 }),
    entry("t_6", "m_b", { status: "later_than_this_build" as never, createdAt: 9 }),
    entry("t_7", "m_a", { status: "ready", createdAt: 3 }),
  ];
  const shape = (view: Parameters<typeof taskGroups>[1], board: Board = DEFAULT_BOARD): string[] =>
    taskGroups(all, view, now, board).map((group) => `${group.column.id}: ${group.tasks.map((one) => one.task.id).join(" ")}`);
  check(
    "one group per column of the board, every one of them in its order; inside one the newest leads and a tie is settled by id",
    shape({ machine: null, query: "", done: "recent" }),
    ["backlog: t_3 t_7 t_1", "running: t_2", "review: t_6", "done: t_4"],
  );
  check("a task in a closing column more than a day is withheld until asked for", shape({ machine: null, query: "", done: "all" }).at(-1), "done: t_4 t_5");
  check("the search row's machine filter cuts every column to that machine", shape({ machine: M("m_a"), query: "", done: "recent" }), ["backlog: t_7 t_1", "running: t_2", "review: ", "done: "]);
  check(
    "the board is every machine's at once: a machine is who does a task, never a page of the board (Q3.724)",
    /return \{ machine: null, query: view\.query, done: currentTaskFilter\(\) === "all" \? "all" : "recent" \};/.test(stripComments(srcFile("ui/board/TaskList.tsx"))),
    true,
  );
  check(
    "the search finds a task by its title, its project, its agent, a label, or its session's name with or without the @",
    ["webhooks", "LEDGER", "codex", "billing", "@mira", "mira", "nothing-here"].map((query) =>
      taskGroups(all, { machine: null, query, done: "all" }, now)
        .flatMap((group) => group.tasks.map((one) => one.task.id))
        .join(" "),
    ),
    ["t_2", "t_3", "t_3", "t_3", "t_2", "t_2", ""],
  );
  check("an empty needle matches everything", matchesTask(all[0]!, "   "), true);
  check(
    "what waits on you is counted by phase, where the list is looking, an unavailable machine's included",
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
    "a task's page leads with the conversation waiting on you, else its run's, else the one working, else the newest; with none before any start",
    [
      leadSession(task("t", { sessions: [session("a", "idle", 3), session("b", "running", 1), session("c", "blocked", 2)] }))?.id,
      leadSession(task("t", { sessions: [session("a", "idle", 3), session("b", "starting", 1)] }))?.id,
      leadSession(task("t", { sessions: [session("a", "exited", 1), session("b", "idle", 3), session("c", "parked", 2)] }))?.id,
      leadSession(task("t", { run: { n: 2, column: "review", state: "ended", executor: "claude@mac", session: "a", startedAt: 1 }, sessions: [session("a", "idle", 1), session("b", "running", 3)] }))?.id,
      leadSession(task("t")),
    ],
    ["c", "b", "b", "a", null],
  );

  process.stdout.write("  a phase as fresh as the sessions it is read from\n");
  const live = (statuses: Record<string, string>) => (id: string): string | null => statuses[id] ?? null;
  const worked = task("t", { status: "running", sessions: [session("a", "running", 1), session("b", "idle", 2)] });
  check(
    "an older daemon's status is settled by what this client last heard of the task's own sessions (Q3.726)",
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
  const settled = liveBoard(all, (machine, id) => (machine === "m_a" && id === "s_1" ? "idle" : null));
  check(
    "the board as drawn moves only what changed, and keeps every other entry as it was",
    [settled.find((one) => one.task.id === "t_2")?.column, settled.filter((one, at) => one === all[at]).length],
    ["review", all.length - 1],
  );
  const inReview = entry("t_r", "m_c", { status: "review", column: "review", phase: "waiting", sessions: [session("s_r", "idle", 1)] }, DEFAULT_BOARD, true);
  const revived = liveBoard([inReview], () => "running")[0]!;
  const asks = liveBoard([inReview], () => "blocked")[0]!;
  check(
    "a configured task's chat coming back to life keeps it in Review, working, and one that asks something needs you there: the column is its daemon's alone",
    [revived.column, revived.phase, asks.column, asks.phase, liveBoard([inReview], () => null)[0] === inReview],
    ["review", "working", "review", "needs_you", true],
  );
  const pressed = liveBoard(all, () => "blocked", new Map([[taskRefKey("m_b", "t_5"), { column: "backlog", at: now }]]));
  const lifted = pressed.find((one) => one.task.id === "t_5")!;
  check(
    "a column a press asked for wins over the board and the sessions until it is answered, and is as new as the press (Q3.728)",
    [lifted.column, lifted.task.updatedAt, pressed.find((one) => one.task.id === "t_2")?.column],
    ["backlog", now, "running"],
  );
  const naming = { assignee: { assignee: "agent" as const, agent: "codex", customAgent: null }, at: now };
  const named = liveBoard(all, () => null, new Map([[taskRefKey("m_a", "t_1"), naming]])).find((one) => one.task.id === "t_1")!;
  const answered = [{ ...all[0]!, task: { ...all[0]!.task, assignee: "agent" as const, agent: "codex", updatedAt: now } }];
  check(
    "an assignee a press named is drawn at once, in the column it was in, and an answer that says the same keeps the entry as it was (Q3.732)",
    [[named.task.assignee, named.task.agent, named.column], liveBoard(answered, () => null, new Map([[taskRefKey("m_a", "t_1"), naming]]))[0] === answered[0]],
    [["agent", "codex", "backlog"], true],
  );
  const moving = { ...naming, machine: "studio" };
  const drawnMoving = liveBoard(answered, () => null, new Map([[taskRefKey("m_a", "t_1"), moving]]))[0]!;
  check(
    "a pick on another machine draws that machine at once, and nothing the task here says answers it, since it is deleted once made there (Q3.736)",
    [drawnMoving.machine, drawnMoving.machineId, drawnMoving === answered[0], liveBoard(answered, () => null)[0]!.machine],
    ["studio", "m_a", false, answered[0]!.machine],
  );
  const waitingHere = entry("t_q", "m_c", { status: "ready", column: "backlog", phase: "waiting", holder: "nobody", assignee: "agent", agent: "codex" }, DEFAULT_BOARD, true);
  const intoRunning = liveBoard([waitingHere], () => null, new Map([[taskRefKey("m_c", "t_q"), { column: "running", at: now }]]), DEFAULT_BOARD)[0]!;
  const intoReview = liveBoard([waitingHere], () => null, new Map([[taskRefKey("m_c", "t_q"), { column: "review", at: now }]]), DEFAULT_BOARD)[0]!;
  check(
    "a card let go in a working column is drawn queued for the agent its run is for, and in a waiting one held by that column's holder, before its daemon answers",
    [
      [intoRunning.column, intoRunning.phase, taskHolder(intoRunning.task, DEFAULT_BOARD)],
      [intoReview.column, intoReview.phase, taskHolder(intoReview.task, DEFAULT_BOARD).kind],
    ],
    [
      ["running", "queued", { kind: "agent", agent: "codex", customAgent: null, nickname: null, at: null }],
      ["review", "waiting", "you"],
    ],
  );
  const reviewOwned = entry("t_o", "m_c", { status: "review", column: "review", phase: "waiting", holder: "you", assignee: "agent", agent: "grok" }, DEFAULT_BOARD, true);
  const runElsewhere = entry("t_k", "m_c", { status: "running", column: "running", phase: "working", holder: "codex@studio", assignee: "agent", agent: "grok" }, DEFAULT_BOARD, true);
  const runNobody = entry("t_n", "m_c", { status: "running", column: "running", phase: "needs_you", holder: "nobody", assignee: "nobody", reason: "assign an agent" }, DEFAULT_BOARD, true);
  check(
    "a card names the task's own assignee wherever it stands, the run's agent only where one works or is queued in a working column, while the column's holder is still who it waits on",
    [
      [cardHolder(reviewOwned, DEFAULT_BOARD).kind, cardHolder(reviewOwned, DEFAULT_BOARD).kind === "agent" ? (cardHolder(reviewOwned, DEFAULT_BOARD) as { agent: string }).agent : null],
      [cardHolder(runElsewhere, DEFAULT_BOARD).kind, (cardHolder(runElsewhere, DEFAULT_BOARD) as { agent?: string }).agent],
      cardHolder(runNobody, DEFAULT_BOARD).kind,
      taskHolder(reviewOwned.task, DEFAULT_BOARD).kind,
    ],
    [["agent", "grok"], ["agent", "codex"], "nobody", "you"],
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

  process.stdout.write("  who holds a card, its phase, and its exits\n");
  check(
    "an older daemon's holder is read off it: in the backlog the agent named, its person or nobody, the agent on it while one works, its person otherwise (Q3.727, Q3.736)",
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
  const run = { n: 3, column: "build", state: "working" as const, executor: "claude@mac", session: "s_b", startedAt: 1 };
  const building = task("t", { status: "running", column: "build", phase: "working", holder: "claude@mac", run, sessions: [session("s_b", "running", 1)] });
  check(
    "a configured daemon's holder is its word, its machine kept apart from its name; a harness it names is no assembled agent; the intake still shows who its next run is",
    [
      taskHolder(building, LOOP),
      taskHolder({ ...building, sessions: [], agent: "claude" , holder: "codex@studio" }, LOOP),
      taskHolder(task("t", { column: "approve", phase: "waiting", holder: "you" }), LOOP),
      taskHolder(task("t", { column: "done", phase: "waiting", holder: "nobody" }), LOOP),
      taskHolder(task("t", { column: "backlog", phase: "waiting", holder: "nobody", assignee: "agent", agent: "codex" }), LOOP),
    ],
    [
      { kind: "agent", agent: "claude", customAgent: null, nickname: "s_b", at: "mac" },
      { kind: "agent", agent: "codex", customAgent: null, nickname: null, at: "studio" },
      { kind: "you" },
      { kind: "nobody" },
      { kind: "agent", agent: "codex", customAgent: null, nickname: null },
    ],
  );
  check(
    "a row's exits, run and the board's other fields are read where the daemon sent them, and an older daemon's row has none of them",
    [
      readTask({ id: "t", title: "x", column: "approve", phase: "waiting", epoch: 2, holder: "you", exits: [{ name: "merge", label: "Merge", to: "done" }, { name: 3 }], reason: null, budget: 7, labels: ["a", 1], waitingSince: 40 }),
      exitsOf(readTask({ id: "t", title: "x" })!),
      readTask({ id: "t", title: "x", run: { n: 1, column: "build", state: "sleeping", executor: null, session: null, startedAt: null } })?.run?.state,
    ],
    [
      {
        id: "t",
        title: "x",
        brief: "",
        status: "review",
        column: "approve",
        phase: "waiting",
        epoch: 2,
        waitingSince: 40,
        holder: "you",
        exits: [{ name: "merge", to: "done", label: "Merge" }],
        reason: null,
        budget: 7,
        labels: ["a"],
        summary: null,
        summaryAt: null,
        summaryBy: null,
        agent: "",
        customAgent: null,
        assignee: "nobody",
        cwd: "",
        key: null,
        createdAt: 0,
        updatedAt: 0,
        sessions: [],
      },
      [],
      "working",
    ],
  );

  process.stdout.write("  For you: the tasks you have a part in, every machine and column, as one list\n");
  const configured = (id: string, machine: string, patch: Partial<TaskSnapshot>): BoardTask => entry(id, machine, patch, LOOP, true);
  const row = (machine: string, id: string, asks: number[], status = "blocked"): SessionRow =>
    ({
      key: `${machine}/${id}`,
      ref: { machineId: M(machine), sessionId: id as SessionId },
      machineName: machine,
      snapshot: {
        id,
        status,
        pendingPermissions: asks.map((raisedAt, index) => ({ permissionId: `p${index}`, toolCallId: null, title: "Run it?", options: [], raisedAt, rawInput: null, content: null })),
        pendingElicitations: [],
        workspace: { requestedCwd: "/w", git: null },
        createdAt: 1,
      },
      daemonNow: 0,
      fetchedAt: 0,
    }) as never;
  const mine = [
    configured("t_q", "m_b", { column: "build", phase: "needs_you", waitingSince: 300, sessions: [session("s_q", "blocked", 1)] }),
    configured("t_s", "m_a", { column: "build", phase: "needs_you", waitingSince: 100, run: { ...run, state: "working" }, reason: "the agent ended its turn without a report" }),
    configured("t_e", "m_b", { column: "review", phase: "needs_you", waitingSince: 200, exits: [{ name: "fix", label: "fix", to: "build" }] }),
    configured("t_f", "m_a", { column: "build", phase: "needs_you", waitingSince: 50, run: { ...run, state: "failed" } }),
    configured("t_y", "m_a", { column: "approve", phase: "waiting", holder: "you", waitingSince: 20 }),
    configured("t_z", "m_b", { column: "approve", phase: "waiting", holder: "you", waitingSince: 10 }),
    configured("t_d", "m_b", { column: "done", phase: "waiting", holder: "you", waitingSince: 1 }),
    configured("t_w", "m_b", { column: "build", phase: "working", holder: "claude@mac" }),
    entry("t_old", "m_old", { status: "review", updatedAt: 150 }, LOOP),
  ];
  check(
    "what needs you leads, every machine's together, oldest first by waitingSince, then what you hold and nothing else needs; a closed task and one an agent works on are nobody's to act on, and an older daemon's in review is yours",
    meTasks(mine, LOOP, () => null).map((one) => `${one.entry.task.id}:${one.need ?? "held"}`),
    ["t_f:failed", "t_s:stop", "t_e:exits", "t_q:question", "t_z:held", "t_y:held", "t_old:held"],
  );
  const taskListAll = stripComments(srcFile("ui/board/TaskList.tsx"));
  const meSrc = taskListAll.slice(taskListAll.indexOf("export function MeBody"), taskListAll.indexOf("function foldedFirst"));
  check(
    "it is one list of lines that open the task: no headings, no conversation that asks, nothing answered in a row",
    [/<MeSection|AskInline|StopReply|MeAction|chatsWithoutTask/.test(meSrc), /onClick=\{\(\) => openTask\(entry\)\}/.test(meSrc)],
    [false, true],
  );
  check(
    "waitingSince is the daemon's, else when the task last changed",
    [waitingSince(mine[0]!), waitingSince(entry("t_u", "m_old", { updatedAt: 77 }))],
    [300, 77],
  );
  check(
    "a needing task says what it waits on: a question its session holds first, then exits to choose, a failed run, a stop",
    [
      needOf(mine[0]!, () => null),
      needOf(configured("t_x", "m_a", { phase: "needs_you", sessions: [session("s_x", "idle", 1)] }), () => "blocked"),
      needOf(mine[2]!, () => null),
      needOf(mine[3]!, () => null),
      needOf(mine[1]!, () => null),
      needOf(configured("t_b", "m_a", { phase: "needs_you", reason: "the board moved this task as many times in a row as it may without you" }), () => null),
    ],
    ["question", "question", "exits", "failed", "stop", "other"],
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
        [M("m_moved"), held([], "known", { revision: 2, hash: "h" }, [{ id: "t_x", epoch: 1, movedTo: "m_a", at: 3 }])],
      ]),
    ),
  );
  check(
    "a machine's board is written down bounded, each brief cut to enough to recognise it, an absent or empty one not at all, and one holding only tombstones kept",
    [[...remembered.keys()], remembered.get(M("m_a"))?.tasks.length, remembered.get(M("m_a"))?.tasks[0]?.brief.length, remembered.get(M("m_moved"))?.tombstones, remembered.get(M("m_moved"))?.config],
    [["m_a", "m_moved"], MAX_REMEMBERED_TASKS, REMEMBERED_BRIEF_CHARS, [{ id: "t_x", epoch: 1, movedTo: "m_a", at: 3 }], { revision: 2, hash: "h" }],
  );
  check("read back, it is what the machine last said and nothing has confirmed since", [remembered.get(M("m_a"))?.read, remembered.get(M("m_a"))?.daemon], ["failed", null]);
  check(
    "so a machine that is away after a relaunch still shows its tasks, as unavailable",
    boardTasks([{ id: M("m_a"), name: "atlas", reach: "offline" }], remembered).slice(0, 1).map((one) => [one.task.id, one.unavailable]),
    [["t_0", true]],
  );
  const before = JSON.stringify({ m_a: { at: 4, tasks: [{ id: "t_1", title: "x", status: "review", createdAt: 1, updatedAt: 2, sessions: [] }] } });
  check(
    "an entry written before the board read back keeps reading: an older daemon's task, with no stamp and no tombstones (compatibility.md rule 2)",
    [...recallBoards(before)].map(([id, one]) => [id, one.tasks.map((t) => t.id), one.config, one.tombstones, one.read]),
    [["m_a", ["t_1"], null, [], "failed"]],
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
    [/<AssigneeDropdown/.test(card), /<ProjectDropdown/.test(card), /const machineId = agent\?\.machineId \?\? edited\.machineId;/.test(card), /cwd: project,/.test(card)],
    [true, true, true, true],
  );
  check(
    "every row starts nobody's, keeping the agent proposed for a later Start, offers its person too, and one press adds it or, with an agent picked, starts it (Q3.727, Q3.736)",
    [
      /return \{ assignee: null, machineId, project: proposal\.project \};/.test(card),
      /agent: agent === null \? \(proposal\.agent \?\? heldRoster\(machineId\)\?\.agents\[0\]\?\.harness \?\? "claude"\) : agent\.kind === "custom" \? "" : agent\.id,/.test(card),
      /const start = agent !== null && column === null;/.test(card),
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

  {
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
    [/entry\.phase === "needs_you" \? "font-semibold" : ""/.test(taskList), /needs_you: "bg-brand ring-\[3px\] ring-brand\/25"/.test(taskList), /<SessionMenu|RowMenu/.test(taskList)],
    [true, true, false],
  );
  check(
    "a page's row budget is the session list's own, a heading costing a row, and every group is drawn once any task is",
    [/const taken = takeRows\(collapsed \? \[\] : group\.tasks, left, 1\);/.test(taskList), /if \(!any \|\| left\.rows <= 0\) return \[\];/.test(taskList)],
    [true, true],
  );
  check("the board's tab counts the tasks that wait on their person", /return needingYou\(useLiveTasks\(state\)\);/.test(taskList), true);
  check(
    "the intake and the closing columns start folded and the groups between open, and a line opens the conversation doing it, else its page (Q3.733, Q3.737)",
    [
      /return column === board\.intake \|\| isFinal\(board, column\);/.test(taskList) &&
        /return foldedFirst\(board, column\) \? !held : held;/.test(taskList),
      /const lead = leadRef\(entry\);\s*if \(lead === null\) openTask\(entry\);\s*else navigate\(sessionPath\(lead\)\);/.test(taskList),
    ],
    [true, true],
  );
  check(
    "a line is dragged between groups on the list's own axis, by the board's drop, and a working task's mark blinks as a working session's does, still only as a column's",
    [
      /const drag = useCardDrag\(drops\.drop, SESSIONS_VIEW, "y"\);/.test(taskList),
      /const drops = useTaskDrop\(state, setLanded\);/.test(taskList),
      /working: "bg-fg text-fg animate-blink",/.test(taskList),
      /still && phase === "working" \? "bg-fg" : PHASE_MARK\[phase\]/.test(taskList),
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
      /entry\.machineId === sessionRef\.machineId && !isFinal\(tasks\.board\.board, entry\.column\)/.test(menu),
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
      // Any id of a column's shape: the board names its columns (Q3.740).
      { name: "newTask", machineId: null, column: "later" },
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
  }

  process.stdout.write("  the board's pane\n");
  const boardSrc = stripComments(srcFile("ui/board/Board.tsx"));
  check(
    "the board is the list's own view drawn a second time: one needle, one filter, and no state but which of the two the pane shows, an assignee's menu and a landing",
    [
      /const view = currentView\(sessionGroups\(state\)\);/.test(boardSrc),
      /taskGroups\(tasks, boardView\(view\), Date\.now\(\), drawn\)/.test(boardSrc),
      [...boardSrc.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((one) => one[1]),
    ],
    [true, true, ["shown", "assigning", "landed"]],
  );
  check(
    "the columns are the account's board, never a view of conversations, which stay in the list; each a lane of its own, the one a card would land in drawn so and a refused one faded (Q3.731)",
    [
      /const columns = flowColumns\(drawn\);/.test(boardSrc),
      /const lanes = columns\.map\(\(column\) => \{/.test(boardSrc),
      /target \? "bg-brand\/8 ring-2 ring-brand\/35 ring-inset" : "bg-raised\/60"/.test(boardSrc),
      /\$\{refused \? "opacity-45" : ""\}/.test(boardSrc),
      /BOARD_COLUMNS|STATUS_LABEL/.test(boardSrc),
    ],
    [true, true, true, true, false],
  );
  check(
    "the columns keep their width and the board scrolls sideways past the pane, each column making a task in itself with its +, and the board's own screen one press away",
    [
      /className=\{`flex min-h-0 w-76 shrink-0 flex-col rounded-xl/.test(boardSrc),
      /<FlipBoundary order=\{order\} className=\{`flex min-h-0 shrink-0 gap-3/.test(boardSrc),
      /<div ref=\{area\} className=\{`board-scroll min-h-0 flex-1 overflow-x-auto px-5 pb-3 \$\{shown === "board" \? "flex" : "hidden"\}`\}>/.test(boardSrc),
      /label=\{`New task in \$\{column\.title\}`\}/.test(boardSrc),
      /onClick=\{\(\) => navigate\(boardConfigPath\(\)\)\}/.test(boardSrc),
      /flex-1 basis-0|min-w-52/.test(boardSrc),
    ],
    [true, true, true, true, true, false],
  );
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check(
    "the board's sideways bar is drawn always, 14 px, with both standard properties back to auto so the pseudo-elements apply, while each column scrolls down with none (Q3.745)",
    [
      /\.board-scroll \{\s*scrollbar-width: auto;\s*scrollbar-color: auto;/.test(css),
      /\.board-scroll::-webkit-scrollbar \{\s*height: 14px;/.test(css),
      /<div data-lane-scroll className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto/.test(boardSrc),
      /\.no-scrollbar \{\s*scrollbar-width: none;/.test(css),
      /<div ref=\{area\} className=\{`no-scrollbar/.test(boardSrc),
    ],
    [true, true, true, true, false],
  );
  check(
    "a card is one size whatever it holds: its title on one line with its age, its phase or why it waits, who holds it with the machine under, and its exits (Q3.731, Q3.737)",
    [
      /pointer-events-none relative flex h-28 w-full flex-col rounded-lg border border-edge bg-surface p-3 shadow-sm/.test(boardSrc),
      /min-w-0 flex-1 truncate text-sm leading-5 font-medium/.test(boardSrc) && !/line-clamp/.test(boardSrc),
      /\{shortDuration\(Math\.max\(0, Date\.now\(\) - task\.createdAt\)\)\}/.test(boardSrc),
      /<HolderAvatar holder=\{holder\} me=\{me\} \/>/.test(boardSrc),
      /const said = entry\.phase !== "waiting" && reason !== null && reason\.length > 0 \? reason : entry\.phase === "waiting" \? null : PHASE_LABEL\[entry\.phase\];/.test(boardSrc),
      /const exits = exitsOf\(task\)\.slice\(0, CARD_EXITS\);/.test(boardSrc),
      /onClick=\{\(\) => onExit\?\.\(\{ exit: exit\.name, to: exit\.to \}\)\}/.test(boardSrc),
      /<PhaseMark phase=\{entry\.phase\} closed=\{closed\} \/>/.test(boardSrc),
    ],
    [true, true, true, true, true, true, true, true],
  );
  check(
    "a card names its assignee in every column, the run's agent where one works, by its name and never `agent@machine`, the machine drawn under it; it is pressed anywhere but while its agent works (Q3.732, Q3.740)",
    [
      /export function holderName[\s\S]{0,300}?return assignedLabel\(/.test(boardSrc) && !/task\.holder/.test(boardSrc),
      /const assignable = !entry\.unavailable && entry\.phase !== "working";/.test(boardSrc),
      /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}\s*onClick=\{\(event\) => onAssignee\(event\.currentTarget\)\}/.test(boardSrc),
      /heading="Assignee"[\s\S]{0,120}?nobody\s+you\s+value=\{assigneeChoiceOf\(entry, board\)\}/.test(boardSrc),
      /createPortal\(/.test(stripComments(srcFile("ui/board/AgentMenu.tsx"))),
    ],
    [true, true, true, true, true],
  );

  process.stdout.write("  moving a card\n");
  const actionsSrc = stripComments(srcFile("ui/board/actions.ts"));
  const dropSrc = stripComments(srcFile("ui/board/TaskDrop.tsx"));
  check(
    "on a daemon that runs the board a move is from the column it was seen in, drawn there at once, and a task that moved meanwhile reads the board again",
    [
      /const release = board\.hold\(entry\.machineId, entry\.task\.id, \{ column: target\.to \}\);/.test(actionsSrc),
      /const from = entry\.task\.column \?\? entry\.column;\s*const body = "exit" in target \? \{ exit: target\.exit, from \} : \{ to: target\.to, from \};/.test(actionsSrc),
      /if \(ApiError\.isApiError\(cause\) && cause\.code === "task_moved"\) board\.refresh\(entry\.machineId\);/.test(actionsSrc),
    ],
    [true, true, true],
  );
  check(
    "one its agent works on is refused, and the card asks whether to stop the agent and move it, sent again with stop (Q3.728)",
    [
      /if \(refusedWhileWorking\(cause\)\) \{[\s\S]{0,200}?setStopping\(\{ entry, target, release: board\.hold\(entry\.machineId, entry\.task\.id, \{ column: target\.to \}\) \}\);/.test(dropSrc),
      /label: "Stop and move",[\s\S]{0,200}?void moveTo\(entry, target, true\)\.catch\(fail\)\.finally\(release\);/.test(dropSrc),
      /heading="Its agent is working"/.test(dropSrc),
    ],
    [true, true, true],
  );
  check(
    "an older daemon's card takes the column's status: its work column starts the agent the intake named, any other asks who (Q3.732)",
    [
      /const status = legacyTarget\(drawn, to\);\s*if \(status !== "running"\) \{\s*void setTaskStatus\(entry, status\)\.catch\(fail\);/.test(dropSrc),
      /if \(entry\.column === drawn\.intake && entry\.task\.assignee === "agent"\) \{\s*const where = window\.location\.pathname;\s*void startHere\(entry, to\)\.then\(\(session\) => openStarted\(session, where\), fail\);/.test(dropSrc),
      /setPicking\(\{ entry, column: to, release: board\.hold\(entry\.machineId, entry\.task\.id, \{ column: to \}\) \}\);/.test(dropSrc),
    ],
    [true, true, true],
  );
  const { legacyTarget } = await import("../src/ui/board/actions.js");
  check(
    "a column of the drawn board is an older daemon's status by what it is: the intake the backlog, a closing one done, a work column a start",
    [DEFAULT_BOARD, LOOP].map((board) => board.columns.filter((column) => column.kind !== "view").map((column) => legacyTarget(board, column.id))),
    [
      ["ready", "running", "review", "done"],
      ["ready", "running", "running", "review", "done"],
    ],
  );
  check(
    "a conversation let go in a column becomes a task holding it: made where it is, attached, then moved, so a work column's run continues it",
    [
      /column: works \? drawn\.intake : column/.test(actionsSrc),
      /const attached = await daemon\.attachSession\(made\.task\.id, chat\.ref\.sessionId\);/.test(actionsSrc),
      /if \(configured && works\) \{[\s\S]{0,240}?await moveTo\(entry, \{ to: column \}\);/.test(actionsSrc),
      /void taskFromChat\(/.test(dropSrc),
    ],
    [true, true, true, true],
  );
  check(
    "handing one nobody started to another machine makes it there under its key first, then takes it off this one",
    /key: entry\.task\.key \?\? taskKey\(\),\s*start,\s*attachments: await carryFiles\(entry, to\.machineId\),\s*\}\);\s*board\.forget\(entry\.machineId, entry\.task\.id\);\s*await deleteTask\(entry\);/.test(actionsSrc),
    true,
  );
  check(
    "and carries its files: fetched from the machine it leaves and staged on the one it goes to, since no daemon moves them (Q3.744)",
    [
      /const blob = await from\.downloadTaskFile\(entry\.task\.id, file\.id\);/.test(actionsSrc),
      /await there\.uploadTaskFile\(new File\(\[blob\], file\.name/.test(actionsSrc),
    ],
    [true, true],
  );
  {
    const newTaskSrc = stripComments(srcFile("ui/board/NewTask.tsx"));
    check(
      "New task's files go to the machine the task is made on, at the press, before the create that names them (Q3.744)",
      [
        /void uploadPicked\(machineId, attached\.files, attached\.progress\)\s*\.then\(\(attachments\) => \{/.test(newTaskSrc),
        /cwd,\s*start,\s*attachments,\s*\}\);/.test(newTaskSrc),
        /onPaste=\{\(event\) => \{\s*const files = \[\.\.\.\(event\.clipboardData\?\.files \?\? \[\]\)\];\s*if \(files\.length === 0\) return;/.test(newTaskSrc),
      ],
      [true, true, true],
    );
  }
  check(
    "a column a press asks for is drawn at once and held until its answer, for a change and for an agent picked to start (Q3.728)",
    [
      /const release = Object\.keys\(asked\)\.length === 0 \? null : board\.hold\(entry\.machineId, entry\.task\.id, asked\);/.test(actionsSrc),
      /const release = board\.hold\(entry\.machineId, entry\.task\.id, \{\s*\.\.\.\(column === null \? \{\} : \{ column \}\),\s*assignee: drawnAs\(entry, to\),\s*\.\.\.\(going === undefined \? \{\} : \{ machine: going\.name \}\),\s*\}\);/.test(actionsSrc),
    ],
    [true, true],
  );
  check(
    "every start pressed on the board or the list opens the conversation it made, unless its person went elsewhere meanwhile (Q3.737)",
    [
      /export function openStarted\(session: SessionRef \| null, from: string\): void \{\s*if \(session !== null && window\.location\.pathname === from\) navigate\(sessionPath\(session\)\);/.test(actionsSrc),
      /void assign\(\{ \.\.\.entry, column, task: \{ \.\.\.entry\.task, status: "running" \} \}, agent\)\s*\.then\(\(session\) => openStarted\(session, where\)\)/.test(dropSrc),
      /void drops\.assign\(entry, to\)\.then\(\(session\) => openStarted\(session, where\)\);/.test(boardSrc),
    ],
    [true, true, true],
  );
  check(
    "the agents offered are the ones New session would offer there, in that machine's order",
    /\.filter\(\(row\) => !row\.hidden && startableHere\(row, agents, presets\)\)/.test(stripComments(srcFile("ui/board/assignees.ts"))),
    true,
  );

  process.stdout.write("  dragging a card between columns\n");
  const { dropRefused, landsIn, laneItems, slotHolder, LIFTED } = await import("../src/ui/board/cardDrag.js");
  check(
    "every column takes a card but the view of conversations: a task is not a conversation (Q3.728)",
    drawnColumns(LOOP).map((column) => dropRefused("chats", column.id)),
    [true, false, false, false, false, false],
  );
  const asCard = (one: BoardTask) => ({ kind: "task" as const, entry: one });
  const carriedCard = { card: asCard(all[0]!), key: "m_a/t_1", from: "backlog", width: 1, height: 1, settling: null };
  check(
    "it lands only in another column that takes it; its own, none and the view all send it back",
    [
      landsIn({ ...carriedCard, over: "review" }, SESSIONS_VIEW),
      landsIn({ ...carriedCard, over: "backlog" }, SESSIONS_VIEW),
      landsIn({ ...carriedCard, over: null }, SESSIONS_VIEW),
      landsIn({ ...carriedCard, over: SESSIONS_VIEW }, SESSIONS_VIEW),
      landsIn({ ...carriedCard, from: "running", over: "review" }, SESSIONS_VIEW),
    ],
    ["review", null, null, null, "review"],
  );
  const kinds = (items: ReturnType<typeof laneItems>) =>
    items.map((item) => `${item.kind}:${item.card.kind === "task" ? item.card.entry.task.id : "chat"}${item.kind === "slot" ? `:${item.holder.kind}` : ""}`);
  const namedCard = { ...carriedCard, card: asCard({ ...all[0]!, task: { ...all[0]!.task, assignee: "agent" as const } }) };
  check(
    "the slot opens where the board's own order puts the card, as it will be there: a waiting column's own holder, a work column the agent the task names or nobody (Q3.732)",
    [
      kinds(laneItems("running", [asCard(all[1]!)], { ...carriedCard, over: "running" }, DEFAULT_BOARD, SESSIONS_VIEW)),
      kinds(laneItems("running", [], { ...namedCard, over: "running" }, DEFAULT_BOARD, SESSIONS_VIEW)),
      kinds(laneItems("review", [asCard(entry("t_9", "m_a", { status: "review", createdAt: 9 }))], { ...carriedCard, over: "review" }, DEFAULT_BOARD, SESSIONS_VIEW)),
      kinds(laneItems("backlog", [asCard(all[0]!)], { ...carriedCard, over: null }, DEFAULT_BOARD, SESSIONS_VIEW)),
    ],
    [["card:t_2", "slot:t_1:nobody"], ["slot:t_1:agent"], ["card:t_9", "slot:t_1:you"], ["ghost:t_1"]],
  );
  const chat = { kind: "chat" as const, row: row("m_a", "s_c", []) };
  check(
    "a conversation carried into a column opens its slot at the top, the newest task there, held by its own agent",
    [
      kinds(laneItems("review", [asCard(entry("t_9", "m_a", { status: "review", createdAt: 9 }))], { ...carriedCard, card: chat, key: "chat:m_a/s_c", from: SESSIONS_VIEW, over: "review" }, DEFAULT_BOARD, SESSIONS_VIEW)),
      slotHolder(DEFAULT_BOARD, asCard(all[0]!), "done"),
    ],
    [["slot:chat:agent", "card:t_9"], { kind: "nobody" }],
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
  check(
    "a press that moved its own card, as one closing the agent menu does, carries nothing: no copy is measured off a card that is gone",
    /if \(!at\.node\.isConnected\) \{\s*stopFollowing\(\);\s*press\.current = null;\s*return;\s*\}/.test(dragSrc),
    true,
  );
  check(
    "the menu a drop opens is placed by the card in the area that took it",
    /area\.current\?\.querySelector\(`\[data-flip="\$\{CSS\.escape\(key\)\}"\]:not\(\[data-slot\]\)`\)/.test(dropSrc),
    true,
  );
  check("a landed card's ring has room above the first card of a column", /overflow-y-auto px-2 pt-0\.5 pb-2/.test(boardSrc), true);
  check(
    "the tilt a copy lifts with is the one it settles back from",
    readFileSync(new URL("../src/index.css", import.meta.url), "utf8").includes(`transform: ${LIFTED};`),
    true,
  );
}
