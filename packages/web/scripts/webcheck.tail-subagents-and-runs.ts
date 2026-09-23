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
  placeNodes,
  runSummary,
  sameNode,
  stillRunning,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * A subagent's work, under the tool call that started it
 * ------------------------------------------------------------------ */

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
    // Placed by a backwards walk, a subagent would read bottom-up and every step
    // would lie about what followed what.
    check("children keep document order under their parent", task.children.map((c) => c.key), ["e2", "e3"]);
    check("steps counts them", task.steps, 2);
    check("and the newest is what a running header shows", task.latest, "read");
  }

  {
    /*
     * ⭐ **What the conversation is waiting on, which the snapshot cannot say.**
     *
     * `showsWorking` reads `session.turn`, and `turn` is cleared the moment the turn
     * ends — while the delegations somebody is waiting on are events in the log and
     * outlive it. That gap is where a conversation reads as finished while the agent
     * is still going, which is the defect this line exists for.
     *
     * ⚠ `pending` has to count. Measured on a live log, a Task spawn arrives
     * `pending` and goes straight to `completed` 13–14 seconds later with no
     * `in_progress` update in between — so a predicate keyed on `in_progress` alone
     * answers 0 for the entire life of every delegation there is.
     */
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

    /*
     * ⚠ **A card that says `completed` about work that has not finished, and the
     * one flag that contradicts it.**
     *
     * A Bash call that detaches returns the instant the command is handed off, so
     * the update carrying `completed` is about the *handoff*. ACP has no tool-call
     * status for "still running elsewhere", which is why the agent marks the update
     * instead — and this is the fold that has to survive the completion arriving
     * **after** the mark, which is the order it really comes in.
     *
     * ⚠ **Sticky, and that is the opposite rule from `subagent` one field over.**
     * claude *drops* the subagent flag on a spawn's completing update, so that one
     * is read from the call and never merged; this one only ever *appears* on an
     * update, so it is merged and never reset. Both rules exist because the agent
     * is inconsistent in opposite directions about two flags in the same bag, and
     * a fold that treated them alike would be wrong about one of them.
     */
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
    /*
     * And the negative, because the whole value of the flag is that it is rare: an
     * ordinary call must not pick it up from anywhere. An older daemon sends the
     * field on nothing at all, which is this row.
     */
    seq = 0;
    const ordinary = buildTail([toolCall("bash", "Bash"), done("bash")], []);
    check(
      "an ordinary completed call is not marked",
      (ordinary.rows[0] as { backgrounded: boolean }).backgrounded,
      false,
    );

    /*
     * Counted, therefore not descended into. Nested delegation is measured to be
     * flat — every call comes back parented to the outermost spawn — so "a task
     * inside a task" is one thing you are waiting on, and `2 tasks` has to mean two.
     */
    seq = 0;
    const nested = buildTail(
      [toolCall("outer", "Outer"), toolCall("inner", "Inner", "outer"), toolCall("leaf", "leaf", "inner")],
      [],
    );
    check("a delegation inside a delegation is one thing to wait for", outstandingTasks(nested.rows).length, 1);

    // An ordinary tool call is not a task, however long it runs: this line says
    // "waiting for N tasks", and a `grep` is not one.
    seq = 0;
    const plain = buildTail([toolCall("a", "grep")], []);
    check("an ordinary call is not a task", outstandingTasks(plain.rows).length, 0);

    // The two predicates the fold and this count now share, which is what keeps them
    // structurally disjoint — a delegation never folds into a group.
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

    /*
     * A finished delegation is descended into, which is the one rule of the four
     * whose deletion the assertions above all survive: `outer` completing while
     * `inner` runs answers 1 either way, because the *outer* one is what the other
     * fixtures count. It needs a child that is itself a delegation.
     */
    seq = 0;
    /*
     * `subagent: true` rather than a child of its own, because `MAX_DEPTH` is 2:
     * a grandchild is re-pointed onto the outermost spawn, so an inner call cannot
     * earn `steps > 0` and the agent's own flag is the only way to say this one is
     * a delegation. Which is the case that matters anyway — claude drops the flag
     * on the spawn's completing update, so an inner spawn declaring itself is
     * exactly the shape here.
     */
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
    /*
     * ⭐ **A delegation a dead agent left `pending`, which is permanent and which
     * no fact about `status` can see.**
     *
     * `mayStillReport` excludes the terminal statuses on the ground that an
     * interrupted turn is never re-sent — true, and it closes only the arm that
     * resolves itself. Auto-resume takes the session back *out* of terminal: it
     * returns `idle`, holding the same conversation and the same rows, so every
     * clause of that predicate reads true again and the foot drew `waiting for 1
     * task` with a pulsing dot for the rest of the session's life, on every
     * session that was mid-delegation when `deploy.sh` ran, surviving reloads
     * because it is derived from a log that persists.
     *
     * `taskFloor` is the half that can see it, and it is a fact about the
     * transcript: below the newest `session_started` is a different agent process.
     */
    seq = 0;
    // Only `type` is read — `session_started` draws nothing (`TRANSCRIPT_SILENT`),
    // and the floor is the one thing anything asks it.
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
    // The half that would have hidden the defect: without the floor it is still 1,
    // which is what shipped and what a reader saw for ever.
    check("which is exactly what the ungated walk answers", outstandingTasks(restarted.rows).length, 1);

    // The same session going on to delegate again: the new spawn is above the
    // floor, so a restart does not silence the line for good either.
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

    /*
     * A cancelled turn is the other marker, and the split is on the stop reason
     * rather than on a list of bad ones: `end_turn` is the *only* reason that
     * means the turn finished rather than was abandoned, and a turn finishing
     * while its delegations carry on is the whole state this line draws.
     */
    const ended = (reason: string): never => ev({ type: "turn_end", stopReason: reason, usage: null });
    // A step, so the spawn is a delegation at all: `isDelegation` is the agent's
    // own flag *or* `steps > 0`, and a childless untagged call is neither.
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
    // Unknown reasons cut, deliberately: a wrong cut costs a line nobody sees and
    // a wrong keep costs the permanent false one above.
    seq = 0;
    const unknown = buildTail([...spawn(), ended("max_tokens")], []);
    check("and a reason this client has never heard of cuts", unknown.taskFloor > 0, true);
    /*
     * ⚠ **Drawn nowhere and counted here**, which is the pair worth pinning
     * together: `taskFloor` runs before the `showsInTranscript` gate, so the end
     * the daemon writes for a failed turn cuts the delegations that turn started
     * even though nothing about it reaches the screen. Without the floor a turn
     * that died mid-delegation left "waiting for 1 task" under the transcript for
     * the rest of the session.
     */
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
    /*
     * The snapshot half, which had no assertion at all. Both exclusions are states
     * in which a spawn can never complete, and the pair with `isTerminal` is the
     * one worth pinning: `stopping` is deliberately **not** terminal, so a
     * predicate written as `!isTerminal(...)` alone would draw the line over a
     * session somebody is stopping — which is `canCancelTurn`'s lesson one field
     * over.
     */
    const { mayStillReport } = await import("../src/wire.js");
    const snap = (status: string): never => ({ status, turn: null }) as never;
    check("a turn that ended can still be reported on", mayStillReport(snap("idle")), true);
    check("so can one still running", mayStillReport(snap("running")), true);
    // Deliberate: the ask card is an `absolute` region over the composer and does
    // not collide with the foot, and suppressing would blink the line out and back
    // on every approval.
    check("and a blocked one, deliberately", mayStillReport(snap("blocked")), true);
    check(
      "an ended session is not waiting for anything",
      ["exited", "failed", "interrupted"].map((status) => mayStillReport(snap(status))),
      [false, false, false],
    );
    check("nor is one being stopped", mayStillReport(snap("stopping")), false);
    check("which isTerminal does not say, which is why it is its own clause", isTerminal("stopping"), false);
  }

  {
    /*
     * The foot of the transcript, both renderings from one call.
     *
     * `noticeText`'s lesson applied before it can be re-learned: the visible line and
     * the `role="status"` region were once written separately and gated differently,
     * and the region fell silent in exactly the state the line existed for. A pair
     * from one function cannot disagree.
     */
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

    /*
     * ⚠ **The third and fourth arguments, which shipped with defaults and were
     * exercised by nothing.** The function's own docblock says the defaults keep
     * the five calls above meaning what they meant — which is true, and is also
     * exactly how two new rules came to be insulated from the only driver that
     * reads this function. A default keeps an old assertion honest; it is not a
     * reason to leave the four-argument form unasserted.
     */
    check("a turn long enough to say so says it beside the working line", footSays(true, 0, "3m"), {
      line: "working… · 3m",
      spoken: "agent is working, 3m",
    });
    check("and one that is not says nothing extra", footSays(true, 0, null), { line: "working…", spoken: "agent is working" });
    /*
     * ⚠ **It never reaches the delegation sentence**, which is the one place the
     * two quantities could be confused: `waiting for 2 tasks` is about work that
     * outlived the turn, and hanging the *turn's* duration on it would be a
     * different number wearing the same words.
     */
    check("but never beside work that outlived the turn", footSays(false, 2, "3m"), {
      line: "waiting for 2 tasks",
      spoken: "waiting for 2 tasks",
    });
    check("and both facts plus the duration still share one line", footSays(true, 2, "3m"), {
      line: "working… · 3m · waiting for 2 tasks",
      spoken: "agent is working, 3m, waiting for 2 tasks",
    });
    /*
     * ⚠ **Nothing streaming: the tense changes AND the number goes.** `working` is
     * `showsWorking` over the last snapshot that arrived, so with no live socket it
     * is a claim about *now* made from something that may be minutes old — three
     * bars blinking beside `working…` for as long as the tab stays open. The
     * elapsed time is the half a reader can watch going wrong, since `turnStartedAt`
     * is frozen at whatever that snapshot said while our own clock carries on, so
     * dropping it is not tidiness.
     */
    check("with nothing streaming it says what was last true, and drops the number", footSays(true, 0, "3m", true), {
      line: "last seen working",
      spoken: "last seen working, not connected",
    });
    check("and carries the delegations under the same tense", footSays(true, 2, "3m", true), {
      line: "last seen working · waiting for 2 tasks",
      spoken: "last seen working, not connected, waiting for 2 tasks",
    });

    /*
     * The second source, and the three answers the sentence can give.
     *
     * ⚠ **Delegations alone keep today's words**, which is why every assertion
     * above this one still means what it meant: the foot had one source for its
     * whole life, and a change that reworded the common case would be a change
     * nobody asked for wearing a feature's clothes.
     *
     * Claude Code's own vocabulary is lifted for the second source, including the
     * canonical fallback — **`N background tasks` whenever the kinds are mixed, or
     * whenever delegations and background work are outstanding together.** The
     * alternative to a fallback is a foot line that lists, and a foot line that
     * lists is a panel drawn one row too high.
     */
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
    /*
     * ⚠ **A kind this client has never heard of is drawn, not hidden.** The
     * adapter humanises `taskType` before it sends, so a fourth word is a word it
     * added — and falling to the canonical noun keeps the count honest where a
     * lookup that answered nothing would drop the row out of the sentence.
     */
    check(
      "and so does a kind this client has no noun for",
      footSays(false, 0, null, false, bg(task("a", "cron", "running")))?.line,
      "waiting for 1 background task",
    );
    /*
     * **The two sources add**, which is safe because they are disjoint by
     * construction: a delegation is a transcript row and a background task comes
     * off the snapshot, and the adapter never announces a backgrounded *subagent*
     * as a task at all. If that ever stops being true the fix is upstream, not a
     * `Set` here — see `outstandingSays`.
     */
    check(
      "delegations and background work together take the canonical noun",
      footSays(false, 1, null, false, bg(task("a", "shell", "running")))?.line,
      "waiting for 2 background tasks",
    );
    /*
     * ⚠ **Finished work is not work anybody is waiting for**, and the panel keeps
     * a `Completed` section — so the array the foot is handed legitimately holds
     * rows that must not be counted. Asserted as the pair: a terminal task alone
     * says nothing at all, and a terminal task beside a live one counts one.
     */
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

    /*
     * The chip table, as a **total** mapping over the five states.
     *
     * Written as an exhaustive sweep rather than five hand-picked rows, because
     * the failure this guards is a sixth state added on the daemon's side with no
     * row here — which draws nothing at all beside a live task, on the one row
     * whose job is saying whether the work is over.
     *
     * ⚠ **The list below is a hand-written copy, not the daemon's union**, and a
     * driver cannot import one. So this sweep proves the five rows exist and are
     * right; it does **not** catch a sixth state added in `src/acp/asynctasks.ts`.
     * What would catch that is reading `STATES` out of that file as source text,
     * the way `webcheck.plugin-protocol.ts` reads the daemon's interfaces — until
     * then these five words live in four places (`STATES` and `TERMINAL` in
     * `asynctasks.ts`, `AsyncTaskState` in `wire.ts`, `taskFinished`'s re-derived
     * terminal three, and this literal) with nothing comparing any pair.
     */
    const { TASK_CHIPS, TASK_SECTIONS, TASK_NOUNS } = await import("../src/tasks.js");
    const states = ["running", "paused", "completed", "failed", "stopped"] as const;
    check(
      "every state a task can be in has a chip, and each is parenthesised",
      states.map((state) => TASK_CHIPS[state]?.[0] ?? null),
      ["(running)", "(paused)", "(done)", "(error)", "(stopped)"],
    );
    /*
     * ⚠ **And the tone carries the meaning, which is this app's rule for a status
     * word: the distinction is a colour, never a size.** The three that are over
     * are three different colours because they mean three different things — it
     * finished, it broke, somebody stopped it — and the two that are not share
     * one, because *going* and *paused* are the same news to a reader deciding
     * whether to wait.
     */
    check(
      "and the two states that are not over share one tone while the three that are do not",
      [
        TASK_CHIPS.running?.[1] === TASK_CHIPS.paused?.[1],
        new Set([TASK_CHIPS.completed?.[1], TASK_CHIPS.failed?.[1], TASK_CHIPS.stopped?.[1]]).size,
      ],
      [true, 3],
    );
    /*
     * ⚠ **And every tone is a colour the palette actually declares.** The check
     * above is satisfied by three *different* names, which is exactly what the
     * first version of this table had — `text-success` and `text-warning` were
     * different strings, emitted no CSS, and drew `(done)` and `(stopped)` in the
     * row's ambient colour (Q3.603). A token renamed under this table (`offer-ink`
     * became `caution`, Q1.650) is the same failure from the other side.
     */
    const palette = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    check(
      "and every tone names a token the palette declares",
      Object.values(TASK_CHIPS)
        .map(([, tone]) => tone.replace(/^text-/, ""))
        .filter((name) => !new RegExp(`^\\s*--color-${name}:`, "m").test(palette)),
      [],
    );

    /*
     * The sections, in Claude Code's own order, and the rule that a kind with no
     * section of its own still lands somewhere.
     *
     * Driven through the predicates rather than by reading their source, because
     * what matters is that the three of them **partition** — a task in two
     * sections is a row drawn twice, and a task in none is a row drawn nowhere
     * while the foot line above still counts it.
     */
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
    /*
     * ⚠ **The noun table and the section table are two lists of the same three
     * kinds, and they have to agree.** They are separate because one names a
     * sentence and the other names a heading — `background dynamic workflow`
     * against `Dynamic workflows` — so neither can be derived from the other, and
     * a kind in one and not the other is a row that counts under a noun its own
     * section never uses.
     */
    check(
      "and the kinds with a noun of their own are the kinds with a section of their own",
      Object.keys(TASK_NOUNS).length,
      TASK_SECTIONS.length,
    );

    /* ----------------------------------------------------------------
     * The panel itself: what it computes, and where it is.
     *
     * ⚠ **Every formatter here is Anthropic's, reproduced from the installed
     * `claude` binary, and the reason to drive them rather than eyeball them is
     * that all three have a carry or a rounding rule that looks like decoration
     * until it is wrong.** `1m 60s` is what the seconds arm produces without the
     * normalisation; `8.0k` is what the token arm produces without the strip.
     * ---------------------------------------------------------------- */
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
    /*
     * ⚠ **The carry, which is the whole reason this is not three template
     * literals.** Seconds are *rounded* above a minute, so 119.6s is 2m rather
     * than `1m 60s`, and the same carry has to run all the way up — 3599.6s is an
     * hour rather than `59m 60s`, and 86399.6s is a day rather than `23h 60m 0s`.
     */
    check(
      "and a rounded second carries instead of printing sixty",
      [119_600, 3_599_600, 86_399_600].map(taskDuration),
      ["2m 0s", "1h 0m 0s", "1d 0h 0m"],
    );
    /* And nothing under a minute is zero-padded: `08s` is not a form either
       formatter in that binary produces, and a leading zero here would be this
       app inventing one. */
    check("and a short duration is never zero-padded", taskDuration(8_000).startsWith("0"), false);

    check(
      "a token count is compact, lowercase, and drops a trailing .0",
      [0, 999, 8_000, 429_700, 1_200_000].map(taskTokens),
      ["0", "999", "8k", "429.7k", "1.2m"],
    );

    /*
     * Elapsed time comes from this daemon's two stamps and never from the agent.
     *
     * ⚠ **The finished case is the one that earns the field.** `usage.durationMs`
     * is the only duration on the wire, it rides a *progress* frame, and the
     * adapter drops both the SDK's final `usage` and its `end_time` — so a
     * completed task's own number is stale by however long its last leg ran, and a
     * quiet task never sent one at all. Without `endedAt` a finished card counts
     * up for ever, which is a card claiming work is still going.
     */
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
    /* A clock that went backwards between two renders is under a minute, not
       `−2m`: the same direction `elapsedSays` already picks one file over. */
    check("and a clock that went backwards says nothing worse than zero", taskElapsedMs(running, 0), 0);

    /*
     * The meter, and the case that is the only one this app can ever draw.
     *
     * A workflow's agents are `local_agent` tasks and the adapter marks every one
     * of them `ignored` before publishing, so nothing on this wire ever counts
     * them: `total` is always zero here. Claude Code's own arithmetic already
     * answers for that — `Xe > 0 ? … : 0` — and the answer is one moving cell,
     * which is what *something is going and nobody is saying how far* should look
     * like. The other rows are driven so the arithmetic stays theirs rather than
     * collapsing to the one case we exercise.
     */
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

    /*
     * The sections, as the panel partitions them — **the three live kinds, and
     * `Completed` is not one of them.**
     *
     * ⭐ **It used to be pushed in here, and moving it out is what lets the band be
     * drawn when there is nothing.** The owner's rule is that Finished is reachable
     * *even when no work exists*, and a function that returns a section per thing
     * that exists cannot return one for a thing that does not. So `sections` means
     * how many **live kinds** — which is all any caller ever read it for — and the
     * band is `PanelBody`'s, which is what `taskSections`' own docblock always
     * claimed: *"neither is a member … Both are drawn by the panel around this
     * list."*
     *
     * The property the old pair protected survives for free and is asserted below
     * from the other side: a finished shell must never *also* appear under
     * `Shells`. `live` is filtered before the kinds are applied, so it cannot.
     */
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

    /*
     * ⚠ **A title is read off a different field per kind, because the adapter
     * fills them differently.** `name` is the workflow script's own `meta.name`
     * and is set *only* for a workflow; for everything else the adapter sets it to
     * the description, so leading with `description` is what puts a backgrounded
     * shell's command line on the card rather than a repeat of it.
     */
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

    /* ----------------------------------------------------------------
     * Placements, read off disk, positive **and** negative — nothing typed can
     * hold one, and every rule below has a plausible edit that undoes it while
     * `typecheck` and every other assertion here stay green.
     * ---------------------------------------------------------------- */
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
    /*
     * ⚠ **It portals and it is not a `Sheet`, and the pair is the whole design.**
     * `fixed` only means the viewport where no ancestor carries a `transform` or a
     * `backdrop-filter`, and this screen's header and composer are one hop from
     * one — so it has to leave the layout. But `Sheet` puts `inert` on `#root`,
     * which at `xl` would switch off the conversation this thing is docked
     * *beside*, and there is no way to make that conditional without asking
     * JavaScript what the breakpoint is.
     */
    check("the panel leaves the layout", /createPortal\(/.test(panelSrc), true);
    check("and it is not the app's modal pop-up", /\bSheet\b/.test(panelSrc), false);
    check('and it is "menu" in the overlay stack rather than "sheet"', [
      /useDismissible\("menu"/.test(panelSrc),
      /useDismissible\("sheet"/.test(panelSrc),
    ], [true, false]);
    /*
     * ⚠ **The breakpoint is answered only in CSS, on both halves.** `AppShell`'s
     * rule, and the failure it prevents is a resized window drawing a docked panel
     * over a conversation that never made room for it — or dimming one it is
     * sitting beside.
     */
    /*
     * ⚠ **It docks *inset*, and the change of shape is what retired a
     * measurement.** Flush against the viewport — `inset-y-0 right-0`, square, no
     * shadow — it claimed the same edges as the window's own chrome, so its head's
     * rule and the header's had to be the same height to the pixel or the eye read
     * one broken line. They were 4px apart; pinning the two heights fixed that
     * instance and left the arrangement, where any later change to either row
     * reopens it. A card standing 12px off every edge meets no line, so there is
     * nothing left to keep in step.
     */
    check("the panel docks inset rather than flush", [/md:right-3/.test(panelSrc), /(?:xl|md):right-0\b/.test(panelSrc)], [true, false]);
    check("and it is a card there: round, bordered, lifted", [
      /md:rounded-2xl/.test(panelSrc),
      /md:border\b/.test(panelSrc),
      /md:shadow-lg/.test(panelSrc),
      /md:rounded-none|md:shadow-none/.test(panelSrc),
    ], [true, true, true, false]);
    /*
     * ⭐ **The sheet is for a phone, so it stops at `md`.** Every phone in portrait
     * is under 768px, and a phone in landscape is better served by the card — a
     * bottom sheet at `h-[92dvh]` over a short landscape viewport is the whole
     * screen. Pinned as the breakpoint the *scrim* stops at too, since the scrim is
     * what makes it a sheet.
     */
    check("the sheet is the phone's arrangement and stops there", [/md:hidden/.test(panelSrc), /xl:hidden/.test(panelSrc)], [true, false]);
    /*
     * ⭐ **It collapses rather than disappearing, and every variant that can be on
     * screen owes an outgoing animation.**
     *
     * The close was `if (!open) return null` — one frame, on a phone, under a sheet
     * that had taken 260ms to arrive. The mechanism is `leaving.ts`'s and asserted
     * there; what is asserted here is the half that is this panel's, and it is the
     * half with a trap in it.
     *
     * ⚠ **`md:animate-none` may not survive in the shared run.** It was correct
     * while there was no exit — it cancels `animate-sheet`, whose `translateY(100%)`
     * would slide the docked card up from the bottom of the screen — and it is
     * exactly wrong now: an element carrying `animation: none` fires no
     * `animationend`, so at `md` and above the exit would fall to the backstop and
     * leave a **fully visible** card over the conversation for its whole duration.
     * Pinned absent, because the repair for that defect is to delete this utility
     * and the repair for the *old* defect was to add it.
     *
     * ⚠ **And both arms are read, because writing `md:animate-rise-out` beside a
     * standing `md:animate-none` is two utilities setting one property in one
     * variant** — resolved by Tailwind's emission order rather than by the order of
     * the class string, which is the `SETTINGS_HEADING` trap on the animation axis.
     * The check is that the cancellation moved onto the *other* arm.
     */
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
    /*
     * ⚠ **`shown`, never `open`, in both places** — the layer's lifetime and the
     * element's are one statement. Registered on `open` the layer pops at the
     * *start* of the exit, so the ask card's digit shortcuts stand back up and
     * Escape stops being swallowed while an opaque sheet is still covering the
     * screen. `MenuDrawer` measured it one layer kind over, where it costs `inert`
     * as well and was keyboard-only — which is why it survived being looked at.
     */
    check(
      "and the layer it registers lasts exactly as long as the element does",
      [/useDismissible\("menu", onClose, shown\)/.test(panelSrc), /if \(!shown\) return null;/.test(panelSrc)],
      [true, true],
    );
    /*
     * The scrim had no animation in **either** direction: it snapped to 25% ink on
     * open and blinked out on close while the sheet slid. `pointer-events-none` is
     * the other half — `--animate-scrim-out` ends at `opacity: 0` while the element
     * lives on, so the tail of every close was an invisible viewport-sized
     * click-eater.
     */
    check(
      "the ground under it arrives and leaves on the same clock",
      [
        /leaving \? "animate-scrim-out pointer-events-none" : "animate-scrim"/.test(panelSrc),
        /onClick=\{leaving \? undefined : onClose\}/.test(panelSrc),
      ],
      [true, true],
    );
    /*
     * ⚠ **The backstop is the *longer* of the two exits, not the one it plays
     * most.** `leaving.ts` ends the exit on `animationend` and this number only
     * decides what happens when that never arrives; a backstop under either
     * duration cuts a movement off mid-slide and leaves the panel mounted with
     * nothing running. Read out of the stylesheet, because neither file can see the
     * other's number — the shape `--rail-w`/`RAIL_DEFAULT` is pinned for.
     */
    const panelCss = taskCssEarly;
    const sheetOutMs = Number(/--animate-sheet-out:\s*sheet-out\s+(\d+)ms[^;]*\bboth\b/.exec(panelCss)?.[1] ?? Number.NaN);
    const riseOutMs = Number(/--animate-rise-out:\s*rise-out\s+(\d+)ms[^;]*\bboth\b/.exec(panelCss)?.[1] ?? Number.NaN);
    const backstopMs = Number(/TASK_PANEL_EXIT_MS = (\d+);/.exec(panelSrc)?.[1] ?? Number.NaN);
    report(
      "both departures were found, and both fill forwards",
      Number.isFinite(sheetOutMs) && Number.isFinite(riseOutMs) && Number.isFinite(backstopMs),
      `sheet ${String(sheetOutMs)}ms, card ${String(riseOutMs)}ms, backstop ${String(backstopMs)}ms`,
    );
    check("the backstop outlasts both of them", backstopMs, Math.max(sheetOutMs, riseOutMs));
    check("and the card's exit is the shorter, since it travels six pixels", riseOutMs < sheetOutMs, true);
    /*
     * ⚠ **Its name may not compete with the name of the screen it is inside.**
     * The panel is a sub-window, and its head was `text-lg` against the
     * conversation's own `text-sm` title. Asserted as the *comparison* rather than
     * as either number, so it stays true when either moves.
     */
    const SCALE = ["text-2xs", "text-xs", "text-sm", "text-base", "text-lg"];
    const panelWord = SCALE.findIndex((size) => new RegExp(`<h2 className="[^"]*\\b${size}\\b`).test(panelSrc));
    const titleWord = SCALE.findIndex((size) => new RegExp(`tap min-w-0 truncate[^"]*\\b${size}\\b`).test(viewSrc));
    report("both words were found on the scale", panelWord >= 0 && titleWord >= 0, `panel ${SCALE[panelWord] ?? "?"}, title ${SCALE[titleWord] ?? "?"}`);
    check("the panel's name is strictly quieter than the conversation's", panelWord >= 0 && titleWord >= 0 && panelWord < titleWord, true);
    /*
     * ⭐ **And its band is this panel's own height, spelled out rather than
     * composed — which nothing here asserted until the height came down.**
     *
     * The head was `SHEET_HEAD`, 56px, a number argued for a *sheet's* head: a
     * `text-lg` `<h1>` beside a 32px `nav` control. This one carries a `text-xs`
     * `<h2>` and a 24px `sm` button, so it was forty pixels of band around
     * twenty-four of content.
     *
     * ⚠ **The repair that suggests itself is a measured no-op.** Two `min-h-*`
     * utilities on one element are resolved by the stylesheet's emission order
     * rather than by the class string, and that order is numeric and ascending —
     * `.min-h-9`, `.min-h-10`, `.min-h-11`, `.min-h-12`, `.min-h-14` in sequence
     * inside one layer — so `` `${SHEET_HEAD} min-h-11` `` can only ever make the
     * band taller. The composed form is pinned **absent** for that reason: it is
     * the smaller diff, it looks right, and it does nothing.
     *
     * ⚠ **44 rather than 40.** Every `ICON_BUTTON_SIZE` entry reaches this app's
     * 44px floor through a positioned `::after` that costs no layout, and the
     * `<aside>` carries `overflow-hidden`, which clips hit-testing along with
     * paint — so at 40 the ✕ is a 42px target with a 2px strip missing off the top
     * and nothing on screen to explain it. Read as a *number* and compared against
     * the floor rather than pinned as a literal.
     */
    const headClasses = /const PANEL_HEAD = "([^"]*)"/.exec(panelSrc)?.[1] ?? "";
    const headMin = Number(/\bmin-h-(\d+)\b/.exec(headClasses)?.[1] ?? Number.NaN);
    report("the panel's own head string was found", headClasses.length > 0, headClasses);
    check(
      "the head is spelled out at this panel's height rather than composed from the sheet's",
      [/<div className=\{PANEL_HEAD\}>/.test(panelSrc), /SHEET_HEAD/.test(panelSrc)],
      [true, false],
    );
    check("and it is shorter than a sheet's head but still reaches the tap floor", [headMin < 14, headMin >= 11], [true, true]);
    /*
     * ⚠ **A head inset further than its own contents is the one visible thing
     * spelling this string out can get wrong**, and the panel's docblock says so —
     * which is a sentence rather than a mechanism until the two are differenced.
     * The scroller directly below it is the comparison.
     */
    const headPad = (headClasses.match(/\bs?m?:?px-[\w.[\]/-]+/g) ?? []).filter((one) => one.includes("px-"));
    const scrollerPad = (/<div className="(min-h-0 flex-1 overflow-y-auto[^"]*)"/.exec(panelSrc)?.[1] ?? "")
      .split(/\s+/)
      .filter((one) => one.includes("px-"));
    report("both insets were read to compare", headPad.length > 0 && scrollerPad.length > 0, `head ${headPad.join(" ")}, body ${scrollerPad.join(" ")}`);
    check("the head and the list it heads share one inset, at every width", headPad, scrollerPad);

    /* ----------------------------------------------------------------
     * The finished band: folded, seeded closed, and clearable.
     * ---------------------------------------------------------------- */

    /*
     * ⭐ **A workflow that ended while the panel was open used to just sit there.**
     * `taskSections` did move it to `Completed` — but `PanelBody` names a section
     * only when something else is populated, so with one workflow and no
     * delegations the finished card kept its place, its size and its position, with
     * its chip changed from `(running)` to `(done)` and **nothing saying the word**.
     * A band that folds is what says the row moved, so the finished section is
     * routed to its own component before `named` is ever consulted.
     */
    check(
      "the finished band is drawn as its own folding section",
      [
        /function FinishedSection\(/.test(panelSrc),
        /aria-expanded=\{open\}/.test(panelSrc),
        /const finished = useMemo\(\(\) => background\.filter\(\(task\) => taskFinished\(task\.state\)\)/.test(panelSrc),
      ],
      [true, true, true],
    );
    /*
     * ⭐ **And it is drawn when there is nothing, which is the owner's rule and the
     * reason the kebab's door exists at all** — a record reachable only while
     * something else is running is not a record.
     *
     * ⚠ **Gated on `reports`, and that gate is the one thing here that is not
     * cosmetic.** `Completed (0)` is a count, and a count of finished background
     * work is an **answer**: claude is the one agent of the four with a lifecycle
     * on the wire, so on the other three a zero asserts exactly what the sentence
     * beside it is careful to disclaim. Ungated, this change would make the panel
     * lie about kimi in the same breath as the paragraph saying it must not.
     */
    check(
      "and it is drawn with nothing in it, but only where an empty list is an answer",
      [
        /const showFinished = reporting === "reports" \|\| finished\.length > 0;/.test(panelSrc),
        /\{showFinished && \(\s*<FinishedSection/.test(panelSrc),
      ],
      [true, true],
    );
    /*
     * ⚠ **Nothing to show is a heading rather than a fold.** A disclosure whose
     * body is empty is a control that lies about having something behind it —
     * `EventList` names it and draws an inert paragraph for the same reason — and
     * it was already reachable before the band became unconditional: clearing the
     * list leaves `tasks.length > 0` with `shown.length === 0`. One condition
     * covers the cleared session and the one that never backgrounded anything.
     */
    check(
      "an empty band is a heading with no fold and no clear",
      /if \(shown\.length === 0\) \{[\s\S]{0,200}?<PanelHeading count=\{0\}/.test(panelSrc),
      true,
    );
    /*
     * ⚠ **One band count replaces two proxies.** `sections.length > 0` and
     * `sections.length > 1` both stood in for *is there more than one band on
     * screen*, which was true while `Completed` was inside `sections` and stopped
     * being so the moment it moved out. Left alone, a lone live kind beside the
     * band would have gone unlabelled and the `Agents` heading would have
     * disappeared whenever the band was the only other thing — and no driver
     * anywhere reads `aria-labelledby`, `"Agents"` or `PanelHeading`, so nothing
     * would have said a word.
     */
    check(
      "the headings are gated on how many bands are on screen, not on the partition's length",
      [/const bands = /.test(panelSrc), /const named = bands > 1;/.test(panelSrc), /sections\.length > 1/.test(panelSrc)],
      [true, true, false],
    );
    /*
     * ⚠ **Seeded closed, and *where* that state lives is the assertion.**
     * `TaskPanel` renders nothing while `!shown`, so everything below `PanelBody`
     * unmounts on every close and a `useState(false)` inside the section is read
     * afresh on every open — the whole of "collapsed by default", with nothing
     * stored. But `TaskPanel` itself is rendered unconditionally by `EventList`, so
     * the same line in *its* body would survive every close and every session
     * switch instead. The two are one character apart in a diff and opposite in
     * behaviour, so the position is read rather than the value.
     */
    const finishedAt = panelSrc.indexOf("function FinishedSection(");
    const finishedEnd = finishedAt < 0 ? -1 : panelSrc.indexOf("\nfunction ", finishedAt + 1);
    const finishedBody = finishedAt >= 0 && finishedEnd > finishedAt ? panelSrc.slice(finishedAt, finishedEnd) : "";
    report("the finished section's own body was isolated", finishedBody.length > 0 && finishedBody.length < 3000, `${String(finishedBody.length)} chars`);
    check("it seeds itself closed, in the component the panel unmounts", /useState\(false\)/.test(finishedBody), true);
    /*
     * ⚠ **`aria-controls` is refused.** The body is `{open && …}`, so an attribute
     * pointing at an id nothing renders names nothing — the defect `PanelBody`
     * carries its own ⚠ about one region up.
     */
    check("and it claims no region it does not render", /aria-controls/.test(finishedBody), false);
    /*
     * ⚠ **The clear hands up *every* finished id, not the visible ones.** That is
     * the prune: stored as exactly what is finished at that instant, the hidden set
     * is always a subset of what the wire holds and can never name a row the daemon
     * has already given up. `onClear={() => onClear(shown.map(…))}` is the natural
     * mistake and it grows the set out of step with the wire.
     */
    check("the clear names every finished row rather than the visible ones", /onClear\(tasks\.map\(\(task\) => task\.id\)\)/.test(finishedBody), true);
    /*
     * ⚠ **The wire's partition stays the wire's.** The hidden set is a *display*
     * filter and may not reach `tasks.ts`: pushed in there, `taskSections` would
     * answer no `Completed` section once everything was cleared, the band would
     * vanish with it, and the owner's rule — the option clears them, `Completed`
     * does not disappear — would be reversed by a change that reads as a
     * simplification.
     */
    const tasksSrc = stripComments(readFileSync(new URL("../src/tasks.ts", import.meta.url), "utf8"));
    check(
      "and the hidden set never reaches the partition, so the band stands at zero",
      [/hidden/.test(tasksSrc), /export const FINISHED_LABEL/.test(tasksSrc)],
      [false, true],
    );
    /*
     * ⚠ **In memory, never stored, and forgotten with the session.** It is a claim
     * about rows on a *remote machine*, not a preference about this client: a
     * daemon restart, the agent's own `/clear` and eviction at the cap each destroy
     * those rows with nothing to tell the browser, so a stored set would go on
     * hiding ids that can never be seen again — and would hide a freshly spawned
     * row that reused one. `groups.ts` persists its collapse set; this one may not,
     * and `forgetSession`'s docblock says anything per-session belongs in it.
     */
    const finishedSrc = stripComments(readFileSync(new URL("../src/finishedTasks.ts", import.meta.url), "utf8"));
    const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    check(
      "the cleared set is held in memory and released with the session",
      [/localStorage/.test(finishedSrc), /forgetHiddenFinished\(key\)/.test(storeSrc)],
      [false, true],
    );
    /*
     * And the behaviour no source pin can see: that a second clear **replaces**
     * rather than unions. Unioned, the set grows for ever with ids the wire cannot
     * match again — every source assertion above stays green over it.
     */
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
    /*
     * ⭐ **The width is a custom property now, and the gutter is `calc` of the same
     * one — so what used to be a pair of lists is a single relation.**
     *
     * It was `md:w-[20rem] xl:w-[26rem]` against `md:pr-[20.75rem]
     * xl:pr-[26.75rem]`, and the driver walked both lists asserting the
     * subtraction at every step, because a width without its gutter at the *same*
     * breakpoint is the card lying over the end of every line. That pin is retired
     * with the thing it pinned: a width somebody can drag cannot be a literal, and
     * a gutter built from the same `var()` cannot disagree with it.
     *
     * ⚠ **What replaces it is the `calc`, read as text, plus the 12px appearing on
     * both sides.** The inset is three `*-3` utilities and a `+ 0.75rem` — one
     * distance in Tailwind's two spellings, with nothing in CSS relating them — so
     * that is the one number here still written twice and it is asserted as an
     * equality rather than trusted.
     *
     * ⚠ **And the literals are pinned *absent*.** Restoring `md:w-[20rem]` beside
     * the property is a smaller diff than any of this and would leave the panel at
     * a fixed width with the separator still dragging a variable nothing reads —
     * a drag that does nothing at all, with every other check here green.
     */
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
    /*
     * ⭐ **What is *spent* is `--task-fit`, and what is *stored* is `--task-w`.**
     * The two panes' clamps are independent and their sum is bounded nowhere:
     * measured in a real browser at a 1024px window with both dragged to their
     * maxima, the conversation's content box floored at 0px and the docked card lay
     * 52px over the session rail. Neither module can see the other and neither may
     * ask how wide the window is — the ban four checks down is by literal — so the
     * clamp is in CSS, where the viewport is. The separator still reads and writes
     * `--task-w`, which is why both spellings appear and why this pair is asserted
     * rather than assumed: spending `--task-w` here is the revert, and it looks
     * like a simplification.
     */
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
    /*
     * ⚠ **Both declared defaults live in the stylesheet and are derived from
     * `taskWidth.ts`'s constants, not typed a second time.** Same pin
     * `--rail-w`/`RAIL_DEFAULT` carries, for the same measured reason: `19.5rem`
     * and `312` were asserted independently for a release, agreed only at a 16px
     * root font, and cost every reader on Chrome's Large setting a 78px snap on
     * load. px on both sides is the whole fix.
     *
     * ⚠ **And the order is the mechanism.** Both declarations are unlayered
     * `:root` and `@media` adds no specificity — this stylesheet's own post-mortem,
     * where every phone animation shipped onto the desktop for exactly this reason.
     * The wide one wins because it comes later and for no other reason, so written
     * above the base it would silently never apply, with both values still present
     * and correct.
     */
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

    /*
     * ⭐ **Two names for one pane, and the join between them was asserted
     * nowhere.**
     *
     * The stored number and the spent one are both pinned above — the `min()` read
     * out of the stylesheet, the separator's read of `pane.prop` read out of
     * `PaneHandle` — and *which* property that second one is was left to a
     * reviewer. `getPropertyValue(pane.prop)` says the separator spends **its
     * pane's** property without saying which of the two that is.
     *
     * ⚠ **So `prop: "--task-fit"` in `taskWidth.ts` is a one-token edit that every
     * check on this screen survives**, and it reads like removing an indirection.
     * What it does is point the drag at the clamped variable: the separator would
     * write it inline onto `documentElement`, where a declaration beats the `:root`
     * `min()` outright, and the conversation's 240px floor would be gone — the
     * floor whose absence was measured as a 0px content box with the card 52px over
     * the session rail. The drag would keep working perfectly.
     *
     * Derived in one direction only: the clamped name is read back out of the
     * stylesheet as *the property declared from the stored one*, so it is not typed
     * here a third time, and the stored one is the single literal this pair rests
     * on.
     */
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
    /*
     * ⭐ **And the separator's own fallback was a computed-style resolution per
     * render, on the one screen where a render is per streamed token.**
     *
     * `aria-valuenow` falls back to the DOM's answer for the stored property, and
     * it falls back for every reader who has never dragged — which is the default
     * state rather than an edge. `TaskPanel` is rendered from `EventList`'s own
     * body with no `memo` between them, so an open panel put
     * `getComputedStyle(documentElement)` in the path of every arriving chunk. The
     * rail never reached it at all, its unset state being a number.
     *
     * The first check below has **two** arms saying different things, and neither
     * is the other's control: the count pins that `getComputedStyle(` appears
     * **once**, so a second resolution added beside the cached one fails it while
     * the `??=` stays true; the `??=` pins that the one site is the cached one, so
     * a read that went back to resolving per render fails that arm while the count
     * stays at 1.
     *
     * ⚠ **A cache is only safe if what drops it is complete, so it is a census of
     * droppers rather than a check that one exists.** Three things can change the
     * answer: a committed width, because that is written inline onto
     * `documentElement` and is then what a computed read hands back; a resize,
     * which is the only thing that moves the breakpoint; and `pointerdown`, so a
     * gesture still begins from a reading taken for it — the read whose absence was
     * measured as a 96px jump under the pointer on the panel's first drag at `xl`.
     * A fourth dropper fails this as found-and-not-listed and a deleted one as
     * listed-and-not-found; a count alone could see neither.
     */
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
    /*
     * ⭐ **And every pointer event the separator answers belongs to the gesture in
     * flight, which is a sweep rather than a spot check.**
     *
     * A second finger landing on the strip is refused entry by the one-at-a-time
     * guard — and was refused entry only: the finger is still on an 8px strip, so
     * its own `pointerup` arrived at this element and committed and ended the
     * *first* pointer's drag, after which the first went on moving with no gesture
     * recorded and the pane was frozen under a button still held down. A capture
     * lost with no release at all — another element taking the same id — left the
     * gesture recorded for ever, and the one-at-a-time guard then refused every
     * later press: a separator that draws, hovers and focuses and moves nothing
     * again for the rest of the session.
     *
     * ⚠ **The census is the attribute list differenced against the guard count**,
     * because the failure is a handler somebody adds rather than a value somebody
     * changes. A sixth pointer handler with no ownership test fails as a count that
     * no longer matches; a guard deleted from one of the three fails the same
     * comparison from the other side. The equality against a written-down member
     * list is also this sweep's floor: a pattern that stopped matching answers the
     * empty list, which is not the list.
     */
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
    /*
     * ⚠ **A capture lost with no release is a cancel, never a commit** —
     * `pointercancel`'s own rule, a gesture taken away not being a smaller pane.
     * `finish(true)` here is the plausible edit: it would commit a width nobody
     * finished asking for, and on an ordinary release — where this fires after
     * `pointerup` — it would commit a second time.
     */
    check(
      "and a lost capture ends the gesture without committing it",
      /const onLostPointerCapture = \(event: React\.PointerEvent<HTMLDivElement>\): void => \{\s*if \(owns\(event\)\) finish\(false\);/.test(paneHandleSrc),
      true,
    );
    /*
     * ⭐ **One copy of the gesture, and this is the half every other driver here
     * is blind to by construction.**
     *
     * `AppShell`'s `RailHandle` is a two-line wrapper with no state, no handlers
     * and no capture, and it kept **four** paragraphs describing all of them after
     * the mechanism moved into `PaneHandle` — including the *pre-correction*
     * version of the Chrome 151 measurement, which said a captured drag leaves
     * nothing to leak when the element holding it is removed. That is precisely the
     * claim `PaneHandle`'s unmount effect exists to repair, so a reader who found
     * the wrapper's copy first was told the opposite of what was measured, in the
     * file a reviewer opens to check where the strip sits.
     *
     * ⚠ **Read raw rather than through `stripComments`, because here the comments
     * are the subject.** Every other assertion about this file strips them for the
     * opposite reason. The sweep is the mechanism's own vocabulary rather than any
     * sentence: a wrapper that only positions an element has no business naming a
     * pointer verb, and the prose cannot be copied back without one of these words.
     * It carries a positive control for the reason `webcheck.env.ts` records as a
     * skip reading like a pass — a sweep whose predicate stopped matching answers
     * the empty list, and the empty list is what passing looks like here. The
     * control runs the **same** `includes` over `PaneHandle.tsx` read raw, the one
     * file that has to name all six, and compares the result against those six
     * written out a second time as a **literal**: an emptied, misspelled or
     * reordered `GESTURE_WORDS` fails there instead of passing here. The literal
     * is the whole of it, and this control was itself the defect once: the first
     * version searched a string it had interpolated the word into and compared the
     * count against `GESTURE_WORDS.length`, so both sides moved together and it
     * answered `ok` for any list, `[]` included.
     */
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
    /*
     * ⚠ **And the sentence a reader sent here from that wrapper lands on first.**
     * The clause the unmount effect repairs is still in `PaneHandle`'s opening
     * docblock, uncorrected, two hundred lines above the effect — kept on purpose,
     * because this repository states a correction once, at the code that acts on
     * it, and `AppShell` deliberately no longer restates the measurement. What the
     * clause may not be is *unmarked*: with the wrapper's copy gone, an unmarked
     * one is the only thing a reader who follows that pointer would read, and the
     * mark beside it is a shortening pass away from being tidied off as
     * commentary-about-commentary.
     *
     * Raw for the sweep's own reason, and the stripped half is asserted with it:
     * all three of these are comments, so a copy read through `stripComments` must
     * find none of them. That is what stops this passing over code that happens to
     * quote itself.
     */
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
    /*
     * ⚠ **One surface lists them, and the transcript's foot is a way in rather
     * than a second copy.** Two surfaces drawing one set is how they come to
     * disagree, and the inline fold could not hold a card without pushing the
     * composer down the screen every time an agent backgrounded a shell.
     */
    const footAt = eventListSrc.indexOf("function WaitingFoot");
    const footBody = footAt < 0 ? "" : eventListSrc.slice(footAt, eventListSrc.indexOf("\n}\n", footAt));
    /*
     * ⚠ **The transcript's run fold keeps its 44px, and it is the third button of
     * this shape rather than a survivor of an oversight.**
     *
     * Two folds lost `min-h-11` by the owner's call — the finished band and
     * `bits.tsx`'s `Disclosure` — and this one wears the same class prefix, so the
     * next sweep for "all buttons like that" reaches it. It must not be taken, and
     * the reason is a *measurement about neighbours* rather than an argument about
     * importance, which is what the other two fell to. These rows are full-width
     * and stacked `space-y-1.5` apart, so an invisible expander grown 9px each way
     * covers 6px of the row above's face — and the row above is another disclosure.
     * There is no free direction here, which is why the box itself had to grow. It
     * was 26px and its own note records what that cost: *"the only record of what
     * the agent did, and until this they were 26px of machinery nobody could
     * reliably hit."* Nor is there a trash beside it to look small against, which
     * is the complaint the other two answered.
     */
    check(
      "the transcript's own run fold keeps the height those two gave up",
      /className="tap flex min-h-11 w-full items-center gap-1\.5 rounded-md px-1 py-1 text-left/.test(eventListSrc),
      true,
    );
    check("the foot's own component was found", footAt >= 0 && footBody.length > 0, true);
    check("the foot opens the panel", /aria-haspopup="dialog"/.test(footBody), true);
    /*
     * ⭐ **And it is no longer the only door, which is the whole point of the
     * second one.** `footSays` answers `null` once nothing is outstanding, so the
     * foot is not drawn — and `onOpenTasks` had exactly one call site, so the
     * record the panel keeps became unreachable at the moment it became worth
     * reading. The session header's kebab is the other door.
     *
     * ⚠ **Asserted on three files at once, because the failure is a missing
     * connection rather than a wrong value.** A row in the menu that nothing
     * mounts, or a mount that passes no callback, leaves every other check here
     * green over a panel nobody can open.
     */
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
    /*
     * ⚠ **The kebab is mounted at every width, and the wrapper that hid it above
     * `lg` is gone.** That wrapper was right for every row it was about — Rename,
     * Pin, Resume and Stop are all on the session's row in the rail, so with the
     * rail beside you the menu was a second door to a door. It is wrong for a row
     * that is on **no** rail row at any width. Pinned in both directions, because
     * restoring the wrapper is a two-word diff that reads like tidying and takes
     * the desktop's only door with it.
     *
     * ⚠ **This pair was enforced nowhere.** Three prose sites rested on it —
     * `SessionView`'s docblock and *two* paragraphs in `Header.tsx` arguing the
     * 44px kebab from "neither control exists above `lg`" — and a sweep of every
     * driver for `lg:hidden` found three hits, none of them about this header. So
     * the change could have gone green with all three left lying, which is the
     * failure this repository names as its worst.
     */
    const kebabAt = viewSrc.indexOf("<SessionMenu");
    const before = kebabAt < 0 ? "" : viewSrc.slice(Math.max(0, kebabAt - 120), kebabAt);
    report("the header's kebab mount was found", kebabAt >= 0, before.replace(/\s+/g, " ").trim().slice(-60));
    check("and nothing hides it at the width where it is the only door", /lg:hidden/.test(before), false);
    /*
     * The menu row opens a dialog rather than acting, and says so — the same
     * promise the foot above makes with the same attribute. A menu row that
     * silently behaves like a second kind of control is the widget-role failure
     * `web-shell.md` records about this app's two popovers.
     */
    check("and the row that opens it says what it opens", /haspopup="dialog"/.test(menuSrc), true);
    check("and no longer claims a region under it", /aria-expanded/.test(footBody), false);
    check("and draws no task rows of its own", /function TaskRow\(|function TaskHeading\(/.test(eventListSrc), false);
    /*
     * ⚠ **That sentence is gone from both surfaces now, by the owner's call, and
     * this assertion is kept rather than deleted.**
     *
     * It used to read "on the panel and nowhere else": the line explained why there
     * is no per-task view, and a copy at the foot of the transcript would have been
     * explaining the absence of a thing one tap away. What the owner decided is
     * that the *panel's* copy earns nothing either — it answers a question nobody
     * asks twice, on every visit, for ever.
     *
     * The half worth keeping is the direction it was always guarding: a standing
     * explanation of an absence must not come back, and least of all at the foot of
     * the transcript, which is the surface with the widest audience and the least
     * room. So both are pinned absent, and a reader who wants the fact it stated
     * finds it in `TaskPanel.tsx`'s own note.
     */
    const footer = "Each task&apos;s output reaches the transcript when it finishes";
    check("the standing sentence about output is on neither surface", [
      panelSrc.includes(footer),
      eventListSrc.includes(footer),
    ], [false, false]);
    /*
     * And its sibling: `N background tasks finished`, which stood at the foot for
     * the rest of a session because terminal rows are kept by decision. Removed for
     * the same reason and pinned the same way — the foot says what is *outstanding*
     * and nothing else, which is what `footSays` answers and what the live region
     * beside it now repeats exactly.
     */
    check("and the foot makes no claim about work that is over", [
      /background task\$\{retained === 1/.test(eventListSrc),
      /foot\?\.line \?\? null/.test(eventListSrc),
    ], [false, true]);
    /*
     * ⭐ **Three empty states, driven as a total partition — and the third arm is a
     * defect this pair was green over.**
     *
     * `No tasks currently running` is Claude Code's sentence and it is a *claim*:
     * true for claude, false for the other three, which is why it was gated on the
     * agent having said it would tell us. What the boolean could not say is that
     * `reportsBackgroundTasks: false` is **two** facts. The daemon's own docblock
     * calls it *"nobody asked"*, and `doStop` sets it — which a daemon restart
     * reaches for every session. So with no agent attached the panel asserted
     * *"This agent doesn't report background work"* about claude, which does. An
     * absent answer drawn as a negative one, reported from a screenshot.
     *
     * ⚠ **Driven rather than read, because the old pair was a *shape* check.** It
     * sliced 200 characters before the claim and looked for a `reports ?` in them.
     * Every arm can be wrong with that shape intact, and the missing arm was not
     * expressible in it at all. Now the function is called.
     *
     * ⚠ **And the slice is gone with it.** `indexOf` answering -1 feeds
     * `slice(-201, -1)`, which hands back the last 200 bytes of the file rather
     * than nothing — so deleting the sentence would have turned this green over a
     * message about something else entirely.
     */
    const { BACKGROUND_EMPTY, backgroundReporting } = await import("../src/tasks.js");
    const snap = (status: string, reports: boolean | undefined): never =>
      ({ status, reportsBackgroundTasks: reports }) as never;
    check("an agent that reports is the only one an empty list is an answer about", backgroundReporting(snap("idle", true)), "reports");
    check("one that does not is a different fact", backgroundReporting(snap("running", false)), "silent");
    check("a restarted daemon has no agent to have asked", backgroundReporting(snap("interrupted", false)), "unasked");
    check("nor does a parked one, whatever the flag says", backgroundReporting(snap("parked", true)), "unasked");
    /*
     * ⚠ **`stopping` is excluded from `hasLiveAgent` on a measured argument** —
     * `doStop` fans a snapshot out both before and after it empties the agent's
     * state, so a frame can legitimately read `stopping` with nothing on it.
     * Inheriting that is the whole reason this reuses the predicate rather than
     * testing `isTerminal` itself.
     */
    check("and an agent being torn down is not one that can be asked", backgroundReporting(snap("stopping", true)), "unasked");
    check("a row that has not arrived lands in the same arm as no agent", backgroundReporting(null), "unasked");
    /*
     * The sentences, as a total partition: every arm has one, no two are the same,
     * and only the arm that earned it makes the claim.
     */
    const arms = ["reports", "silent", "unasked"] as const;
    check("every arm has a sentence, and no two share one", new Set(arms.map((arm) => BACKGROUND_EMPTY[arm])).size, arms.length);
    check("only the answerable arm says nothing is running", arms.filter((arm) => BACKGROUND_EMPTY[arm] === "No tasks currently running"), ["reports"]);
    check(
      "the silent arm says what it cannot know rather than that nothing is running",
      /doesn't report background work/.test(BACKGROUND_EMPTY.silent),
      true,
    );
    /*
     * ⚠ **And the unasked arm may not describe an agent at all**, which is the
     * whole of what was wrong: it is reached with no agent *and* with no row, so
     * any sentence about what "this agent" does is a claim about something nothing
     * has heard from.
     */
    check("and the unasked arm makes no claim about any agent", /this agent|the agent/i.test(BACKGROUND_EMPTY.unasked), false);
    check("while saying where the record went, which is what somebody there is asking", /restart/.test(BACKGROUND_EMPTY.unasked), true);
    check("and the panel draws the table rather than a shape of its own", /BACKGROUND_EMPTY\[reporting\]/.test(panelSrc), true);
    /*
     * ⚠ **The spoken half says "not connected" rather than "reconnecting", and the
     * change of word is the fix rather than a rewording.** This arm is reached with
     * no socket at all and with one still opening for the first time, where nothing
     * is reconnecting to anything — see the caller pair below.
     */
    check("and it never claims a reconnection it cannot know about", footSays(true, 0, null, true)?.spoken.includes("reconnect"), false);
    /* A turn that has ended is not frozen: `stale` only ever bites `working`. */
    check("a stale session with work outstanding reads exactly as a live one", footSays(false, 2, null, true), {
      line: "waiting for 2 tasks",
      spoken: "waiting for 2 tasks",
    });
    check("and one with nothing outstanding still says nothing at all", footSays(false, 0, null, true), null);

    /*
     * The whole space, because the two new arguments doubled it twice and the rules
     * above are stated over four of the sixteen cells. Collected rather than
     * printed, `draftAct`'s rule: a sweep whose output nobody reads is a sweep whose
     * failure nobody sees.
     */
    const footCells = [false, true].flatMap((working) =>
      [0, 2].flatMap((tasks) =>
        [null, "3m"].flatMap((elapsed) =>
          [false, true].map((stale) => ({ working, tasks, stale, said: footSays(working, tasks, elapsed, stale) })),
        ),
      ),
    );
    check("the sweep is the whole space", footCells.length, 16);
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

    /*
     * ⚠ **The caller, and this half is the one that matters: a pure-function check
     * cannot catch the bug that shipped.** `footSays` was already correct for its
     * argument — the defect was the *predicate at the call site*, which asked
     * `phase === "waiting"` and so answered `false` for the whole of every retry.
     * `retryLater` sets `waiting`, arms a timer, and that timer calls `connect()`,
     * which sets `connecting` before it has so much as a token; nothing in
     * `stream.ts` bounds a handshake. So the phase loops `waiting → connecting →
     * waiting` for as long as the network is down and the foot went back to
     * blinking `working…` for the whole of each attempt, with the elapsed number
     * reappearing several seconds larger than when it left.
     *
     * ⚠ **`!== "live"` rather than a list of the bad phases**, which is the part a
     * later edit is most likely to undo: `StreamPhase` has five members and
     * enumerating four of them is what breaks silently when a sixth arrives. And
     * `stream === null` is a real state rather than a theoretical one —
     * `primeBlocked` builds a transcript straight off the list poll, so a foot with
     * nothing behind it asserted work outright.
     */
    const foot = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
    check(
      "the foot asks whether anything is streaming at all, by the property rather than by a list",
      /const stale = stream === null \|\| stream\.phase !== "live";/.test(foot),
      true,
    );
    /*
     * ⚠ **And the banner keeps the narrow question, which is why these are two
     * constants.** The banner asks *should I announce this*: `connecting` is the
     * first attempt and the ordinary state of a session opening, so announcing a
     * reconnection there would put a banner on every navigation. The foot asks *is
     * what I am drawing still checkable*, and an announcement can afford to wait
     * until it is sure while a claim about **now** cannot. Merging them is the
     * regression in either direction, so the second half asserts the banner's
     * answer never reaches the transcript.
     */
    check("while the banner keeps the narrower one", /const reconnecting = stream\?\.phase === "waiting";/.test(foot), true);
    check(
      "and they are two answers rather than one handed to both",
      [/reconnecting=/.test(foot), (foot.match(/stale=\{stale\}/g) ?? []).length, /\{reconnecting && \(/.test(foot)],
      [false, 2, true],
    );
    /*
     * The transcript's own end of the same wire: the fourth argument reaches
     * `footSays`, and the mark stops blinking in **both** of `WaitingFoot`'s arms —
     * the bare `<p>` and the disclosure button. Anchored inside the function,
     * because the cancelled-turn row draws a third, unrelated `WorkingMark still`
     * and a file-wide count would be satisfied by either arm plus that one.
     */
    const footSrc = stripComments(readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8"));
    const waitingFootAt = footSrc.indexOf("function WaitingFoot");
    const waitingFoot = waitingFootAt < 0 ? "" : footSrc.slice(waitingFootAt, footSrc.indexOf("\n}\n", waitingFootAt));
    check("the foot's own component was found", waitingFootAt >= 0, true);
    /*
     * ⚠ **It was "all four arguments" and it is five now, which is the point of
     * pinning the call rather than the signature.** `footSays` gives both of the
     * newest two a default, so a caller that stops passing one compiles clean and
     * silently reverts this line to what it said before the argument existed —
     * which is how the elapsed time and the frozen tense shipped unasserted in the
     * first place. The fifth is the background set, and dropping it would leave
     * the foot counting delegations alone on a session whose only outstanding work
     * is a build.
     */
    check(
      "the caller threads all five arguments, and both of its arms stop the mark",
      [
        /footSays\(working, tasks\.length, elapsedSays\(turnElapsedMs\), stale, background\)/.test(footSrc),
        (waitingFoot.match(/WorkingMark still=\{stale\}/g) ?? []).length,
      ],
      [true, 2],
    );

    /*
     * ⚠ **`elapsedSays`, which had zero occurrences in this file.** It is not
     * exported — a module-private helper between the prop and `footSays` — so this
     * is the weaker source form, and it is worth having because both of its rules
     * are silent when broken. The floor is a *judgement*: under two minutes the
     * number is noise on a line that already says `working…`, and `null` means both
     * "no turn" and "not long enough", so a caller cannot draw a number this rule
     * says not to draw. The floor doubles as the guard on a negative — our own clock
     * moving backwards between two renders — which is why the comparison is `<`
     * against the elapsed value rather than a `Math.max` anywhere.
     */
    check(
      "the elapsed time is floored in one place, and the floor is a judgement rather than a unit",
      [
        /const ELAPSED_FLOOR_MS = 120_000;/.test(footSrc),
        /return turnElapsedMs < ELAPSED_FLOOR_MS \? null : shortDuration\(turnElapsedMs\);/.test(footSrc),
        /if \(turnElapsedMs === null\) return null;/.test(footSrc),
      ],
      [true, true, true],
    );
    /*
     * ⚠ **And the milliseconds arrive *measured*, which is the other half of the
     * clock pair asserted at the top of this file.** `EventList` was handed
     * `turnStartedAt` — the daemon's stamp — and subtracted `Date.now()` from it, so
     * a phone that drifted while it slept read a turn that started a minute ago as
     * hours long, or printed nothing at all on one running since breakfast.
     * `elapsedSince` is the single copy of the correct form and it takes the **row**
     * rather than the snapshot, which is why `SessionView` keeps the row at all.
     */
    check(
      "and they are measured against the row's two clocks rather than against ours",
      [
        /const turnElapsedMs = row === null \|\| turnStartedAt === null \? null : elapsedSince\(row, turnStartedAt\);/.test(foot),
        /Date\.now\(\) - turnStartedAt/.test(foot + footSrc),
      ],
      [true, false],
    );
  }

  {
    // A subagent spawned before a `/clear` and still running after it: the parent
    // card is below the cut, so its steps have nothing to nest under and stay
    // where they are. Revealing what is above re-collects them on the next render,
    // so the degradation is temporary by construction.
    seq = 0;
    const events = [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")];
    const tail = buildTail(events, [], 2);
    check("a parent below the cut leaves its children where they were", drawn(tail.rows), ["e2", "e3"]);
    check("and says how many events are below it", tail.hidden, 1);
  }

  {
    // Unbounded indent on a 390px screen is not a thing to discover in
    // production. Claude cannot reach this today; see MAX_DEPTH.
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
    // Without the cap a long subagent eats the whole render budget before the
    // walk reaches its parent, and the card naming the work is what disappears.
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
    // Identity, not arity. Asserting only the length passes whichever end the cap
    // keeps, and it did: `placeNodes` runs forwards over `collected.reverse()`, so
    // the naive `if (full) skip` kept `step 0`…`step 39` under a label saying the
    // opposite, with `omitted` counting the twelve newest.
    check(
      "only the newest forty steps are kept",
      [task.children[0]?.title, task.children.at(-1)?.title],
      ["step 12", "step 51"],
    );
    check("the count still says how many there were", task.steps, MAX_CHILDREN + 12);
    check("and how many are not shown", task.omitted, 12);
    // The second symptom of the same bug, and the one a person sees: the running
    // header reads `latest`, so keeping the oldest froze it at step 39 for the
    // whole remaining life of every long subagent.
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
    /*
     * The flag survives to the node, and an update never takes it away.
     *
     * Measured 2026-08-01: claude stamps `subagent: true` on the spawn and drops
     * it from that same call's *completing* update. Folded last-wins, the icon
     * would go from robot to brain at the end of every subagent — so the flag is
     * read from the `tool_call` only, and this is what says so. The other half of
     * the same defect is what prompted it: a spawn whose delegate made no tool
     * call has no children, and rendered as a `think` card.
     */
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
    // Kimi filters subagent events at the source, so no call ever has a child.
    // A UI that grew an empty affordance there would advertise a feature that
    // agent does not have. This is the assertion that guards the whole feature.
    seq = 0;
    const flat = buildTail([toolCall("a", "grep"), toolCall("b", "read"), toolCall("c", "bash")], []);
    check("with no parent link anywhere, the tail is exactly what it was", drawn(flat.rows), ["e1", "e2", "e3"]);
    check(
      "and nothing claims a child",
      flat.rows.flatMap((r) => (r.kind === "group" ? r.children : [r])).every((r) => (r as { children?: unknown[] }).children?.length === 0),
      true,
    );
  }

  /*
   * `placeNodes`' precondition, stated by its own docstring and until now only
   * ever reached through `buildTail`.
   *
   * It takes document order and does not sort — "asserted rather than defended
   * with a sort" is the claim, and this is the assertion. Handed a child before
   * its parent, it must leave that child at the top level rather than quietly
   * repairing the order, because repairing it here would hide a `buildTail` that
   * had stopped reversing.
   */
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

  /*
   * A lineage an agent should not have sent.
   *
   * `parentToolCallId` is verbatim agent-chosen `_meta` and the daemon normalizes
   * only self-reference, so these are inputs a client will be handed rather than
   * inputs it can rule out. Both cases below ran forever before the visited sets
   * went in — inside `EventList`'s `useMemo`, so an unrecoverable tab, and one
   * that came back on every reload because the events are on disk.
   *
   * These assertions can only fail by hanging, which is worth stating: a
   * regression here does not print `FAIL`, it stops `pnpm webcheck` dead.
   */
  {
    seq = 0;
    const cycle = buildTail([toolCall("a", "alpha", "b"), toolCall("b", "beta", "a")], []);
    check("two calls that parent each other still terminate", cycle.rows.length, 1);

    seq = 0;
    // The other half: `byId.set` rebinding an id mid-pass is what let two live
    // entries point at each other while both sat at the clamp's exit depth.
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

  /*
   * The failed-update paths, in both directions.
   *
   * `nodeFor` builds an `UpdateNode` only for a *failed* update, so every case
   * above using `done()` leaves `placeNodes`' fold branch untouched — the whole
   * `update` node type was uncovered in both directions until here.
   */
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
    // The orphan: a step that failed after a `/clear`, whose own `tool_call` is
    // below the cut. This row is the only thing saying something broke up there.
    // Cut at 3 and not 2 — at 2 the failing call itself is still collected, so the
    // fold above is what fires and the standalone row is correctly suppressed.
    // Only when the `tool_call` is genuinely out of reach does this row exist.
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

  /*
   * How long it took, and which event's clock said so.
   *
   * Timing from the newest update read the clock of an event that said nothing —
   * the five-events table has two whose every field is null — so a duration grew
   * with traffic rather than with the call, and widening the window with "show
   * more" changed a *finished* call's number.
   */
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

  /*
   * A reused id does not let two calls claim one update.
   *
   * The `updates` map is keyed by `toolCallId` alone, so without consume-and-
   * delete *every* call answering to that id merged the same list and the two
   * cards drew identical titles, status and output. The walk is backwards, so
   * the claimant is the nearest call preceding the update, which is the only
   * defensible owner.
   */
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

  /* ---------------------------------------------------------------- *
   * The memo comparator
   *
   * `buildTail` builds fresh node objects every time it runs, and it runs on every
   * streamed token — so `React.memo`'s own shallow compare, which asks whether the
   * `node` prop is the same object, answers "no" for every row every time. That is
   * what `sameNode` replaces, and it is the whole reason drawing an unbounded
   * transcript is affordable: an appended event should re-render the row it
   * appended, not the fifteen hundred above it.
   *
   * Both directions matter and they fail differently. Answering `false` when
   * nothing changed is merely slow — the old behaviour, restored. Answering `true`
   * when something *did* change leaves a stale row on screen for ever, with
   * nothing anywhere to say so, which is exactly the class of defect a driver with
   * no DOM can still catch.
   * ---------------------------------------------------------------- */
  {
    const txt = (text: string): never =>
      ev({ type: "text", role: "agent", thought: false, text });

    // The tool call *first*, so a chunk arriving after it does not renumber it —
    // which is what an appended event actually looks like. Ordered the other way
    // this fixture would report the card as changed for the trivial reason that
    // its seq moved, and would be asserting nothing about the comparator.
    seq = 0;
    const before = buildTail([toolCall("t", "grep"), txt("hel")], []);
    seq = 0;
    const same = buildTail([toolCall("t", "grep"), txt("hel")], []);
    check(
      "two builds over the same events compare equal, node for node",
      before.rows.every((node, i) => sameNode(node, same.rows[i]!)),
      true,
    );
    // Which is the point: the objects themselves are new every time, so the
    // default shallow compare would have skipped nothing at all.
    check("even though none of them is the same object", before.rows[0] === same.rows[0], false);

    seq = 0;
    const grown = buildTail([toolCall("t", "grep"), txt("hel"), txt("lo")], []);
    // A streamed chunk extends the run it belongs to, so that row must re-render
    // and the card above it must not.
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

    // Children are compared too, or a subagent's card would freeze at whatever its
    // steps looked like the first time it was drawn — the one place a stale row
    // would be least visible, since the card is collapsed.
    seq = 0;
    const oneStep = buildTail([toolCall("task", "Explore"), toolCall("c1", "grep", "task")], []);
    seq = 0;
    const twoSteps = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")],
      [],
    );
    check("a subagent that gained a step is not equal", sameNode(oneStep.rows[0]!, twoSteps.rows[0]!), false);

    /*
     * ⚠ **A settled question's row carries a derived *array*, and that is exactly
     * where reference equality would have quietly cost the whole optimisation.**
     * `EventNode.asked` is rebuilt by `buildTail` on every streamed token, so
     * `a.asked === b.asked` is false forever and this one row would re-render on
     * every token of every reply after it — the failure `sameNode` exists to
     * prevent, reintroduced by the field added to fix a different one. Compared by
     * value instead, and driven here rather than trusted.
     */
    seq = 0;
    const askEvents = () => [
      toolCall("tq", "Asking for your input"),
      { seq: (seq += 1), ts: seq, event: { type: "tool_call_update", toolCallId: "tq", title: null, status: null, locations: [], rawInput: { questions: [{ question: "Which one?", options: [{ label: "This one" }, { label: "The other" }] }] }, content: null, images: null, parentToolCallId: null } },
      { seq: (seq += 1), ts: seq, event: { type: "elicitation_request", elicitationId: "eq", toolCallId: "tq", message: "Please answer the following questions." } },
      { seq: (seq += 1), ts: seq, event: { type: "elicitation_resolved", elicitationId: "eq", toolCallId: "tq", message: "Please answer the following questions.", action: "accept", by: "client", answers: [{ key: "question_0", label: "Pick", value: "This one" }] } },
    ];
    // ⚠ **The same array twice**, because `sameNode`'s event arm compares
    // `stored` by identity and the real client holds stable event objects across
    // rebuilds. Two fresh fixtures would answer `false` for that reason alone and
    // would be asserting nothing about `asked`.
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

/* ------------------------------------------------------------------ *
 * A turn's worth of machinery, as one line
 *
 * The transcript's question is *does anything anywhere need me*, and a run of tool
 * calls is not an answer to it. Measured across every session on the development
 * machine, by running `foldRuns` itself rather than estimating over raw events: **16
 * runs, 9 of them a single call, 7 folded** (sizes 2,3,3,3,3,4,11), taking 111 drawn
 * rows to 89. So what folding saves is height rather than rows — a card is several
 * rows tall per call — and what it must never save height on is a decision somebody
 * made.
 * ------------------------------------------------------------------ */

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
  // Read out of the union rather than cast to `never` like the *inputs* in this file:
  // these assertions read fields off a group, so the type has to survive.
  type Group = Extract<BuiltRows[number], { kind: "group" }>;
  const group = (rows: BuiltRows, at = 0): Group => rows[at] as Group;

  {
    /*
     * Two calls between two messages are one row, and the messages either side are
     * untouched — the `flush()` boundaries `buildTail` puts around a `tool_call` are
     * what separated them before folding existed, and folding runs after all of that
     * on the finished rows.
     */
    seq = 0;
    const tail = buildTail([say("before"), toolCall("a", "grep"), toolCall("b", "ls"), say("after")], []);
    check("a run of two is one row between the two messages", keys(tail.rows), ["t1", "r2", "t4"]);
    check("holding both calls, with their own keys", drawn(tail.rows), ["t1", "e2", "e3", "t4"]);
  }

  {
    /*
     * ⭐ **A run of one is never wrapped**, which is what keeps a lone tool call
     * splitting a message into `before`/`[tool]`/`after` exactly as it did. 9 of the
     * 16 runs measured are single calls, so a wrapper there would add a disclosure
     * whose body is one row — the same "worse than no disclosure" `opensToAnything`
     * refuses one level down.
     */
    seq = 0;
    const tail = buildTail([say("before "), toolCall("a", "grep"), say("after")], []);
    check("a single call is left as it was", keys(tail.rows), ["t1", "e2", "t3"]);
  }

  {
    /*
     * ⭐ **The rule this feature must not break, and the shape of it was reversed
     * once.**
     *
     * The first version was "no permission ever folds", and it cost more than it
     * bought: measured on a real codex session, one approval in the middle of four
     * calls split them into a group, a bare row and a lone card — because a run of one
     * is never wrapped. So an **approval** folds in, in document order, and the
     * collapsed row counts it; a **refusal** never does, because that row is the only
     * record that somebody said no.
     *
     * The verdict comes from `permissionDecisions`, never from `outcome`, and these
     * fixtures carry the `permission_request` for that reason: `outcome: "selected"`
     * means an option was chosen and every `reject_*` option produces it too.
     */
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
    // In document order, where it happened — the request row is merged away by the
    // answer, as it always was, so three children rather than four.
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

    /*
     * The two ways the verdict can be unknown, and both fall through to "not
     * foldable" — so the failure mode is a visible row rather than a hidden refusal.
     * The second is what a driver calling `buildTail` with three arguments gets.
     */
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

    /*
     * A run of approvals and nothing else is not a run: there is no work for them to
     * be folded into, and a group there would draw a sentence with no clause in it.
     */
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
    // Every other row that is not machinery breaks a run for the same reason: it is
    // something a person reads, not a step the agent took.
    seq = 0;
    const plan = buildTail([toolCall("a", "grep"), ev({ type: "plan", entries: [] }), toolCall("b", "ls")], []);
    check("a plan breaks a run", keys(plan.rows), ["e1", "e2", "e3"]);

    /*
     * **And the surviving one of a collapsed pair still breaks it**, which is the
     * sibling of the assertion above and the one that fails if somebody ever
     * "fixes" the duplicate checklist by making a plan foldable. It would collapse
     * two plans for free — and let a run of tool calls swallow the whole plan.
     */
    seq = 0;
    const foldedPlans = buildTail(
      [toolCall("a", "grep"), ev({ type: "plan", entries: [] }), ev({ type: "plan", entries: [] }), toolCall("b", "ls")],
      [],
    );
    check("and the survivor of a collapsed pair still breaks it", keys(foldedPlans.rows), ["e1", "e3", "e4"]);
  }

  /* ---- one TodoWrite is many plan events, and one checklist ---- */

  /*
   * **Measured: one `TodoWrite` emits a `plan` per streaming refinement — nine
   * events for a three-item list — each a full replacement.** So the transcript
   * drew the same checklist nine times in a row, and a screenshot of three
   * identical tables stacked on top of each other is what this collapses.
   *
   * "Consecutive" is defined over **emitted nodes**, which is the only definition
   * that means what a reader sees. Over raw events, a codex `session_info_update`
   * — about five a turn, and invisible — would save a stale card. Over *drawable*
   * events it would too, since `showsInTranscript` answers true for things
   * `nodeFor` then merges away.
   */
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

    // A plan is the *first* thing in the transcript: the `-1` sentinel rather
    // than `0`, since `collected.length` is 0 before anything has been drawn.
    seq = 0;
    check("a transcript that opens with a plan still draws it", keys(buildTail([plan(1)], []).rows), ["e1"]);

    /*
     * What separates two plans is anything the reader can see. Real work between
     * them is a history worth keeping, and the card stays where it happened.
     */
    seq = 0;
    check(
      "work between two plans keeps both",
      keys(buildTail([plan(1), toolCall("a", "grep"), plan(2)], []).rows),
      ["e1", "e2", "e3"],
    );
    seq = 0;
    check("and so does a message", keys(buildTail([plan(1), say("done"), plan(2)], []).rows), ["e1", "t2", "e3"]);

    // ...and what does not separate them is anything invisible.
    seq = 0;
    check("a thought does not save a stale checklist", keys(buildTail([plan(1), thought("hm"), plan(2)], []).rows), ["e3"]);
    seq = 0;
    check("nor does an event nobody draws", keys(buildTail([plan(1), silent(), silent(), plan(2)], []).rows), ["e4"]);

    /*
     * The cut is a wall in both directions and needs no clause of its own: the
     * walk `break`s below it, so a plan on the far side is never reached and can
     * neither suppress nor be suppressed.
     */
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
    /*
     * A subagent is not folded: its card is already a summary of N steps with its own
     * tree inside, so putting it behind a sentence about it would hide the one row in
     * the transcript that says a delegation happened.
     */
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
    /*
     * What a folded run knows about itself. Neither fact opens it any more — see the
     * source-text assertion below — but both are still drawn on the collapsed row,
     * which is where they have to be correct.
     *
     * `live` inks the hollow pulse and `failed` the count, and they are computed the
     * same way they always were: `live` is a disjunction over the run's tool children,
     * `failed` a tally of them.
     */
    seq = 0;
    const live = buildTail([toolCall("a", "grep", "other", "completed"), toolCall("b", "ls", "other", "in_progress")], []);
    check("a run with something still running is live", [group(live.rows).live, group(live.rows).failed], [true, 0]);
    seq = 0;
    const broke = buildTail([toolCall("a", "grep"), toolCall("b", "ls", "other", "failed")], []);
    check("and one that failed says how many", [group(broke.rows).live, group(broke.rows).failed], [false, 1]);
    seq = 0;
    const settled = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    check("a finished run is neither", [group(settled.rows).live, group(settled.rows).failed], [false, 0]);

    /*
     * ⭐ **Nothing opens a folded run but a tap, and this is a source-text assertion
     * because the rule is one line of JSX.**
     *
     * Two facts have been tried in that slot and both were reported as bugs, which is
     * why the assertion is now on the constant rather than on whichever fact is
     * currently allowed. `failed > 0` came first: `override` is component state and
     * dies on reload while a failure is permanent, so a group somebody deliberately
     * collapsed came back open on every refresh for ever. `node.live` replaced it and
     * failed the other way — the newest run drew expanded until the agent stopped
     * calling tools, so the machinery a reader had folded away unfolded itself on
     * every turn, and the row whose height nobody chose was the one at the foot of
     * the page.
     *
     * Pinned on the derived expression itself rather than on a rendering, since
     * `webcheck` has no DOM.
     */
    const footSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const derived = /const open = override \?\? ([^;]+);/.exec(footSrc)?.[1] ?? "(not found)";
    check("a folded run starts collapsed, whatever it is doing", derived, "false");

    /*
     * And the other half of that change, which is what keeps `live` from becoming a
     * field three assertions above describe and nothing renders — the `sessionOf`
     * failure, in the direction this repo names it for. It is spent on the collapsed
     * row's pulse now; if that goes, those three assertions go with it.
     */
    check("and liveness still inks the row it no longer opens", /node\.live/.test(footSrc), true);
  }

  {
    /*
     * The sentence, which is mechanical for a measured reason: the words a model
     * writes about its own work reach us as `rawInput.description`, on 13 of 1132
     * updates in the log — practically every claude `Bash` call and not one edit. Two
     * grammars in one transcript, differing by agent, is worse than one that is
     * always the same.
     *
     * Built from ACP's `kind` and never from a title or an id, which is the rule the
     * rest of this client follows for every control it draws.
     */
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
    // The clauses are in the order their kind first appeared, and the counts are what
    // the row draws `+N −M` from — the events themselves, so there is one source for
    // them and it is the one the card rows use.
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
    // Counted per **file**, not per call: the clause names a file, so the number
    // beside it has to be a number of files or a `MultiEdit` reads as one change.
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

    /*
     * ⭐ **Both of these were found by running the grammar over the real log**, and
     * neither is symmetry for its own sake.
     *
     * `ToolSearch` arrives as `kind: "other"` with `rawInput.query =
     * "select:AskUserQuestion"`, and naming an unknown kind by its *summary* put that
     * string straight into a sentence: "Ran 2 commands, select:AskUserQuestion". An
     * argument is not a name — for a kind nobody here knows, the only thing that reads
     * as one is what the agent called the tool.
     *
     * And a nameless single call produced **"used 1 tools"**, which reads as a broken
     * product rather than a missing plural.
     */
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

    /*
     * ⭐ **Every clause needs three arms, and four of them shipped with two.**
     *
     * `used 1 tools` was caught by running the grammar over the log; the same shape
     * survived in `create`, `edit`, `read` and `search`, where `count === 1` with a
     * name too long to draw fell through to the plural. For **search** that is the
     * ordinary case rather than an edge one: the query measured in the log is
     * `'context window|context size|tokens|token limit|1m|1,000,000'`, well past
     * `CLAUSE_NAME_CHARS`, so a real session said "ran 1 searches".
     */
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
    /*
     * ⭐ **A change is drawn by the card that made it, and the second copy of it is
     * dropped.**
     *
     * Measured against kimi (Q6.12): one edit produces two `file_change` events —
     * `source: "diff"` carrying the tool call's id, then `source: "fs_write"` with
     * `toolCallId: null`. The first is folded into the card. The second has no call to
     * fold into and would stand underneath it as the same edit again.
     *
     * ⚠ **The two halves do not carry the same text, and a fixture that fed them the
     * same text passed while the product was broken.** The `diff` copy is the
     * *fragment* the model typed (Q7.29: `"two"` → `"TWO CHANGED"`), while
     * `onWriteTextFile` reads the file and sends the **whole** of it either side. So
     * the match is on the path — a content signature could never fire, and with a
     * diff drawn from each the result was worse than the two bare paths this
     * replaced: one edit reported twice with two different `+N −M`. The fixture below
     * is kimi's real shape for that reason.
     */
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

    /*
     * One credit per absorbed edit, not "this path is dealt with for ever". A second
     * write to a file edited earlier is a different act, and its row is the only
     * trace of it.
     */
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
    // Through `drawn`, because the card and the surviving change are both machinery
    // and therefore fold together — which is the point being made two sections up.
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

    // A change whose call is outside the window keeps its own row — that row is the
    // only thing saying the file was touched at all.
    seq = 0;
    const orphan = buildTail([changed("/w/a.txt", null, "hello", "gone")], []);
    check("a change with no call on screen stands alone", keys(orphan.rows), ["c1"]);
  }

  {
    /*
     * The comparator, in both directions, for the two node kinds this change added.
     * A `sameNode` that wrongly answers `true` leaves a stale row on screen for ever
     * with nothing anywhere to say so — which is why it is exported at all.
     */
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

    /*
     * A change compares by the **identity of the event that produced it**, which is
     * the same rule an `event` node has and rests on the same fact: a `StoredEvent`
     * is never mutated, so two rebuilds over one log see the same object — and the
     * diff drawn from it is memoised against that identity too. So this is driven
     * over one array twice, which is what `buildTail` actually does on every token;
     * two equivalent-but-separate fixtures would be asserting a field-by-field
     * comparison that deliberately is not there.
     */
    seq = 0;
    const log = [changed("/w/a.txt", null, "hello", "gone")];
    check("two builds of one change compare equal", sameNode(buildTail(log, []).rows[0]!, buildTail(log, []).rows[0]!), true);
    seq = 0;
    const other = buildTail([changed("/w/a.txt", null, "goodbye", "gone")], []);
    check("and a different one does not", sameNode(buildTail(log, []).rows[0]!, other.rows[0]!), false);
  }

  {
    /*
     * ⭐ **A permission codex did not name, named.**
     *
     * Measured 2026-08-13 in the log (`s_d43bae82`): codex sends a permission with no
     * title, so the daemon's `title = toolCall.title ?? toolCallId` falls through to
     * the id and the transcript's only record of an approval read
     * `✓ exec-55382d16-8647-4b5e-a87c-32c95b8ed2e8`. `permissionHeadline` rescues the
     * *card*; nothing rescued the row.
     *
     * The join is on the id the agent itself supplied, and the trigger is the exact
     * equality the daemon's fallback leaves behind — it names no vendor and no
     * pattern. Resolved after the walk, because a permission is met **before** the
     * `tool_call` that names it.
     */
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

    // And a title worth keeping is kept — which is every claude and kimi permission.
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

    /*
     * The naming can only borrow a *name*. A call the agent also failed to name
     * carries its own id as its title, and lending that to the permission would
     * swap one uuid for the same uuid while claiming it had been resolved.
     */
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
    // `foldRuns` is pure and exported, so the shape can be driven without a log at
    // all — which is what lets the empty and single-row cases be stated.
    check("nothing folds to nothing", foldRuns([]), []);
    check(
      "and a row that is not machinery is passed straight through",
      keys(foldRuns([{ kind: "gap", key: "g1", seq: 1, parentId: null, gap: { from: 1, to: 2, reason: "evicted" } } as never])),
      ["g1"],
    );
  }
}
