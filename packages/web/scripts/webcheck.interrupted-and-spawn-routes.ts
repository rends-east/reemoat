import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { stripComments } from "./webcheck.source.js";
import {
  chipParts,
  chipValue,
  choiceRefusal,
  drawnControls,
  expandConfig,
  gapPlan,
  hasLiveAgent,
  holdConfig,
  isTerminal,
  labelFor,
  prune,
  reduceConfig,
  restartsAgent,
  showsCaption,
  splitOptions,
  unavailableHint,
} from "./webcheck.modules.js";

process.stdout.write("\nsessions the daemon interrupted\n");
{
  const {
    AGENT_LIVE_STATUSES,
    DAEMON_EXIT_REASONS,
    FINAL_EXIT_REASONS,
    TERMINAL_STATUSES,
    countsAsLive,
    endedWithDaemon,
    isParked,
    resumeStalled,
    showsAsEnded,
    waitingForDaemon,
  } = await import("../src/wire.js");
  type ExitReason = Parameters<typeof endedWithDaemon>[0] extends { reason: infer R } | null | undefined
    ? R
    : never;

  const REASONS = [
    "stopped",
    "agent_exited",
    "start_failed",
    "start_timeout",
    "daemon_shutdown",
    "agent_kill_failed",
    "daemon_restarted",
    "config_changed",
    "agent_signed_out",
    "parked",
  ] as const;

  // Written out once: the compiler ties these to the client's unions, the checks below tie them to the daemon's source.
  const STATUSES = ["starting", "idle", "running", "blocked", "stopping", "exited", "failed", "interrupted", "parked"] as const;
  const LAG_REASONS = ["evicted", "slow_consumer", "backlog"] as const;

  // wire.ts is a hand-made copy of src/events.ts, so the daemon's side is read off disk and compared.
  {
    const daemon = readFileSync(new URL("../../../src/events.ts", import.meta.url), "utf8");
    const union = daemon.slice(daemon.indexOf("export type ExitReason ="));
    const members = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("every exit reason the daemon can write is in the client's union", members.sort(), [...REASONS].sort());

    const listed = daemon.slice(daemon.indexOf("export const DAEMON_EXIT_REASONS"));
    const daemonSide = [...listed.slice(0, listed.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("and the two sides agree on which of them mean the daemon went away", daemonSide.sort(), [
      ...DAEMON_EXIT_REASONS,
    ].sort());

    // endedWithDaemon tests not-final, so an unknown reason reads as coming back; that holds only while the lists partition the union.
    check(
      "the exit-reason lists partition the daemon's union, with parked its own part",
      [...DAEMON_EXIT_REASONS, ...FINAL_EXIT_REASONS, "parked"].sort(),
      [...members].sort(),
    );
    check(
      "parked is in neither list: not resumed at boot, and not final",
      [
        DAEMON_EXIT_REASONS.includes("parked" as ExitReason),
        FINAL_EXIT_REASONS.includes("parked" as ExitReason),
      ],
      [false, false],
    );
    check(
      "and nothing is in both",
      DAEMON_EXIT_REASONS.filter((reason) => FINAL_EXIT_REASONS.includes(reason)),
      [],
    );
    check(
      "an exit reason from a newer daemon reads as coming back, not as ended",
      endedWithDaemon({ reason: "something_invented_later" as ExitReason }),
      true,
    );

    // Stripped: a docblock inside the SessionStatus union contains a semicolon that would cut the raw slice short.
    const daemonCode = daemon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const statusUnion = daemonCode.slice(daemonCode.indexOf("export type SessionStatus ="));
    const statusMembers = [...statusUnion.slice(0, statusUnion.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("every status the daemon derives is in the client's union", statusMembers.sort(), [...STATUSES].sort());

    check(
      "and TERMINAL_STATUSES holds exactly the ones isTerminal answers for",
      STATUSES.filter((status) => isTerminal(status)).sort(),
      [...TERMINAL_STATUSES].sort(),
    );
    check(
      "and AGENT_LIVE_STATUSES exactly the ones hasLiveAgent answers for",
      STATUSES.filter((status) => hasLiveAgent(status)).sort(),
      [...AGENT_LIVE_STATUSES].sort(),
    );
    check(
      "and the only statuses that are neither are the two transitional ones",
      STATUSES.filter((status) => isTerminal(status) === hasLiveAgent(status)).sort(),
      ["starting", "stopping"],
    );
  }

  // Stripped because a comment quotes a lagged reason; the daemon writes reasons as literals and in the collapse signature.
  {
    const server = readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const written = [...server.matchAll(/type: "lagged",[\s\S]{0,240}?reason: "([a-z_]+)"/g)].map((m) => m[1]);
    const signature = "private collapse(reason:";
    const sig = server.includes(signature) ? server.slice(server.indexOf(signature)) : "";
    const argued = [...sig.slice(0, sig.indexOf(")")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("the daemon still writes lagged reasons as literals", written.length > 0, true);
    check("and still names the rest in collapse's own signature", argued.length > 0, true);
    check(
      "every reason the daemon can lag with is in the client's union",
      [...new Set([...written, ...argued])].sort(),
      [...LAG_REASONS].sort(),
    );
    // gapPlan takes the client's union, so a reason the client lacks fails tsc here.
    check(
      "and the client plans for each of them",
      LAG_REASONS.map((reason) => gapPlan(reason, 4_000).kind),
      ["record", "record", "restart"],
    );
  }

  check("a daemon shutdown is the daemon going away", endedWithDaemon({ reason: "daemon_shutdown" }), true);
  check("and so is a crash", endedWithDaemon({ reason: "daemon_restarted" }), true);
  check("a stop is not", endedWithDaemon({ reason: "stopped" }), false);
  check("nor is an agent quitting by itself", endedWithDaemon({ reason: "agent_exited" }), false);
  check("nor a failed start", [endedWithDaemon({ reason: "start_failed" }), endedWithDaemon({ reason: "start_timeout" })], [false, false]);
  check("nor an ambiguous legacy kill", endedWithDaemon({ reason: "agent_kill_failed" }), false);
  check("and a live session has no exit to ask about", [endedWithDaemon(null), endedWithDaemon(undefined)], [false, false]);
  const sessionOf = (over: Record<string, unknown>) => ({ ...snapshot, ...over }) as never;

  check(
    "every reason in the union is accounted for",
    REASONS.filter((reason) => endedWithDaemon({ reason })).sort(),
    [...DAEMON_EXIT_REASONS, "parked"].sort(),
  );
  // endedWithDaemon is true for parked by design (the fail-safe for unknown reasons), so isParked must be tested first.
  check(
    "endedWithDaemon is not exact about parked, and isParked is what runs first",
    [
      endedWithDaemon({ reason: "parked" as ExitReason }),
      waitingForDaemon(sessionOf({ status: "parked", exit: { reason: "parked" }, agentSessionId: "a_1" })),
    ],
    [true, false],
  );


  const matrix: Record<string, unknown>[] = [];
  for (const status of ["running", "idle", "exited", "failed", "interrupted", "parked"]) {
    for (const reason of REASONS) {
      for (const agentSessionId of ["a_1", null]) {
        for (const state of [undefined, "waiting", "running", "failed"]) {
          matrix.push({
            status,
            agentSessionId,
            exit: status === "running" || status === "idle" ? null : { reason },
            resume: state === undefined ? undefined : { state, attempts: 1, error: null, at: 0 },
          });
        }
      }
    }
  }
  const broken = matrix.filter((over) => {
    const session = sessionOf(over);
    const hits = [
      isParked(session),
      waitingForDaemon(session),
      resumeStalled(session),
      showsAsEnded(session),
    ].filter(Boolean).length;
    return (over["status"] === "running" || over["status"] === "idle") ? hits !== 0 : hits !== 1;
  });
  check("exactly one presentation holds for every terminal session", broken.length, 0);

  const deployed = sessionOf({ status: "exited", exit: { reason: "daemon_shutdown" }, agentSessionId: "a_1" });
  check("a graceful restart is waiting, not ended", [waitingForDaemon(deployed), showsAsEnded(deployed)], [true, false]);
  check("and it still counts as live", countsAsLive(deployed), true);

  const givenUp = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "x" }, at: 0 },
  });
  check("one the daemon gave up on is stalled", [resumeStalled(givenUp), showsAsEnded(givenUp)], [true, false]);
  check("and stops counting as live", countsAsLive(givenUp), false);

  // An older daemon sends no resume field, so absence must read as waiting, never as failed.
  const older = sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: "a_1" });
  check("no resume field yet reads as waiting", [waitingForDaemon(older), resumeStalled(older)], [true, false]);

  const nothingToResume = sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: null });
  check("and nothing to reattach to is stalled, not ended", resumeStalled(nothingToResume), true);

  const { lastSeenText } = await import("../src/wire.js");
  const now = 1_800_000_000_000;

  check("an older control plane says nothing", lastSeenText(undefined, now), null);
  check("and a machine that never dialled in says nothing either", lastSeenText(null, now), null);
  check("nor does one that went away seconds ago", lastSeenText(now - 4_000, now), null);

  check("minutes are minutes", lastSeenText(now - 20 * 60_000, now), "last seen 20 min ago");
  check("hours are hours", lastSeenText(now - 5 * 3_600_000, now), "last seen 5 h ago");
  check("and a machine that has been gone for days says so", lastSeenText(now - 9 * 86_400_000, now), "last seen 9 days ago");
  check(
    "each step hands over cleanly",
    [lastSeenText(now - 5_399_000, now), lastSeenText(now - 5_401_000, now)],
    ["last seen 90 min ago", "last seen 2 h ago"],
  );
  check("and a future stamp is not a negative age", lastSeenText(now + 60_000, now), null);
}

