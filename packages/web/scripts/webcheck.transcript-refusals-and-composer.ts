import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import {
  TRANSCRIPT_SILENT,
  acceptsMidTurn,
  buildTail,
  canCancelTurn,
  cancelInFlight,
  composerPlaceholder,
  focusWorthKeeping,
  formatLocation,
  isTerminal,
  machineSubline,
  markKeyNav,
  needsHuman,
  permissionDecisions,
  queuedSeqs,
  refused,
  shouldFocusComposer,
  shouldReleaseComposer,
  showsInTranscript,
  showsWorking,
  stripFence,
  sublineWarns,
  takeKeyNav,
  toolSummary,
  workStartedAt,
  workingUnprompted,
} from "./webcheck.modules.js";

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
      "permission_request",
      "permission_resolved",
      "plan",
      "context_cleared",
      "error",
    ].map((type) => drawn({ type })),
    [true, true, true, true, true, true, true],
  );
  check("an ordinary turn ending is not news", drawn({ type: "turn_end", stopReason: "end_turn" }), false);
  // `abandoned` draws a row: an unanswered turn leaves nothing else to account for the gap (Q2.231).
  check(
    "but a turn that did not finish is",
    ["max_tokens", "refusal", "cancelled", "abandoned"].map((reason) => drawn({ type: "turn_end", stopReason: reason })),
    [true, true, true, true],
  );
  check(
    "and a turn the agent rejected is not, because the error above it already said so",
    drawn({ type: "turn_end", stopReason: "agent_error" }),
    false,
  );
  check(
    "the three with their own node kinds are not silent",
    ["text", "tool_call", "tool_call_update"].map((type) => drawn({ type })),
    [true, true, true],
  );

  {
    seq = 0;
    const tail = buildTail([status("idle"), workspace(), prompt("hello"), turnEnd("end_turn")], []);
    check("only the prompt survives a turn's worth of chrome", tail.rows.map((r) => r.key), ["e3"]);
  }

  {
    seq = 0;
    const tail = buildTail([status("starting"), status("idle"), prompt("a"), prompt("b")], [], 3);
    check("a suppressed event draws no row above the cut either", tail.rows.map((r) => r.key), ["e3", "e4"]);
    check("while `hidden` goes on counting events rather than rows", tail.hidden, 2);
  }

  {
    // A workspace event earns no row, and nothing reads its warnings since latestWorkspaceWarnings was removed.
    seq = 0;
    const events = [
      workspace({ code: "dirty_source", message: "uncommitted work is not in this session" }),
    ];
    check("a workspace event draws no row", buildTail(events, []).rows.length, 0);
    check("because the type is suppressed by name", TRANSCRIPT_SILENT.has("workspace"), true);
  }

  {
    // Through the daemon a parked request keeps a null decision for life, so the merge must not key on that field.
    seq = 0;
    const settled = buildTail([asked("p1"), answered("p1")], []);
    check("a request whose answer follows is drawn once, by the answer", settled.rows.map((r) => r.key), ["e2"]);
  }

  {
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

  // A selected outcome also covers every reject option, so a refusal is read from the chosen option's kind.
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

    seq = 0;
    const strange = permissionDecisions([withOptions("p3"), answeredWith("p3", "o-elsewhere")]);
    check("an option the request never offered is unknown", strange.has("p3"), false);
    check("and unknown is never treated as a refusal", refused(strange.get("p3")), false);

    seq = 0;
    check(
      "a cancelled request records no option",
      permissionDecisions([withOptions("p4"), answeredWith("p4", null)]).has("p4"),
      false,
    );

    seq = 0;
    check(
      "a resolution with no request in the window is unknown rather than approved",
      refused(permissionDecisions([answeredWith("p5", "o-no")]).get("p5")),
      false,
    );
  }
}

// buildTail's flush keys on TRANSCRIPT_SILENT, not showsInTranscript: a silent event must not split a streamed message.

