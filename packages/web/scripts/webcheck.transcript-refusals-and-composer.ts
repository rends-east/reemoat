import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import {
  TRANSCRIPT_SILENT,
  buildTail,
  canCancelTurn,
  cancelInFlight,
  composerPlaceholder,
  focusWorthKeeping,
  formatLocation,
  isTerminal,
  machineSubline,
  markKeyNav,
  permissionDecisions,
  refused,
  shouldFocusComposer,
  shouldReleaseComposer,
  showsInTranscript,
  showsWorking,
  stripFence,
  sublineWarns,
  takeKeyNav,
  toolSummary,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * What the transcript refuses to draw
 *
 * Every type below had **no fixture at all** before this block existed, which is
 * why the rules were extracted into `showsInTranscript` rather than left as arms
 * of a `switch` nothing could reach.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the transcript refuses to draw\n");
{
  let seq = 0;
  const ev = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const prompt = (text: string): never => ev({ type: "prompt", text, attachments: [] });
  const status = (value: string): never => ev({ type: "status", status: value, exit: null });
  const workspace = (...warnings: { code: string; message: string }[]): never =>
    ev({
      type: "workspace",
      mode: "worktree",
      root: "/w",
      requestedCwd: "/p",
      branch: "b",
      baseCommit: "c",
      plainReason: null,
      warnings,
    });
  const turnEnd = (stopReason: string): never => ev({ type: "turn_end", stopReason, usage: null });
  const asked = (permissionId: string | null): never =>
    ev({
      type: "permission_request",
      permissionId,
      toolCallId: null,
      title: "run rm -rf",
      options: [],
      decision: null,
    });
  const answered = (permissionId: string): never =>
    ev({
      type: "permission_resolved",
      permissionId,
      toolCallId: null,
      title: "run rm -rf",
      outcome: "selected",
      optionId: "allow",
      by: "client",
    });

  const drawn = (event: Record<string, unknown>): boolean => showsInTranscript(event as never);

  check(
    "chrome that is always on screen draws no row",
    ["status", "workspace", "agent_config", "session_started", "agent_log", "other"].map((type) =>
      drawn({ type }),
    ),
    [false, false, false, false, false, false],
  );
  check(
    "and everything somebody came to read still does",
    [
      "prompt",
      "file_change",
      // Answers `true` from the event alone; whether it is *merged away* is
      // `nodeFor`'s separate question, driven four cases below. Listed so the
      // three groups here cover all seventeen `SessionEvent` members rather
      // than sixteen, which is what makes the union claim below literal.
      "permission_request",
      "permission_resolved",
      "plan",
      "context_cleared",
      "error",
    ].map((type) => drawn({ type })),
    [true, true, true, true, true, true, true],
  );
  // The divider that landed after every single agent reply, saying only that the
  // paragraph you had just finished reading had finished.
  check("an ordinary turn ending is not news", drawn({ type: "turn_end", stopReason: "end_turn" }), false);
  check(
    "but a turn that did not finish is",
    ["max_tokens", "refusal", "cancelled"].map((reason) => drawn({ type: "turn_end", stopReason: reason })),
    [true, true, true],
  );
  /*
   * ⭐ The **second** reason with no row, and silent for the opposite argument to
   * `end_turn`'s. The daemon writes `agent_error` for a turn that ended in an
   * `error` — it had written nothing at all, so four prompts produced three ends —
   * and the row immediately above it is that error, in the agent's own words. A
   * line under it saying the turn ended states one fact twice, the second time
   * worse. What it must still do is cut `taskFloor`, asserted beside it.
   */
  check(
    "and a turn the agent rejected is not, because the error above it already said so",
    drawn({ type: "turn_end", stopReason: "agent_error" }),
    false,
  );
  // Handled by their own node kinds long before this is reached; answered honestly
  // anyway, so this reads as a statement about the union rather than the leftovers.
  check(
    "the three with their own node kinds are not silent",
    ["text", "tool_call", "tool_call_update"].map((type) => drawn({ type })),
    [true, true, true],
  );

  /*
   * Driven through `buildTail` as well as through the predicate, because a
   * predicate passing while nothing actually changed is the failure this file
   * already records elsewhere.
   */
  {
    seq = 0;
    const tail = buildTail([status("idle"), workspace(), prompt("hello"), turnEnd("end_turn")], []);
    check("only the prompt survives a turn's worth of chrome", tail.rows.map((r) => r.key), ["e3"]);
  }

  {
    seq = 0;
    const tail = buildTail([status("starting"), status("idle"), prompt("a"), prompt("b")], [], 3);
    check("a suppressed event draws no row above the cut either", tail.rows.map((r) => r.key), ["e3", "e4"]);
    /*
     * And `hidden` counts what it has always counted: **events**, not rows, which
     * the cut block above pins from the other side. So the two status events below
     * the cut are counted as hidden even though showing them would draw nothing.
     *
     * Recorded rather than fixed, and it matters less than it did: `hidden` is now
     * only ever read for the one control offering back a cleared conversation, and
     * a real one has plenty of real content in it. The alternative is a second walk
     * over everything below the cut on every render to make a number marginally
     * more honest.
     */
    check("while `hidden` goes on counting events rather than rows", tail.hidden, 2);
  }

  {
    /*
     * The row stays cut, and now nothing else draws it either.
     *
     * This block used to assert that cutting the transcript row did not cut the
     * *warning*, because `SessionView`'s banner read the events directly and was
     * the only thing keeping `dirty_source` on screen. The banner was deleted on
     * request, so the second half of that pair has nothing left to hold and
     * `latestWorkspaceWarnings` went with it. What is still worth pinning is the
     * half that survives: a `workspace` event earns no row, so re-adding a reader
     * for these warnings is a decision somebody makes rather than something that
     * falls out of the transcript by itself.
     */
    seq = 0;
    const events = [
      workspace({ code: "dirty_source", message: "uncommitted work is not in this session" }),
    ];
    check("a workspace event draws no row", buildTail(events, []).rows.length, 0);
    // By name, not by side effect: the row count above is 0 for anything that
    // fails to parse too, so the set membership is what says this is a decision.
    check("because the type is suppressed by name", TRANSCRIPT_SILENT.has("workspace"), true);
  }

  {
    // The merge. Through the daemon a parked request keeps `decision: null` for its
    // whole life, so a rule reading that field would have got this exactly backwards.
    seq = 0;
    const settled = buildTail([asked("p1"), answered("p1")], []);
    check("a request whose answer follows is drawn once, by the answer", settled.rows.map((r) => r.key), ["e2"]);
  }

  {
    // A daemon restart with an approval in flight: no `permission_resolved` is
    // synthesized on restore, so this row is the only trace of it.
    seq = 0;
    const lost = buildTail([asked("p1"), prompt("still there?")], []);
    check("a request nothing ever answered keeps its row", lost.rows.map((r) => r.key), ["e1", "e2"]);
  }

  {
    seq = 0;
    const two = buildTail([asked("p1"), asked("p2"), answered("p2")], []);
    check("the merge is by id and not by adjacency", two.rows.map((r) => r.key), ["e1", "e3"]);
  }

  {
    // A bare `Session` answers inline and emits no resolution at all.
    seq = 0;
    check("a request with no id is never merged away", buildTail([asked(null)], []).rows.length, 1);
  }

  /*
   * What the surviving row says the answer *was*.
   *
   * `outcome: "selected"` means an option was chosen, not that permission was
   * granted — every `reject_*` option produces it too. Since the request row is
   * now merged away, a renderer keyed on `outcome` drew a check mark against a
   * refused command and that was the only surviving record of it.
   */
  {
    const withOptions = (permissionId: string): never =>
      ev({
        type: "permission_request",
        permissionId,
        toolCallId: null,
        title: "run rm -rf",
        options: [
          { optionId: "o-yes", name: "Allow", kind: "allow_once" },
          { optionId: "o-no", name: "Deny", kind: "reject_once" },
        ],
        decision: null,
      });
    const answeredWith = (permissionId: string, optionId: string | null): never =>
      ev({
        type: "permission_resolved",
        permissionId,
        toolCallId: null,
        title: "run rm -rf",
        outcome: optionId === null ? "cancelled" : "selected",
        optionId,
        by: "client",
      });

    seq = 0;
    const denied = permissionDecisions([withOptions("p1"), answeredWith("p1", "o-no")]);
    check("a denial is recorded as a refusal", denied.get("p1"), "reject_once");
    check("and reads as refused", refused(denied.get("p1")), true);

    seq = 0;
    const allowed = permissionDecisions([withOptions("p2"), answeredWith("p2", "o-yes")]);
    check("an approval is not", [allowed.get("p2"), refused(allowed.get("p2"))], ["allow_once", false]);

    // The id is the agent's, so it is joined by identity and never pattern-matched.
    // An option the request never offered is "cannot tell", which draws as neither.
    seq = 0;
    const strange = permissionDecisions([withOptions("p3"), answeredWith("p3", "o-elsewhere")]);
    check("an option the request never offered is unknown", strange.has("p3"), false);
    check("and unknown is never treated as a refusal", refused(strange.get("p3")), false);

    // A cancellation carries no option at all, and is handled by `outcome`.
    seq = 0;
    check(
      "a cancelled request records no option",
      permissionDecisions([withOptions("p4"), answeredWith("p4", null)]).has("p4"),
      false,
    );

    // The request can sit above the render window while its answer is on screen,
    // which is why this walks the loaded events rather than the drawn rows.
    seq = 0;
    check(
      "a resolution with no request in the window is unknown rather than approved",
      refused(permissionDecisions([answeredWith("p5", "o-no")]).get("p5")),
      false,
    );
  }
}

/* ------------------------------------------------------------------ *
 * An event nobody draws does not break the message
 *
 * The section above says which events draw no row. This one says what that
 * absence costs the run around them, and the two answers are different — which
 * is the whole reason `buildTail`'s flush is keyed on `TRANSCRIPT_SILENT` rather
 * than on `showsInTranscript`, and the reason a single fixture cannot cover it.
 *
 * `flush()` is what puts a boundary between two agent messages. For a
 * `tool_call`, a `context_cleared` or a `turn_end: end_turn` that boundary is
 * real — something happened between them, and for the turn end the message after
 * it belongs to a different turn. For `agent_log` and `other` it is not: the row
 * costs no slot and appears nowhere, so cutting the run there split one streamed
 * message into two independently parsed `<Markdown>` blocks with nothing on
 * screen to explain the break. Both types genuinely interleave with `text` inside
 * one turn — an `agent_log` is a line the agent wrote to stderr, and codex emits
 * `session_info_update` (an `other`) about five times a turn.
 *
 * Parts join with **no separator**, so the visible cost is a word cut in half
 * across two paragraphs — `"here is the pl"` then `"an:"` — and, on a fenced code
 * block whose chunks straddle one, an unterminated fence followed by a stray
 * paragraph. The trap is the mirror of that: a dropped **thought** must go on
 * flushing, or the last sentence before the reasoning block runs into the first
 * word after it. That half is asserted in "the tail is built backwards"; this
 * section is the other half, and each would pass with the other's rule installed.
 * ------------------------------------------------------------------ */

process.stdout.write("\nan event nobody draws does not break the message\n");
{
  let seq = 0;
  const at = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const say = (text: string): never => at({ type: "text", role: "agent", thought: false, text });
  const log = (line: string): never => at({ type: "agent_log", line });
  // codex's ~5-a-turn thread status, which falls into `onUpdate`'s `default:` arm
  // on the daemon and arrives here as an `other`.
  const other = (): never => at({ type: "other", sessionUpdate: "session_info_update", raw: null });
  const status = (value: string): never => at({ type: "status", status: value, exit: null });
  const turnEnd = (stopReason: string): never => at({ type: "turn_end", stopReason, usage: null });
  const call = (id: string): never =>
    at({
      type: "tool_call",
      toolCallId: id,
      title: id,
      kind: "other",
      status: "pending",
      locations: [],
      rawInput: null,
      parentToolCallId: null,
    });

  const texts = (events: readonly never[]): string[] =>
    buildTail(events, []).rows.map((row) => (row as { text?: string }).text ?? `[${row.kind}]`);

  {
    // The measured shape: an agent writing to stderr mid-sentence. Reverting the
    // flush to unconditional gives ["here is the pl", "an:"] — two paragraphs, no
    // row between them, and nothing on screen to say why the word broke.
    seq = 0;
    check(
      "an agent_log between two chunks does not split the sentence",
      texts([say("here is the pl"), log("[debug] tool resolved"), say("an:")]),
      ["here is the plan:"],
    );
    seq = 0;
    check("and it draws no row of its own", buildTail([say("a"), log("x"), say("b")], []).rows.length, 1);
  }

  {
    /*
     * **A suppressed plan still flushes, and that is provably free.**
     *
     * The worry is real of the *wrong* rule: a row that draws nothing and still
     * cuts the run splits one streamed message into two independently parsed
     * `<Markdown>` blocks with nothing on screen to explain the break — which is
     * the whole point of the two cases above. It cannot happen here, and the
     * proof is the collapse rule itself: a plan is suppressed only when
     * `collected` did not grow between it and its successor, and `flush()` runs
     * *before* the node decision — so an open text run is pushed at that exact
     * moment and the older plan is drawn. A plan with a message on either side of
     * it is always a real boundary.
     *
     * Asserted as a **pair**, because each half passes with the other's rule
     * installed: the first is what fails if `plan` is added to
     * `TRANSCRIPT_SILENT` to "make the suppressed one stop flushing", and the
     * second is what fails if the suppression is moved above the flush.
     */
    const plan = (): never => at({ type: "plan", entries: [] });
    seq = 0;
    check(
      "a drawn plan is a real boundary between two messages",
      texts([say("here is the pl"), plan(), say("an:")]),
      ["here is the pl", "[event]", "an:"],
    );
    seq = 0;
    check(
      "and a suppressed one does not silently join them",
      texts([say("a"), plan(), plan(), say("b")]),
      ["a", "[event]", "b"],
    );
  }

  {
    /*
     * codex's own case, and the one that fires several times per turn. A fenced
     * block is the fixture rather than a plain sentence because it is the visible
     * worst case: split here, the first half renders as an unterminated fence.
     */
    seq = 0;
    check(
      "nor does codex's session_info_update",
      texts([say("```ts\nconst a = 1;\n"), other(), say("```")]),
      ["```ts\nconst a = 1;\n```"],
    );
  }

  {
    // Every member of the set, not just the two that happen today: a `status` or
    // a `workspace` landing mid-turn has exactly the same claim on the run.
    seq = 0;
    check("a status line does not either", texts([say("one "), status("running"), say("two")]), ["one two"]);
  }

  {
    /*
     * The run keeps the **older** event's key, which is the risk this change
     * carries and is worth pinning rather than discovering: two nodes became one,
     * so the key of the surviving row is the first chunk's seq. Anything keyed on
     * the newer half would remount the message on every arriving token, which is
     * what shuts a card the reader had opened inside it.
     */
    seq = 0;
    check(
      "the merged run is one row, keyed by its first event",
      buildTail([say("a"), log("x"), say("b")], []).rows.map((row) => row.key),
      ["t1"],
    );
  }

  {
    /*
     * The boundaries that are real, and this is the half that fails if the flush
     * is keyed on `showsInTranscript` instead of on the set. `turn_end: end_turn`
     * draws no row *and* is a boundary — the message after it is a different
     * turn's — so the two rules disagree on exactly this fixture and only here.
     */
    seq = 0;
    check(
      "a turn ending still separates two turns",
      texts([say("first turn."), turnEnd("end_turn"), say("second turn.")]),
      ["first turn.", "second turn."],
    );
    seq = 0;
    check(
      "and a tool call still separates what it sits between",
      texts([say("before "), call("c1"), say("after")]),
      ["before ", "[tool]", "after"],
    );
  }

  {
    // Two silent events in a row, which is the ordinary case rather than a corner
    // — codex sends several a turn — and a rule that flushed on the second would
    // still look right on a single-event fixture.
    seq = 0;
    check(
      "a burst of them is still one message",
      texts([say("a"), log("x"), other(), log("y"), say("b")]),
      ["ab"],
    );
  }
}

process.stdout.write("\nwhat a machine's header says on its trailing edge\n");
{
  const group = (over: Record<string, unknown>): never =>
    ({ blockedCount: 0, reach: "online", tokenDegraded: false, liveCount: 0, ...over }) as never;

  check("nothing happening reads idle", machineSubline(group({})).kind, "idle");
  check("live sessions are counted", machineSubline(group({ liveCount: 5 })), { kind: "live", count: 5 });
  check("an unreachable machine says so", machineSubline(group({ reach: "offline" })).kind, "offline");
  check("a cached token says so", machineSubline(group({ tokenDegraded: true })).kind, "degraded");

  /*
   * The precedence, which is the whole reason this is a function. "5 live" must
   * not be the sentence that hides a session waiting on a human — a collapsed
   * section showing it is the one failure this screen exists to prevent.
   */
  check(
    "waiting beats a live count",
    machineSubline(group({ blockedCount: 2, liveCount: 5 })),
    { kind: "blocked", count: 2 },
  );
  // Deliberate: the header's own `Dot` still carries reachability, so nothing is
  // lost by this, and a hidden approval would be.
  check(
    "and beats an unreachable machine, whose dot still says offline",
    machineSubline(group({ blockedCount: 1, reach: "offline" })).kind,
    "blocked",
  );
  check(
    "a machine you cannot reach outranks which token was used to try",
    machineSubline(group({ reach: "offline", tokenDegraded: true })).kind,
    "offline",
  );
  check(
    "and a cached token outranks the ordinary count",
    machineSubline(group({ tokenDegraded: true, liveCount: 3 })).kind,
    "degraded",
  );

  // The two that earn the header's one warn colour.
  check(
    "only waiting and a cached token are warn-toned",
    (["blocked", "offline", "degraded", "idle", "live"] as const).map((kind) =>
      sublineWarns({ kind, count: 1 } as never),
    ),
    [true, false, true, false, false],
  );
}

process.stdout.write("\nwhose focus is worth keeping\n");
{
  const el = (over: Record<string, unknown>): unknown => ({
    tagName: "BUTTON",
    getAttribute: () => null,
    ...over,
  });

  /*
   * The clause that made autofocus dead on Chromium at `lg`: a session row is a
   * `<button>`, Chromium focuses buttons on click, and the old test was "anything
   * is focused at all". Confirmed not working in practice before it was narrowed.
   */
  check("a row button that merely took a click is not worth keeping", focusWorthKeeping(el({})), false);
  check("nor is nothing at all", [focusWorthKeeping(null), focusWorthKeeping(undefined)], [false, false]);
  check(
    "a text field somebody is typing in is",
    ["INPUT", "TEXTAREA", "SELECT"].map((tagName) => focusWorthKeeping(el({ tagName }))),
    [true, true, true],
  );
  check("so is a contenteditable", focusWorthKeeping(el({ isContentEditable: true })), true);
  // An *open* disclosure only. A collapsed one reads `"false"` and is a plain
  // button again, which is the distinction that keeps row buttons falling through.
  check(
    "an open menu is, and a closed one is not",
    [
      focusWorthKeeping(el({ getAttribute: (n: string) => (n === "aria-expanded" ? "true" : null) })),
      focusWorthKeeping(el({ getAttribute: (n: string) => (n === "aria-expanded" ? "false" : null) })),
    ],
    [true, false],
  );
}

/* ------------------------------------------------------------------ *
 * Who is working, what the box says, and who gets the caret
 * ------------------------------------------------------------------ */

process.stdout.write("\nwho is working, and what the box says\n");
{
  const session = (over: Record<string, unknown>): never =>
    ({
      status: "running",
      turn: 1,
      pendingPermissions: [],
      exit: null,
      agentSessionId: "a",
      resume: null,
      ...over,
    }) as never;

  check("a turn with nothing waiting on you is working", showsWorking(session({})), true);
  check("no turn is not", showsWorking(session({ turn: null })), false);
  // Raised mid-turn, so `turn` is still set while the agent is in fact waiting —
  // and the permission card two rows down says the opposite at full size.
  check(
    "a pending permission is not working, it is waiting for you",
    showsWorking(session({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
    false,
  );
  // `turn` is cleared in a `finally` a daemon that dies mid-turn never reaches.
  check(
    "and a session that ended mid-turn does not blink for ever",
    ["exited", "failed", "interrupted"].map((status) => showsWorking(session({ status }))),
    [false, false, false],
  );

  /*
   * The Stop control's own predicate, and the one difference from `showsWorking`
   * that matters: a session parked on a question is exactly where somebody most
   * wants out, and the daemon takes a cancel there — sweeping whatever is
   * parked — so a control drawn on `showsWorking` alone would be missing from the
   * state it exists for. Everything else the two agree about, which is what makes
   * the blocked row the whole assertion.
   */
  check("there is a turn to stop while the agent works", canCancelTurn(session({})), true);
  check(
    "and while it waits on you, which is where showsWorking says no",
    [
      canCancelTurn(session({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
      showsWorking(session({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
    ],
    [true, false],
  );
  check("nothing to stop with no turn", canCancelTurn(session({ turn: null })), false);
  check(
    "and nothing to stop on a session that has ended",
    ["exited", "failed", "interrupted"].map((status) => canCancelTurn(session({ status }))),
    [false, false, false],
  );
  /*
   * The one `isTerminal` does not cover, and it is not a moment: `turn` is
   * cleared in `pump`'s `finally`, which cannot run until the prompt generator
   * unwinds inside `dispose()` — a 5s cancel grace and a 2s close later. So a
   * session somebody stopped mid-turn carries `{status: "stopping", turn: 5}` for
   * seconds, the daemon refuses a cancel on it (`terminal || stopRequested`), and
   * a predicate reading `isTerminal` alone armed Stop across all of it onto a
   * guaranteed 409 and a red toast.
   */
  check("nor on one somebody is already stopping", canCancelTurn(session({ status: "stopping" })), false);
  check("which isTerminal does not say", isTerminal("stopping"), false);

  /*
   * Whether somebody has already asked. Read off the daemon's snapshot rather
   * than held in the tab, because the turn routinely outlives the request that
   * asked for it — an agent notices a cancel when it next looks up — and a button
   * that re-armed on the answer would invite a second tap at every stop.
   */
  check("nobody has asked yet", cancelInFlight(session({})), false);
  check("somebody has", cancelInFlight(session({ cancelRequestedAt: 1 })), true);
  /*
   * The migration, and it is the whole of it: an older daemon does not send the
   * field, and `undefined` has to read as "that daemon cannot say" rather than as
   * a cancel nobody asked for.
   */
  check("an older daemon that cannot say reads as no cancel", cancelInFlight(session({ cancelRequestedAt: undefined })), false);
  /*
   * Cleared with the turn on the daemon's side, so the pair cannot disagree —
   * asserted here because a client trusting `cancelRequestedAt` alone would draw
   * a permanently disabled Stop on an idle session.
   */
  check(
    "and a stale marker with no turn is not a cancel in flight",
    cancelInFlight(session({ turn: null, cancelRequestedAt: 1 })),
    false,
  );

  const say = (over: Record<string, boolean>): string =>
    composerPlaceholder({ blocked: false, reconnecting: false, working: false, revising: false, ...over });
  check("an idle box asks for a message", say({}), "message…");
  check("a working one says so", say({ working: true }), "agent is working…");
  // Wins over `working`: it is the rarer fact, and the one explaining the spinner.
  check(
    "an in-flight send during a restart explains the wait",
    say({ working: true, reconnecting: true }),
    "reconnecting the agent…",
  );
  // Wins over both: nothing typed here moves until the card above is answered.
  check(
    "and a blocked one points at the request above",
    say({ working: true, reconnecting: true, blocked: true }),
    "answer the request above first",
  );
  /*
   * **And a plan outranks even that, because it is the one blocked state where
   * this box is an answer rather than something to wait behind.** A message
   * written in front of a plan stops the turn and goes, which refuses the plan
   * and says why in one gesture — so telling somebody to go and answer the card
   * above would be pointing them away from the control they are already in.
   */
  check(
    "a plan on screen asks for the correction instead",
    say({ blocked: true, revising: true }),
    "say what to change…",
  );
  check(
    "and it says so whatever else is true",
    say({ blocked: true, working: true, reconnecting: true, revising: true }),
    "say what to change…",
  );

  /* ---- the three places that state has to hold together ---- */

  /*
   * All source-text, in the idiom this file already uses for class strings:
   * these are JSX-level decisions with no pure function behind them, and the
   * failure mode is silent — a gate left reading `blocked || working` refuses the
   * send that this whole state exists to allow, and nothing else would notice.
   */
  const composerSrc = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
  check(
    "a plan lifts the send gate rather than being gated by it",
    /const sendRefused = revising \? false : blocked \|\| working;/.test(composerSrc),
    true,
  );
  check(
    "and takes the Stop slot for Send",
    /const stoppable = canCancelTurn\(session\) && !revising;/.test(composerSrc),
    true,
  );
  /*
   * The ordering that makes it land: the daemon refuses a prompt inside a turn,
   * and a parked permission is one. Measured — rejecting the plan does *not* end
   * the turn, so the cancel is what the operator was pressing by hand.
   */
  check(
    "and a send from that state cancels the turn first",
    /const settled = revising\s*\n\s*\? daemon\.cancelTurn\(/.test(composerSrc),
    true,
  );
  check(
    "with the prompt behind it rather than beside it",
    /\.then\(\(\) => daemon\.prompt\(sessionRef\.sessionId, body, sending\)\)/.test(composerSrc),
    true,
  );
  // And the blur rule stands down, or the caret is taken out from under somebody
  // the placeholder has just invited to type.
  check(
    "a plan does not release the caret",
    /needsHuman\(row\.snapshot\) && !revising;/.test(composerSrc),
    true,
  );

  /*
   * ⚠ **Every hook in `SessionView` runs before its guard clause, and nothing
   * else in this repository checks that.**
   *
   * There is no eslint, `tsc` does not model hook order, and this driver has no
   * DOM — a sentence `Composer.tsx` already writes over its own release effect,
   * and which was true in the worst way: a `useMemo` added below `row.snapshot`
   * sat *after* `if (row === undefined) return`, so a cold-opened session
   * rendered three hooks while it said "loading" and four once its row landed.
   * That is React #310, thrown the moment the row arrives, and it takes the whole
   * screen down.
   *
   * `SessionView` is the one component in this package with a guard clause
   * between its hooks and its body. A second one owes this check.
   */
  const sessionViewSrc = readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8");
  const body = sessionViewSrc.slice(
    sessionViewSrc.indexOf("export function SessionView("),
    sessionViewSrc.indexOf("\nfunction SessionTitle("),
  );
  const guard = body.indexOf("\n  if (row === undefined) {");
  check("the guard clause is still where this check thinks it is", guard > 0, true);
  const late = [...body.matchAll(/\buse[A-Z]\w*\(/g)].filter((m) => (m.index ?? 0) > guard);
  check("no hook runs after SessionView's guard clause", late.map((m) => m[0]), []);
}

process.stdout.write("\nwho gets the caret on a session switch\n");
{
  const ask = (over: Record<string, boolean>): boolean =>
    shouldFocusComposer({
      hasBox: true,
      pointerCoarse: false,
      focusHeldElsewhere: false,
      blocked: false,
      fromKeyboardNav: false,
      ...over,
    });

  /*
   * **The missing half.** Declining to *take* the caret does nothing about one
   * taken a moment earlier: on a desktop the composer focuses itself when a
   * session opens, and a request that parks after that finds it already holding
   * focus — so `isTypingInto` switches every shortcut on the card off and the
   * numbers beside the answers do nothing.
   */
  check(
    "a parked request hands the caret back",
    shouldReleaseComposer({ blocked: true, focused: true, draftEmpty: true }),
    true,
  );
  check(
    "but never out from under a half-written message",
    shouldReleaseComposer({ blocked: true, focused: true, draftEmpty: false }),
    false,
  );
  check(
    "and there is nothing to hand back when nothing holds it",
    [
      shouldReleaseComposer({ blocked: true, focused: false, draftEmpty: true }),
      shouldReleaseComposer({ blocked: false, focused: true, draftEmpty: true }),
    ],
    [false, false],
  );

  check("a desktop switch onto a live session takes it", ask({}), true);
  // Each of these is a way it is *wrong*, so each is asserted on its own.
  check("an ended session has no box to focus", ask({ hasBox: false }), false);
  check("a phone would raise the keyboard over half the screen", ask({ pointerCoarse: true }), false);
  check("something that already has focus keeps it", ask({ focusHeldElsewhere: true }), false);
  check("a blocked session points at the request instead", ask({ blocked: true }), false);
  // The one that is not obvious: `isTypingInto` switches every bare shortcut off
  // once the composer has focus, so autofocusing after `j` breaks the next `j`.
  check("and `j`/`k` keep working for the next hop", ask({ fromKeyboardNav: true }), false);

  check("the flag starts down", takeKeyNav(), false);
  markKeyNav();
  check("the keyboard layer can raise it", takeKeyNav(), true);
  check("and reading it puts it down, so it cannot suppress the next switch", takeKeyNav(), false);
}

/* ------------------------------------------------------------------ *
 * The two helpers the extraction moved, and nothing asserted
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a collapsed row says, and what a fence hides\n");
{
  // Tool output is rendered in a `<pre>` rather than through the markdown
  // renderer — deliberately, since it is untrusted text from a repository — so an
  // unstripped fence reaches a person as three literal backticks.
  check("a fence wrapping the whole block is removed", stripFence("```console\nhi-there\n```"), "hi-there");
  check("a lone fence line is not a wrapper", stripFence("```"), "```");
  check(
    "and a fence in the middle is part of what the tool printed",
    stripFence("before\n```\ninner\n```"),
    "before\n```\ninner\n```",
  );
  check("text with no fence at all is untouched", stripFence("plain\noutput"), "plain\noutput");

  check(
    "a command is what a collapsed row says",
    toolSummary({ command: "ls -la" }, []),
    { summary: "ls -la", detail: "ls -la" },
  );
  check(
    "and with no arguments it falls back to the first location",
    toolSummary(null, [{ path: "/home/proj/notes.txt", line: 3 }]).summary,
    formatLocation({ path: "/home/proj/notes.txt", line: 3 }),
  );
  check("with neither, it says nothing rather than `{}`", toolSummary({}, []), {
    summary: null,
    detail: null,
  });

  /*
   * **The row shortens a path and never a command**, and the second half is the one
   * worth pinning.
   *
   * Reported off a phone: every session works inside one directory, so a `Read` row
   * drew that directory again on every line and `truncate` then removed the end —
   * the part that says which file. The three sites this was fixed at first
   * (`ChangeRow`, the `locations` list, the diff header) all missed *this* one,
   * which is where a reader actually looks, so the sentence "paths are relative now"
   * was true and useless.
   *
   * The refusal is the safety half. `COMMAND_FIELDS` is the string the agent ran;
   * rewriting it would draw a command that was never executed, which is the same
   * judgement `PermissionCard` makes when it renders one through a raw `<pre>`.
   */
  // The real `relFor`, not a stand-in: the rule under test is what a reader sees,
  // and a hand-written relativiser here could agree with the assertion while
  // disagreeing with `SessionView`, which wires this exact function in.
  const { relativeTo: relTo } = await import("../src/paths.js");
  const under = (root: string) => (path: string) => relTo(root, path);
  const ROOT = "/Users/me/proj";

  check(
    "a path under the workspace loses the prefix everything shares",
    toolSummary({ file_path: `${ROOT}/src/ui/EventList.tsx` }, [], under(ROOT)).summary,
    "src/ui/EventList.tsx",
  );
  check(
    "and so does the location it falls back to",
    toolSummary(null, [{ path: `${ROOT}/notes.txt`, line: 3 }], under(ROOT)).summary,
    "notes.txt:3",
  );
  /*
   * ⚠ The one that must never change. `ls -la /Users/me/proj/src` is what ran, and a
   * row reading `ls -la src` is a row describing a command nobody issued.
   */
  check(
    "a command is drawn as it ran, prefix and all",
    toolSummary({ command: `ls -la ${ROOT}/src` }, [{ path: `${ROOT}/src`, line: null }], under(ROOT)).summary,
    `ls -la ${ROOT}/src`,
  );
  // `TARGET_FIELDS` holds `url` and `uri` beside the path names and needs no special
  // case: nothing outside the root is relative to it, so it falls through unchanged.
  check(
    "a URL is not a path and is left alone",
    toolSummary({ url: "https://example.com/a/b" }, [], under(ROOT)).summary,
    "https://example.com/a/b",
  );
  check(
    "and a file outside the workspace keeps the prefix that locates it",
    toolSummary({ file_path: "/etc/hosts" }, [], under(ROOT)).summary,
    "/etc/hosts",
  );
  // The default answers `null` for everything, so the two callers that have no
  // `FileAccess` — `nameOfTool` among them — get exactly what they got before.
  check(
    "with no relativiser at all, nothing moves",
    toolSummary({ file_path: `${ROOT}/src/a.ts` }, []).summary,
    `${ROOT}/src/a.ts`,
  );

  /*
   * ⚠ **And the call site, because everything above passes without it.**
   *
   * The default third argument answers `null` for everything, which is what makes
   * the two callers with no `FileAccess` safe — and it is also what makes dropping
   * the argument at the one call site that *has* one completely silent. Measured:
   * with the relativiser deleted from `EventList`, every assertion above stayed
   * green and the row went back to drawing `/Users/rends/remoslop_agent…`, which is
   * the screenshot this whole change came from.
   *
   * That is the same shape as the defect itself. Three sites were fixed by reading
   * the code and this fourth was missed, so a pure-function check that cannot see
   * call sites would have certified the fix and shipped the bug. `webcheck` already
   * reads files off disk for exactly this class — see the notice, the fold and the
   * palette gate — and this joins them.
   */
  const eventList = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check("the row asks for a relative path", /toolSummary\([^;]*relFor/.test(eventList), true);
  check("and never takes the two-argument form", /toolSummary\(rawInput, locations\)/.test(eventList), false);
}

/* ------------------------------------------------------------------ *
 * Which files the composer will take
 *
 * Two client-side limits and nothing else. The per-session byte budget is the
 * daemon's, deliberately: this client cannot know it across a reload, so a
 * half-tracked copy would be wrong more often than useful and the daemon's own
 * refusal is what a chip shows instead.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich files the composer will take\n");
{
  const { admitFiles } = await import("../src/attach.js");
  const { MAX_UPLOAD_BYTES } = await import("../src/wire.js");

  // `File` needs a DOM; a plain object with the two fields the rule reads is the
  // honest stand-in in a driver that stubs `window` and nothing else.
  const file = (name: string, size: number): File => ({ name, size }) as File;
  const chip = (state: string, uploadId: string | null = null): never =>
    ({ state, uploadId }) as never;

  const ten = Array.from({ length: 10 }, (_, i) => chip("ready", `u_${i}`));
  // The boundary, not the middle: ten is the limit, so the eleventh is refused
  // while the first ten are not.
  const eleventh = admitFiles(ten, [file("k.txt", 10)]);
  check("the eleventh file is refused", eleventh.accepted.length, 0);
  check("and says why", eleventh.refused[0]?.reason, "too_many");
  check("the tenth is not", admitFiles(ten.slice(0, 9), [file("j.txt", 10)]).accepted.length, 1);

  check("exactly the cap is accepted", admitFiles([], [file("a.bin", MAX_UPLOAD_BYTES)]).accepted.length, 1);
  const over = admitFiles([], [file("a.bin", MAX_UPLOAD_BYTES + 1)]);
  check("one byte more is not", over.accepted.length, 0);
  check("and says why", over.refused[0]?.reason, "too_large");
  // A directory dropped on a picker arrives as a zero-byte entry.
  check("an empty file is refused", admitFiles([], [file("d", 0)]).refused[0]?.reason, "empty");

  // A picker handing back twelve when there is room for three must attach three
  // and say so, not refuse all twelve and make somebody pick again.
  const straddle = admitFiles(ten.slice(0, 8), [file("a", 1), file("b", 1), file("c", 1), file("d", 1)]);
  check("a batch over the limit accepts a prefix", straddle.accepted.map((f) => f.name), ["a", "b"]);
  check("and names the rest", straddle.refused.map((f) => f.file.name), ["c", "d"]);

  // The rule that would otherwise be decided differently in two places: a failed
  // chip is not going to be sent, so it must not hold a slot.
  const failed = Array.from({ length: 10 }, () => chip("failed"));
  check("a failed chip does not occupy a slot", admitFiles(failed, [file("a", 1)]).accepted.length, 1);
  check("an uploading one does", admitFiles(Array.from({ length: 10 }, () => chip("uploading")), [file("a", 1)]).accepted.length, 0);
}

/* ------------------------------------------------------------------ *
 * A file attached while the send was in flight
 *
 * `send` empties the chip list optimistically and `restoreAttachments` puts it
 * back when the daemon refuses — and that restore used to be an **assignment**,
 * which is only correct if nothing can be attached in between. Nothing stops it:
 * `onPaste`, `onDrop` and the paperclip all stay live, and `POST
 * /sessions/:id/prompt` is on the 90s slow-route budget, so the window is up to
 * a minute and a half wide.
 *
 * What an assignment cost is worse than a lost chip. The upload behind it keeps
 * streaming to completion against the daemon's per-session 100 files / 100 MiB,
 * and the entry carried the `cancel` closure — so `removeAttachment` and
 * `forgetAttachments` have nothing left to abort with, and there is no chip on
 * screen to press anyway. The person then retries the send and it goes without
 * the screenshot they attached, with nothing anywhere saying so.
 *
 * Driven through the module's own state rather than a copy of it: the map, its
 * version counter and the merge are the subject, and `restoreAttachments` is
 * exported precisely so this is assertable without a composer.
 * ------------------------------------------------------------------ */

process.stdout.write("\na file attached while the send was in flight\n");
{
  const { addAttachments, attachmentsFor, forgetAttachments, restoreAttachments } = await import("../src/attach.js");

  const key = "m_1/s_1" as never;
  // Only the fields the merge reads. `File` needs a DOM, and the rule under test
  // never touches it — same stand-in the admission cases one section up use.
  const chip = (localId: string, state = "ready"): never => ({ localId, state, uploadId: `u_${localId}` }) as never;
  const ids = (): string[] => attachmentsFor(key).map((item) => item.localId);

  {
    // The failure exactly: two chips are cleared by the optimistic send, a third
    // is pasted while the prompt is in flight, and the refusal restores. Under
    // the assignment this answered ["a","b"] — `c` gone from the map with its
    // upload still running and its `cancel` unreachable.
    forgetAttachments(key);
    addAttachments(key, [chip("c")]);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("a chip attached mid-send survives the restore", ids(), ["a", "b", "c"]);
  }

  {
    // Restored first, because they were attached first and that is the order the
    // refused message had them in — the one the retry has to reproduce.
    forgetAttachments(key);
    addAttachments(key, [chip("late")]);
    restoreAttachments(key, [chip("early")]);
    check("and the restored ones lead, in their own order", ids(), ["early", "late"]);
  }

  {
    // The ordinary path, where nothing was attached in between: a plain restore.
    // Asserted so the merge cannot be read as changing what the common case does.
    forgetAttachments(key);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("with nothing live it is the list as it was", ids(), ["a", "b"]);
  }

  {
    /*
     * Deduplicated by `localId`. Two restores can genuinely overlap — a refusal
     * arriving while a previous refusal's restore is on screen — and without this
     * one file is drawn twice under the same React key, which is the one shape a
     * list must never take.
     */
    forgetAttachments(key);
    addAttachments(key, [chip("a"), chip("c")]);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("a file already back is not drawn twice", ids(), ["a", "b", "c"]);
  }

  {
    // An empty restore is not a clear. `send` calls this with whatever it captured,
    // and a text-only message captured nothing — which must not delete a file
    // attached since.
    forgetAttachments(key);
    addAttachments(key, [chip("a")]);
    restoreAttachments(key, []);
    check("restoring nothing leaves what is there", ids(), ["a"]);
  }

  // Module state, shared with every later section that imports this file. Left as
  // it was found.
  forgetAttachments(key);
  check("and the fixture leaves nothing behind", attachmentsFor(key).length, 0);
}

/* ------------------------------------------------------------------ *
 * Which of the composer's writes may land late
 *
 * At `lg` a session switch does **not** remount `Composer`, so `text`, `echo`,
 * `busy`, `applying` and `dismissed` are one shared instance while `drafts` and
 * `attach.ts` are keyed. Everything that resolves after an await therefore has to
 * be split: the keyed halves are correct from anywhere, the shared ones belong to
 * whichever session is actually on screen. `onScreen()` is that question.
 *
 * Three callbacks in `Composer.tsx` need that split — `send`'s two continuations,
 * `applyValue`'s `.then`, and the one-tap callback `choose` hands it — and the
 * first got its guards while the two a few lines above it did not. `applyValue`'s
 * `.then` closed a **different** session's `/` menu when a config change landed
 * (`closeMenu` sets `dismissed`), and `choose`'s one-tap branch wrote A's
 * completion into B's visible box through `update` and then moved B's caret to
 * A's offset — after which an Enter aimed at retrying A's gesture sent A's text
 * to B's agent, since `submit` reads the live render's `sessionRef`. Both run
 * behind `POST /sessions/:id/config` on the 90s slow route, which is long enough
 * for a person to move.
 *
 * And the fourth site is the opposite defect: `send` is reachable from **both**
 * doors, and asking `onScreen()` on the synchronous one made the ordinary Send
 * depend on the `[key]` effect having flushed. In that window the message goes to
 * the daemon while the box is left full, no echo is drawn and no spinner lights —
 * "it did not send", and a duplicate. So `send` takes `late` explicitly, required
 * with no default for the reason `LaunchOptions.fileIo` is: a new call site has
 * to decide, and deleting the argument is a type error rather than a silent one.
 *
 * Read off disk, because a component cannot be rendered here — no DOM and no
 * React — and none of this is a value a pure function returns. It is the same
 * argument the `SessionBrowser` extraction above makes and the `cpctl` one at the
 * foot of this file: compare behaviour where that is possible, and pin the one
 * line that decides it where it is not. Comments are stripped first, so what is
 * measured is code rather than the prose explaining it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich of the composer's writes may land late\n");
{
  const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  /** The source between an opening anchor and the next `end`, code only. */
  const region = (from: string, end: string): string => {
    const at = composer.indexOf(from);
    if (at < 0) return "";
    const to = composer.indexOf(end, at + from.length);
    return code(composer.slice(at, to < 0 ? composer.length : to));
  };

  /*
   * `send`'s two doors, named at the call sites rather than inferred inside it.
   * A default would make the deferred door the silent one, which is the direction
   * that loses a message into another session's box.
   */
  check(
    "send is told whether it is arriving late",
    /const send = \(body: string, late: boolean\): void =>/.test(composer),
    true,
  );
  check("the keystroke door says it is not", /send\(text\.trim\(\), false\)/.test(composer), true);
  check("and the config-round-trip door says it is", /send\(rest, true\)/.test(composer), true);
  /*
   * The short-circuit is the assertion, not merely the guard: with a bare
   * `if (onScreen())` the synchronous door asks a question answered from an
   * effect, and `onScreen`'s own docblock — "only ever asked after an await" —
   * becomes a claim about call sites that nothing holds.
   */
  check(
    "so the shared instance is written unconditionally on the synchronous one",
    /if \(!late \|\| onScreen\(\)\) \{/.test(composer),
    true,
  );

  /*
   * `applyValue`'s own late writes. `setApplying` is the spinner on a control
   * strip and `closeMenu` sets `dismissed`, and both belong to the session the
   * change was dispatched against.
   */
  const apply = region("const applyValue = ", "const choose = ");
  check("a config change that lands late asks whose composer this is", /onScreen\(\)/.test(apply), true);
  check("before it clears the control's spinner", /if \(present\) setApplying\(null\)/.test(apply), true);
  check("and before it closes a menu", /if \(ok && present\) closeMenu\(\)/.test(apply), true);
  /*
   * `onDone` is called either way. Its own body decides what a late answer means
   * — every one of them is keyed — and skipping it would drop the draft edit the
   * one-tap path defers, i.e. lose the completion rather than misplace it.
   */
  check("the deferred callback still runs whatever the answer is", /^\s*onDone\?\.\(ok\);/m.test(apply), true);

  /*
   * `choose`'s one-tap branch, which is the sibling the prompt-path fix missed.
   * Asserted by *order* rather than by the presence of a string: `update` and
   * `pendingCaret` both have to sit behind the test, and an edit that reinstated
   * either above it would still contain both tokens.
   */
  const oneTap = region("applyValue(entry.option, entry.value, (ok) => {", "\n      return;");
  const guardAt = oneTap.indexOf("onScreen()");
  check("the one-tap completion asks before writing the box", guardAt >= 0, true);
  report(
    "and both shared writes sit behind that test",
    guardAt >= 0 &&
      guardAt < oneTap.indexOf("update(next.text)") &&
      guardAt < oneTap.indexOf("pendingCaret.current = next.caret"),
    `guard at ${guardAt}, update at ${oneTap.indexOf("update(next.text)")}, caret at ${oneTap.indexOf("pendingCaret.current = next.caret")}`,
  );
  /*
   * The keyed half is unconditional, and that is the whole point of splitting
   * rather than simply dropping the write: the completion belongs to the session
   * it was typed in, so it goes into that session's draft and is waiting there
   * when somebody comes back. `pendingCaret` is a position *in the box*, so it
   * has no keyed half and correctly has none here.
   */
  check("while the draft is still written for the session it was typed in", /drafts\.set\(key, next\.text\)/.test(oneTap), true);
  check("and cleared rather than left stale when the completion is empty", /drafts\.delete\(key\)/.test(oneTap), true);

  /*
   * **A late-write gate is only half a rule, and the other half is the reset.**
   *
   * Everything above pins that a shared flag is not written by a request that
   * arrived after a session switch. What none of it says is that the flag is
   * *cleared* on that switch — and for `busy` both halves have always existed,
   * with the effect's own comment explaining why the second is needed. `stopping`
   * arrived with the gate and without the reset, and the ending is worse than
   * `busy`'s because nothing can recover it: while it is set the send slot draws
   * a "Stopping" spinner instead of the Stop button, so no tap can reach
   * `cancelTurn`, whose own `if (stopping) return` refuses anyway — the one path
   * to the `finally` that would release it. Every session opened in that tab
   * afterwards showed a spinner where Send belongs.
   *
   * Asserted as the *pair*, on the effect's own region, so a future shared flag
   * given one and not the other fails here rather than on somebody's phone.
   */
  const onSwitch = region("liveKey.current = key;", "}, [key]);");
  for (const [what, token] of [
    ["a send", "setBusy(false)"],
    ["a control change", "setApplying(null)"],
    ["a cancel", "setStopping(false)"],
  ] as const) {
    check(`switching session forgets ${what} dispatched against the last one`, onSwitch.includes(token), true);
  }
}

/* ------------------------------------------------------------------ *
 * What a nameless file gets called
 *
 * The case this exists for is Ctrl+V of a screenshot, which is how an image is
 * attached on a desktop. Most browsers hand back `image.png`, but not all and
 * not from every source — and the daemon refuses an empty name with `400
 * invalid_name`, so without this the commonest desktop path would fail with an
 * opaque error.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a nameless file gets called\n");
{
  const { pastedName } = await import("../src/attach.js");
  // 2026-08-04T09:15:30Z, fixed so the assertion is about the shape.
  const at = Date.UTC(2026, 7, 4, 9, 15, 30);

  // A name the browser gave us always wins. Nothing is invented over it.
  check("a real name is kept", pastedName("shot.png", "image/png", at), "shot.png");
  check("even an odd one", pastedName("Screen Shot 2026.png", "image/png", at), "Screen Shot 2026.png");
  check("whitespace around it is not a name", pastedName("   ", "image/png", at), "pasted-20260804-091530.png");

  check("a nameless png", pastedName("", "image/png", at), "pasted-20260804-091530.png");
  // Spelled rather than derived: the subtype would give `.jpeg`.
  check("a jpeg gets the extension people expect", pastedName("", "image/jpeg", at), "pasted-20260804-091530.jpg");
  check("a subtype with a suffix is not one", pastedName("", "image/svg+xml", at), "pasted-20260804-091530.svg");
  // Derived, and right far more often than a table would be.
  check("an unlisted type takes its subtype", pastedName("", "application/pdf", at), "pasted-20260804-091530.pdf");
  check("a parameter on the type is ignored", pastedName("", "text/csv; charset=utf-8", at), "pasted-20260804-091530.csv");
  // Nothing usable to derive from still has to produce a storable name, because
  // the alternative is the 400 this function exists to avoid.
  check("no type at all still gets a name", pastedName("", "", at), "pasted-20260804-091530.bin");
  check("and neither does a malformed one", pastedName("", "not-a-mime", at), "pasted-20260804-091530.bin");

  // The name it produces has to survive the daemon's own sanitizer, which
  // refuses control characters and path separators. This is the assertion that
  // ties the two ends together.
  const generated = pastedName("", "image/png", at);
  check("what it generates is a single safe segment", /^[A-Za-z0-9._-]+$/.test(generated), true);
}

/* ------------------------------------------------------------------ *
 * What may be drawn inline, and what may only be saved
 *
 * Two of these three rules are security decisions. `image/svg+xml` is absent
 * from the allowlist on purpose: SVG is a document format that can carry
 * `<script>`, and the only thing between that and this origin is `<img>`
 * disabling scripting for it — a promise about engine behaviour rather than
 * about our code. Four raster types cost nothing and do not depend on it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat may be drawn inline\n");
{
  const { previewable, MAX_PREVIEW_BYTES } = await import("../src/preview.js");

  check("a png draws", previewable("image/png", 1024), true);
  check("a jpeg draws", previewable("image/jpeg", 1024), true);
  check("a gif draws", previewable("image/gif", 1024), true);
  check("a webp draws", previewable("image/webp", 1024), true);
  // The assertion that earns the allowlist. It still downloads; it never renders.
  check("an svg never draws", previewable("image/svg+xml", 1024), false);
  check("nor does a pdf", previewable("application/pdf", 1024), false);
  check("nor does text", previewable("text/plain", 1024), false);
  // Not `image/*`, which would admit svg and whatever the registry grows next.
  check("nor an unknown image type", previewable("image/avif", 1024), false);

  check("a parameter on the type is ignored", previewable("image/png; charset=binary", 1024), true);
  check("and case is", previewable("IMAGE/PNG", 1024), true);

  // The budget: these bytes are pulled automatically, through the relay, onto a
  // phone, for something somebody may only be scrolling past.
  check("exactly at the cap still draws", previewable("image/png", MAX_PREVIEW_BYTES), true);
  check("one byte over does not", previewable("image/png", MAX_PREVIEW_BYTES + 1), false);
  // An unknown size is precisely the one that must not be fetched, so it is
  // refused rather than treated as small.
  check("a zero size does not", previewable("image/png", 0), false);
  check("nor does a nonsense one", previewable("image/png", Number.NaN), false);
  // A workspace file has no declared type at all — the daemon never echoes one.
  check("and neither does a file with no type", previewable(null, 1024), false);
}

/* ------------------------------------------------------------------ *
 * What is sent with a prompt
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat is sent with a prompt\n");
{
  const { sendableAttachments } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null = null): never => ({ state, uploadId }) as never;

  check("ready chips are sent, in order", sendableAttachments([chip("ready", "u_2"), chip("ready", "u_1")]).ids, [
    "u_2",
    "u_1",
  ]);
  // Blocked is a *visible* refusal: sending now would send the message without
  // the file somebody attached to it.
  check("an upload in flight blocks", sendableAttachments([chip("uploading")]).blocked, true);
  // And a failed one does not, or there would be no way out but removing it.
  check("a failed one does not", sendableAttachments([chip("failed")]).blocked, false);
  check("and is not sent", sendableAttachments([chip("ready", "u_1"), chip("failed")]).ids, ["u_1"]);
  // The impossible state, refused rather than trusted: it would send an empty
  // list under a message that says it has files.
  check("ready with no id never reaches the wire", sendableAttachments([chip("ready", null)]).ids, []);
}

/* ------------------------------------------------------------------ *
 * Whether a message can be sent at all
 *
 * Text **or** files. A message that is only a screenshot is an ordinary thing to
 * send, and the composer refused it for a while because the only guard was on the
 * text — the daemon refused it too, before it had even looked at `attachments`.
 * Both sides changed together, and this is the client's half.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhether a message can be sent at all\n");
{
  const { canSend } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null = null): never => ({ state, uploadId }) as never;

  check("text alone sends", canSend("hello", []), true);
  check("a file alone sends", canSend("", [chip("ready", "u_1")]), true);
  check("both send", canSend("look", [chip("ready", "u_1")]), true);
  check("neither does not", canSend("", []), false);
  // Whitespace is not a message, and never was.
  check("nor does whitespace alone", canSend("   \n ", []), false);

  // `blocked` outranks everything: for a files-only message, sending mid-upload
  // would deliver nothing at all.
  check("an upload in flight holds the send", canSend("hello", [chip("uploading")]), false);
  check("even with a ready file beside it", canSend("", [chip("ready", "u_1"), chip("uploading")]), false);
  // A failed chip is not going to finish, so it must not hold Send hostage —
  // there would be no way out but removing it.
  /*
   * The turn, and it is here because the composer was offering a send the daemon
   * could only refuse. `ManagedSession.prompt` answers `busy` while a turn is
   * open — a parked question keeps one open — so every message typed then came
   * back `409 turn_in_flight` as a red toast, under a button whose own tooltip
   * claimed it queued. Nothing queues anywhere in this system.
   *
   * ⚠ That sentence briefly stopped being true and is true again. A correction
   * typed on the plan card used to be *held* by the client and sent when the
   * agent stopped; it is now an ordinary message in the ordinary box, gated by
   * the ordinary rule. See Q3.454 for what that bought and what it cost.
   */
  check("a turn in flight refuses the send", canSend("hello", [], true), false);
  check("and so does a parked question, which is the same open turn", canSend("hello", [chip("ready", "u_1")], true), false);
  check("with no turn it is the rule it always was", canSend("hello", [], false), true);
  check("and the argument defaults to off, so nothing else had to change", canSend("hello", []), true);

  check("a failed chip does not", canSend("hello", [chip("failed")]), true);
  // But it is not a message either.
  check("and cannot be the whole message", canSend("", [chip("failed")]), false);

}

/* ------------------------------------------------------------------ *
 * A path inside the workspace, and one outside it
 *
 * `file_change` and `FileLocation` carry absolute, agent-chosen paths; the
 * download route takes one relative to the workspace root. A location that does
 * not convert draws no button at all — this repo's own paperclip rule, one
 * screen over.
 * ------------------------------------------------------------------ */

process.stdout.write("\na path inside the workspace, and one outside it\n");
{
  const { downloadablePath, filenameFor, formatBytes, relativeTo } = await import("../src/paths.js");

  check("an ordinary path", relativeTo("/w", "/w/a/b.ts"), "a/b.ts");
  check("a trailing slash on the root is the same answer", relativeTo("/w/", "/w/a.ts"), "a.ts");
  // The assertion that earns the function: a bare `startsWith` says "a".
  check("a prefix is not a boundary", relativeTo("/w", "/workspace/a"), null);
  check("the root itself is not a file", relativeTo("/w", "/w"), null);
  check("nor is a directory under it", relativeTo("/w", "/w/sub/"), null);
  check("a path elsewhere converts to nothing", relativeTo("/w", "/etc/passwd"), null);
  check("and neither does one that climbs out", relativeTo("/w", "/w/../etc/passwd"), null);
  check("an already-relative path passes through", relativeTo("/w", "a.ts"), "a.ts");
  check("unless it climbs", relativeTo("/w", "../a"), null);
  check("or contains a dot segment", relativeTo("/w", "a/./b"), null);

  // Forced rather than chosen: the daemon sends no `access-control-expose-headers`,
  // so `content-disposition` is unreadable cross-origin and the name has to come
  // from the path we asked for.
  check("the name is the last segment", filenameFor("a/b/c.png"), "c.png");
  check("a bare name is itself", filenameFor("c.png"), "c.png");
  check("a directory has none", filenameFor("a/"), null);
  check("and neither does nothing", filenameFor(""), null);

  /*
   * Which inline code spans in agent prose become a download.
   *
   * The measured claim this rests on: across every session in one real database,
   * agent prose held 55 path-shaped strings and 4 were inside their session's
   * workspace — one session printed 39 and would show nothing. It is the
   * containment test, not a guess at intent, that keeps the transcript quiet.
   */
  const touched = new Set(["/w/out.png", "/w/sub/a.svg", "/elsewhere/x.png"]);
  check("a file the session made", downloadablePath("/w/out.png", "/w", touched), "out.png");
  check("nested", downloadablePath("/w/sub/a.svg", "/w", touched), "sub/a.svg");
  // Relative spans are resolved against the root before being compared, because
  // what the daemon reported is absolute.
  check("a relative span resolves first", downloadablePath("sub/a.svg", "/w", touched), "sub/a.svg");

  // The filter that does the work: mentioned, but not ours.
  check("a path outside the workspace is not offered", downloadablePath("/elsewhere/x.png", "/w", touched), null);
  // The second filter: inside the workspace, but this session never touched it.
  check("nor is one the session never touched", downloadablePath("/w/never.png", "/w", touched), null);

  // Inline code holds commands far more often than filenames, and whitespace
  // removes almost all of them in one rule.
  check("a command is not a path", downloadablePath("git commit -m x", "/w", touched), null);
  check("nor is prose with a slash", downloadablePath("and/or something", "/w", touched), null);
  // A bare filename counts, because `touched` is what decides — requiring a slash
  // was standing in for "looks like a path" and rejected the shorter reference an
  // agent naturally makes to a file it just named in full.
  check("a bare filename in the set counts", downloadablePath("out.png", "/w", touched), "out.png");
  check("a bare word that is not is refused", downloadablePath("npm", "/w", touched), null);
  check("nor is an empty span", downloadablePath("", "/w", touched), null);
  // The span is agent-chosen, so the traversal case is refused by `relativeTo`
  // even when somebody puts it in the touched set.
  check("and a climb out is refused", downloadablePath("/w/../etc/passwd", "/w", new Set(["/w/../etc/passwd"])), null);

  check("bytes read as bytes", formatBytes(512), "512 B");
  check("and scale", formatBytes(2048), "2.0 KB");
  // Binary divisors with decimal labels, which is the convention `paths.ts` picked
  // and which is why the per-file cap reads as a round number rather than as 105.
  check("to something a chip can hold", formatBytes(100 * 1024 * 1024), "100 MB");
}
