import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
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
    const listSrc = stripComments(readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8"));
    const waitingFootAt = listSrc.indexOf("function WaitingFoot");
    const waitingFoot = waitingFootAt < 0 ? "" : listSrc.slice(waitingFootAt, listSrc.indexOf("\n}\n", waitingFootAt));
    check("the foot's own component was found", waitingFootAt >= 0, true);
    check(
      "the caller threads all four arguments, and both of its arms stop the mark",
      [
        /footSays\(working, tasks\.length, elapsedSays\(turnElapsedMs\), stale\)/.test(listSrc),
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
        /const ELAPSED_FLOOR_MS = 120_000;/.test(listSrc),
        /return turnElapsedMs < ELAPSED_FLOOR_MS \? null : shortDuration\(turnElapsedMs\);/.test(listSrc),
        /if \(turnElapsedMs === null\) return null;/.test(listSrc),
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
        /Date\.now\(\) - turnStartedAt/.test(foot + listSrc),
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
    const listSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const derived = /const open = override \?\? ([^;]+);/.exec(listSrc)?.[1] ?? "(not found)";
    check("a folded run starts collapsed, whatever it is doing", derived, "false");

    /*
     * And the other half of that change, which is what keeps `live` from becoming a
     * field three assertions above describe and nothing renders — the `sessionOf`
     * failure, in the direction this repo names it for. It is spent on the collapsed
     * row's pulse now; if that goes, those three assertions go with it.
     */
    check("and liveness still inks the row it no longer opens", /node\.live/.test(listSrc), true);
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