process.stdout.write("\nan event nobody draws does not break the message\n");
{
  let seq = 0;
  const at = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const say = (text: string): never => at({ type: "text", role: "agent", thought: false, text });
  const log = (line: string): never => at({ type: "agent_log", line });
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
    // Asserted as a pair: the first fails if plan joins TRANSCRIPT_SILENT, the second if suppression moves above the flush.
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
    seq = 0;
    check(
      "nor does codex's session_info_update",
      texts([say("```ts\nconst a = 1;\n"), other(), say("```")]),
      ["```ts\nconst a = 1;\n```"],
    );
  }

  {
    seq = 0;
    check("a status line does not either", texts([say("one "), status("running"), say("two")]), ["one two"]);
  }

  {
    // The merged run keeps its first chunk's key; keying on the newer half would remount the message on every token.
    seq = 0;
    check(
      "the merged run is one row, keyed by its first event",
      buildTail([say("a"), log("x"), say("b")], []).rows.map((row) => row.key),
      ["t1"],
    );
  }

  {
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

  check(
    "waiting beats a live count",
    machineSubline(group({ blockedCount: 2, liveCount: 5 })),
    { kind: "blocked", count: 2 },
  );
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

  check("a row button that merely took a click is not worth keeping", focusWorthKeeping(el({})), false);
  check("nor is nothing at all", [focusWorthKeeping(null), focusWorthKeeping(undefined)], [false, false]);
  check(
    "a text field somebody is typing in is",
    ["INPUT", "TEXTAREA", "SELECT"].map((tagName) => focusWorthKeeping(el({ tagName }))),
    [true, true, true],
  );
  check("so is a contenteditable", focusWorthKeeping(el({ isContentEditable: true })), true);
  check(
    "an open menu is, and a closed one is not",
    [
      focusWorthKeeping(el({ getAttribute: (n: string) => (n === "aria-expanded" ? "true" : null) })),
      focusWorthKeeping(el({ getAttribute: (n: string) => (n === "aria-expanded" ? "false" : null) })),
    ],
    [true, false],
  );
}

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

  // Q2.233: claude works with no turn of ours once background work comes back, and the daemon says so.
  const unprompted = (over: Record<string, unknown> = {}): never =>
    session({ turn: null, turnStartedAt: null, unpromptedSince: 5, ...over });
  check("work nobody prompted is working", [workingUnprompted(unprompted()), showsWorking(unprompted())], [true, true]);
  check(
    "a daemon too old to say, or one saying no, is not",
    [workingUnprompted(session({ turn: null })), workingUnprompted(unprompted({ unpromptedSince: null }))],
    [false, false],
  );
  check(
    "and it waits on you exactly as a turn does",
    showsWorking(unprompted({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
    false,
  );
  check(
    "and does not outlive the session",
    ["exited", "failed", "interrupted"].map((status) => showsWorking(unprompted({ status }))),
    [false, false, false],
  );
  check(
    "its clock starts at the turn, else at the unprompted work, else nowhere",
    [
      workStartedAt(session({ turnStartedAt: 3, unpromptedSince: 5 })),
      workStartedAt(unprompted()),
      workStartedAt(session({ turn: null, turnStartedAt: null })),
    ],
    [3, 5, null],
  );
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
    "but something to stop with no turn while the agent works or waits (Q2.232)",
    [
      canCancelTurn(unprompted()),
      canCancelTurn(session({ turn: null, status: "blocked", pendingElicitations: [{ elicitationId: "e" }] })),
    ],
    [true, true],
  );
  check(
    "and still nothing once the session is over or going",
    ["exited", "stopping"].map((status) => canCancelTurn(unprompted({ status }))),
    [false, false],
  );
  check(
    "and nothing to stop on a session that has ended",
    ["exited", "failed", "interrupted"].map((status) => canCancelTurn(session({ status }))),
    [false, false, false],
  );
  // A stopping session keeps its turn for seconds while dispose unwinds, and the daemon refuses a cancel there.
  check("nor on one somebody is already stopping", canCancelTurn(session({ status: "stopping" })), false);
  check("which isTerminal does not say", isTerminal("stopping"), false);

  check("nobody has asked yet", cancelInFlight(session({})), false);
  check("somebody has", cancelInFlight(session({ cancelRequestedAt: 1 })), true);
  check("an older daemon that cannot say reads as no cancel", cancelInFlight(session({ cancelRequestedAt: undefined })), false);
  check(
    "and a stale marker with no turn is not a cancel in flight",
    cancelInFlight(session({ turn: null, cancelRequestedAt: 1 })),
    false,
  );
  check(
    "while a cancel of unprompted work is, until that work ends",
    [cancelInFlight(unprompted({ cancelRequestedAt: 1 })), cancelInFlight(unprompted({ cancelRequestedAt: 1, unpromptedSince: null }))],
    [true, false],
  );

  const say = (over: Record<string, boolean>): string =>
    composerPlaceholder({
      blocked: false,
      reconnecting: false,
      working: false,
      revising: false,
      hasCommands: true,
      ...over,
    });
  check("an idle box teaches the one key nothing else does", say({}), "Type / for commands");
  check("but only where that key opens something", say({ hasCommands: false }), "Message…");
  {
    const every: string[] = [];
    for (const blocked of [false, true])
      for (const reconnecting of [false, true])
        for (const working of [false, true])
          for (const revising of [false, true])
            for (const hasCommands of [false, true])
              every.push(say({ blocked, reconnecting, working, revising, hasCommands }));
    const distinct = [...new Set(every)].sort();
    check("every placeholder this box can draw", distinct.length, 6);
    check("and each of them starts with a capital", distinct.filter((line) => !/^[A-Z]/.test(line)), []);
  }
  check("a working one says so", say({ working: true }), "Agent is working…");
  check(
    "an in-flight send during a restart explains the wait",
    say({ working: true, reconnecting: true }),
    "Reconnecting the agent…",
  );
  check(
    "and a blocked one points at the request above",
    say({ working: true, reconnecting: true, blocked: true }),
    "Answer the request above first",
  );
  check(
    "and it says so however the daemon would deliver a message sent now",
    say({ blocked: true }),
    "Answer the request above first",
  );

  {
    const parked = session({ turn: 4, status: "blocked", pendingPermissions: [{ permissionId: "p" }] });
    check(
      "a blocked session is never also a working one, whatever this grid says",
      [needsHuman(parked), showsWorking(parked)],
      [true, false],
    );
    check(
      "so the state a placeholder rule may not rely on is the one the app cannot build",
      say({ blocked: true, working: false }),
      say({ blocked: true, working: true }),
    );
  }
  check(
    "a plan on screen asks for the correction instead",
    say({ blocked: true, revising: true }),
    "Say what to change…",
  );
  check(
    "and it says so whatever else is true",
    say({ blocked: true, working: true, reconnecting: true, revising: true }),
    "Say what to change…",
  );

  // An absent midTurnDelivery must read as a daemon that still refuses mid-turn sends; defaulting it hands old daemons a live Send.
  {
    const snap = (over: Record<string, unknown>): never =>
      ({ status: "running", turn: 1, pendingPermissions: [], exit: null, agentSessionId: "a", resume: null, ...over }) as never;
    check("a daemon that does not send the field is one that still refuses", acceptsMidTurn(snap({})), false);
    check("and so is one with no agent to ask", acceptsMidTurn(snap({ midTurnDelivery: null })), false);
    check(
      "while both ways of taking one are yes",
      [acceptsMidTurn(snap({ midTurnDelivery: "steer" })), acceptsMidTurn(snap({ midTurnDelivery: "queue" }))],
      [true, true],
    );
    check("no queue on the wire is no seqs", queuedSeqs(snap({})).size, 0);
    check(
      "and a queued message is named by the seq of the prompt it already is",
      [...queuedSeqs(snap({ queuedPrompts: [{ id: "q_1", seq: 7, at: 0 }] }))],
      [7],
    );
  }

  // Source-text checks: these are JSX-level decisions with no pure function behind them.
  const composerSrc = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
  check(
    "a plan lifts the send gate rather than being gated by it",
    /const sessionRefused = revising\s*\n\s*\? false/.test(composerSrc),
    true,
  );
  check(
    "and the gate is the daemon's own answer rather than a constant",
    /const midTurnOk = acceptsMidTurn\(session\);/.test(composerSrc),
    true,
  );
  check(
    "and where the daemon cannot take one, the old refusal is still exactly that",
    /!midTurnOk && \(blocked \|\| working\)/.test(composerSrc),
    true,
  );
  check(
    "while a session already stopping is refused on every daemon",
    /session\.status === "stopping"/.test(composerSrc),
    true,
  );
  // The slot follows slotSends alone; a separate draftPresent drew a disabled Send over a live turn and hid Stop.
  check(
    "the slot is decided by whether Send would work",
    /const slotSends = sendable\(text, attachments, sendRefused\);/.test(composerSrc),
    true,
  );
  check(
    "and Stop holds it the rest of the time",
    /const stoppable = canCancelTurn\(session\) && !revising && !slotSends && !draftAnswerable;/.test(
      composerSrc,
    ),
    true,
  );
  check(
    "except where the refusal is about the draft, which keeps its own sentence",
    /const draftAnswerable = !sessionRefused && !slotSends &&/.test(composerSrc),
    true,
  );
  check(
    "and the one command the daemon still refuses while the agent works or waits is refused here too",
    /const clearRefused = !revising && canCancelTurn\(session\) && text\.trim\(\) === "\/clear";/.test(composerSrc),
    true,
  );
  // The occupant is one pure function now (Q3.654); the composer only says which facts it is given.
  const { slotOccupant } = await import("../src/ui/slotSwap.js");
  check(
    "and a sendable draft outranks the stopping spinner",
    slotOccupant({ sending: false, stopping: true, sends: true, stoppable: false }),
    "send",
  );
  check(
    "which is asked with a cancel in flight counted as stopping",
    /slotOccupant\(\{ sending: busy, stopping: stopping \|\| pendingCancel, sends: slotSends, stoppable \}\)/.test(composerSrc),
    true,
  );
  // Rejecting a plan does not end the turn, so a send from that state cancels first.
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
  check(
    "a plan does not release the caret",
    /needsHuman\(row\.snapshot\) && !revising;/.test(composerSrc),
    true,
  );

  // Nothing else checks hook order here (no eslint, no DOM): a hook after the guard throws React #310 when the row lands.
  const sessionViewSrc = readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8");
  const body = sessionViewSrc.slice(
    sessionViewSrc.indexOf("export function SessionView("),
    sessionViewSrc.indexOf("\nfunction SessionTitle("),
  );
  const guard = body.indexOf("\n  if (row === undefined) {");
  check("the guard clause is still where this check thinks it is", guard > 0, true);
  const late = [...body.matchAll(/\buse[A-Z]\w*\(/g)].filter((m) => (m.index ?? 0) > guard);
  check("no hook runs after SessionView's guard clause", late.map((m) => m[0]), []);

  // openSession may create no transcript, so plan detection must not wait on events; the snapshot carries the plan.
  check(
    "a plan is recognised before its transcript exists",
    /permissionContext\(pendingAsk, events \?\? \[\]\)\.plan !== null/.test(sessionViewSrc),
    true,
  );
  check(
    "and the card it is drawn beside makes the same read",
    /events=\{transcript\?\.events \?\? \[\]\}/.test(sessionViewSrc),
    true,
  );
}

process.stdout.write("\nthe send slot swaps rather than jumps\n");
{
  // One live occupant, the ones it replaced fading beneath it, inert (Q3.654).
  const { exitEnded, refocusBox, SLOT_ORDER, slotHolding, slotOccupant, SWAP_MS, swapTo } = await import(
    "../src/ui/slotSwap.js"
  );
  type Occupant = (typeof SLOT_ORDER)[number];
  const drawn = (state: { shown: Occupant; leaving: readonly { occupant: Occupant }[] }): string[] => [
    `live:${state.shown}`,
    ...state.leaving.map((one) => `out:${one.occupant}`),
  ];

  check(
    "a send in flight holds the slot whatever else is true",
    slotOccupant({ sending: true, stopping: true, sends: true, stoppable: true }),
    "sending",
  );
  check(
    "a cancel in flight draws its spinner over an empty box",
    slotOccupant({ sending: false, stopping: true, sends: false, stoppable: true }),
    "stopping",
  );
  check(
    "then Stop where the turn can be cancelled, and Send the rest of the time",
    [
      slotOccupant({ sending: false, stopping: false, sends: false, stoppable: true }),
      slotOccupant({ sending: false, stopping: false, sends: false, stoppable: false }),
    ],
    ["stop", "send"],
  );
  check("every occupant has one place in the layers' order", [...SLOT_ORDER].sort(), ["send", "sending", "stop", "stopping"]);

  const idle = slotHolding("send");
  check("the same occupant is no swap at all", swapTo(idle, "send", true) === idle, true);
  const toStop = swapTo(idle, "stop", true);
  check("a swap draws the new occupant live and the old one leaving", drawn(toStop), ["live:stop", "out:send"]);
  const back = swapTo(toStop, "send", true);
  // Send -> Stop -> Send inside one swap: the returning occupant is not also left fading.
  check("a flip back inside the swap draws each occupant once", drawn(back), ["live:send", "out:stop"]);
  check(
    "and three swaps inside one leave two fading and one live",
    drawn(swapTo(swapTo(idle, "sending", true), "stop", true)),
    ["live:stop", "out:send", "out:sending"],
  );
  check("reduced motion jumps and leaves nothing fading", drawn(swapTo(idle, "stop", false)), ["live:stop"]);
  check("and so does a jump over an occupant already there", drawn(swapTo(toStop, "stop", false)), ["live:stop"]);
  check("an exit ending takes its own layer away", drawn(exitEnded(toStop, toStop.swap)), ["live:stop"]);
  check("and a late end of an earlier swap takes nothing", exitEnded(back, toStop.swap) === back, true);

  // Every sequence of four swaps, each animated or not, with every exit ending or not: never two live, never none.
  const broken: string[] = [];
  const seqs: Occupant[][] = [[]];
  for (let depth = 0; depth < 4; depth += 1) {
    for (const seq of [...seqs]) if (seq.length === depth) for (const one of SLOT_ORDER) seqs.push([...seq, one]);
  }
  for (const seq of seqs) {
    for (let mask = 0; mask < 1 << (seq.length * 2); mask += 1) {
      let state = slotHolding("send");
      seq.forEach((one, i) => {
        const before = state.swap;
        state = swapTo(state, one, (mask >> (i * 2)) % 2 === 0);
        if ((mask >> (i * 2 + 1)) % 2 === 1) state = exitEnded(state, before);
        const out = state.leaving.map((l) => l.occupant);
        const ok =
          state.shown === one && !out.includes(state.shown) && new Set(out).size === out.length && out.length <= 3;
        if (!ok) broken.push(`${seq.join(">")}#${mask}`);
      });
    }
  }
  check("over every sequence of four swaps, one live occupant and no occupant drawn twice", broken, []);
  check("and the walk was taken", seqs.length, 341);

  check(
    "a swap that takes the focused control away hands focus to the box, on a desktop only",
    [refocusBox(true, false), refocusBox(true, true), refocusBox(false, false)],
    [true, false, false],
  );

  // One clock: SWAP_MS, the two classes, and the popover's rise it borrows.
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string): string =>
    new RegExp(`\\n${selector.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const swapIn = rule(".swap-in");
  const swapOut = rule(".swap-out");
  const glyphIn = rule(".swap-in svg");
  check("the three swap rules were found", [swapIn !== "", swapOut !== "", glyphIn !== ""], [true, true, true]);
  const clocks = [swapIn, swapOut, glyphIn].flatMap((body) => [...body.matchAll(/(\d+)ms/g)].map((m) => Number(m[1])));
  const rises = [...css.matchAll(/--animate-rise(?:-out)?: rise(?:-out)? (\d+)ms/g)].map((m) => Number(m[1]));
  check("every swap duration is SWAP_MS", [clocks.length >= 4, clocks.every((ms) => ms === SWAP_MS)], [true, true]);
  check("and SWAP_MS is rise's clock, arriving and leaving", [rises.length, rises.every((ms) => ms === SWAP_MS)], [2, true]);
  check(
    "arriving eases out and leaving eases in, as rise does",
    [/ease-out/.test(swapIn) && /ease-out/.test(glyphIn), /ease-in\b/.test(swapOut) && !/ease-out/.test(swapOut)],
    [true, true],
  );
  // The arriving button's box never scales, so a tap in the first frame lands on it at full size.
  check("the arriving layer only fades", /transform/.test(swapIn), false);
  const starting = /@starting-style \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  check(
    "and starts from nothing, its glyph from half size",
    [/\.swap-in \{\s*opacity: 0;\s*\}/.test(starting), /\.swap-in svg \{\s*transform: scale\(0\.5\);\s*\}/.test(starting)],
    [true, true],
  );
  check("the leaving one fades and shrinks", [/opacity: 0;/.test(swapOut), /transform: scale\(0\.6\);/.test(swapOut)], [
    true,
    true,
  ]);

  const slotSrc = readFileSync(new URL("../src/ui/SendSlot.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const leavingTag = /<div\s+key=\{one\}\s+inert[\s\S]*?>/.exec(slotSrc)?.[0] ?? "";
  check(
    "a leaving layer is inert, hidden from assistive technology and takes no pointer",
    [/\binert\b/.test(leavingTag), /aria-hidden="true"/.test(leavingTag), /pointer-events-none/.test(leavingTag), /swap-out/.test(leavingTag)],
    [true, true, true, true],
  );
  check(
    "and what it draws can do nothing",
    [/onClick=\{live \? onStop : undefined\}/.test(slotSrc), /type=\{live \? "submit" : "button"\}/.test(slotSrc)],
    [true, true],
  );
  check("the live layer paints on top", /className=\{`z-1 col-start-1 row-start-1 \$\{fading \? "swap-in" : ""\}`\}/.test(slotSrc), true);
  check("in one fixed order, since a moved node restarts its transition", /\{SLOT_ORDER\.map\(\(one\) =>/.test(slotSrc), true);
  check(
    "the swap is decided before paint, with reduced motion and another session jumping",
    [
      /useLayoutEffect\(\(\) => \{\s*if \(occupant === held\.slot\.shown && scope === held\.scope\) return;/.test(slotSrc),
      /const still = scope !== held\.scope \|\| window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches;/.test(slotSrc),
      /swapTo\(held\.slot, occupant, !still\)/.test(slotSrc),
    ],
    [true, true, true],
  );
  check(
    "focus is read while the old control still holds it, and given to the box",
    /refocusBox\(here\.current\?\.contains\(document\.activeElement\) \?\? false, window\.matchMedia\("\(pointer: coarse\)"\)\.matches\)\)\s*\{\s*box\.current\?\.focus\(\{ preventScroll: true \}\);/.test(
      slotSrc,
    ),
    true,
  );
  check(
    "an exit ends on its own opacity, with a backstop",
    [/event\.propertyName !== "opacity"/.test(slotSrc), /SWAP_MS \* 2/.test(slotSrc)],
    [true, true],
  );
  check("nothing in the slot is a hand-rolled button", /<button\b/.test(slotSrc), false);

  const composerCode = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
  check(
    "the composer hands the slot its occupant and draws none itself",
    [/<SendSlot\s+occupant=\{occupant\}/.test(composerCode), /icon=\{Square\}|icon=\{ArrowUp\}/.test(composerCode)],
    [true, false],
  );
  check("and the refusal line follows the same answer", /const sendDrawn = occupant === "send";/.test(composerCode), true);
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
  check("an ended session has no box to focus", ask({ hasBox: false }), false);
  check("a phone would raise the keyboard over half the screen", ask({ pointerCoarse: true }), false);
  check("something that already has focus keeps it", ask({ focusHeldElsewhere: true }), false);
  check("a blocked session points at the request instead", ask({ blocked: true }), false);
  // isTypingInto disables bare shortcuts once the composer has focus, so autofocus after j would break the next j.
  check("and `j`/`k` keep working for the next hop", ask({ fromKeyboardNav: true }), false);

  check("the flag starts down", takeKeyNav(), false);
  markKeyNav();
  check("the keyboard layer can raise it", takeKeyNav(), true);
  check("and reading it puts it down, so it cannot suppress the next switch", takeKeyNav(), false);
}

process.stdout.write("\nwhat a collapsed row says, and what a fence hides\n");
{
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
  check(
    "a command is drawn as it ran, prefix and all",
    toolSummary({ command: `ls -la ${ROOT}/src` }, [{ path: `${ROOT}/src`, line: null }], under(ROOT)).summary,
    `ls -la ${ROOT}/src`,
  );
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
  check(
    "with no relativiser at all, nothing moves",
    toolSummary({ file_path: `${ROOT}/src/a.ts` }, []).summary,
    `${ROOT}/src/a.ts`,
  );

  // Pins the EventList call site: the default relativiser answers null, so dropping it leaves every check above green.
  const eventList = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check("the row asks for a relative path", /toolSummary\([^;]*relFor/.test(eventList), true);
  check("and never takes the two-argument form", /toolSummary\(rawInput, locations\)/.test(eventList), false);
}

process.stdout.write("\nwhich files the composer will take\n");
{
  const { admitFiles } = await import("../src/attach.js");
  const { MAX_UPLOAD_BYTES } = await import("../src/wire.js");

  const file = (name: string, size: number): File => ({ name, size }) as File;
  const chip = (state: string, uploadId: string | null = null): never =>
    ({ state, uploadId }) as never;

  const ten = Array.from({ length: 10 }, (_, i) => chip("ready", `u_${i}`));
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

  const straddle = admitFiles(ten.slice(0, 8), [file("a", 1), file("b", 1), file("c", 1), file("d", 1)]);
  check("a batch over the limit accepts a prefix", straddle.accepted.map((f) => f.name), ["a", "b"]);
  check("and names the rest", straddle.refused.map((f) => f.file.name), ["c", "d"]);

  const failed = Array.from({ length: 10 }, () => chip("failed"));
  check("a failed chip does not occupy a slot", admitFiles(failed, [file("a", 1)]).accepted.length, 1);
  check("an uploading one does", admitFiles(Array.from({ length: 10 }, () => chip("uploading")), [file("a", 1)]).accepted.length, 0);
}

// restoreAttachments must merge, not assign: a chip attached during the in-flight send would lose its upload and cancel.

process.stdout.write("\na file attached while the send was in flight\n");
{
  const { addAttachments, attachmentsFor, forgetAttachments, restoreAttachments } = await import("../src/attach.js");

  const key = "m_1/s_1" as never;
  const chip = (localId: string, state = "ready"): never => ({ localId, state, uploadId: `u_${localId}` }) as never;
  const ids = (): string[] => attachmentsFor(key).map((item) => item.localId);

  {
    forgetAttachments(key);
    addAttachments(key, [chip("c")]);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("a chip attached mid-send survives the restore", ids(), ["a", "b", "c"]);
  }

  {
    forgetAttachments(key);
    addAttachments(key, [chip("late")]);
    restoreAttachments(key, [chip("early")]);
    check("and the restored ones lead, in their own order", ids(), ["early", "late"]);
  }

  {
    forgetAttachments(key);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("with nothing live it is the list as it was", ids(), ["a", "b"]);
  }

  {
    forgetAttachments(key);
    addAttachments(key, [chip("a"), chip("c")]);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("a file already back is not drawn twice", ids(), ["a", "b", "c"]);
  }

  {
    forgetAttachments(key);
    addAttachments(key, [chip("a")]);
    restoreAttachments(key, []);
    check("restoring nothing leaves what is there", ids(), ["a"]);
  }

  // Module state shared with later sections: leave it as found.
  forgetAttachments(key);
  check("and the fixture leaves nothing behind", attachmentsFor(key).length, 0);
}

// At lg a session switch does not remount Composer, so shared state written after an await must check onScreen.
// Comments are stripped so the patterns match code, not prose.

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

  check(
    "send is told whether it is arriving late",
    /const send = \(body: string, late: boolean\): void =>/.test(composer),
    true,
  );
  check("the keystroke door says it is not", /send\(sentText\(text\), false\)/.test(composer), true);
  check("and the config-round-trip door says it is", /send\(rest, true\)/.test(composer), true);
  check(
    "so the shared instance is written unconditionally on the synchronous one",
    /if \(!late \|\| onScreen\(\)\) \{/.test(composer),
    true,
  );

  const apply = region("const applyValue = ", "const choose = ");
  check("a config change that lands late asks whose composer this is", /onScreen\(\)/.test(apply), true);
  check("before it clears the control's spinner", /if \(present\) setApplying\(null\)/.test(apply), true);
  check("and before it closes a menu", /if \(ok && present\) closeMenu\(\)/.test(apply), true);
  check("the deferred callback still runs whatever the answer is", /^\s*onDone\?\.\(ok\);/m.test(apply), true);

  // Asserted by order, not presence: moving either shared write above the guard keeps both tokens.
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
  check("while the draft is still written for the session it was typed in", /drafts\.set\(key, next\.text\)/.test(oneTap), true);
  check("and cleared rather than left stale when the completion is empty", /drafts\.delete\(key\)/.test(oneTap), true);

  // Each shared flag gated against late writes also needs its reset on session switch, or a stuck flag outlives the session.
  const onSwitch = region("liveKey.current = key;", "}, [key]);");
  for (const [what, token] of [
    ["a send", "setBusy(false)"],
    ["a control change", "setApplying(null)"],
    ["a cancel", "setStopping(false)"],
  ] as const) {
    check(`switching session forgets ${what} dispatched against the last one`, onSwitch.includes(token), true);
  }
}

process.stdout.write("\nwhat a nameless file gets called\n");
{
  const { pastedName } = await import("../src/attach.js");
  // 2026-08-04T09:15:30Z, fixed so the assertion is about the shape.
  const at = Date.UTC(2026, 7, 4, 9, 15, 30);

  check("a real name is kept", pastedName("shot.png", "image/png", at), "shot.png");
  check("even an odd one", pastedName("Screen Shot 2026.png", "image/png", at), "Screen Shot 2026.png");
  check("whitespace around it is not a name", pastedName("   ", "image/png", at), "pasted-20260804-091530.png");

  check("a nameless png", pastedName("", "image/png", at), "pasted-20260804-091530.png");
  check("a jpeg gets the extension people expect", pastedName("", "image/jpeg", at), "pasted-20260804-091530.jpg");
  check("a subtype with a suffix is not one", pastedName("", "image/svg+xml", at), "pasted-20260804-091530.svg");
  check("an unlisted type takes its subtype", pastedName("", "application/pdf", at), "pasted-20260804-091530.pdf");
  check("a parameter on the type is ignored", pastedName("", "text/csv; charset=utf-8", at), "pasted-20260804-091530.csv");
  check("no type at all still gets a name", pastedName("", "", at), "pasted-20260804-091530.bin");
  check("and neither does a malformed one", pastedName("", "not-a-mime", at), "pasted-20260804-091530.bin");

  const generated = pastedName("", "image/png", at);
  check("what it generates is a single safe segment", /^[A-Za-z0-9._-]+$/.test(generated), true);
}

// SVG stays off the allowlist: it can carry script, and only the img element's engine behaviour would stop it.

process.stdout.write("\nwhat may be drawn inline\n");
{
  const { previewable, MAX_PREVIEW_BYTES } = await import("../src/preview.js");

  check("a png draws", previewable("image/png", 1024), true);
  check("a jpeg draws", previewable("image/jpeg", 1024), true);
  check("a gif draws", previewable("image/gif", 1024), true);
  check("a webp draws", previewable("image/webp", 1024), true);
  check("an svg never draws", previewable("image/svg+xml", 1024), false);
  check("nor does a pdf", previewable("application/pdf", 1024), false);
  check("nor does text", previewable("text/plain", 1024), false);
  check("nor an unknown image type", previewable("image/avif", 1024), false);

  check("a parameter on the type is ignored", previewable("image/png; charset=binary", 1024), true);
  check("and case is", previewable("IMAGE/PNG", 1024), true);

  check("exactly at the cap still draws", previewable("image/png", MAX_PREVIEW_BYTES), true);
  check("one byte over does not", previewable("image/png", MAX_PREVIEW_BYTES + 1), false);
  check("a zero size does not", previewable("image/png", 0), false);
  check("nor does a nonsense one", previewable("image/png", Number.NaN), false);
  check("and neither does a file with no type", previewable(null, 1024), false);
}

process.stdout.write("\nwhat is sent with a prompt\n");
{
  const { sendableAttachments } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null = null): never => ({ state, uploadId }) as never;

  check("ready chips are sent, in order", sendableAttachments([chip("ready", "u_2"), chip("ready", "u_1")]).ids, [
    "u_2",
    "u_1",
  ]);
  check("an upload in flight blocks", sendableAttachments([chip("uploading")]).blocked, true);
  check("a failed one does not", sendableAttachments([chip("failed")]).blocked, false);
  check("and is not sent", sendableAttachments([chip("ready", "u_1"), chip("failed")]).ids, ["u_1"]);
  check("ready with no id never reaches the wire", sendableAttachments([chip("ready", null)]).ids, []);
}

process.stdout.write("\nwhether a message can be sent at all\n");
{
  const { canSend } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null = null): never => ({ state, uploadId }) as never;

  check("text alone sends", canSend("hello", []), true);
  check("a file alone sends", canSend("", [chip("ready", "u_1")]), true);
  check("both send", canSend("look", [chip("ready", "u_1")]), true);
  check("neither does not", canSend("", []), false);
  check("nor does whitespace alone", canSend("   \n ", []), false);

  check("an upload in flight holds the send", canSend("hello", [chip("uploading")]), false);
  check("even with a ready file beside it", canSend("", [chip("ready", "u_1"), chip("uploading")]), false);
  // The third argument is a refusal the caller already decided; canSend never offers a send into it (Q3.454).
  check("a refusal the caller has decided is not overridden here", canSend("hello", [], true), false);
  check("whatever is attached to it", canSend("hello", [chip("ready", "u_1")], true), false);
  check("and with no refusal it is the rule it always was", canSend("hello", [], false), true);
  check("and the argument defaults to off, so nothing else had to change", canSend("hello", []), true);

  check("an empty box keeps Stop", canSend("", []), false);
  check("a space is not a message", canSend(" ", []), false);
  check("nor is a tab", canSend("\t", []), false);
  check("nor any run of them", canSend("  \t \n  ", []), false);
  check("one character takes the slot for Send", canSend("x", []), true);
  check("and so does a file with nothing typed", canSend("", [chip("ready", "u_1")]), true);
  check(
    "an upload in flight keeps Stop even with text typed",
    canSend("hello", [chip("uploading")]),
    false,
  );
  check(
    "and a daemon that would refuse the send keeps it too",
    canSend("hello", [], true),
    false,
  );

  check("a failed chip does not", canSend("hello", [chip("failed")]), true);
  check("and cannot be the whole message", canSend("", [chip("failed")]), false);

}

process.stdout.write("\na path inside the workspace, and one outside it\n");
{
  const { downloadablePath, filenameFor, formatBytes, relativeTo } = await import("../src/paths.js");

  check("an ordinary path", relativeTo("/w", "/w/a/b.ts"), "a/b.ts");
  check("a trailing slash on the root is the same answer", relativeTo("/w/", "/w/a.ts"), "a.ts");
  check("a prefix is not a boundary", relativeTo("/w", "/workspace/a"), null);
  check("the root itself is not a file", relativeTo("/w", "/w"), null);
  check("nor is a directory under it", relativeTo("/w", "/w/sub/"), null);
  check("a path elsewhere converts to nothing", relativeTo("/w", "/etc/passwd"), null);
  check("and neither does one that climbs out", relativeTo("/w", "/w/../etc/passwd"), null);
  check("an already-relative path passes through", relativeTo("/w", "a.ts"), "a.ts");
  check("unless it climbs", relativeTo("/w", "../a"), null);
  check("or contains a dot segment", relativeTo("/w", "a/./b"), null);

  // The daemon exposes no content-disposition header cross-origin, so the filename comes from the requested path.
  check("the name is the last segment", filenameFor("a/b/c.png"), "c.png");
  check("a bare name is itself", filenameFor("c.png"), "c.png");
  check("a directory has none", filenameFor("a/"), null);
  check("and neither does nothing", filenameFor(""), null);

  const touched = new Set(["/w/out.png", "/w/sub/a.svg", "/elsewhere/x.png"]);
  check("a file the session made", downloadablePath("/w/out.png", "/w", touched), "out.png");
  check("nested", downloadablePath("/w/sub/a.svg", "/w", touched), "sub/a.svg");
  check("a relative span resolves first", downloadablePath("sub/a.svg", "/w", touched), "sub/a.svg");

  check("a path outside the workspace is not offered", downloadablePath("/elsewhere/x.png", "/w", touched), null);
  check("nor is one the session never touched", downloadablePath("/w/never.png", "/w", touched), null);

  check("a command is not a path", downloadablePath("git commit -m x", "/w", touched), null);
  check("nor is prose with a slash", downloadablePath("and/or something", "/w", touched), null);
  check("a bare filename in the set counts", downloadablePath("out.png", "/w", touched), "out.png");
  check("a bare word that is not is refused", downloadablePath("npm", "/w", touched), null);
  check("nor is an empty span", downloadablePath("", "/w", touched), null);
  check("and a climb out is refused", downloadablePath("/w/../etc/passwd", "/w", new Set(["/w/../etc/passwd"])), null);

  check("bytes read as bytes", formatBytes(512), "512 B");
  check("and scale", formatBytes(2048), "2.0 KB");
  check("to something a chip can hold", formatBytes(100 * 1024 * 1024), "100 MB");
}