process.stdout.write("\nwhat an interrupted session says\n");
{
  const { resumeFailureText, resumeRetryable, sessionNotice, statusTone } = await import("../src/ui/bits.js");
  const { countsAsLive, resumeStalled, showsAsEnded, waitingForDaemon } = await import("../src/wire.js");
  const sessionOf = (over: Record<string, unknown>) => ({ ...snapshot, ...over }) as never;

  const stopped = sessionOf({
    status: "exited",
    exit: { reason: "stopped", detail: null, agentConfirmedDead: true },
  });
  const deployed = sessionOf({ status: "exited", exit: { reason: "daemon_shutdown" }, agentSessionId: "a_1" });
  const stalled = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "x" }, at: 0 },
  });

  const { exitText } = await import("../src/ui/bits.js");
  // Compared with the fallback's exact output, not a substring: the stopped sentence contains its own reason name.
  const reachable = ["stopped", "agent_exited", "start_failed", "start_timeout", "agent_kill_failed"] as const;
  check(
    "every exit reason a person can be shown has a sentence of its own",
    reachable.filter((reason) => exitText(reason) === `ended: ${reason}`),
    [],
  );
  check("a session somebody stopped says who did it", sessionNotice(stopped, "kimi", "box")?.text, "you stopped this conversation");
  const waitingText = sessionNotice(deployed, "kimi", "box")?.text ?? "";
  check("an interrupted one never says ended", waitingText.includes("ended"), false);
  check("nor names an exit reason", /daemon_shutdown|daemon_restarted/.test(waitingText), false);
  check("it says what is actually happening", waitingText, "the daemon restarted — reconnecting the agent");
  check("and offers no button, because nobody needs to press one", sessionNotice(deployed, "kimi", "box")?.action, null);

  const deferredCli = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: {
      state: "waiting",
      attempts: 0,
      error: { code: "agent_unavailable", message: "kimi is not on this daemon's PATH or in the directories deploy/agents.sh installs into" },
      at: 0,
    },
  });
  const deferredNotice = sessionNotice(deferredCli, "kimi", "box");
  check("a session waiting for its CLI to be installed is waiting, not stalled", [waitingForDaemon(deferredCli), resumeStalled(deferredCli)], [true, false]);
  check("and says so", deferredNotice?.text, "kimi is not installed on box — waiting for it to be installed");
  check("quietly, with no button", [deferredNotice?.tone, deferredNotice?.action], ["quiet", null]);
  check("and never the daemon's own paragraph", deferredNotice?.text.includes("deploy/agents.sh"), false);

  const stalledNotice = sessionNotice(stalled, "kimi", "box");
  check("a stalled one is warn-toned", stalledNotice?.tone, "warn");
  check("says what the daemon said", stalledNotice?.text, "could not reconnect the agent — kimi is not signed in on box");
  check("and offers the sign-in it has actually verified", stalledNotice?.action, "sign_in");
  const stalledOther = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_start_timeout", message: "x" }, at: 0 },
  });
  check("while any other failure still offers the retry", sessionNotice(stalledOther, "kimi", "box")?.action, "reconnect");
  check("a live session says nothing at all", sessionNotice(sessionOf({ status: "running", exit: null }), "kimi", "box"), null);

  const signedOut = sessionOf({
    status: "exited",
    exit: { reason: "agent_signed_out", detail: null, at: 1, agentConfirmedDead: true },
  });
  const out = sessionNotice(signedOut, "claude", "box");
  check("it names the agent and the machine", out?.text, "claude could not authenticate on box, so this conversation stopped.");
  check("never as an internal reason", /agent_signed_out|ended:/.test(out?.text ?? ""), false);
  check(
    "and it asserts nothing about the present",
    /signed in|comes back/.test(out?.text ?? ""),
    false,
  );
  check("and it offers the reconnect, which is the one that works", out?.action, "reconnect");
  const view = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
  check("the view draws it as a route to that machine", /settingsPath\("machines", row\.ref\.machineId\)/.test(view), true);
  check("and never names a system from an agent id", /settingsPath\([^)]*row\.snapshot\.agent\)/.test(view), false);
  check("and the two buttons are mutually exclusive by construction", /notice\.retry/.test(view), false);

  const composer = stripComments(readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"));
  // A refused send only restores the text, so without a toast it is silent; no code is exempt (Q7.102).
  check("a refused send is never silent", /catch\(\(cause: unknown\)[\s\S]*?toast\("error", errorText\(cause\)\);/.test(composer), true);
  check("with no code carved out of it", /cause\.code === "(agent_signed_out|session_terminal)"/.test(composer), false);
  check("while still putting the message back", /restoreAttachments\(key, sent\);/.test(composer), true);

  const orphaned = sessionOf({
    status: "exited",
    exit: { reason: "stopped", detail: null, agentConfirmedDead: false },
  });
  check("an unconfirmed kill is reported when somebody stopped it", sessionNotice(orphaned, "kimi", "box")?.text, "you stopped this conversation (agent not confirmed dead)");

  check("a stopped session's dot is dim", statusTone(stopped), "ended");
  // The pair that matters: same `status`, opposite tone, decided by the reason.
  check("an interrupted one's is not", statusTone(deployed), "waiting");
  check("a hard restart reads the same as a graceful one", statusTone(sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: "a_1" })), "waiting");
  check("and one nobody is coming for is loud", statusTone(stalled), "stalled");
  check("a live session keeps its own tone", [
    statusTone(sessionOf({ status: "running", exit: null })),
    statusTone(sessionOf({ status: "blocked", exit: null })),
  ], ["running", "blocked"]);
  check("and a starting one has its own, which is neither", statusTone(sessionOf({ status: "starting", exit: null })), "starting");

  const parked = sessionOf({ status: "parked", exit: { reason: "parked" }, agentSessionId: "a_1" });
  const plainIdle = sessionOf({ status: "idle", exit: null });
  check("a released agent is drawn exactly as a quiet one", statusTone(parked), statusTone(plainIdle));
  check(
    "and never as ended, which is what somebody deciding looks like",
    [statusTone(parked) === "ended", statusTone(parked) === "waiting"],
    [false, false],
  );
  // sessionNotice falls through to exitText, so parked needs its own explicit null.
  check(
    "and says nothing at all, exactly as a live session does",
    [sessionNotice(parked, "claude", "box"), sessionNotice(plainIdle, "claude", "box")],
    [null, null],
  );
  check(
    "it is not live, and not ended",
    [countsAsLive(parked), showsAsEnded(parked)],
    [false, false],
  );
  const stoppedByHand = sessionOf({
    status: "exited",
    exit: { reason: "stopped", detail: null, agentConfirmedDead: true },
    agentSessionId: "a_1",
  });
  check(
    "a released session and a stopped one are filed apart",
    showsAsEnded(parked) === showsAsEnded(stoppedByHand),
    false,
  );
  check(
    "and only one of them says somebody ended it",
    [sessionNotice(parked, "claude", "box"), sessionNotice(stoppedByHand, "claude", "box")?.text],
    [null, "you stopped this conversation"],
  );

  // TONE_DOT is module-private, so it is read off disk; the working row is WorkingMark (formerly WorkingDot) with its own keyframe.
  {
    const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    const table = bits.slice(bits.indexOf("const TONE_DOT"));
    const blinking = [...table.slice(0, table.indexOf("\n};")).matchAll(/^\s{2}([a-z]+):.*animate-blink/gm)].map(
      (match) => match[1],
    );
    check("only one tone blinks, and it is the one that means work", blinking, ["running"]);
  }

  check("a missing conversation cannot be retried", resumeRetryable("no_agent_session_id"), false);
  check("nor can an agent that does not support it", resumeRetryable("resume_unsupported"), false);
  check("nor one whose conversation the agent lost", resumeRetryable("agent_forgot_session"), false);
  check(
    "and that says the transcript survived",
    resumeFailureText("agent_forgot_session", "", "claude", "box").includes("intact"),
    true,
  );
  check("an unknown code falls open", resumeRetryable("something_new"), true);
  check("and shows the daemon's own words", resumeFailureText("something_new", "the disk is on fire", "kimi", "box"), "the disk is on fire");
  check("a folder that is gone is still retryable, because it can be put back", resumeRetryable("workspace_missing"), true);
}

