import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";
import { type BuiltRows, drawn } from "./webcheck.rows.js";
import {
  MAX_CHILDREN,
  buildTail,
  foldRuns,
  isDelegation,
  isTerminal,
  outstandingTasks,
  permissionDecisions,
  streamedSinceTool,
  placeNodes,
  runSummary,
  sameNode,
  stillRunning,
} from "./webcheck.modules.js";

process.stdout.write("\na subagent's work, under the tool call that started it\n");
{
  let seq = 0;
  const ev = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const toolCall = (id: string, title: string, parent: string | null = null): never =>
    ev({ type: "tool_call", toolCallId: id, title, kind: "other", status: "pending", locations: [], rawInput: null, parentToolCallId: parent });
  const done = (id: string, parent: string | null = null): never =>
    ev({ type: "tool_call_update", toolCallId: id, title: null, status: "completed", locations: [], rawInput: null, content: null, parentToolCallId: parent });
  const failed = (id: string, parent: string | null = null): never =>
    ev({ type: "tool_call_update", toolCallId: id, title: "boom", status: "failed", locations: [], rawInput: null, content: null, parentToolCallId: parent });

  {
    seq = 0;
    const tail = buildTail(
      [toolCall("task", "Explore the auth code"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")],
      [],
    );
    check("a child is placed under its parent and not in the transcript", tail.rows.map((r) => r.key), ["e1"]);
    const task = tail.rows[0] as { children: { key: string }[]; steps: number; latest: string | null };
    check("children keep document order under their parent", task.children.map((c) => c.key), ["e2", "e3"]);
    check("steps counts them", task.steps, 2);
    check("and the newest is what a running header shows", task.latest, "read");
  }

  {
    seq = 0;
    const running = buildTail([toolCall("task", "Explore the auth code"), toolCall("c1", "grep", "task")], []);
    const waiting = outstandingTasks(running.rows);
    check("a spawn nobody has finished is what we are waiting for", waiting.map((t) => t.title), ["Explore the auth code"]);
    check("and it carries what it last did, for the opened list", [waiting[0]?.steps, waiting[0]?.latest], [1, "grep"]);

    seq = 0;
    const finished = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), done("task")],
      [],
    );
    check("a spawn that reported finishing is not", outstandingTasks(finished.rows).length, 0);

    seq = 0;
    const backgrounded = buildTail(
      [
        toolCall("bash", "Bash"),
        ev({ type: "tool_call_update", toolCallId: "bash", title: null, status: null, locations: [], rawInput: null, content: null, parentToolCallId: null, backgrounded: true }),
        done("bash"),
      ],
      [],
    );
    check(
      "a call that detached is still marked after its completing update lands",
      (backgrounded.rows[0] as { backgrounded: boolean; status: string }).backgrounded,
      true,
    );
    check(
      "and the status it was sent is kept rather than rewritten",
      (backgrounded.rows[0] as { status: string }).status,
      "completed",
    );
    seq = 0;
    const ordinary = buildTail([toolCall("bash", "Bash"), done("bash")], []);
    check(
      "an ordinary completed call is not marked",
      (ordinary.rows[0] as { backgrounded: boolean }).backgrounded,
      false,
    );

    seq = 0;
    const nested = buildTail(
      [toolCall("outer", "Outer"), toolCall("inner", "Inner", "outer"), toolCall("leaf", "leaf", "inner")],
      [],
    );
    check("a delegation inside a delegation is one thing to wait for", outstandingTasks(nested.rows).length, 1);

    seq = 0;
    const plain = buildTail([toolCall("a", "grep")], []);
    check("an ordinary call is not a task", outstandingTasks(plain.rows).length, 0);

    const node = (over: Record<string, unknown>) =>
      ({ kind: "tool", status: "completed", subagent: false, steps: 0, ...over }) as never;
    check("still-running is pending or in_progress and nothing else", [
      stillRunning(node({ status: "pending" })),
      stillRunning(node({ status: "in_progress" })),
      stillRunning(node({ status: "completed" })),
      stillRunning(node({ status: "failed" })),
    ], [true, true, false, false]);
    check("a delegation is one the agent declared, or one that started work", [
      isDelegation(node({ subagent: true })),
      isDelegation(node({ steps: 3 })),
      isDelegation(node({})),
    ], [true, true, false]);

    seq = 0;
    const sub = (id: string, title: string, parent: string): never =>
      ev({ type: "tool_call", toolCallId: id, title, kind: "other", status: "pending", locations: [], rawInput: null, parentToolCallId: parent, subagent: true });
    const stale = buildTail(
      [toolCall("outer", "Outer"), sub("inner", "Inner", "outer"), toolCall("leaf", "grep", "outer"), done("outer")],
      [],
    );
    check(
      "a child still running under a parent that reported finishing is still a wait",
      outstandingTasks(stale.rows).map((t) => t.title),
      ["Inner"],
    );
  }

  {
    seq = 0;
    const started = (): never => ev({ type: "session_started" });
    const restarted = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), started()],
      [],
    );
    check("a restart puts a floor under the transcript", restarted.taskFloor, 3);
    check(
      "and a spawn the previous agent left running is not still a wait",
      outstandingTasks(restarted.rows, restarted.taskFloor).length,
      0,
    );
    check("which is exactly what the ungated walk answers", outstandingTasks(restarted.rows).length, 1);

    seq = 0;
    const after = buildTail(
      [toolCall("old", "Old"), started(), toolCall("new", "New"), toolCall("c1", "grep", "new")],
      [],
    );
    check(
      "a spawn the new agent started is a wait again",
      outstandingTasks(after.rows, after.taskFloor).map((t) => t.title),
      ["New"],
    );

    const ended = (reason: string): never => ev({ type: "turn_end", stopReason: reason, usage: null });
    const spawn = (): never[] => [toolCall("task", "Explore"), toolCall("c1", "grep", "task")];
    seq = 0;
    const cancelled = buildTail([...spawn(), ended("cancelled")], []);
    check(
      "a cancelled turn abandons what it started",
      outstandingTasks(cancelled.rows, cancelled.taskFloor).length,
      0,
    );
    seq = 0;
    const finishedTurn = buildTail([...spawn(), ended("end_turn")], []);
    check("a turn that simply ended does not", finishedTurn.taskFloor, 0);
    check(
      "so its delegation is still outstanding, which is the point of the line",
      outstandingTasks(finishedTurn.rows, finishedTurn.taskFloor).length,
      1,
    );
    seq = 0;
    const unknown = buildTail([...spawn(), ended("max_tokens")], []);
    check("and a reason this client has never heard of cuts", unknown.taskFloor > 0, true);
    seq = 0;
    const failed = buildTail([...spawn(), ended("agent_error")], []);
    check("a turn that ended in an error abandons what it started too", failed.taskFloor > 0, true);
    check(
      "so nothing is left waiting on work that stopped when the turn did",
      outstandingTasks(failed.rows, failed.taskFloor).length,
      0,
    );
  }

  {
    const { mayStillReport } = await import("../src/wire.js");
    const snap = (status: string): never => ({ status, turn: null }) as never;
    check("a turn that ended can still be reported on", mayStillReport(snap("idle")), true);
    check("so can one still running", mayStillReport(snap("running")), true);
    check("and a blocked one, deliberately", mayStillReport(snap("blocked")), true);
    check(
      "an ended session is not waiting for anything",
      ["exited", "failed", "interrupted"].map((status) => mayStillReport(snap(status))),
      [false, false, false],
    );
    check("nor is one being stopped", mayStillReport(snap("stopping")), false);
    check("which isTerminal does not say, which is why it is its own clause", isTerminal("stopping"), false);
  }

  // Q3.644: what the working line counts, and what counting it costs.
  {
    const { streamedSays } = await import("../src/ui/EventList.js");
    check("nothing streamed says nothing", streamedSays(0), null);
    check("nor does less than half a token", streamedSays(1), null);
    check("one token is one, in the singular", streamedSays(4), "↓ 1 token");
    check("Claude Code's estimate, characters over four", streamedSays(400), "↓ 100 tokens");
    check("in the panel's compact number past a thousand", streamedSays(4_800), "↓ 1.2k tokens");

    seq = 0;
    const text = (body: string, over: Record<string, unknown> = {}): never =>
      ev({ type: "text", role: "agent", thought: false, text: body, messageId: null, ...over });
    const opening = [ev({ type: "prompt", text: "go", attachments: null }), text("abcd"), text("efgh", { thought: true })];
    check(
      "the agent's words count and so do its thoughts, which are logged though never drawn",
      streamedSinceTool([...opening, text("zzzz", { role: "user" })]),
      8,
    );
    const called = [...opening, toolCall("t1", "Terminal")];
    check("a tool call starts it again", streamedSinceTool(called), 0);
    check("so a tool's own progress adds nothing", streamedSinceTool([...called, done("t1")]), 0);
    const answered = [...called, done("t1"), text("12345678")];
    check("and what the agent says after it is counted from there", streamedSinceTool(answered), 8);
    const ended = [...answered, ev({ type: "turn_end", stopReason: "end_turn", usage: null })];
    check("a turn's end starts it again", streamedSinceTool(ended), 0);
    check(
      "so work nobody prompted is counted from the end of the turn before it",
      streamedSinceTool([...ended, text("abcd")]),
      4,
    );
    check(
      "and so is a cleared conversation",
      streamedSinceTool([...answered, ev({ type: "context_cleared", agentSessionId: "b", previousAgentSessionId: "a" }), text("ab")]),
      2,
    );
    check("an empty window counts nothing", streamedSinceTool([]), 0);

    // A window opened mid-run must not be remembered short once the history under it arrives.
    seq = 100;
    const late = [text("abcd"), text("efgh")];
    check("a window that starts mid-run counts what it holds", streamedSinceTool(late), 8);
    seq = 90;
    const history = [toolCall("t2", "Read"), text("wxyz")];
    check("and the full count once history pages in beneath it", streamedSinceTool([...history, ...late]), 12);

    // The cost claim, counted rather than timed: a new event reads the one before it and itself, and nothing else.
    seq = 0;
    const long = [toolCall("t3", "Terminal"), ...Array.from({ length: 5_000 }, () => text("abcd"))];
    check("five thousand chunks count once", streamedSinceTool(long), 20_000);
    let reads = 0;
    const watched = new Proxy([...long, text("efgh")], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    check("and the next token costs a step, not a walk", [streamedSinceTool(watched), reads <= 3], [20_004, true]);
  }

  {
    const { footSays } = await import("../src/ui/EventList.js");
    check("an idle conversation with nothing outstanding says nothing", footSays(false, 0), null);
    check("a running turn says so", footSays(true, 0), { line: "working…", spoken: "agent is working" });
    check("a turn that ended with work outstanding still speaks", footSays(false, 1), {
      line: "waiting for 1 task",
      spoken: "waiting for 1 task",
    });
    check("and it counts in the plural", footSays(false, 3)?.line, "waiting for 3 tasks");
    check("both facts share one line", footSays(true, 2), {
      line: "working… · waiting for 2 tasks",
      spoken: "agent is working, waiting for 2 tasks",
    });

    check("a turn long enough to say so says it beside the working line", footSays(true, 0, "3m"), {
      line: "working… · 3m",
      spoken: "agent is working, 3m",
    });
    check("and one that is not says nothing extra", footSays(true, 0, null), { line: "working…", spoken: "agent is working" });
    check("but never beside work that outlived the turn", footSays(false, 2, "3m"), {
      line: "waiting for 2 tasks",
      spoken: "waiting for 2 tasks",
    });
    check("and both facts plus the duration still share one line", footSays(true, 2, "3m"), {
      line: "working… · 3m · waiting for 2 tasks",
      spoken: "agent is working, 3m, waiting for 2 tasks",
    });
    check("with nothing streaming it says what was last true, and drops the number", footSays(true, 0, "3m", true), {
      line: "last seen working",
      spoken: "last seen working, not connected",
    });
    check("and carries the delegations under the same tense", footSays(true, 2, "3m", true), {
      line: "last seen working · waiting for 2 tasks",
      spoken: "last seen working, not connected, waiting for 2 tasks",
    });

    // Q3.644: Claude Code's `(1m 12s · ↓ 1.2k tokens)`, in this line's own separators.
    check("what streamed since the last tool call rides beside the time", footSays(true, 0, "3m", false, [], "↓ 1.2k tokens"), {
      line: "working… · 3m · ↓ 1.2k tokens",
      spoken: "agent is working, 3m",
    });
    check(
      "and alone while the time is under its floor",
      footSays(true, 0, null, false, [], "↓ 12 tokens")?.line,
      "working… · ↓ 12 tokens",
    );
    check(
      "and ahead of what is outstanding, which is a different fact",
      footSays(true, 2, null, false, [], "↓ 12 tokens")?.line,
      "working… · ↓ 12 tokens · waiting for 2 tasks",
    );

    const task = (id: string, taskType: string, state: string): unknown => ({
      id,
      name: id,
      taskType,
      description: "",
      state,
      summary: null,
      lastToolName: null,
      usage: null,
      canStop: true,
      showInTranscript: false,
      outputFilePath: null,
      toolCallId: null,
      startedAt: 0,
      endedAt: null,
    });
    const bg = (...tasks: unknown[]): never[] => tasks as never[];

    check(
      "one shell of its own is named as one",
      footSays(false, 0, null, false, bg(task("a", "shell", "running")))?.line,
      "waiting for 1 shell",
    );
    check(
      "and several of one kind take that kind's plural",
      footSays(false, 0, null, false, bg(task("a", "shell", "running"), task("b", "shell", "running")))?.line,
      "waiting for 2 shells",
    );
    check(
      "a monitor is a monitor and a workflow says which kind it is",
      [
        footSays(false, 0, null, false, bg(task("a", "monitor", "running")))?.line,
        footSays(false, 0, null, false, bg(task("a", "workflow", "running")))?.line,
      ],
      ["waiting for 1 monitor", "waiting for 1 background dynamic workflow"],
    );
    check(
      "two kinds fall to the canonical noun rather than listing",
      footSays(false, 0, null, false, bg(task("a", "shell", "running"), task("b", "monitor", "running")))?.line,
      "waiting for 2 background tasks",
    );
    check(
      "and so does a kind this client has no noun for",
      footSays(false, 0, null, false, bg(task("a", "cron", "running")))?.line,
      "waiting for 1 background task",
    );
    check(
      "delegations and background work together take the canonical noun",
      footSays(false, 1, null, false, bg(task("a", "shell", "running")))?.line,
      "waiting for 2 background tasks",
    );
    check(
      "a finished task is not counted, and on its own says nothing",
      [
        footSays(false, 0, null, false, bg(task("a", "shell", "completed"))),
        footSays(false, 0, null, false, bg(task("a", "shell", "completed"), task("b", "shell", "running")))?.line,
      ],
      [null, "waiting for 1 shell"],
    );
    check(
      "and a paused one is, because paused work is still there",
      footSays(false, 0, null, false, bg(task("a", "shell", "paused")))?.line,
      "waiting for 1 shell",
    );

    // A hand-written copy of the daemon's states: a sixth state added in src/acp/asynctasks.ts is not caught here.
    const { TASK_CHIPS, TASK_SECTIONS, TASK_NOUNS } = await import("../src/tasks.js");
    const states = ["running", "paused", "completed", "failed", "stopped"] as const;
    check(
      "every state a task can be in has a chip, and each is parenthesised",
      states.map((state) => TASK_CHIPS[state]?.[0] ?? null),
      ["(running)", "(paused)", "(done)", "(error)", "(stopped)"],
    );
    check(
      "and the two states that are not over share one tone while the three that are do not",
      [
        TASK_CHIPS.running?.[1] === TASK_CHIPS.paused?.[1],
        new Set([TASK_CHIPS.completed?.[1], TASK_CHIPS.failed?.[1], TASK_CHIPS.stopped?.[1]]).size,
      ],
      [true, 3],
    );
    const palette = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    check(
      "and every tone names a token the palette declares",
      Object.values(TASK_CHIPS)
        .map(([, tone]) => tone.replace(/^text-/, ""))
        .filter((name) => !new RegExp(`^\\s*--color-${name}:`, "m").test(palette)),
      [],
    );

    check(
      "the sections are the ones Claude Code names, with workflows lifted to the front",
      TASK_SECTIONS.map(([label]) => label),
      ["Dynamic workflows", "Shells", "Monitors"],
    );
    const placed = (taskType: string): string[] =>
      TASK_SECTIONS.filter(([, holds]) => holds(task("a", taskType, "running") as never)).map(([label]) => label);
    check(
      "every kind lands in exactly one section, an unknown one included",
      [placed("shell"), placed("monitor"), placed("workflow"), placed("cron")],
      [["Shells"], ["Monitors"], ["Dynamic workflows"], ["Shells"]],
    );
    check(
      "and the kinds with a noun of their own are the kinds with a section of their own",
      Object.keys(TASK_NOUNS).length,
      TASK_SECTIONS.length,
    );

    const {
      dotCells,
      taskDuration,
      taskElapsedMs,
      taskKindLabel,
      taskSections,
      taskTitle,
      taskTokens,
    } = await import("../src/tasks.js");

    check(
      "a duration is Claude Code's spaced form at every scale",
      [0, 8_000, 59_999, 87_000, 7_503_000, 102_600_000].map(taskDuration),
      ["0s", "8s", "59s", "1m 27s", "2h 5m 3s", "1d 4h 30m"],
    );
    check(
      "and a rounded second carries instead of printing sixty",
      [119_600, 3_599_600, 86_399_600].map(taskDuration),
      ["2m 0s", "1h 0m 0s", "1d 0h 0m"],
    );
    check("and a short duration is never zero-padded", taskDuration(8_000).startsWith("0"), false);

    check(
      "a token count is compact, lowercase, and drops a trailing .0",
      [0, 999, 8_000, 429_700, 1_200_000].map(taskTokens),
      ["0", "999", "8k", "429.7k", "1.2m"],
    );

    const running = { ...(task("a", "shell", "running") as object), startedAt: 1_000 } as never;
    const ended = {
      ...(task("a", "shell", "completed") as object),
      startedAt: 1_000,
      endedAt: 61_000,
    } as never;
    check(
      "a running task measures against now and a finished one stops where it stopped",
      [taskElapsedMs(running, 31_000), taskElapsedMs(ended, 900_000)],
      [30_000, 60_000],
    );
    check("and a clock that went backwards says nothing worse than zero", taskElapsedMs(running, 0), 0);

    check(
      "the meter is four cells, and an uncounted run still says it is going",
      [
        dotCells(0, 0, true).join(" "),
        dotCells(0, 0, false).join(" "),
        dotCells(5, 10, true).join(" "),
        dotCells(10, 10, false).join(" "),
        dotCells(10, 10, true).join(" "),
      ],
      [
        "live empty empty empty",
        "empty empty empty empty",
        "full full live empty",
        "full full full full",
        "full full full live",
      ],
    );

    const sectioned = taskSections([
      task("live", "shell", "running") as never,
      task("mon", "monitor", "running") as never,
      task("flow", "workflow", "running") as never,
      task("old", "shell", "completed") as never,
    ]);
    check(
      "the panel's sections are the three live kinds, workflows first",
      sectioned.map((section) => `${section.label}:${section.tasks.length}`),
      ["Dynamic workflows:1", "Shells:1", "Monitors:1"],
    );
    check(
      "and a finished task is in none of them, the band being drawn from the snapshot instead",
      sectioned.flatMap((section) => section.tasks.map((row) => row.id)).filter((id) => id === "old").length,
      0,
    );
    check("and a section with nothing in it is absent rather than empty", taskSections([]), []);

    const titled = (id: string, taskType: string, name: string, description: string): string =>
      taskTitle({ ...(task(id, taskType, "running") as object), name, description } as never);
    check(
      "a workflow is named by its script and everything else by what it ran",
      [
        titled("w", "workflow", "spec", "10 agents each wait"),
        titled("s", "shell", "sleep 900", "sleep 900"),
        titled("m", "monitor", "", "watching the build"),
        titled("x", "shell", "", ""),
      ],
      ["spec", "sleep 900", "watching the build", "x"],
    );
    check(
      "and a kind names itself as Claude Code's own default does",
      ["shell", "workflow", "monitor", "cron", ""].map(taskKindLabel),
      ["Shell", "Workflow", "Monitor", "Cron", "Task"],
    );

    const panelSrc = stripComments(
      readFileSync(new URL("../src/ui/TaskPanel.tsx", import.meta.url), "utf8"),
    );
    const taskCssEarly = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const viewSrc = stripComments(
      readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"),
    );
    const eventListSrc = stripComments(
      readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8"),
    );

    check("the panel was found at all", panelSrc.length > 0 && viewSrc.length > 0 && eventListSrc.length > 0, true);
    check("the panel leaves the layout", /createPortal\(/.test(panelSrc), true);
    check("and it is not the app's modal pop-up", /\bSheet\b/.test(panelSrc), false);
    check('and it is "menu" in the overlay stack rather than "sheet"', [
      /useDismissible\("menu"/.test(panelSrc),
      /useDismissible\("sheet"/.test(panelSrc),
    ], [true, false]);
    check("the panel docks inset rather than flush", [/md:right-3/.test(panelSrc), /(?:xl|md):right-0\b/.test(panelSrc)], [true, false]);
    check("and it is a card there: round, bordered, lifted", [
      /md:rounded-2xl/.test(panelSrc),
      /md:border\b/.test(panelSrc),
      /md:shadow-lg/.test(panelSrc),
      /md:rounded-none|md:shadow-none/.test(panelSrc),
    ], [true, true, true, false]);
    check("the sheet is the phone's arrangement and stops there", [/md:hidden/.test(panelSrc), /xl:hidden/.test(panelSrc)], [true, false]);
    check(
      "the panel leaves under its own keyframes rather than being unmounted",
      [
        /leaving \? "animate-sheet-out" : "animate-sheet"/.test(panelSrc),
        /leaving \? "md:animate-rise-out" : "md:animate-rise"/.test(panelSrc),
        /md:animate-none/.test(panelSrc),
        /onAnimationEnd=\{onAnimationEnd\}/.test(panelSrc),
      ],
      [true, true, false, true],
    );
    check(
      "and the layer it registers lasts exactly as long as the element does",
      [/useDismissible\("menu", onClose, shown\)/.test(panelSrc), /if \(!shown\) return null;/.test(panelSrc)],
      [true, true],
    );
    check(
      "the ground under it arrives and leaves on the same clock",
      [
        /leaving \? "animate-scrim-out pointer-events-none" : "animate-scrim"/.test(panelSrc),
        /onClick=\{leaving \? undefined : onClose\}/.test(panelSrc),
      ],
      [true, true],
    );
    const panelCss = taskCssEarly;
    // The sheet's exit runs on the one sheet clock; sheetMotion.ts's SHEET_MS is pinned to it in webcheck.sheets.ts.
    const sheetOutMs = /--animate-sheet-out:\s*sheet-out\s+var\(--sheet-ms\)[^;]*\bboth\b/.test(panelCss)
      ? Number(/--sheet-ms:\s*(\d+)ms;/.exec(panelCss)?.[1] ?? Number.NaN)
      : Number.NaN;
    const riseOutMs = Number(/--animate-rise-out:\s*rise-out\s+(\d+)ms[^;]*\bboth\b/.exec(panelCss)?.[1] ?? Number.NaN);
    const { SHEET_MS } = await import("../src/ui/sheetMotion.js");
    const backstopMs = /useLeaving\(open, SHEET_MS\)/.test(panelSrc) ? SHEET_MS : Number.NaN;
    report(
      "both departures were found, and both fill forwards",
      Number.isFinite(sheetOutMs) && Number.isFinite(riseOutMs) && Number.isFinite(backstopMs),
      `sheet ${String(sheetOutMs)}ms, card ${String(riseOutMs)}ms, backstop ${String(backstopMs)}ms`,
    );
    check("the backstop outlasts both of them", backstopMs, Math.max(sheetOutMs, riseOutMs));
    check("and the card's exit is the shorter, since it travels six pixels", riseOutMs < sheetOutMs, true);
    const SCALE = ["text-2xs", "text-xs", "text-sm", "text-base", "text-lg"];
    const panelWord = SCALE.findIndex((size) => new RegExp(`<h2 className="[^"]*\\b${size}\\b`).test(panelSrc));
    const titleWord = SCALE.findIndex((size) => new RegExp(`tap min-w-0 truncate[^"]*\\b${size}\\b`).test(viewSrc));
    report("both words were found on the scale", panelWord >= 0 && titleWord >= 0, `panel ${SCALE[panelWord] ?? "?"}, title ${SCALE[titleWord] ?? "?"}`);
    check("the panel's name is strictly quieter than the conversation's", panelWord >= 0 && titleWord >= 0 && panelWord < titleWord, true);
    const headClasses = /const PANEL_HEAD = "([^"]*)"/.exec(panelSrc)?.[1] ?? "";
    const headMin = Number(/\bmin-h-(\d+)\b/.exec(headClasses)?.[1] ?? Number.NaN);
    report("the panel's own head string was found", headClasses.length > 0, headClasses);
    check(
      "the head is spelled out at this panel's height rather than composed from the sheet's",
      [/<div className=\{PANEL_HEAD\}>/.test(panelSrc), /SHEET_HEAD/.test(panelSrc)],
      [true, false],
    );
    check("and it is shorter than a sheet's head but still reaches the tap floor", [headMin < 14, headMin >= 11], [true, true]);
    const headPad = (headClasses.match(/\bs?m?:?px-[\w.[\]/-]+/g) ?? []).filter((one) => one.includes("px-"));
    const scrollerPad = (/<div className="(min-h-0 flex-1 overflow-y-auto[^"]*)"/.exec(panelSrc)?.[1] ?? "")
      .split(/\s+/)
      .filter((one) => one.includes("px-"));
    report("both insets were read to compare", headPad.length > 0 && scrollerPad.length > 0, `head ${headPad.join(" ")}, body ${scrollerPad.join(" ")}`);
    check("the head and the list it heads share one inset, at every width", headPad, scrollerPad);

    check(
      "the finished band is drawn as its own folding section",
      [
        /function FinishedSection\(/.test(panelSrc),
        /aria-expanded=\{open\}/.test(panelSrc),
        /const finished = useMemo\(\(\) => background\.filter\(\(task\) => taskFinished\(task\.state\)\)/.test(panelSrc),
      ],
      [true, true, true],
    );
    check(
      "and it is drawn with nothing in it, but only where an empty list is an answer",
      [
        /const showFinished = reporting === "reports" \|\| finished\.length > 0;/.test(panelSrc),
        /\{showFinished && \(\s*<FinishedSection/.test(panelSrc),
      ],
      [true, true],
    );
    check(
      "an empty band is a heading with no fold and no clear",
      /if \(shown\.length === 0\) \{[\s\S]{0,200}?<PanelHeading count=\{0\}/.test(panelSrc),
      true,
    );
    check(
      "the headings are gated on how many bands are on screen, not on the partition's length",
      [/const bands = /.test(panelSrc), /const named = bands > 1;/.test(panelSrc), /sections\.length > 1/.test(panelSrc)],
      [true, true, false],
    );
    const finishedAt = panelSrc.indexOf("function FinishedSection(");
    const finishedEnd = finishedAt < 0 ? -1 : panelSrc.indexOf("\nfunction ", finishedAt + 1);
    const finishedBody = finishedAt >= 0 && finishedEnd > finishedAt ? panelSrc.slice(finishedAt, finishedEnd) : "";
    report("the finished section's own body was isolated", finishedBody.length > 0 && finishedBody.length < 3000, `${String(finishedBody.length)} chars`);
    check("it seeds itself closed, in the component the panel unmounts", /useState\(false\)/.test(finishedBody), true);
    check("and it claims no region it does not render", /aria-controls/.test(finishedBody), false);
    check("the clear names every finished row rather than the visible ones", /onClear\(tasks\.map\(\(task\) => task\.id\)\)/.test(finishedBody), true);
    const tasksSrc = stripComments(readFileSync(new URL("../src/tasks.ts", import.meta.url), "utf8"));
    check(
      "and the hidden set never reaches the partition, so the band stands at zero",
      [/hidden/.test(tasksSrc), /export const FINISHED_LABEL/.test(tasksSrc)],
      [false, true],
    );
    const finishedSrc = stripComments(readFileSync(new URL("../src/finishedTasks.ts", import.meta.url), "utf8"));
    const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    check(
      "the cleared set is held in memory and released with the session",
      [/localStorage/.test(finishedSrc), /forgetHiddenFinished\(key\)/.test(storeSrc)],
      [false, true],
    );
    // The daemon keeps the rows across an agent swap (Q2.234), so a clear must too: released with the session and nowhere else.
    const forgetSessionBody = /private forgetSession\(key: SessionKey\): void \{[\s\S]*?\n {2}\}/.exec(storeSrc)?.[0] ?? "";
    check(
      "and nothing but forgetting the session releases it, so an agent swap under it keeps hidden what it hid",
      [(storeSrc.match(/forgetHiddenFinished\(/g) ?? []).length, /forgetHiddenFinished\(key\)/.test(forgetSessionBody)],
      [1, true],
    );
    const { forgetHiddenFinished, hiddenFinished: hiddenFor, hideFinished } = await import("../src/finishedTasks.js");
    const aKey = "m1 s1" as never;
    check("nothing is hidden until somebody clears", hiddenFor(aKey).size, 0);
    hideFinished(aKey, ["t1", "t2"]);
    check("a clear hides exactly what it was handed", [...hiddenFor(aKey)].sort(), ["t1", "t2"]);
    hideFinished(aKey, ["t2", "t3"]);
    check("and a second clear replaces rather than accumulating", [...hiddenFor(aKey)].sort(), ["t2", "t3"]);
    check("an empty clear is not a clear", (() => { hideFinished(aKey, []); return [...hiddenFor(aKey)].sort(); })(), ["t2", "t3"]);
    check("another session is untouched", hiddenFor("m1 s2" as never).size, 0);
    forgetHiddenFinished(aKey);
    check("and a session that is gone takes its set with it", hiddenFor(aKey).size, 0);
    check(
      "the panel's width is a property somebody can drag, and the conversation's gutter is that same property",
      [
        /md:w-\[var\(--task-fit\)\]/.test(panelSrc),
        /md:pr-\[calc\(var\(--task-fit\)\+0\.75rem\)\]/.test(panelSrc),
        /\w+:w-\[[\d.]+rem\]/.test(panelSrc),
        /\w+:pr-\[[\d.]+rem\]/.test(panelSrc),
      ],
      [true, true, false, false],
    );
    const paneHandleSrc = stripComments(readFileSync(new URL("../src/ui/PaneHandle.tsx", import.meta.url), "utf8"));
    check(
      "and what it spends is clamped against the room there actually is",
      [
        /--task-fit:\s*min\(var\(--task-w\), calc\(var\(--task-room\) - [\d.]+rem\)\)/.test(taskCssEarly),
        /@media \(min-width: 64rem\) \{\s*:root \{\s*--task-room: calc\(100vw - var\(--rail-w\)\)/.test(taskCssEarly),
        /getPropertyValue\(pane\.prop\)/.test(paneHandleSrc),
      ],
      [true, true, true],
    );
    const insetSteps = Number(/md:right-(\d+)/.exec(panelSrc)?.[1] ?? Number.NaN);
    const gutterRem = Number(/md:pr-\[calc\(var\(--task-fit\)\+([\d.]+)rem\)\]/.exec(panelSrc)?.[1] ?? Number.NaN);
    report(
      "the inset was found on both sides",
      Number.isFinite(insetSteps) && Number.isFinite(gutterRem),
      `right-${String(insetSteps)} against +${String(gutterRem)}rem`,
    );
    check(
      "and the room the conversation leaves is the panel plus exactly the gap beside it",
      gutterRem,
      insetSteps * 0.25,
    );
    const taskCss = taskCssEarly;
    const { TASK_DEFAULT, TASK_MAX, TASK_MIN, TASK_WIDE, taskPane } = await import("../src/ui/taskWidth.js");
    const baseAt = taskCss.indexOf(`--task-w: ${String(TASK_DEFAULT)}px`);
    const wideAt = taskCss.search(/@media \(min-width: 80rem\) \{\s*:root \{\s*--task-w:/);
    check("both declared widths are the ones the module names", [baseAt >= 0, wideAt >= 0], [true, true]);
    check(
      "and the wide one is at the breakpoint, with the value the module names",
      new RegExp(`@media \\(min-width: 80rem\\) \\{\\s*:root \\{\\s*--task-w: ${String(TASK_WIDE)}px`).test(taskCss),
      true,
    );
    check("and it comes later, which is the only thing that makes it win", baseAt >= 0 && wideAt > baseAt, true);
    check("neither declared width is in a unit that depends on the reader's font size", /--task-w:\s*[\d.]+r?em/.test(taskCss), false);
    check("and a drag can reach either of them from both directions", [TASK_MIN < TASK_DEFAULT, TASK_WIDE < TASK_MAX], [true, true]);
    check("and the conversation makes room at the same breakpoint", /TASK_PANEL_GUTTER/.test(viewSrc), true);
    check(
      "and no breakpoint is read in JavaScript",
      /matchMedia|innerWidth|clientWidth/.test(panelSrc),
      false,
    );

    const widthClass = /TASK_PANEL_WIDTH = "([^"]+)"/.exec(panelSrc)?.[1] ?? "";
    const gutterClass = /TASK_PANEL_GUTTER = "([^"]+)"/.exec(panelSrc)?.[1] ?? "";
    const spentProp = new RegExp(String.raw`(--[a-z-]+):\s*min\(var\(${taskPane.prop}\)`).exec(taskCssEarly)?.[1] ?? "";
    report(
      "both class strings and the clamped property were found",
      widthClass.length > 0 && gutterClass.length > 0 && spentProp.length > 0,
      `${widthClass} / ${gutterClass} / ${spentProp} from ${taskPane.prop}`,
    );
    check(
      "the separator writes the stored property and the stylesheet clamps a second one from it",
      [taskPane.prop, spentProp.length > 0, spentProp === taskPane.prop],
      ["--task-w", true, false],
    );
    check(
      "and the clamped one is what the panel and the gutter spend, never the one a drag writes",
      [
        widthClass.includes(`var(${spentProp})`),
        gutterClass.includes(`var(${spentProp})`),
        widthClass.includes(`var(${taskPane.prop})`),
        gutterClass.includes(`var(${taskPane.prop})`),
      ],
      [true, true, false, false],
    );
    check(
      "the separator holds the DOM's answer rather than resolving it once per streamed token",
      [(paneHandleSrc.match(/getComputedStyle\(/g) ?? []).length, /cached\.current \?\?= resolve\(\)/.test(paneHandleSrc)],
      [1, true],
    );
    check(
      "and each of the three things that can change that answer drops it",
      [
        (paneHandleSrc.match(/cached\.current = null/g) ?? []).length,
        /\}, \[announced\]\);/.test(paneHandleSrc),
        /window\.addEventListener\("resize", forget\)/.test(paneHandleSrc),
        /setPointerCapture\(event\.pointerId\);\s*cached\.current = null;/.test(paneHandleSrc),
      ],
      [3, true, true, true],
    );
    const pointerAttrs = [...paneHandleSrc.matchAll(/\bon(?:Pointer\w+|LostPointerCapture)=/g)].map((m) => m[0].slice(0, -1)).sort();
    check(
      "the separator answers exactly these five pointer events",
      pointerAttrs,
      ["onLostPointerCapture", "onPointerCancel", "onPointerDown", "onPointerMove", "onPointerUp"],
    );
    const terminal = pointerAttrs.filter((name) => name !== "onPointerDown" && name !== "onPointerMove");
    check(
      "and every one of them that ends a drag asks first whether the pointer is the one that started it",
      [
        terminal.length,
        (paneHandleSrc.match(/if \(owns\(event\)\)/g) ?? []).length,
        /const owns = \(event: React\.PointerEvent<HTMLDivElement>\): boolean => from\.current\?\.id === event\.pointerId/.test(paneHandleSrc),
        /from\.current = \{ id: event\.pointerId,/.test(paneHandleSrc),
        /origin === null \|\| origin\.id !== event\.pointerId/.test(paneHandleSrc),
      ],
      [3, 3, true, true, true],
    );
    check(
      "and a lost capture ends the gesture without committing it",
      /const onLostPointerCapture = \(event: React\.PointerEvent<HTMLDivElement>\): void => \{\s*if \(owns\(event\)\) finish\(false\);/.test(paneHandleSrc),
      true,
    );
    // AppShell.tsx is read raw: its wrapper's comments may not name the gesture; PaneHandle.tsx read raw is the positive control.
    const shellRaw = readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8");
    const handleRaw = readFileSync(new URL("../src/ui/PaneHandle.tsx", import.meta.url), "utf8");
    const GESTURE_WORDS = ["setPointerCapture", "releasePointerCapture", "pointerdown", "pointerup", "pointercancel", "aria-valuenow"];
    report("the shell was read whole, comments and all", shellRaw.includes("function RailHandle"), `${String(shellRaw.length)} bytes`);
    check(
      "the sweep's own predicate finds every one of these words in the file that does implement the gesture",
      GESTURE_WORDS.filter((word) => handleRaw.includes(word)),
      ["setPointerCapture", "releasePointerCapture", "pointerdown", "pointerup", "pointercancel", "aria-valuenow"],
    );
    check(
      "and the shell's wrapper names no part of a gesture it does not implement",
      GESTURE_WORDS.filter((word) => shellRaw.includes(word)),
      [],
    );
    // PaneHandle.tsx's own comments are asserted raw: the uncorrected clause must point forward to its correction.
    const leakAt = handleRaw.indexOf("nothing to leak when this unmounts");
    const fixAt = handleRaw.indexOf("Unmounting mid-drag is not a `pointercancel`");
    check(
      "the uncorrected clause carries a mark forward to the correction it is wrong about",
      [
        leakAt >= 0,
        fixAt > leakAt,
        /read the unmount effect below/.test(handleRaw.slice(leakAt, fixAt)),
        paneHandleSrc.includes("nothing to leak when this unmounts"),
        paneHandleSrc.includes("Unmounting mid-drag is not a `pointercancel`"),
        paneHandleSrc.includes("read the unmount effect below"),
      ],
      [true, true, true, false, false, false],
    );
    const footAt = eventListSrc.indexOf("function WaitingFoot");
    const footBody = footAt < 0 ? "" : eventListSrc.slice(footAt, eventListSrc.indexOf("\n}\n", footAt));
    check(
      "the transcript's own run fold keeps the height those two gave up",
      /className="tap flex min-h-11 w-full items-center gap-1\.5 rounded-md px-1 py-1 text-left/.test(eventListSrc),
      true,
    );
    check("the foot's own component was found", footAt >= 0 && footBody.length > 0, true);
    check("the foot opens the panel", /aria-haspopup="dialog"/.test(footBody), true);
    const menuSrc = stripComments(readFileSync(new URL("../src/ui/SessionMenu.tsx", import.meta.url), "utf8"));
    check(
      "the panel has a second door in the session's own menu",
      [
        /label="Background tasks"/.test(menuSrc),
        /onOpenTasks !== undefined && \(/.test(menuSrc),
        /<SessionMenu\s+onOpenTasks=\{openTasks\}/.test(viewSrc),
      ],
      [true, true, true],
    );
    const kebabAt = viewSrc.indexOf("<SessionMenu");
    const before = kebabAt < 0 ? "" : viewSrc.slice(Math.max(0, kebabAt - 120), kebabAt);
    report("the header's kebab mount was found", kebabAt >= 0, before.replace(/\s+/g, " ").trim().slice(-60));
    check("and nothing hides it at the width where it is the only door", /lg:hidden/.test(before), false);
    check("and the row that opens it says what it opens", /haspopup="dialog"/.test(menuSrc), true);
    check("and no longer claims a region under it", /aria-expanded/.test(footBody), false);
    check("and draws no task rows of its own", /function TaskRow\(|function TaskHeading\(/.test(eventListSrc), false);
    const footer = "Each task&apos;s output reaches the transcript when it finishes";
    check("the standing sentence about output is on neither surface", [
      panelSrc.includes(footer),
      eventListSrc.includes(footer),
    ], [false, false]);
    check("and the foot makes no claim about work that is over", [
      /background task\$\{retained === 1/.test(eventListSrc),
      /foot\?\.line \?\? null/.test(eventListSrc),
    ], [false, true]);
    const { BACKGROUND_EMPTY, backgroundReporting } = await import("../src/tasks.js");
    const snap = (status: string, reports: boolean | undefined): never =>
      ({ status, reportsBackgroundTasks: reports }) as never;
    check("an agent that reports is the only one an empty list is an answer about", backgroundReporting(snap("idle", true)), "reports");
    check("one that does not is a different fact", backgroundReporting(snap("running", false)), "silent");
    check("a restarted daemon has no agent to have asked", backgroundReporting(snap("interrupted", false)), "unasked");
    check("nor does a parked one, whatever the flag says", backgroundReporting(snap("parked", true)), "unasked");
    check("and an agent being torn down is not one that can be asked", backgroundReporting(snap("stopping", true)), "unasked");
    check("a row that has not arrived lands in the same arm as no agent", backgroundReporting(null), "unasked");
    check("and so does the agent a restart is bringing back", backgroundReporting(snap("starting", false)), "unasked");
    // So an agent swap passes through unasked, and it is the rows the daemon kept that hold the band and its fold (Q2.234).
    check(
      "which keeps the finished band only because it is drawn off the rows too",
      /const showFinished = reporting === "reports" \|\| finished\.length > 0;/.test(panelSrc),
      true,
    );
    const arms = ["reports", "silent", "unasked"] as const;
    check("every arm has a sentence, and no two share one", new Set(arms.map((arm) => BACKGROUND_EMPTY[arm])).size, arms.length);
    check("only the answerable arm says nothing is running", arms.filter((arm) => BACKGROUND_EMPTY[arm] === "No tasks currently running"), ["reports"]);
    check(
      "the silent arm says what it cannot know rather than that nothing is running",
      /doesn't report background work/.test(BACKGROUND_EMPTY.silent),
      true,
    );
    check("and the unasked arm makes no claim about any agent", /this agent|the agent/i.test(BACKGROUND_EMPTY.unasked), false);
    check("while saying where the record went, which is what somebody there is asking", /restart/.test(BACKGROUND_EMPTY.unasked), true);
    check("and the panel draws the table rather than a shape of its own", /BACKGROUND_EMPTY\[reporting\]/.test(panelSrc), true);
    check("and it never claims a reconnection it cannot know about", footSays(true, 0, null, true)?.spoken.includes("reconnect"), false);
    check("a stale session with work outstanding reads exactly as a live one", footSays(false, 2, null, true), {
      line: "waiting for 2 tasks",
      spoken: "waiting for 2 tasks",
    });
    check("and one with nothing outstanding still says nothing at all", footSays(false, 0, null, true), null);

    const footCells = [false, true].flatMap((working) =>
      [0, 2].flatMap((tasks) =>
        [null, "3m"].flatMap((elapsed) =>
          [null, "↓ 1.2k tokens"].flatMap((streamed) =>
            [false, true].map((stale) => ({
              working,
              tasks,
              stale,
              said: footSays(working, tasks, elapsed, stale, [], streamed),
            })),
          ),
        ),
      ),
    );
    check("the sweep is the whole space", footCells.length, 32);
    check(
      "and nothing anywhere in it claims the agent is working now while nothing is streaming",
      footCells.filter(
        (one) =>
          one.stale &&
          one.said !== null &&
          (one.said.line.includes("working…") || one.said.spoken.includes("agent is working")),
      ),
      [],
    );
    check(
      "nor carries a number beside a claim it cannot check",
      footCells.filter((one) => one.stale && one.said?.line.includes("3m") === true),
      [],
    );
    check(
      "and the token count goes with the time, for the same reason",
      footCells.filter((one) => one.stale && one.said?.line.includes("↓") === true),
      [],
    );
    // The spoken form feeds an aria-live region: a count in it would be announced on every token.
    check(
      "the count is drawn and never spoken, anywhere in the space",
      [
        footCells.some((one) => one.said?.line.includes("↓ 1.2k tokens") === true),
        footCells.filter((one) => one.said !== null && /token|↓/.test(one.said.spoken)),
      ],
      [true, []],
    );
    check(
      "and only beside a claim that the agent is working",
      footCells.filter((one) => !one.working && one.said?.line.includes("↓") === true),
      [],
    );

    const foot = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
    check(
      "the foot asks whether anything is streaming at all, by the property rather than by a list",
      /const stale = stream === null \|\| stream\.phase !== "live";/.test(foot),
      true,
    );
    // The reconnecting banner is gone: a stream reattaching is the connection pill's to say (Q3.659).
    check(
      "and no banner over the conversation says the socket is down",
      [/const reconnecting =/.test(foot), (foot.match(/stale=\{stale\}/g) ?? []).length, /reconnecting\{/.test(foot)],
      [false, 2, false],
    );
    const footSrc = stripComments(readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8"));
    const waitingFootAt = footSrc.indexOf("function WaitingFoot");
    const waitingFoot = waitingFootAt < 0 ? "" : footSrc.slice(waitingFootAt, footSrc.indexOf("\n}\n", waitingFootAt));
    check("the foot's own component was found", waitingFootAt >= 0, true);
    check(
      "the caller threads all six arguments, and both of its arms stop the mark",
      [
        /footSays\(working, tasks\.length, elapsedSays\(workElapsedMs\), stale, background, streamedSays\(streamed\)\)/.test(
          footSrc,
        ),
        (waitingFoot.match(/WorkingMark still=\{stale\}/g) ?? []).length,
      ],
      [true, 2],
    );
    // A count threaded into the rows would re-render the whole conversation on every token.
    const listAt = footSrc.indexOf("export function EventList(");
    const listBody = listAt < 0 ? "" : footSrc.slice(listAt, footSrc.indexOf("\n}\n", listAt));
    check(
      "the count is computed only while working, and nothing but the foot receives it",
      [
        /const streamed = working \? streamedSinceTool\(transcript\.events\) : 0;/.test(listBody),
        (listBody.match(/\bstreamed\b/g) ?? []).length,
      ],
      [true, 2],
    );

    check(
      "the elapsed time is floored in one place, and the floor is a judgement rather than a unit",
      [
        /const ELAPSED_FLOOR_MS = 120_000;/.test(footSrc),
        /return workElapsedMs < ELAPSED_FLOOR_MS \? null : shortDuration\(workElapsedMs\);/.test(footSrc),
        /if \(workElapsedMs === null\) return null;/.test(footSrc),
      ],
      [true, true, true],
    );
    check(
      "and they are measured against the row's two clocks rather than against ours",
      [
        /const workElapsedMs = row === null \|\| startedAt === null \? null : elapsedSince\(row, startedAt\);/.test(foot),
        /Date\.now\(\) - (turnStartedAt|startedAt|unpromptedSince)/.test(foot + footSrc),
      ],
      [true, false],
    );
    check(
      "and the clock starts at the turn, or at the work nobody prompted",
      /const startedAt = snapshot === null \? null : workStartedAt\(snapshot\);/.test(foot),
      true,
    );
  }

  {
    seq = 0;
    const events = [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")];
    const tail = buildTail(events, [], 2);
    check("a parent below the cut leaves its children where they were", drawn(tail.rows), ["e2", "e3"]);
    check("and says how many events are below it", tail.hidden, 1);
  }

  {
    seq = 0;
    const tail = buildTail(
      [toolCall("a", "outer"), toolCall("b", "inner", "a"), toolCall("c", "deepest", "b")],
      [],
    );
    const outer = tail.rows[0] as { children: { key: string; children: { key: string }[] }[] };
    check("a grandchild is flattened into its grandparent, never a third indent", outer.children.map((c) => c.key), ["e2", "e3"]);
    check("and the middle child keeps none of its own", outer.children[0]?.children.length, 0);
  }

  {
    seq = 0;
    const events = [toolCall("task", "Explore")];
    for (let i = 0; i < MAX_CHILDREN + 12; i += 1) events.push(toolCall(`c${i}`, `step ${i}`, "task"));
    const tail = buildTail(events, []);
    const task = tail.rows[0] as {
      children: { title: string }[];
      steps: number;
      omitted: number;
      latest: string | null;
    };
    check(
      "only the newest forty steps are kept",
      [task.children[0]?.title, task.children.at(-1)?.title],
      ["step 12", "step 51"],
    );
    check("the count still says how many there were", task.steps, MAX_CHILDREN + 12);
    check("and how many are not shown", task.omitted, 12);
    check("the header still names the step it is on", task.latest, "step 51");
  }

  {
    seq = 0;
    const tail = buildTail([toolCall("task", "Explore"), toolCall("c1", "grep", "task"), done("c1", "task")], []);
    const task = tail.rows[0] as { children: { key: string }[]; steps: number };
    check("a completed step folds into its own card, not a second row", task.children.map((c) => c.key), ["e2"]);
    check("and an update is not counted as another step", task.steps, 1);
  }

  {
    seq = 0;
    const spawn = (id: string, title: string): never =>
      ev({ type: "tool_call", toolCallId: id, title, kind: "think", status: "pending", locations: [], rawInput: null, parentToolCallId: null, subagent: true });
    const tail = buildTail([spawn("task", "Play rock paper scissors"), done("task")], []);
    const task = tail.rows[0] as { subagent: boolean; steps: number };
    check("a declared spawn is one even with no step to show for it", task.subagent, true);
    check("and it still counts no steps it did not have", task.steps, 0);
    check(
      "a call nobody declared is not one",
      (buildTail([toolCall("a", "grep")], []).rows[0] as { subagent: boolean }).subagent,
      false,
    );
  }

  {
    seq = 0;
    const flat = buildTail([toolCall("a", "grep"), toolCall("b", "read"), toolCall("c", "bash")], []);
    check("with no parent link anywhere, the tail is exactly what it was", drawn(flat.rows), ["e1", "e2", "e3"]);
    check(
      "and nothing claims a child",
      flat.rows.flatMap((r) => (r.kind === "group" ? r.children : [r])).every((r) => (r as { children?: unknown[] }).children?.length === 0),
      true,
    );
  }

  {
    const bare = (id: string, parent: string | null, at: number): never =>
      ({
        kind: "tool", key: `e${at}`, seq: at, toolCallId: id, parentId: parent,
        title: id, toolKind: "other", status: "pending", rawInput: null, locations: [],
        output: null, images: [], changes: [], children: [], steps: 0, omitted: 0, latest: null, elapsedMs: null,
      }) as never;

    check(
      "in document order a child nests",
      placeNodes([bare("p", null, 1), bare("k", "p", 2)]).map((n) => n.key),
      ["e1"],
    );
    check(
      "and out of it the child stays where it is, rather than being sorted into place",
      placeNodes([bare("k", "p", 2), bare("p", null, 1)]).map((n) => n.key),
      ["e2", "e1"],
    );
  }

  // These can only fail by hanging: a cycle regression stops `pnpm webcheck` rather than printing FAIL.
  {
    seq = 0;
    const cycle = buildTail([toolCall("a", "alpha", "b"), toolCall("b", "beta", "a")], []);
    check("two calls that parent each other still terminate", cycle.rows.length, 1);

    seq = 0;
    const reused = buildTail(
      [
        toolCall("r", "root"),
        toolCall("a", "a", "r"),
        toolCall("b", "b", "a"),
        toolCall("a", "a again", "b"),
        toolCall("c", "c", "a"),
      ],
      [],
    );
    check("and so does a repeated toolCallId", reused.rows.length > 0, true);

    seq = 0;
    check(
      "a call naming itself as its parent is top level, not a child of itself",
      buildTail([toolCall("solo", "solo", "solo")], []).rows.map((r) => r.key),
      ["e1"],
    );
  }

  {
    seq = 0;
    const folded = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), failed("c1", "task")],
      [],
    );
    const parent = folded.rows[0] as { children: { key: string }[] };
    check(
      "a failed step draws inside its own card, never as a second row",
      [folded.rows.map((r) => r.key), parent.children.map((c) => c.key)],
      [["e1"], ["e2"]],
    );

    seq = 0;
    const orphan = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), failed("c1", "task")],
      [],
      3,
    );
    check(
      "a failure whose own call fell below the cut survives on its own",
      orphan.rows.map((r) => [r.key, (r as { title?: string | null }).title]),
      [["uc1:3", "boom"]],
    );
  }

  {
    seq = 0;
    const finished = buildTail(
      [toolCall("t", "grep"), done("t"), ev({ type: "text", role: "agent", thought: false, text: "x" })],
      [],
    );
    check(
      "a finished call reports call-to-completion",
      (finished.rows[0] as { elapsedMs: number | null }).elapsedMs,
      1000,
    );

    seq = 0;
    const trailing = buildTail(
      [
        toolCall("t", "grep"),
        done("t"),
        ev({ type: "tool_call_update", toolCallId: "t", title: null, status: null, locations: [], rawInput: null, content: null, parentToolCallId: null }),
      ],
      [],
    );
    check(
      "and a later update that says nothing does not inflate it",
      (trailing.rows[0] as { elapsedMs: number | null }).elapsedMs,
      1000,
    );

    seq = 0;
    check(
      "a call still running reports nothing rather than a ticking number",
      (buildTail([toolCall("t", "grep")], []).rows[0] as { elapsedMs: number | null }).elapsedMs,
      null,
    );
  }

  {
    seq = 0;
    const reused = buildTail(
      [
        toolCall("dup", "first"),
        toolCall("dup", "second"),
        ev({ type: "tool_call_update", toolCallId: "dup", title: "what the update said", status: "completed", locations: [], rawInput: null, content: ["one"], parentToolCallId: null }),
      ],
      [],
    );
    check(
      "an update is claimed once, by the call it followed",
      reused.rows
        .flatMap((r) => (r.kind === "group" ? r.children : [r]))
        .map((r) => (r as { title?: string }).title),
      ["first", "what the update said"],
    );
  }

  {
    const txt = (text: string): never =>
      ev({ type: "text", role: "agent", thought: false, text });

    // Tool call first, so the appended chunk does not renumber it; the other order asserts nothing about the comparator.
    seq = 0;
    const before = buildTail([toolCall("t", "grep"), txt("hel")], []);
    seq = 0;
    const same = buildTail([toolCall("t", "grep"), txt("hel")], []);
    check(
      "two builds over the same events compare equal, node for node",
      before.rows.every((node, i) => sameNode(node, same.rows[i]!)),
      true,
    );
    check("even though none of them is the same object", before.rows[0] === same.rows[0], false);

    seq = 0;
    const grown = buildTail([toolCall("t", "grep"), txt("hel"), txt("lo")], []);
    check("a run that gained a chunk is not equal", sameNode(before.rows[1]!, grown.rows[1]!), false);
    check("while the untouched row beside it is", sameNode(before.rows[0]!, grown.rows[0]!), true);

    seq = 0;
    const completed = buildTail(
      [
        toolCall("t", "grep"),
        txt("hel"),
        ev({ type: "tool_call_update", toolCallId: "t", title: null, status: "completed", locations: [], rawInput: null, content: ["out"], parentToolCallId: null }),
      ],
      [],
    );
    check("a card whose status or output moved is not equal", sameNode(before.rows[0]!, completed.rows[0]!), false);

    seq = 0;
    const oneStep = buildTail([toolCall("task", "Explore"), toolCall("c1", "grep", "task")], []);
    seq = 0;
    const twoSteps = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")],
      [],
    );
    check("a subagent that gained a step is not equal", sameNode(oneStep.rows[0]!, twoSteps.rows[0]!), false);

    seq = 0;
    const askEvents = () => [
      toolCall("tq", "Asking for your input"),
      { seq: (seq += 1), ts: seq, event: { type: "tool_call_update", toolCallId: "tq", title: null, status: null, locations: [], rawInput: { questions: [{ question: "Which one?", options: [{ label: "This one" }, { label: "The other" }] }] }, content: null, images: null, parentToolCallId: null } },
      { seq: (seq += 1), ts: seq, event: { type: "elicitation_request", elicitationId: "eq", toolCallId: "tq", message: "Please answer the following questions." } },
      { seq: (seq += 1), ts: seq, event: { type: "elicitation_resolved", elicitationId: "eq", toolCallId: "tq", message: "Please answer the following questions.", action: "accept", by: "client", answers: [{ key: "question_0", label: "Pick", value: "This one" }] } },
    ];
    // The same array twice: `sameNode` compares `stored` by identity, so fresh fixtures would differ for that reason alone.
    seq = 0;
    const askFixture = askEvents();
    const askedOnce = buildTail(askFixture as never, []);
    const askedTwice = buildTail(askFixture as never, []);
    const askedRow = (t: { rows: unknown[] }): never =>
      t.rows.find((r) => (r as { kind: string; stored?: { event: { type: string } } }).kind === "event" && (r as { stored: { event: { type: string } } }).stored.event.type === "elicitation_resolved") as never;
    check(
      "the question behind a settled answer is recovered at all",
      (askedRow(askedOnce) as unknown as { asked: { question: string }[] | null }).asked?.map((a) => a.question),
      ["Which one?"],
    );
    check("and two builds of it compare equal", sameNode(askedRow(askedOnce), askedRow(askedTwice)), true);
    check("though the arrays are not the same object", (askedRow(askedOnce) as unknown as { asked: unknown }).asked === (askedRow(askedTwice) as unknown as { asked: unknown }).asked, false);
  }
}

process.stdout.write("\na run of tool calls, folded into one row\n");
{
  let seq = 0;
  const ev = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const toolCall = (
    id: string,
    title: string,
    kind = "other",
    status = "completed",
    rawInput: unknown = null,
  ): never =>
    ev({ type: "tool_call", toolCallId: id, title, kind, status, locations: [], rawInput, parentToolCallId: null });
  const say = (text: string): never => ev({ type: "text", role: "agent", thought: false, text });
  const changed = (
    path: string,
    oldText: string | null,
    newText: string,
    toolCallId: string | null = null,
    source = "diff",
  ): never => ev({ type: "file_change", path, oldText, newText, source, toolCallId });
  const keys = (rows: BuiltRows): string[] => rows.map((r) => r.key);
  type Group = Extract<BuiltRows[number], { kind: "group" }>;
  const group = (rows: BuiltRows, at = 0): Group => rows[at] as Group;

  {
    seq = 0;
    const tail = buildTail([say("before"), toolCall("a", "grep"), toolCall("b", "ls"), say("after")], []);
    check("a run of two is one row between the two messages", keys(tail.rows), ["t1", "r2", "t4"]);
    check("holding both calls, with their own keys", drawn(tail.rows), ["t1", "e2", "e3", "t4"]);
  }

  {
    seq = 0;
    const tail = buildTail([say("before "), toolCall("a", "grep"), say("after")], []);
    check("a single call is left as it was", keys(tail.rows), ["t1", "e2", "t3"]);
  }

  {
    // Approvals fold in and refusals never do; the verdict comes from permissionDecisions, since every reject_* option also yields outcome "selected".
    const request = (id: string, call: string, kinds: Record<string, string>): never =>
      ev({
        type: "permission_request",
        permissionId: id,
        toolCallId: call,
        title: "Bash",
        options: Object.entries(kinds).map(([optionId, kind]) => ({ optionId, name: optionId, kind })),
        decision: null,
      });
    const answer = (id: string, call: string, optionId: string): never =>
      ev({ type: "permission_resolved", permissionId: id, toolCallId: call, title: "Bash", outcome: "selected", optionId, by: "client" });

    seq = 0;
    const allowed = buildTail(
      [
        toolCall("a", "grep"),
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "allow_once"),
        toolCall("b", "bash"),
      ],
      [],
      0,
      permissionDecisions([
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "allow_once"),
      ] as never),
    );
    check("an approval folds into the run it authorised", keys(allowed.rows), ["r1"]);
    check("counted on the collapsed row rather than hidden", group(allowed.rows).approved, 1);
    check("and its children keep their order", drawn(allowed.rows), ["e1", "e3", "e4"]);

    seq = 0;
    const denied = buildTail(
      [
        toolCall("a", "grep"),
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "reject_once"),
        toolCall("b", "bash"),
        toolCall("c", "bash"),
      ],
      [],
      0,
      permissionDecisions([
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "reject_once"),
      ] as never),
    );
    check("a refusal is never folded away", keys(denied.rows), ["e1", "e3", "r4"]);

    seq = 0;
    const unmatched = buildTail(
      [toolCall("a", "grep"), answer("p1", "b", "some_option_the_request_never_offered"), toolCall("b", "bash")],
      [],
      0,
      new Map(),
    );
    check("an answer nothing can classify keeps its row", keys(unmatched.rows), ["e1", "e2", "e3"]);
    seq = 0;
    const noMap = buildTail(
      [
        toolCall("a", "grep"),
        request("p1", "b", { allow_once: "allow_once" }),
        answer("p1", "b", "allow_once"),
        toolCall("b", "bash"),
      ],
      [],
    );
    check("and with no verdicts passed at all, nothing folds", keys(noMap.rows), ["e1", "e3", "e4"]);

    seq = 0;
    const onlyAnswers = buildTail(
      [
        request("p1", "x", { allow_once: "allow_once" }),
        answer("p1", "x", "allow_once"),
        request("p2", "y", { allow_once: "allow_once" }),
        answer("p2", "y", "allow_once"),
      ],
      [],
      0,
      permissionDecisions([
        request("p1", "x", { allow_once: "allow_once" }),
        answer("p1", "x", "allow_once"),
        request("p2", "y", { allow_once: "allow_once" }),
        answer("p2", "y", "allow_once"),
      ] as never),
    );
    check("approvals with no work to fold into stay rows", keys(onlyAnswers.rows), ["e2", "e4"]);
  }

  {
    seq = 0;
    const plan = buildTail([toolCall("a", "grep"), ev({ type: "plan", entries: [] }), toolCall("b", "ls")], []);
    check("a plan breaks a run", keys(plan.rows), ["e1", "e2", "e3"]);

    seq = 0;
    const foldedPlans = buildTail(
      [toolCall("a", "grep"), ev({ type: "plan", entries: [] }), ev({ type: "plan", entries: [] }), toolCall("b", "ls")],
      [],
    );
    check("and the survivor of a collapsed pair still breaks it", keys(foldedPlans.rows), ["e1", "e3", "e4"]);
  }

  {
    const entries = (n: number) => [{ content: `step ${n}`, priority: "medium", status: "pending" }];
    const plan = (n: number): never => ev({ type: "plan", entries: entries(n) });
    const thought = (text: string): never => ev({ type: "text", role: "agent", thought: true, text });
    const silent = (): never => ev({ type: "other", sessionUpdate: "session_info_update", raw: null });
    const entriesOf = (rows: BuiltRows, at = 0): unknown =>
      (rows[at] as { stored?: { event?: { entries?: unknown } } }).stored?.event?.entries;

    seq = 0;
    const pair = buildTail([plan(1), plan(2)], []);
    check("two plan updates in a row are one card", keys(pair.rows), ["e2"]);
    check("and it is the newest one", entriesOf(pair.rows), entries(2));

    seq = 0;
    const nine = buildTail([plan(1), plan(2), plan(3), plan(4), plan(5), plan(6), plan(7), plan(8), plan(9)], []);
    check("the measured nine-for-three shape is one card", keys(nine.rows), ["e9"]);

    seq = 0;
    check("a transcript that opens with a plan still draws it", keys(buildTail([plan(1)], []).rows), ["e1"]);

    seq = 0;
    check(
      "work between two plans keeps both",
      keys(buildTail([plan(1), toolCall("a", "grep"), plan(2)], []).rows),
      ["e1", "e2", "e3"],
    );
    seq = 0;
    check("and so does a message", keys(buildTail([plan(1), say("done"), plan(2)], []).rows), ["e1", "t2", "e3"]);

    seq = 0;
    check("a thought does not save a stale checklist", keys(buildTail([plan(1), thought("hm"), plan(2)], []).rows), ["e3"]);
    seq = 0;
    check("nor does an event nobody draws", keys(buildTail([plan(1), silent(), silent(), plan(2)], []).rows), ["e4"]);

    seq = 0;
    const across = [plan(1), ev({ type: "context_cleared", reason: "clear" }), plan(2)] as never[];
    check("a plan below the cut is not drawn at all", keys(buildTail(across, [], 3).rows), ["e3"]);
    seq = 0;
    const gap = buildTail([toolCall("a", "grep"), toolCall("b", "ls"), toolCall("c", "bash")], [
      { from: 3, to: 4, reason: "evicted" } as never,
    ]);
    check("and so does a hole in the conversation", keys(gap.rows), ["r1", "g3", "e3"]);
  }

  {
    seq = 0;
    const tail = buildTail(
      [
        toolCall("task", "Explore"),
        ev({ type: "tool_call", toolCallId: "c1", title: "grep", kind: "other", status: "completed", locations: [], rawInput: null, parentToolCallId: "task" }),
        toolCall("b", "ls"),
      ],
      [],
    );
    check("a subagent stands on its own", keys(tail.rows), ["e1", "e3"]);
  }

  {
    seq = 0;
    const live = buildTail([toolCall("a", "grep", "other", "completed"), toolCall("b", "ls", "other", "in_progress")], []);
    check("a run with something still running is live", [group(live.rows).live, group(live.rows).failed], [true, 0]);
    seq = 0;
    const broke = buildTail([toolCall("a", "grep"), toolCall("b", "ls", "other", "failed")], []);
    check("and one that failed says how many", [group(broke.rows).live, group(broke.rows).failed], [false, 1]);
    seq = 0;
    const settled = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    check("a finished run is neither", [group(settled.rows).live, group(settled.rows).failed], [false, 0]);

    const footSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const derived = /const open = override \?\? ([^;]+);/.exec(footSrc)?.[1] ?? "(not found)";
    check("a folded run starts collapsed, whatever it is doing", derived, "false");

    check("and liveness still inks the row it no longer opens", /node\.live/.test(footSrc), true);
  }

  {
    seq = 0;
    const two = buildTail([toolCall("a", "Bash", "execute"), toolCall("b", "Bash", "execute")], []);
    check("two commands", runSummary(group(two.rows).tally), "Ran 2 commands");

    seq = 0;
    const mixed = buildTail(
      [
        toolCall("a", "Bash", "execute"),
        toolCall("b", "Bash", "execute"),
        toolCall("w", "Write", "edit"),
        changed("/w/README.md", "old\nlines\nhere", "new\nlines\nhere\nand\nmore", "w"),
      ],
      [],
    );
    check(
      "a mixed run names the file and counts the commands",
      runSummary(group(mixed.rows).tally),
      "Ran 2 commands, edited README.md",
    );
    check("with the run's own changes on the tally", group(mixed.rows).tally.changes.length, 1);

    seq = 0;
    const created = buildTail(
      [toolCall("w", "Write", "edit"), changed("/w/bot.py", null, "a\nb\nc", "w"), toolCall("r", "Bash", "execute")],
      [],
    );
    check(
      "a file with no old side was created, not edited",
      runSummary(group(created.rows).tally),
      "Created bot.py, ran a command",
    );

    seq = 0;
    const many = buildTail(
      [
        toolCall("w", "Write", "edit"),
        changed("/w/a.ts", null, "a", "w"),
        changed("/w/b.ts", null, "b", "w"),
        toolCall("v", "Write", "edit"),
        changed("/w/c.ts", null, "c", "v"),
      ],
      [],
    );
    // Counted per file, not per call, or a `MultiEdit` reads as one change.
    check("three files created by two calls is three", runSummary(group(many.rows).tally), "Created 3 files");

    seq = 0;
    const reads = buildTail(
      [
        toolCall("a", "Read", "read", "completed", { file_path: "/w/one.ts" }),
        toolCall("b", "Read", "read", "completed", { file_path: "/w/two.ts" }),
        toolCall("c", "Read", "read", "completed", { file_path: "/w/three.ts" }),
      ],
      [],
    );
    check("three files read", runSummary(group(reads.rows).tally), "Read 3 files");
    seq = 0;
    const oneRead = buildTail(
      [
        toolCall("a", "Read", "read", "completed", { file_path: "/w/one.ts" }),
        toolCall("b", "Bash", "execute"),
      ],
      [],
    );
    check("but one file gets named", runSummary(group(oneRead.rows).tally), "Read one.ts, ran a command");

    seq = 0;
    const unknown = buildTail(
      [
        toolCall("a", "Bash", "execute"),
        toolCall("b", "Bash", "execute"),
        toolCall("t", "ToolSearch", "other", "completed", { query: "select:AskUserQuestion" }),
      ],
      [],
    );
    check("an unknown kind is named by its tool, never by its arguments", runSummary(group(unknown.rows).tally), "Ran 2 commands, used ToolSearch");
    seq = 0;
    const nameless = buildTail(
      [toolCall("a", "Bash", "execute"), toolCall("b", "x".repeat(60), "other")],
      [],
    );
    check("and one it cannot name can still count to one", runSummary(group(nameless.rows).tally), "Ran a command, used a tool");

    const long = "x".repeat(60);
    seq = 0;
    const oneLongSearch = buildTail(
      [toolCall("s", "Search", "search", "completed", { query: long }), toolCall("b", "Bash", "execute")],
      [],
    );
    check("one search it cannot name", runSummary(group(oneLongSearch.rows).tally), "Searched, ran a command");
    seq = 0;
    const oneLongFile = buildTail(
      [
        toolCall("w", "Write", "edit"),
        changed(`/w/${long}.ts`, null, "a", "w"),
        toolCall("b", "Bash", "execute"),
      ],
      [],
    );
    check("one created file it cannot name", runSummary(group(oneLongFile.rows).tally), "Created a file, ran a command");
    seq = 0;
    const oneLongRead = buildTail(
      [
        toolCall("r", "Read", "read", "completed", { file_path: `/w/${long}.ts` }),
        toolCall("b", "Bash", "execute"),
      ],
      [],
    );
    check("one read file it cannot name", runSummary(group(oneLongRead.rows).tally), "Read a file, ran a command");
  }

  {
    // kimi sends each edit twice (the diff, then fs_write with the whole file), so the match is on the path, never the content (Q6.12).
    seq = 0;
    const pair = buildTail(
      [
        toolCall("w", "Edit", "edit"),
        changed("/w/notes.txt", "two", "TWO CHANGED", "w", "diff"),
        changed("/w/notes.txt", "one\ntwo\nthree", "one\nTWO CHANGED\nthree", null, "fs_write"),
      ],
      [],
    );
    check("one edit reported twice is one row", keys(pair.rows), ["e1"]);
    check(
      "and the card is the one that holds it",
      (pair.rows[0] as Extract<BuiltRows[number], { kind: "tool" }>).changes.length,
      1,
    );

    seq = 0;
    const later = buildTail(
      [
        toolCall("w", "Edit", "edit"),
        changed("/w/notes.txt", "two", "TWO CHANGED", "w", "diff"),
        changed("/w/notes.txt", "a", "b", null, "fs_write"),
        changed("/w/notes.txt", "b", "c", null, "fs_write"),
      ],
      [],
    );
    check("a second write to the same file keeps its row", drawn(later.rows), ["e1", "c4"]);

    seq = 0;
    const twice = buildTail(
      [
        changed("/w/a.txt", "x", "y", null, "fs_write"),
        changed("/w/a.txt", "x", "y", null, "fs_write"),
      ],
      [],
    );
    check("and with no diff half at all, nothing is suppressed", drawn(twice.rows), ["c1", "c2"]);

    seq = 0;
    const orphan = buildTail([changed("/w/a.txt", null, "hello", "gone")], []);
    check("a change with no call on screen stands alone", keys(orphan.rows), ["c1"]);
  }

  {
    seq = 0;
    const first = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    seq = 0;
    const again = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    check("two builds of one run compare equal", sameNode(first.rows[0]!, again.rows[0]!), true);
    seq = 0;
    const grew = buildTail([toolCall("a", "grep"), toolCall("b", "ls"), toolCall("c", "bash")], []);
    check("a run that gained a call does not", sameNode(first.rows[0]!, grew.rows[0]!), false);
    seq = 0;
    const finished = buildTail([toolCall("a", "grep"), toolCall("b", "ls", "other", "in_progress")], []);
    check("nor does one whose last call is still running", sameNode(first.rows[0]!, finished.rows[0]!), false);

    seq = 0;
    const log = [changed("/w/a.txt", null, "hello", "gone")];
    check("two builds of one change compare equal", sameNode(buildTail(log, []).rows[0]!, buildTail(log, []).rows[0]!), true);
    seq = 0;
    const other = buildTail([changed("/w/a.txt", null, "goodbye", "gone")], []);
    check("and a different one does not", sameNode(buildTail(log, []).rows[0]!, other.rows[0]!), false);
  }

  {
    seq = 0;
    const unnamed = buildTail(
      [
        toolCall("exec-5538", "node fetch-codex-manual.mjs", "execute", "completed"),
        ev({ type: "permission_resolved", permissionId: "perm-1", toolCallId: "exec-5538", title: "exec-5538", outcome: "selected", optionId: "allow_once", by: "client" }),
      ],
      [],
    );
    check(
      "a permission titled with its own call id takes the call's name",
      (unnamed.rows.at(-1) as Extract<BuiltRows[number], { kind: "event" }>).heading,
      "node fetch-codex-manual.mjs",
    );

    seq = 0;
    const named = buildTail(
      [
        toolCall("t1", "Bash", "execute", "completed"),
        ev({ type: "permission_resolved", permissionId: "perm-2", toolCallId: "t1", title: "Bash", outcome: "selected", optionId: "allow_once", by: "client" }),
      ],
      [],
    );
    check(
      "and one the daemon named is left alone",
      (named.rows.at(-1) as Extract<BuiltRows[number], { kind: "event" }>).heading,
      null,
    );

    seq = 0;
    const bothUnnamed = buildTail(
      [
        toolCall("exec-9", "exec-9", "execute", "completed"),
        ev({ type: "permission_resolved", permissionId: "perm-3", toolCallId: "exec-9", title: "exec-9", outcome: "selected", optionId: "allow_once", by: "client" }),
      ],
      [],
    );
    check(
      "a call with no name of its own lends nothing",
      (bothUnnamed.rows.at(-1) as Extract<BuiltRows[number], { kind: "event" }>).heading,
      null,
    );
  }

  {
    check("nothing folds to nothing", foldRuns([]), []);
    check(
      "and a row that is not machinery is passed straight through",
      keys(foldRuns([{ kind: "gap", key: "g1", seq: 1, parentId: null, gap: { from: 1, to: 2, reason: "evicted" } } as never])),
      ["g1"],
    );
  }
}