process.stdout.write("\nthe routes that spawn a process\n");
{
  const { slowRoute } = await import("../src/machine.js");

  // A client deadline below the daemon's is a transport failure that marks a healthy machine unreachable.
  check("creating a session is slow", slowRoute("POST", "/sessions"), true);
  check("resuming one is slow", slowRoute("POST", "/sessions/s_1/resume"), true);
  check("changing a control is slow", slowRoute("POST", "/sessions/s_1/config"), true);
  check("the login probe is slow", [slowRoute("GET", "/agents"), slowRoute("GET", "/agent-auth/x")], [true, true]);
  check("and so is a prompt, now that it may resume first", slowRoute("POST", "/sessions/s_1/prompt"), true);
  check("reading events is not", slowRoute("GET", "/sessions/s_1/events"), false);
  check("nor is answering a permission", slowRoute("POST", "/sessions/s_1/permissions/p_1"), false);
  check("nor is listing sessions", slowRoute("GET", "/sessions"), false);
  check("and stopping a turn is not, because it does not wait for the agent", slowRoute("POST", "/sessions/s_1/cancel"), false);

  // The GET /agents prefix is slow on purpose: only a CLI answers under it, so no member is pinned false.
  const budgets: [string, string, boolean][] = [
    ["POST", "/sessions", true],
    ["POST", "/sessions/s_1/prompt", true],
    ["POST", "/sessions/s_1/resume", true],
    ["POST", "/sessions/s_1/config", true],
    ["POST", "/plugins/source", true],
    ["POST", "/plugins/p_1/state", true],
    ["GET", "/agents", true],
    ["GET", "/agents/capabilities", true],
    ["GET", "/agent-auth/claude", true],
    // Only the writes: each re-validates the pairing by spawning an agent.
    ["POST", "/custom-agents", true],
    ["PATCH", "/custom-agents/ca_1234abcd", true],
    // The reads are synchronous SQLite on the builder's first paint, so they keep the ordinary budget.
    ["GET", "/custom-agents", false],
    ["DELETE", "/custom-agents/ca_1234abcd", false],
    ["GET", "/sessions", false],
    ["GET", "/sessions/s_1/events", false],
    ["POST", "/sessions/s_1/permissions/p_1", false],
    ["POST", "/sessions/s_1/cancel", false],
  ];
  check(
    "and every route in the table agrees with its budget, swept in both directions",
    budgets.filter(([verb, path, want]) => slowRoute(verb, path) !== want).map(([verb, path]) => `${verb} ${path}`),
    [],
  );

  // slowRoute sees the sent method, so the client's verbs are read off disk and fed back through it.
  const client = stripComments(readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8"));
  const writeVerb = (method: string): string =>
    /method: "([A-Z]+)"/.exec(client.slice(client.indexOf(`  ${method}(`)))?.[1] ?? "";
  check(
    "the two writes that assemble an agent send the verbs the table names",
    [writeVerb("addCustomAgent"), writeVerb("updateCustomAgent")],
    ["POST", "PATCH"],
  );
  check(
    "and each of them lands on the slow budget as sent",
    [
      slowRoute(writeVerb("addCustomAgent"), "/custom-agents"),
      slowRoute(writeVerb("updateCustomAgent"), "/custom-agents/ca_1234abcd"),
    ],
    [true, true],
  );
  // DELETE is replayable on the ordinary budget, and the route's idempotent answer to a missing id depends on that.
  check(
    "and the delete is sent as DELETE and stays on the budget the idempotence argument rests on",
    [writeVerb("removeCustomAgent"), slowRoute(writeVerb("removeCustomAgent"), "/custom-agents/ca_1234abcd")],
    ["DELETE", false],
  );
  check(
    "the client promises the discriminator the daemon actually sends",
    /removeCustomAgent\(id: string\): Promise<\{ removed: boolean; id: string \}>/.test(client),
    true,
  );

  const config = (ids: string[]) => ({
    modes: null,
    options: ids.map((id) => ({
      id,
      name: id,
      description: null,
      // The agents publish effort under the thought_level category.
      category: id === "effort" ? "thought_level" : id,
      kind: "select" as const,
      value: "a",
      choices: [{ value: "a", name: "A", description: null, group: null }],
    })),
  });
  const live = config(["mode", "model"]);

  // stopping is not live: doStop fans out an emptied config while stopping.
  check(
    "an agent exists in exactly three statuses",
    (["starting", "idle", "running", "blocked", "stopping", "exited", "failed", "interrupted"] as const).filter(
      (status) => hasLiveAgent(status),
    ),
    ["idle", "running", "blocked"],
  );

  check("a running agent's controls are what is held", holdConfig(undefined, { status: "idle", agentConfig: live }), live);
  check(
    "an emptied config on a session the daemon is bringing back keeps them",
    holdConfig(live as never, { status: "interrupted", agentConfig: { modes: null, options: [] } }),
    live,
  );
  check(
    "and so does the window while it starts again",
    holdConfig(live as never, { status: "starting", agentConfig: { modes: null, options: [] } }),
    live,
  );
  check(
    "and the one where it is being torn down, which fans out an emptied snapshot",
    holdConfig(live as never, { status: "stopping", agentConfig: { modes: null, options: [] } }),
    live,
  );
  check(
    "but a live agent that publishes nothing clears the memory",
    holdConfig(live as never, { status: "idle", agentConfig: { modes: null, options: [] } }),
    { modes: null, options: [] },
  );
  check(
    "and an older daemon that sends no config at all on a live session clears it too",
    holdConfig(live as never, { status: "idle", agentConfig: undefined }),
    undefined,
  );

  // The ids drawnControls synthesizes for unpublished slots (see placeholderFor); they must stay namespaced.
  const ABSENT_MODE = "reemoat:mode";
  const ABSENT_MODEL = "reemoat:model";
  const ABSENT_EFFORT = "reemoat:thought_level";

  const drawnFrom = (status: string, options: string[] | null, held: string[] | null) =>
    drawnControls(
      { status, agentConfig: options === null ? undefined : config(options) } as never,
      held === null ? undefined : (config(held) as never),
    );
  check(
    "a live agent's controls come from the daemon, and the slots it skipped are added after",
    [
      drawnFrom("idle", ["mode"], ["mode"]).options.map((o: { id: string }) => o.id),
      drawnFrom("idle", ["mode"], ["mode"]).stale,
    ],
    [["mode", ABSENT_MODEL, ABSENT_EFFORT], false],
  );
  check(
    "and one it has dropped is added after them, marked",
    [
      drawnFrom("idle", ["mode"], ["old"]).options.map((o: { id: string }) => o.id),
      [...drawnFrom("idle", ["mode"], ["old"]).unavailable],
    ],
    [
      ["mode", "old", ABSENT_MODEL, ABSENT_EFFORT],
      ["old", ABSENT_MODEL, ABSENT_EFFORT],
    ],
  );
  check(
    "a live agent with nothing to offer still draws the slots, and is not stale",
    [
      drawnFrom("idle", [], ["old"]).options.map((o: { id: string }) => o.id),
      drawnFrom("idle", [], ["old"]).stale,
    ],
    [[ABSENT_MODE, ABSENT_MODEL, ABSENT_EFFORT], false],
  );
  check(
    "an absent agent draws the memory, and says so",
    [
      drawnFrom("interrupted", [], ["mode", "model"]).options.map((o: { id: string }) => o.id),
      drawnFrom("interrupted", [], ["mode", "model"]).stale,
    ],
    [["mode", "model", ABSENT_EFFORT], true],
  );
  check(
    "an absent agent with nothing remembered draws the slots rather than vanishing",
    [
      drawnFrom("exited", [], null).options.map((o: { id: string }) => o.id),
      drawnFrom("exited", [], null).stale,
      [...drawnFrom("exited", [], null).unavailable],
    ],
    [
      [ABSENT_MODE, ABSENT_MODEL, ABSENT_EFFORT],
      false,
      [ABSENT_MODE, ABSENT_MODEL, ABSENT_EFFORT],
    ],
  );
  // Statuses are read off the daemon rather than copied, so a new status is swept.
  const daemonStatuses = (() => {
    const code = readFileSync(new URL("../../../src/events.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const union = code.slice(code.indexOf("export type SessionStatus ="));
    return [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
  })();
  report("the sweep's statuses came off the daemon, not a copy", daemonStatuses.length > 0, `${daemonStatuses.length} read`);
  const LIVE_SHAPES = [null, [], ["mode"]];
  const HELD_SHAPES = [null, [], ["mode", "model"]];
  const combinations = daemonStatuses.flatMap((status) =>
    LIVE_SHAPES.flatMap((live) => HELD_SHAPES.map((held) => ({ status, live, held }))),
  );
  const empties = combinations.filter(
    ({ status, live, held }) => drawnFrom(status, live, held).options.length === 0,
  );
  // The combinations count is a product by construction, so the swept set is compared with wire.ts's classification instead.
  const { AGENT_LIVE_STATUSES, TERMINAL_STATUSES } = await import("../src/wire.js");
  check(
    "the sweep tried every status the daemon derives, and the client classifies no others",
    [...new Set(combinations.map(({ status }) => status))].sort(),
    [...new Set([...AGENT_LIVE_STATUSES, ...TERMINAL_STATUSES, "starting", "stopping"])].sort(),
  );
  check("and not one of them leaves the composer with no controls at all", empties, []);
  // The first branch of drawnControls must ignore status: parked and stopped sessions arrive with real config.
  check(
    "a non-empty config is never stale, whatever the session's status says",
    daemonStatuses.filter((status) => HELD_SHAPES.some((held) => drawnFrom(status, ["mode"], held).stale)),
    [],
  );
  {
    let held = holdConfig(undefined, { status: "idle", agentConfig: live });
    const drawn: { ids: string[]; stale: boolean }[] = [];
    for (const status of ["interrupted", "starting", "idle"] as const) {
      const snapshot = {
        status,
        agentConfig: status === "idle" ? live : { modes: null, options: [] },
      };
      held = holdConfig(held, snapshot as never);
      const step = drawnControls(snapshot as never, held);
      drawn.push({
        ids: step.options.map((option) => option.id),
        stale: step.stale,
      });
    }
    check("across a whole restart the same controls stay on screen", drawn, [
      { ids: ["mode", "model", ABSENT_EFFORT], stale: true },
      { ids: ["mode", "model", ABSENT_EFFORT], stale: true },
      { ids: ["mode", "model", ABSENT_EFFORT], stale: false },
    ]);
  }

  {
    const both = config(["mode", "model", "effort"]);
    const withoutEffort = config(["mode", "model"]);
    let kept = holdConfig(undefined, { status: "idle", agentConfig: both } as never);
    kept = holdConfig(kept, { status: "idle", agentConfig: withoutEffort } as never);
    const drawn = drawnControls({ status: "idle", agentConfig: withoutEffort } as never, kept);
    check(
      "a control the model dropped keeps its slot",
      drawn.options.map((option) => option.id),
      ["mode", "model", "effort"],
    );
    check("and is marked as having nothing to choose", [...drawn.unavailable], ["effort"]);
    check("while the session itself is not stale — there is an agent", drawn.stale, false);

    const returned = holdConfig(kept, { status: "idle", agentConfig: both } as never);
    const after = drawnControls({ status: "idle", agentConfig: both } as never, returned);
    check(
      "and a model that offers it again makes it live",
      [after.options.map((option) => option.id), [...after.unavailable]],
      [["mode", "model", "effort"], []],
    );

    const away = drawnControls(
      { status: "interrupted", agentConfig: { modes: null, options: [] } } as never,
      kept,
    );
    check("a session with no agent reports nothing unavailable", [away.stale, [...away.unavailable]], [true, []]);


    const opencode = drawnControls(
      { status: "idle", agentConfig: config(["mode", "model"]) } as never,
      undefined,
    );
    check(
      "an agent that never published an effort control gets the slot anyway",
      [opencode.options.map((option) => option.id), [...opencode.unavailable], opencode.stale],
      [["mode", "model", ABSENT_EFFORT], [ABSENT_EFFORT], false],
    );
    check(
      "the synthesized slot is namespaced, so no agent could have published it",
      // Read off the drawn slot, not ABSENT_EFFORT, which would be a literal testing itself.
      [opencode.options.at(-1)?.id.startsWith("reemoat:"), opencode.options.at(-1)?.category],
      [true, "thought_level"],
    );
    check(
      "and it says the one thing that is true about it",
      unavailableHint(
        opencode.options.at(-1) as never,
        opencode.never.has(opencode.options.at(-1)?.id ?? ""),
      ),
      "The model in use offers no levels here. Another model may.",
    );
    check(
      "and this machine knows it is never coming back",
      opencode.never.has(opencode.options.at(-1)?.id ?? ""),
      true,
    );
    // Empty choices keep it out of the slash menu: buildCommands skips an empty select.
    check(
      "it carries nothing to choose, so it can neither be tapped nor typed",
      [opencode.options.at(-1)?.kind, opencode.options.at(-1)?.choices.length],
      ["select", 0],
    );
    check(
      "it sits in the right-hand cluster after the model, where a real one sits",
      splitOptions(opencode.options).right.map((option) => option.id),
      ["model", ABSENT_EFFORT],
    );
    const stood = opencode.options.at(-1) as never;
    const published = config(["effort"]).options[0] as never;
    check(
      "and the slot stands in for an effort control, drawing what one draws",
      [(stood as { category: string }).category, chipParts(stood, false)],
      [(published as { category: string }).category, chipParts(published, false)],
    );
    check(
      "and no slot this strip invents draws a caption, which is why comparing two proves nothing",
      drawnFrom("exited", [], null).options.map((option) => [option.category, showsCaption(option)]),
      [
        ["mode", false],
        ["model", false],
        ["thought_level", false],
      ],
    );
    check(
      "a live agent offering nothing still gets the three slots",
      [
        drawnFrom("idle", [], ["mode"]).options.map((option: { id: string }) => option.id),
        [...drawnFrom("idle", [], ["mode"]).unavailable],
      ],
      [
        [ABSENT_MODE, ABSENT_MODEL, ABSENT_EFFORT],
        [ABSENT_MODE, ABSENT_MODEL, ABSENT_EFFORT],
      ],
    );
    check(
      "and so does a session with no agent and nothing remembered",
      [
        drawnFrom("exited", [], null).options.map((option: { id: string }) => option.id),
        drawnFrom("exited", [], null).stale,
      ],
      [[ABSENT_MODE, ABSENT_MODEL, ABSENT_EFFORT], false],
    );

    // Only the selected choice is kept: chipValue needs it to name the value, and opencode publishes hundreds of models.
    {
      const wide = {
        modes: { current: "plan", available: [{ id: "plan", name: "Plan" }, { id: "build", name: "Build" }] },
        options: [
          {
            id: "model",
            name: "Model",
            description: "ignored",
            category: "model",
            kind: "select" as const,
            value: "b",
            choices: [
              { value: "a", name: "A", description: null, group: null },
              { value: "b", name: "B", description: "B · best", group: null },
              { value: "c", name: "C", description: null, group: null },
            ],
          },
        ],
      };
      const small = reduceConfig(wide as never);
      check(
        "a remembered control keeps the chosen choice and only that one",
        [small.options.length, small.options[0]?.choices.length, small.options[0]?.choices[0]?.value],
        [1, 1, "b"],
      );
      check(
        "and the chip still names it rather than printing the raw value",
        chipValue(expandConfig(small).options[0] as never),
        chipValue(wide.options[0] as never),
      );
      // A memory written before the notice rule still carries claude's notice as the choice description.
      const resumed280Config = {
        modes: null,
        options: [
          {
            id: "model",
            name: "Model",
            description: null,
            category: "model",
            kind: "select" as const,
            value: "claude-opus-5[1m]",
            choices: [
              { value: "opus", name: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks", group: null },
              {
                value: "claude-opus-5[1m]",
                name: "Opus 5 (1M context)",
                description: "Newer version available · select Opus for Opus 5.5",
                group: null,
              },
            ],
          },
        ],
      };
      check(
        "a memory written before this rule still draws the row's name",
        chipValue(expandConfig(reduceConfig(resumed280Config as never)).options[0] as never),
        "Opus 5",
      );
      check(
        "modes keep the current one and drop the rest",
        [small.modes?.current, small.modes?.available.length],
        ["plan", 1],
      );
      const many = Object.fromEntries(
        Array.from({ length: 5 }, (_, at) => [`s${at}`, { at, modes: null, options: [] }]),
      );
      check("the bound keeps the most recently seen", Object.keys(prune(many as never, 2)).sort(), ["s3", "s4"]);
      check("and leaves a file already under it alone", Object.keys(prune(many as never, 9)).length, 5);
    }

    const blank = drawnFrom("exited", [], null).options as readonly never[];
    check(
      "a synthesized slot is named the way a published one would be",
      blank.map((option) => labelFor(option as never)),
      ["Mode", "Model", "Effort"],
    );
    // Expectations are written per slot, not derived from config, which names each option after its id.
    check(
      "and every synthesized slot stands in for its own control, in its own place",
      blank.map((option: { id: string; category: string; name: string }) => [
        option.id,
        option.category,
        labelFor(option),
        chipParts(option as never, false),
      ]),
      [
        [ABSENT_MODE, "mode", "Mode", { caption: null, value: "—" }],
        [ABSENT_MODEL, "model", "Model", { caption: null, value: "—" }],
        [ABSENT_EFFORT, "thought_level", "Effort", { caption: null, value: "—" }],
      ],
    );
    {
      const hollow = {
        modes: null,
        options: [
          { id: "mode", name: "Mode", description: null, category: "mode", kind: "select" as const, value: "a", choices: [{ value: "a", name: "A", description: null, group: null }] },
          { id: "effort", name: "Effort", description: null, category: "thought_level", kind: "select" as const, value: "", choices: [] },
        ],
      };
      const empty = drawnControls({ status: "idle", agentConfig: hollow } as never, undefined);
      check(
        "a select published with nothing in it is drawn as having nothing to choose",
        [empty.options.map((option) => option.id), [...empty.unavailable]],
        [
          ["mode", "effort", ABSENT_MODEL],
          ["effort", ABSENT_MODEL],
        ],
      );
    }
    check(
      "a withdrawn effort control is not joined by a synthesized one",
      drawn.options.filter((option) => option.category === "thought_level").map((option) => option.id),
      ["effort"],
    );
    check(
      "and neither is a live one",
      after.options.filter((option) => option.category === "thought_level").map((option) => option.id),
      ["effort"],
    );

    check(
      "the hint names the kind of control it is about",
      [
        unavailableHint({ category: "thought_level" }, false),
        unavailableHint({ category: "mode" }, false),
      ],
      [
        "The model in use offers no levels here. Another model may.",
        "The agent is not offering this control at the moment.",
      ],
    );
    check(
      "and a control the agent has answered without says so permanently",
      [
        unavailableHint({ category: "thought_level" }, true),
        unavailableHint({ category: "mode" }, true),
        unavailableHint({ category: "model" }, true),
      ],
      [
        "The model in use offers no levels here. Another model may.",
        "This agent has no modes.",
        "This agent offers no choice here.",
      ],
    );

    // restartsAgent pairs with the toast applyConfigChange suppresses: if it narrows, the refusal goes silent (Q3.429).
    // Typed off the function under test so the fixture cannot drift from what it reads.
    type EffortOption = Parameters<typeof restartsAgent>[0];
    const effort = (value: string): EffortOption => ({
      id: "effort",
      name: "Effort",
      description: null,
      category: "thought_level",
      kind: "select",
      value,
      choices: [
        { value: "default", name: "Default", description: null, group: null },
        { value: "xhigh", name: "Xhigh", description: null, group: null },
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    });

    check(
      "entering ultracode restarts, and so does leaving it",
      [
        restartsAgent(effort("default"), "ultracode"),
        restartsAgent(effort("ultracode"), "default"),
      ],
      [true, true],
    );
    check(
      "moving between ordinary levels does not",
      [restartsAgent(effort("default"), "xhigh"), restartsAgent(effort("ultracode"), "ultracode")],
      [false, false],
    );
    // The daemon appends ultracode only to a thought_level control that already offers xhigh.
    const noXhigh = {
      ...effort("default"),
      choices: [
        { value: "default", name: "Default", description: null, group: null },
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    };
    check("a list the daemon never appended to is not a restart", restartsAgent(noXhigh, "ultracode"), false);
    check(
      "and neither is another category",
      restartsAgent({ ...effort("default"), category: "mode" }, "ultracode"),
      false,
    );

    check(
      "the row says why, and only while the turn is running",
      [
        choiceRefusal(effort("default"), "ultracode", true),
        choiceRefusal(effort("default"), "ultracode", false),
        choiceRefusal(effort("default"), "xhigh", true),
      ],
      [
        "Restarts the agent, so not while this turn is running — wait for it, or Stop.",
        null,
        null,
      ],
    );

    const shape = {
      id: "one",
      name: "One",
      description: null,
      kind: "select" as const,
      value: "default",
      choices: [
        { value: "default", name: "Default", description: null, group: null },
        { value: "max", name: "Max", description: null, group: null },
      ],
    };
    for (const category of ["mode", "model", "thought_level", "model_config", "unheard_of"]) {
      const one = { ...shape, category } as never;
      const shown = chipParts(one, true);
      const gone = chipParts(one, false);
      check(`a ${category} chip keeps its caption when the agent stops offering it`, gone.caption, shown.caption);
      check(`while its value says there is nothing to choose`, gone.value, "—");
    }
    check("a chip is a caption and a value and nothing else", Object.keys(chipParts(shape as never, true)).sort(), ["caption", "value"]);

    // The fixed reserve is gone (Q3.564): CHIP_MAX and truncate are what bound a chip.
    // Stripped: this module argues about these classes in prose near the code.
    const bar = stripComments(readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8"));
    // A missing anchor must throw: a slice ending at -1 would widen the region to most of the file.
    const region = (from: string, to: string): string => {
      const start = bar.indexOf(from);
      const end = bar.indexOf(to);
      if (start < 0 || end <= start) throw new Error(`webcheck: no ${from} … ${to} in AgentConfigBar.tsx`);
      return bar.slice(start, end);
    };
    const inner = region("function chipInner", "function Absent");
    check("the value is capped and clips rather than overflowing", /\$\{CHIP_MAX\} truncate/.test(inner), true);
    check("the caption takes the same cap", (inner.match(/\$\{CHIP_MAX\}/g) ?? []).length, 2);
    check("and the fixed sizers are gone rather than hidden", inner.includes("col-start-1 row-start-1"), false);
    check("with nothing left holding a width open", /max-w-40|sm:absolute sm:inset-0/.test(inner), false);

    // The first CHIP template in each function is its own button; the menu panel carries none.
    const chipClass = (source: string): string =>
      /className=\{`\$\{CHIP\}([^`]*)`\}/.exec(source)?.[1] ?? "\u26a0 no ${CHIP} button found";
    const GEOMETRY = " border-transparent px-2 ";
    const absentChip = chipClass(region("function Absent", "function Select"));
    const liveChip = chipClass(region("function Select", "function ChoiceSection"));
    check(
      "the unavailable chip and the live one are sized by the same string",
      [absentChip.startsWith(GEOMETRY), liveChip.startsWith(GEOMETRY)],
      [true, true],
    );
    // text-faint and hover:bg-raised are legitimate here, so the type-scale half names the six steps.
    const SIZING = /\b(?:w|h|min-w|max-w|min-h|max-h|p|px|py|pt|pb|pl|pr|gap|basis|flex)-|\btext-(?:2xs|xs|sm|base|lg|xl)\b/;
    check(
      "and neither of them adds a size of its own after it",
      [SIZING.test(absentChip.slice(GEOMETRY.length)), SIZING.test(liveChip.slice(GEOMETRY.length))],
      [false, false],
    );
  }

  check("nothing about usage rides the controls", Object.keys(drawnFrom("interrupted", [], ["mode"])).sort(), [
    "never",
    "options",
    "stale",
    "unavailable",
  ]);
}
