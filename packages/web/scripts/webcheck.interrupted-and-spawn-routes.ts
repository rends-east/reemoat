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

/* ------------------------------------------------------------------ *
 * A session the daemon ended, and how it is presented
 * ------------------------------------------------------------------ */

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

  /*
   * The other two shapes the extraction below pins, listed here for the same
   * reason `REASONS` is: written out once, so the compiler ties them to the
   * *client's* unions (`isTerminal`/`hasLiveAgent` take a `SessionStatus`,
   * `gapPlan` takes a `LaggedFrame["reason"]`) while the checks tie the same
   * list to the daemon's source. Neither half is worth anything alone.
   */
  const STATUSES = ["starting", "idle", "running", "blocked", "stopping", "exited", "failed", "interrupted", "parked"] as const;
  const LAG_REASONS = ["evicted", "slow_consumer", "backlog"] as const;

  /*
   * The mirror against the thing it mirrors, read off disk.
   *
   * `wire.ts` is the daemon's vocabulary copied by hand — it cannot import
   * `src/events.ts`, for the module-resolution reason that file's own header
   * gives — and the copy is only worth having while it *is* the copy. It was not,
   * for exactly one release: `config_changed` was added to the daemon's
   * `DAEMON_EXIT_REASONS` and not to the client's, so a session the daemon was
   * restarting on purpose fell out of `waitingForDaemon` into `showsAsEnded`,
   * which takes the composer off the screen — the one outcome that partition
   * exists to make impossible for a conversation that is coming back. Every
   * assertion in this section passed throughout, because they all read the same
   * wrong copy.
   *
   * Both halves are compared: the union, so a reason cannot be added on one side
   * only, and the list, so it cannot be classified differently on the two sides.
   *
   * ⭐ **And `ExitReason` was never the only thing worth pinning** — it was only
   * the thing that had already broken. `wire.ts` carries ~109 exports and is
   * edited in most of the commits that touch this package, and the two checks
   * above were the whole of the cross-package coverage. The blocks below are the
   * same technique aimed at the shapes whose drift is silent and expensive: the
   * status union every list, dot and control keys on; the two arrays that
   * classify it; and the `lagged` reason, where confusing `backlog` with a real
   * loss draws a hole over an intact conversation.
   */
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

    /*
     * And the complement, which is what `endedWithDaemon` actually tests.
     *
     * The predicate is `!FINAL_EXIT_REASONS.includes(...)` rather than
     * `DAEMON_EXIT_REASONS.includes(...)`, so that a reason from a newer daemon —
     * one this tab has never heard of — reads as "coming back" instead of taking
     * the composer off the screen. That inversion is only safe while the two
     * lists genuinely partition the daemon's union: a member missing from *both*
     * would now be silently treated as a daemon restart, where before it was
     * silently treated as ended. So the partition is asserted rather than assumed,
     * in both directions.
     */
    /*
     * ⚠ **Three parts now, not two, and `parked` is deliberately in neither
     * list.**
     *
     * It is not a `DAEMON_EXIT_REASON` — that list drives the daemon's own boot
     * pass, and un-parking everything at a restart would put back exactly the
     * memory parking released. It is not `FINAL` either — it is the one reason
     * that *is* coming back. So it is its own part, and the partition is asserted
     * over all three rather than relaxed into "these two plus whatever".
     *
     * The consequence is worth stating because it is not obvious and it is load
     * bearing: `endedWithDaemon` is `!FINAL.includes(...)`, so it answers **true**
     * for `parked`. That is the fail-safe direction for an *unknown* reason and
     * the wrong answer for this known one, which is why `wire.ts` tests
     * `isParked` first in every function that would otherwise ask. Both halves are
     * pinned below.
     */
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
    /*
     * The runtime property the partition exists for, stated directly: a reason
     * invented after this build keeps the composer on screen.
     */
    check(
      "an exit reason from a newer daemon reads as coming back, not as ended",
      endedWithDaemon({ reason: "something_invented_later" as ExitReason }),
      true,
    );

    /*
     * `SessionStatus`, read the same way but off a **stripped** copy, which the
     * two above do not need and this one does. `interrupted`'s docblock contains
     * a semicolon — *"`{@link endedWithDaemon}` is the one rule now; `exit.reason`
     * still says which of the two happened"* — so slicing the raw text to the
     * first `;` stops inside the explanation and drops the member it explains.
     * Measured on this check's first run: seven members where there are eight,
     * and the one missing was `interrupted`, which is the status this whole
     * section is about.
     */
    const daemonCode = daemon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const statusUnion = daemonCode.slice(daemonCode.indexOf("export type SessionStatus ="));
    const statusMembers = [...statusUnion.slice(0, statusUnion.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("every status the daemon derives is in the client's union", statusMembers.sort(), [...STATUSES].sort());

    /*
     * The two classification arrays over that union. There is no daemon-side
     * copy of them — the daemon derives `status` and says nothing about which of
     * them are terminal or have an agent on the other end — so what is asserted
     * is that they are subsets of the union just read off `events.ts`, and that
     * the three of them **partition** it.
     *
     * The subset half is what catches a member invented on the client; the
     * partition half is what catches a status added on the *daemon*, which
     * otherwise lands in neither array in silence and draws as a row with no
     * controls and no ended treatment either.
     */
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

  /*
   * `LaggedFrame["reason"]`, whose daemon side is in `server.ts` rather than
   * `events.ts` and is written in two places — which is the whole reason it is
   * read in two. The attach path builds its two frames with the reason as a
   * literal; `collapse` takes its reason as an argument, so the only place those
   * words are written down is its signature.
   *
   * Comments are stripped first because one of them quotes `reason: "backlog"`
   * while explaining the split, and a pin that reads the explanation instead of
   * the code survives deleting the code.
   *
   * What it costs to be wrong here is the failure `gapPlan`'s docblock records:
   * a `backlog` filed as a loss draws "N events not shown (beyond retention)"
   * over a conversation that is entirely intact.
   */
  {
    const server = readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const written = [...server.matchAll(/type: "lagged",[\s\S]{0,240}?reason: "([a-z_]+)"/g)].map((m) => m[1]);
    const signature = "private collapse(reason:";
    const sig = server.includes(signature) ? server.slice(server.indexOf(signature)) : "";
    const argued = [...sig.slice(0, sig.indexOf(")")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    // Both anchors asserted, so a rename fails naming the writer that moved
    // rather than passing on an empty sweep.
    check("the daemon still writes lagged reasons as literals", written.length > 0, true);
    check("and still names the rest in collapse's own signature", argued.length > 0, true);
    check(
      "every reason the daemon can lag with is in the client's union",
      [...new Set([...written, ...argued])].sort(),
      [...LAG_REASONS].sort(),
    );
    // The other half, and it is the compiler's: `gapPlan` takes the client's
    // union, so a reason the client does not have fails `tsc` on this line.
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
  /*
   * Exhaustiveness, which the daemon gets from a `default`-less switch and this
   * mirror cannot: `DAEMON_EXIT_REASONS` is a plain array here, so a reason
   * added to the union would otherwise be classified `false` in silence. This
   * fails the driver instead.
   */
  const sessionOf = (over: Record<string, unknown>) => ({ ...snapshot, ...over }) as never;

  check(
    "every reason in the union is accounted for",
    REASONS.filter((reason) => endedWithDaemon({ reason })).sort(),
    [...DAEMON_EXIT_REASONS, "parked"].sort(),
  );
  /*
   * ⚠ **And the one that says the line above is not a mistake.**
   *
   * `endedWithDaemon` answers `true` for `parked` because it asks "not final",
   * and that is the *wrong* answer read literally — the daemon does not bring a
   * parked session back on its own. The predicate is left alone anyway, because
   * making it exact would mean naming known reasons and would cost the fail-safe
   * that keeps an unknown one from taking the composer away. What makes it
   * harmless is ordering: `isParked` is tested first everywhere the answer would
   * matter. So both facts are pinned, together, or the next person deletes the
   * ordering to "simplify" and gets "reconnecting after a restart" on a machine
   * that is doing nothing.
   */
  check(
    "endedWithDaemon is not exact about parked, and isParked is what runs first",
    [
      endedWithDaemon({ reason: "parked" as ExitReason }),
      waitingForDaemon(sessionOf({ status: "parked", exit: { reason: "parked" }, agentSessionId: "a_1" })),
    ],
    [true, false],
  );


  /*
   * The partition. Three predicates decide what a terminal row looks like, and
   * they are only correct *together*: exactly one must hold for any terminal
   * session and none for a live one. Asserted as a property over the whole
   * matrix rather than case by case, because the way this breaks is a new state
   * falling into two buckets at once — visible as a row that is both in Active
   * and in Ended, which no individual case would catch.
   */
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

  // The row a deploy actually produces, pinned on its own — a `status`-keyed
  // implementation reads this as `exited` and draws "nothing is happening" over
  // a conversation that is coming back.
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

  // Absence must read as "waiting", never "failed". An older daemon sends no
  // field and resumes nothing, so the inverse default would put a red banner on
  // every ended session in the fleet.
  const older = sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: "a_1" });
  check("no resume field yet reads as waiting", [waitingForDaemon(older), resumeStalled(older)], [true, false]);

  // Nothing to reattach to is stalled rather than ended: the daemon still went
  // away underneath somebody, and "ended" would be answering a question they
  // did not ask.
  const nothingToResume = sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: null });
  check("and nothing to reattach to is stalled, not ended", resumeStalled(nothingToResume), true);

  /* ---- how long a machine has been away ---- */

  /*
   * ⚠ **"Offline" was one word for a lid that closed a minute ago and a host that
   * died last week.** Presence is deleted on disconnect — that is what makes it
   * presence — so nothing outlived it, and the first question anybody has about a
   * machine that is not answering had no answer anywhere in the product.
   *
   * The three silences are the whole of this function and they are three
   * different facts, which is why they are asserted apart rather than as "returns
   * null sometimes".
   */
  const { lastSeenText } = await import("../src/wire.js");
  const now = 1_800_000_000_000;

  // A control plane that predates the field. Saying "never seen" here would be a
  // claim about a fleet that is working fine.
  check("an older control plane says nothing", lastSeenText(undefined, now), null);
  // Nothing has ever recorded a tunnel. The row already says "waiting for the
  // daemon to dial in", which is the same fact with a remedy attached.
  check("and a machine that never dialled in says nothing either", lastSeenText(null, now), null);
  // Under two minutes is a machine somebody is watching drop; "0 min ago" is a
  // number pretending to be information, and the poll interval is the same size.
  check("nor does one that went away seconds ago", lastSeenText(now - 4_000, now), null);

  check("minutes are minutes", lastSeenText(now - 20 * 60_000, now), "last seen 20 min ago");
  check("hours are hours", lastSeenText(now - 5 * 3_600_000, now), "last seen 5 h ago");
  check("and a machine that has been gone for days says so", lastSeenText(now - 9 * 86_400_000, now), "last seen 9 days ago");
  /*
   * The boundary in both directions, because a coarsening function is exactly
   * where an off-by-one produces "last seen 90 min ago" beside "last seen 2 h
   * ago" for two seconds apart.
   */
  check(
    "each step hands over cleanly",
    [lastSeenText(now - 5_399_000, now), lastSeenText(now - 5_401_000, now)],
    ["last seen 90 min ago", "last seen 2 h ago"],
  );
  // A clock that ran backwards — a phone whose time was corrected — must not
  // produce a negative age.
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
  /*
   * **Every reason this line can reach has a sentence, and the fallback is the
   * proof rather than the safety net.**
   *
   * `exitText`'s unknown arm draws `ended: <reason>`, which is what the whole line
   * used to be — so asserting that no reason *reachable here* falls to that arm is
   * the same assertion as "there are no raw enums left on this screen", stated as
   * a property instead of five strings. `agent_signed_out` and the three daemon
   * reasons are excluded because `sessionNotice` answers them above this line and
   * they cannot arrive at it; the exclusion is asserted one screen down, by the
   * two checks that they say something else entirely.
   *
   * Against the fallback's exact shape and **not** `includes(reason)`, which was
   * the first attempt and is a worse test than no test: `stopped` reads "you
   * stopped this conversation", so the identifier is a substring of a perfectly
   * good sentence. What is wrong is a reason printed *as* its identifier, and
   * that is one string comparison.
   */
  const reachable = ["stopped", "agent_exited", "start_failed", "start_timeout", "agent_kill_failed"] as const;
  check(
    "every exit reason a person can be shown has a sentence of its own",
    reachable.filter((reason) => exitText(reason) === `ended: ${reason}`),
    [],
  );
  check("a session somebody stopped says who did it", sessionNotice(stopped, "kimi", "box")?.text, "you stopped this conversation");
  /*
   * The copy rule, asserted as a rule rather than as a string: a session the
   * daemon interrupted must say neither "ended" nor any raw `ExitReason` token.
   * Those are daemon plumbing, and "ended: daemon_shutdown" is a sentence about
   * our own internals printed at somebody who redeployed their own machine.
   */
  const waitingText = sessionNotice(deployed, "kimi", "box")?.text ?? "";
  check("an interrupted one never says ended", waitingText.includes("ended"), false);
  check("nor names an exit reason", /daemon_shutdown|daemon_restarted/.test(waitingText), false);
  check("it says what is actually happening", waitingText, "the daemon restarted — reconnecting the agent");
  check("and offers no button, because nobody needs to press one", sessionNotice(deployed, "kimi", "box")?.action, null);

  /*
   * **The one waiting state that carries a reason draws it.** The daemon defers
   * a session whose harness has no CLI on the machine yet — `waiting`, no attempt
   * spent, the refusal on the snapshot — and its installer is already scheduled.
   * Drawn as the restart line above, that read as a reconnect in progress for the
   * whole wait, minutes at best and for good with updates off. The sentence is
   * the short one for the code, never `error.message`: that is the daemon's
   * paragraph naming a script, and it does not belong on a phone.
   */
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
  /*
   * ⚠ **And offers the sign-in, not the retry, for this one code.** The fixture is
   * `agent_auth_required`, which means the daemon spawned the CLI, asked it to
   * reopen the conversation and was refused — so "not signed in" here is measured
   * rather than remembered, and it is the one place in this app that has earned
   * the right to say it. Retrying is still what every other failure offers, which
   * the pair below pins.
   */
  check("and offers the sign-in it has actually verified", stalledNotice?.action, "sign_in");
  const stalledOther = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_start_timeout", message: "x" }, at: 0 },
  });
  check("while any other failure still offers the retry", sessionNotice(stalledOther, "kimi", "box")?.action, "reconnect");
  check("a live session says nothing at all", sessionNotice(sessionOf({ status: "running", exit: null }), "kimi", "box"), null);

  /*
   * **A failed authentication explains itself in the transcript, with the remedy.**
   *
   * ⚠ **It said "nobody is signed in to claude on box. Sign in and this
   * conversation comes back", and both halves could be false at once.** This row
   * is a record of something that happened, and nothing re-checks it — the
   * daemon's own login probe is live and three seconds fresh and is not consulted
   * anywhere near here. An OAuth token that expired mid-conversation and was then
   * refreshed by the CLI itself left this asserting the opposite of the truth. The
   * promise was not kept either: `reloadCredentials` is the only thing that
   * reverses the reason and all its callers are in-app credential *writes*, so the
   * Sign in button went to a screen where you already were.
   *
   * The sentence is about the past now, which is the only thing the row knows, and
   * the action is the one that has always worked and was never offered:
   * `POST /sessions/:id/resume` is ungated by `autoResumable`.
   */
  const signedOut = sessionOf({
    status: "exited",
    exit: { reason: "agent_signed_out", detail: null, at: 1, agentConfirmedDead: true },
  });
  const out = sessionNotice(signedOut, "claude", "box");
  check("it names the agent and the machine", out?.text, "claude could not authenticate on box, so this conversation stopped.");
  check("never as an internal reason", /agent_signed_out|ended:/.test(out?.text ?? ""), false);
  /*
   * **And it claims nothing about right now.** The row cannot know, so the words
   * that would need checking must not appear: no "nobody is signed in", and no
   * promise about what happens next.
   */
  check(
    "and it asserts nothing about the present",
    /signed in|comes back/.test(out?.text ?? ""),
    false,
  );
  check("and it offers the reconnect, which is the one that works", out?.action, "reconnect");
  /*
   * One field, so the two remedies cannot both be claimed. Two booleans could,
   * and the screen would draw two buttons for one problem.
   */
  const view = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
  /*
   * ⚠ **To the machine's list, and the third argument is what this now refuses to
   * pass.** That slot used to be an agent id and is a *system* id — so
   * `row.snapshot.agent` built `/settings/machines/:id/systems/claude`, which
   * parses (any id up to 64 characters does, deliberately, so a newer daemon's
   * system stays reachable from an older client) and then asks a daemon about a
   * system nobody has. Mapping a harness to its system is `nativeHarness`'s
   * answer and lives on the daemon; this screen holds no systems listing, so it
   * goes one level shallower rather than guessing. Asserted as the *absence* of
   * the guess as well as the presence of the link, because a link to the right
   * screen with a wrong segment on the end passes any test that only greps for
   * the screen.
   */
  check("the view draws it as a route to that machine", /settingsPath\("machines", row\.ref\.machineId\)/.test(view), true);
  check("and never names a system from an agent id", /settingsPath\([^)]*row\.snapshot\.agent\)/.test(view), false);
  check("and the two buttons are mutually exclusive by construction", /notice\.retry/.test(view), false);

  const composer = stripComments(readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"));
  /*
   * ⚠ **A refusal always says so, which reverses an exception that had rotted
   * twice over.** It suppressed the toast for `agent_signed_out` — a code the
   * daemon had stopped sending, so the branch was dead and this check was green
   * on a *literal* rather than on the behaviour. And the reason it existed
   * (Q7.102: the screen already changed, so a toast is the same news twice)
   * expired when the composer became unconditional: a refused send now restores
   * the text and changes nothing else, so without a toast it is silent.
   */
  check("a refused send is never silent", /catch\(\(cause: unknown\)[\s\S]*?toast\("error", errorText\(cause\)\);/.test(composer), true);
  check("with no code carved out of it", /cause\.code === "(agent_signed_out|session_terminal)"/.test(composer), false);
  check("while still putting the message back", /restoreAttachments\(key, sent\);/.test(composer), true);

  // `agentConfirmedDead: false` is worth saying about a session somebody
  // stopped — it is the difference between "stopped" and "probably orphaned" —
  // and is noise after a routine deploy, about a process being replaced anyway.
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

  /*
   * A released agent is drawn as an ordinary quiet session, and the three
   * assertions below are one decision read from three sides.
   *
   * ⚠ **`idle` is the *chosen* answer, not the leftover one**, and the pins are
   * written so that both ways of getting it wrong are red. Fall through to the
   * terminal arm and it reads `ended` — the one word it may not carry, since
   * nobody ended it. Give it a mark of its own — which it had for a draft — and an
   * implementation detail becomes a state somebody has to interpret, explaining
   * only a 1.3s wait the composer's spinner already covers. So: equal to what an
   * ordinary idle session draws, and not equal to `ended` or `waiting`.
   */
  const parked = sessionOf({ status: "parked", exit: { reason: "parked" }, agentSessionId: "a_1" });
  const plainIdle = sessionOf({ status: "idle", exit: null });
  check("a released agent is drawn exactly as a quiet one", statusTone(parked), statusTone(plainIdle));
  check(
    "and never as ended, which is what somebody deciding looks like",
    [statusTone(parked) === "ended", statusTone(parked) === "waiting"],
    [false, false],
  );
  /*
   * ⚠ **And it says nothing.** Removing the notice does not remove it — every
   * path in `sessionNotice` falls through to a catch-all that draws
   * `exitText(reason)`, so without an explicit `return null` a parked session
   * announces itself in the shape of a conversation that ended. Asserted as an
   * absence beside a live session's, which is the only comparison that says
   * "the same amount of nothing".
   */
  check(
    "and says nothing at all, exactly as a live session does",
    [sessionNotice(parked, "claude", "box"), sessionNotice(plainIdle, "claude", "box")],
    [null, null],
  );
  /*
   * What is *not* the same as idle, and must not be: nothing is running on this
   * machine, so it may not inflate a count drawn beside a green dot — and nobody
   * ended it, so it is not filed under Ended either. The dot answers "what is this
   * conversation doing"; the count answers "what is this machine doing". Two
   * questions, and parking is the case that separates them.
   */
  check(
    "it is not live, and not ended",
    [countsAsLive(parked), showsAsEnded(parked)],
    [false, false],
  );
  /*
   * ⚠ **A released conversation and one somebody stopped are never the same thing
   * to a reader, and this is the pin that says so.**
   *
   * The requirement is the brief's first: nobody stopped a parked session, so it
   * may not read as stopped. What carries it is not the mark — `idle` and `ended`
   * share a dot, and always did — but `showsAsEnded`, which decides the bucket in
   * `sessionLists` *and* the Active/Ended filter in the browser, whose default is
   * `active`. So in the ordinary view a released session is present and a stopped
   * one is not, and the two never appear on one screen unless somebody asks for
   * `all`.
   *
   * Asserted as a difference rather than as two separate facts: either value alone
   * would stay green if both moved together, which is exactly how a bucket rule
   * collapses.
   */
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

  /*
   * The loud blink is spent exactly once, on work actually happening.
   *
   * `TONE_DOT`'s own comments say so twice, and `starting` wore it anyway — so an
   * agent being restarted for a settings change announced, for about a second,
   * that an idle session was working. Read off disk because the table is module
   * -private and the rule is about the table rather than about any one entry.
   *
   * It used to hold a second occurrence too — `WorkingDot` reused
   * `TONE_DOT.running` — and does not any more: the transcript's working row is
   * `WorkingMark` in `ui/Mark.tsx`, the product's own three bars with a keyframe of
   * their own. This assertion is unaffected and is worth **more** now, since the
   * blink has one user rather than two and a stray `animate-blink` would be
   * correspondingly easier to add unnoticed.
   */
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
  // The daemon has already decided never to try this one again, and a button
  // that spawns an agent to hear the same answer would be drawing that decision
  // as a promise.
  check("nor one whose conversation the agent lost", resumeRetryable("agent_forgot_session"), false);
  // Says whose memory failed, and — the half a reader actually fears for — that
  // what they can still read is not going anywhere.
  check(
    "and that says the transcript survived",
    resumeFailureText("agent_forgot_session", "", "claude", "box").includes("intact"),
    true,
  );
  // Fails open, per `wire.ts`'s rule for this whole mirror: a client behind the
  // daemon passes its words through and offers the action, rather than refusing
  // something that may well work.
  check("an unknown code falls open", resumeRetryable("something_new"), true);
  check("and shows the daemon's own words", resumeFailureText("something_new", "the disk is on fire", "kimi", "box"), "the disk is on fire");
  check("a folder that is gone is still retryable, because it can be put back", resumeRetryable("workspace_missing"), true);
}

process.stdout.write("\nthe routes that spawn a process\n");
{
  const { slowRoute } = await import("../src/machine.js");

  /*
   * The table `machine.ts` spends a page describing and nothing checked. Its
   * failure mode is not a slow screen: a client deadline below the daemon's own
   * is a *transport* failure, which drops the route memo and renders a perfectly
   * healthy machine "not reachable" over the thing somebody just did.
   */
  check("creating a session is slow", slowRoute("POST", "/sessions"), true);
  check("resuming one is slow", slowRoute("POST", "/sessions/s_1/resume"), true);
  check("changing a control is slow", slowRoute("POST", "/sessions/s_1/config"), true);
  check("the login probe is slow", [slowRoute("GET", "/agents"), slowRoute("GET", "/agent-auth/x")], [true, true]);
  // The new one, and unconditional: sending a message to an interrupted session
  // resumes it first, and `request` sees only a method and a path — a deadline
  // that depended on session state would be state leaking into the transport.
  check("and so is a prompt, now that it may resume first", slowRoute("POST", "/sessions/s_1/prompt"), true);
  check("reading events is not", slowRoute("GET", "/sessions/s_1/events"), false);
  check("nor is answering a permission", slowRoute("POST", "/sessions/s_1/permissions/p_1"), false);
  check("nor is listing sessions", slowRoute("GET", "/sessions"), false);
  /*
   * The one route that talks to a running agent and is deliberately *not* here.
   * It answers without waiting for the agent to agree — the daemon bounds its own
   * wait an order of magnitude under the default budget — so 90 seconds would be
   * a deadline for a control nobody would still be looking at. Asserted because
   * "we thought about it and said no" and "we forgot" are the same code.
   */
  check("and stopping a turn is not, because it does not wait for the agent", slowRoute("POST", "/sessions/s_1/cancel"), false);

  /*
   * ⚠ **The whole table, both directions, in one place — because the defect this
   * assertion was written for is a route that was never in it.** `GET /agents`
   * was matched by a *literal*, and it was a literal on the day
   * `GET /agents/capabilities` shipped, so that route inherited nothing and got
   * the ordinary 15s. What 15s bought there: `server.ts` starts a whole agent per
   * harness and loops them **serially** on purpose, up to `ASK_TIMEOUT_MS` (120s)
   * each, so on a cold cache the client's abort was not a risk but the norm — and
   * the abort is a *transport* failure, so `forgetRoute` then `markUnreachable`
   * drew a perfectly healthy machine as unreachable everywhere at once, including
   * the New session sheet the builder had just been opened from.
   *
   * Checking only the entries somebody remembered is how a table stays a list of
   * the things somebody thought of, which is the whole story above. So every arm
   * is swept at once and the failure names the route rather than a boolean.
   *
   * ⚠ **`GET /agents/<anything>` is deliberately `true` and is asserted false
   * nowhere.** The prefix *is* the fix: nothing but a CLI can answer what that
   * namespace answers, so there is no cheap GET under it and there cannot be one.
   * Pinning an unlisted member false would re-create the gap the next time a
   * route is added there.
   */
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
    /*
     * The writes under `/custom-agents`, and **only** the writes. Both re-validate
     * the pairing with `hostable` against `asks.capabilities(harness)`, so a write
     * there spawns an agent by construction rather than by coincidence — which is
     * why the predicate is a verb plus a prefix and not two literals that a third
     * write route would silently miss.
     */
    ["POST", "/custom-agents", true],
    ["PATCH", "/custom-agents/ca_1234abcd", true],
    /*
     * ⚠ **And the reads stay on the ordinary budget, which is the whole of that
     * verb split.** `GET /custom-agents` is `customAgents.list()` and the `DELETE`
     * is a lookup plus a delete, both synchronous SQLite, and both sit on the
     * builder's first paint — where 90 seconds of a screen that cannot say
     * anything is worse than 15 and a refusal. A later "simplification" to a bare
     * prefix reads as tidying and undoes exactly this.
     */
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

  /*
   * ⚠ **And the verb the client actually sends is the verb the table was written
   * for.** `slowRoute` is handed `init.method`, so the whole entry above is worth
   * nothing if `updateCustomAgent` sends `PUT` — which typechecks, works from
   * curl, and puts an agent-spawning write back on the 15s budget with every
   * assertion in this section still green. The two methods are read off disk
   * because a `DaemonClient` needs a live `MachineConnection` to call, and their
   * verbs are fed back through the predicate rather than compared to a literal.
   */
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
  /*
   * ⚠ **And the delete, which is the other half of the same split and is the
   * premise of an argument written down in `src/server.ts`.** `DELETE` is on
   * `isReplayable` and deliberately **off** `slowRoute`, so it runs on
   * `REQUEST_TIMEOUT_MS` — the budget `settleTransport` names as the one an
   * ordinary drop to LTE earns — and a lost *answer* is resent as an identical
   * request. That is why the route answers `200 {removed: false}` for an id with
   * nothing under it rather than `404`: the second send finds nothing because the
   * first one worked, and a refusal there puts `errorText` on the builder's screen
   * over an act that succeeded. If this row ever moves onto the slow budget the
   * docblock's reasoning stops holding and the *route* should be revisited rather
   * than this assertion updated.
   */
  check(
    "and the delete is sent as DELETE and stays on the budget the idempotence argument rests on",
    [writeVerb("removeCustomAgent"), slowRoute(writeVerb("removeCustomAgent"), "/custom-agents/ca_1234abcd")],
    ["DELETE", false],
  );
  /*
   * ⚠ **`removed: boolean`, never `removed: true`.** A literal there is a promise
   * the wire stopped making, and the way that gets discovered is a screen quietly
   * narrowing an answer it never checked — `AgentBuilder` navigates away on either
   * value today, so nothing would notice until something read it. Read off disk
   * for `writeVerb`'s own reason: a `DaemonClient` needs a live `MachineConnection`
   * to call, so the declaration is what there is to assert.
   */
  check(
    "the client promises the discriminator the daemon actually sends",
    /removeCustomAgent\(id: string\): Promise<\{ removed: boolean; id: string \}>/.test(client),
    true,
  );

  /*
   * The controls do not blink out of existence while the agent is away.
   *
   * The daemon drops `agentConfig` the moment the agent dies — deliberately, and
   * documented — which left the strip blank for the whole of every restart: a
   * deploy, an auto-resume, and now every ultracode change. The client keeps the
   * last set a *running* agent published and draws it refused.
   *
   * `hasLiveAgent` is what makes the memory safe rather than sticky: an agent
   * that is up and publishes nothing clears it, so a session with genuinely no
   * controls cannot end up wearing a dead one's for ever.
   */
  const config = (ids: string[]) => ({
    modes: null,
    options: ids.map((id) => ({
      id,
      name: id,
      description: null,
      /*
       * The id doubles as the category, which is fine for `mode` and `model` and
       * was wrong for the one that matters: the agents call this control `effort`
       * and `thinking` and ACP calls the category `thought_level`, so a fixture
       * keyed on the id alone described a control `drawnControls` has never heard
       * of — and the test named "a control the model dropped keeps its slot" was
       * therefore not about the effort control at all.
       */
      category: id === "effort" ? "thought_level" : id,
      kind: "select" as const,
      value: "a",
      choices: [{ value: "a", name: "A", description: null, group: null }],
    })),
  });
  const live = config(["mode", "model"]);

  /*
   * The predicate underneath both, and the exclusion that carries the weight:
   * `stopping` is not a live agent. `doStop` fans a snapshot out both before and
   * after it empties the config, so a `stopping` frame with no controls is
   * ordinary — and counting it as "the agent says it has none" would throw the
   * memory away on the exact path this exists for.
   */
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

  /*
   * And what the strip draws from the pair. The property is that `stale` is true
   * **iff** what is on screen did not come from the daemon's current answer — so
   * a bar that is not marked stale is never drawing a memory.
   */
  /*
   * The ids `drawnControls` synthesizes for a standard slot nobody published — see
   * `placeholderFor`. Not exported from the module, and pinned here against the
   * function's own answers rather than restated from memory: the strings
   * themselves are a contract with nobody, but *that they are namespaced* is one,
   * since `unavailable` is keyed on ids and a collision would draw a live control
   * as an absent one.
   *
   * ⚠ **There used to be one of these and now there are three, because the strip
   * is no longer allowed to be shorter on one session than on the next.** The
   * effort slot was synthesized alone, for a measured reason — every agent derives
   * its effort list from the selected model — while `mode` and `model` were left
   * to the agent. That was fine right up until an agent published *nothing*, which
   * is every session whose agent has not started, failed to start, or went away
   * before the tab was reloaded; then the whole row vanished and took the model,
   * the effort and the mode with it.
   */
  const ABSENT_MODE = "reemoat:mode";
  const ABSENT_MODEL = "reemoat:model";
  const ABSENT_EFFORT = "reemoat:thought_level";

  const drawnFrom = (status: string, options: string[] | null, held: string[] | null) =>
    drawnControls(
      { status, agentConfig: options === null ? undefined : config(options) } as never,
      held === null ? undefined : (config(held) as never),
    );
  /*
   * A live agent's own answer is what every *value* comes from; the memory only
   * ever adds slots the agent has stopped offering, and says which those are.
   * The two are drawn together and are never confused: `stale` is about the
   * session, `unavailable` is about one control.
   */
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
  /*
   * ⚠ **The strip is never empty, and these two cases are why the rule changed.**
   *
   * Both used to assert `options.length === 0` — they were the *permission* for an
   * empty strip, written on the argument that an agent publishing nothing already
   * is the sentence "this agent has no controls", and that a row which is not
   * drawn cannot have a slot missing from it. The argument answers the wrong
   * question: the reader is not comparing an agent against itself, they are
   * comparing this session against the last one they opened, and a composer that
   * grows and shrinks a whole row between sessions is the shape change every other
   * rule in this area forbids.
   *
   * What made it urgent is that the second case is not rare. `heldConfig` lives in
   * the tab and the daemon deliberately restores none from disk, so *every reload*
   * of a session whose agent is away landed here — permanently, for an ended one,
   * since nothing will ever publish again. Reported from a screenshot of exactly
   * that: a composer with a paperclip, a Send button and nothing else.
   */
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
  /*
   * The property behind all of the above, swept rather than sampled: **there is no
   * session state that empties the strip.** Every status the union has, crossed
   * with every shape of published and remembered config. A new status, or a fourth
   * branch in `drawnControls`, is caught here rather than by eye.
   *
   * ⚠ **The statuses are read off the daemon, and a hand-typed copy of them here
   * is what made that sentence false.** This block declared its own nine-string
   * shadow and guarded the sweep with `STATUSES.length * 9 === 81` — a constant
   * over two literals in the same block, which is `81 === 81`. Add a tenth
   * `SessionStatus` and the census at the top of this file goes red, you fix it by
   * editing *that* list, this shadow stays at nine, the sweep silently covers nine
   * of ten, and the report still prints ok. A count cannot see a skipped item,
   * because skipping does not lower one.
   *
   * So the union is re-read here the way the census reads it, and what guards the
   * sweep is a census of its own rather than an arity — see the ⚠ below, where the
   * arity guard turned out to be the same defect in a second dress.
   */
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
  /*
   * ⚠ **And the guard that replaced the `81 === 81` one was the same shape.** It
   * checked `combinations.length` against `daemonStatuses.length * LIVE_SHAPES.length
   * * HELD_SHAPES.length` — but `combinations` is a `flatMap` over exactly those
   * three arrays, so its length *is* that product by construction and no edit can
   * make the two disagree. The arity is a fact about the expression above, not
   * about the sweep, so it is stated here and asserted nowhere.
   *
   * What is asserted instead is the thing a count cannot see: the set of statuses
   * actually swept, differenced against a **second, independent derivation** of the
   * same union — the client's own classification arrays, which come from
   * `wire.ts` rather than from the `events.ts` read above. A status added on the
   * daemon and classified nowhere makes the left side longer than the right; one
   * classified on the client that the daemon never declares makes the right side
   * longer. Either way the sweep is no longer covering what this block says it is.
   *
   * `starting` and `stopping` are written out because they are deliberately in
   * neither array — they are the two transitional statuses, which the section at
   * the top of this file pins as *exactly* the ones that are neither terminal nor
   * live. Two literals here rather than a ninth list, and they are the two a
   * mistake in cannot hide: dropping one shortens this side.
   */
  const { AGENT_LIVE_STATUSES, TERMINAL_STATUSES } = await import("../src/wire.js");
  check(
    "the sweep tried every status the daemon derives, and the client classifies no others",
    [...new Set(combinations.map(({ status }) => status))].sort(),
    [...new Set([...AGENT_LIVE_STATUSES, ...TERMINAL_STATUSES, "starting", "stopping"])].sort(),
  );
  check("and not one of them leaves the composer with no controls at all", empties, []);
  /*
   * ⚠ **And the property the daemon now leans its whole parking fix on: what the
   * daemon publishes decides whether the strip is live, and the status decides
   * nothing.**
   *
   * `doStop` keeps `agentConfigState` for every stop a message would undo
   * (`revivableByPrompt` in `src/registry.ts`) and `agent_state_json` carries it
   * across a restart — so a `parked`, `stopped`, `exited` or `interrupted`
   * session now arrives with real options on it, and must draw them tappable.
   * That works today only because `drawnControls`' first branch never looks at
   * `status`, which is a property nothing asserted: every `stale` check in this
   * file drives the *empty*-live branch, where the status is exactly what decides.
   * Re-narrow that branch to `hasLiveAgent` and every one of them stays green
   * while the composer goes faint on four statuses at once.
   */
  check(
    "a non-empty config is never stale, whatever the session's status says",
    daemonStatuses.filter((status) => HELD_SHAPES.some((held) => drawnFrom(status, ["mode"], held).stale)),
    [],
  );
  /*
   * The sequence that is the bug, walked end to end: a restart is a live frame,
   * then an emptied `interrupted` one, then an emptied `starting` one. The strip
   * must draw the same controls at every step.
   *
   * ⚠ **A third field used to ride this walk, and it is gone with the predicate
   * it called.** `configBarShows` guarded one failure — no bar, so no paperclip,
   * so no way to attach a file on a session with no live agent — and the paperclip
   * is the composer's own control now rather than the strip's `leading` prop, so
   * that failure is structurally impossible instead of asserted. What was left of
   * the predicate was `optionCount > 0`. The subject of this walk was always
   * `ids` and `stale`.
   */
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
    /*
     * ⭐ **The synthesized slot is on every frame, and the first draft had it on
     * only one.** It cannot reach `held` — `holdConfig` merges what the *daemon*
     * published — so a slot invented on the live branch alone vanished for the
     * length of every restart and took its neighbours' positions with it, which is
     * this very sequence's complaint arriving through the fix for another one.
     */
    check("across a whole restart the same controls stay on screen", drawn, [
      { ids: ["mode", "model", ABSENT_EFFORT], stale: true },
      { ids: ["mode", "model", ABSENT_EFFORT], stale: true },
      { ids: ["mode", "model", ABSENT_EFFORT], stale: false },
    ]);
  }

  /*
   * **A control never leaves the strip**, which is the rule the model gate broke.
   *
   * All three agents build the effort list from the *currently selected model's*
   * own levels and drop the control when there are none — so choosing Haiku
   * deleted the effort chip outright, moving every button beside it and saying
   * nothing about where it went. The memory keeps the slot; the live set decides
   * what can still be used.
   */
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

    // And back: a model that offers it again takes the slot back as a live one.
    const returned = holdConfig(kept, { status: "idle", agentConfig: both } as never);
    const after = drawnControls({ status: "idle", agentConfig: both } as never, returned);
    check(
      "and a model that offers it again makes it live",
      [after.options.map((option) => option.id), [...after.unavailable]],
      [["mode", "model", "effort"], []],
    );

    /*
     * The one thing this must not do: report a control missing when there is
     * simply no agent. That is `stale`, a different sentence with a different
     * refusal behind it.
     */
    const away = drawnControls(
      { status: "interrupted", agentConfig: { modes: null, options: [] } } as never,
      kept,
    );
    check("a session with no agent reports nothing unavailable", [away.stale, [...away.unavailable]], [true, []]);


    /* ---------------------------------------------------------------- *
     * And the same fact in the other shape: never published at all
     *
     * ⭐ claude and kimi *withdraw* the effort control when the model has no
     * levels, which is the block above. opencode never publishes one for such a
     * model in the first place — so the identical fact arrived as an absence, and
     * the right-hand cluster had three chips on one session and two on the next.
     *
     * Measured 2026-08-27 against opencode 1.18.23 with one OpenRouter key and
     * 362 models: `session/set_config_option` on the model answers with a
     * `thought_level` for `openai/gpt-5.6` and `~anthropic/claude-sonnet-latest`,
     * and without one for `minimax/minimax-m3` and `deepseek/deepseek-r1`. So the
     * sentence this draws is a description of the agent, one model apart, rather
     * than a client guessing about a control it has never seen.
     * ---------------------------------------------------------------- */
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
      // Read off the *drawn* slot rather than this block's own `ABSENT_EFFORT`,
      // which would be a literal testing itself. The constant is differenced
      // against the synthesized id by the check above, which compares the whole
      // drawn id list against it.
      [opencode.options.at(-1)?.id.startsWith("reemoat:"), opencode.options.at(-1)?.category],
      [true, "thought_level"],
    );
    check(
      "and it says the one thing that is true about it",
      // The `never` flag read off the same answer rather than written in: this
      // fixture is a live published config, so the slot really is one opencode
      // will not offer, and the sentence must be the same either way. Passing a
      // literal would assert this arm against a value the read never produces.
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
    /*
     * It has to be *empty*, and that is what keeps it out of the `/` menu:
     * `buildCommands` skips a select with nothing in it — asserted in the command
     * section — so there is no `/effort` row that opens onto zero choices and eats
     * what somebody typed. `Composer` passes the raw `agentConfig` there rather
     * than this, so the placeholder never reaches it at all; both halves hold.
     */
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
    /*
     * What the row this client invents stands in for — and, because this is the
     * check whose predecessor was a tautology, how much of that is *asserted*
     * rather than entailed by the element beside it.
     *
     * ⚠ **This compared `chipParts(…, false)` against `chipParts(…, false)` and
     * was `"—" === "—"`.** With `available: false` the `value` field is the literal
     * `UNAVAILABLE_VALUE` and the option is never consulted; `thought_level` is in
     * `CAPTION_SILENT`, so `caption` is `null` on both sides as well. Neither half
     * of the comparison ever read the thing it was comparing, and it stayed green
     * through a slot synthesized in the wrong place, for the wrong category,
     * standing for the wrong control — which is the whole of what it claimed.
     *
     * ⚠ **The repair's own first prose then re-described that comparison as
     * meaningful, and is corrected here in the open rather than quietly.** It read
     * "every field a chip is assembled from matches a published control of that
     * category — the caption in **both** availability states, which is
     * `ChipParts`' own property". It is not asserting that, and for a slot this
     * strip synthesizes it never can: `ALWAYS_DRAWN` is `CATEGORY_SLOT` filtered to
     * the two visible slots, which yields `mode`, `model` and `thought_level`, and
     * all three are in `CAPTION_SILENT`. So `caption` is `null` in both states *by
     * construction*, and a caption comparison here is entailed by the category
     * equality next to it rather than evidence for anything. The second check
     * below states that as a property instead of leaning on it in silence: a
     * fourth always-drawn slot, for a category that does draw a caption, makes
     * this paragraph false and is what goes red.
     *
     * What the pair below honestly discriminates is **which control the last slot
     * stands in for**: its category is a published effort control's, and its
     * position is load-bearing — swap the synthesized slots and `at(-1)` is the
     * model, whose category fails. `chipParts(…, false)` is kept as the statement
     * that the two are one shape, not as the evidence for it.
     *
     * Where the caption *is* a real comparison is the other kind of absence: a
     * control the agent published and then withdrew, whose category can be
     * anything, including one with no glyph and therefore a caption. That is the
     * sweep at "a … chip keeps its caption when the agent stops offering it",
     * below, and it is the only place `ChipParts`' availability-independence is
     * actually put to a category that can fail it.
     *
     * **The width is not in here at all**, and the sentence that used to open this
     * docblock — "a chip that reserves a different width from a real effort
     * control" — outlived the thing it described: the fixed reserve that made
     * width a `chipParts` property was withdrawn on the owner's word (Q3.564).
     * What is left is `Absent`'s class string, asserted against the live chip's
     * own further down, off disk, since that is the only place the fact lives.
     */
    const stood = opencode.options.at(-1) as never;
    const published = config(["effort"]).options[0] as never;
    check(
      "and the slot stands in for an effort control, drawing what one draws",
      [(stood as { category: string }).category, chipParts(stood, false)],
      [(published as { category: string }).category, chipParts(published, false)],
    );
    /*
     * The premise the paragraph above rests on, as a check rather than a claim:
     * every slot this strip invents is caption-silent, so no comparison of two
     * captions over one of them can ever discriminate anything.
     *
     * A census over the slots as *drawn*, compared against a written-out list
     * rather than counted: a count cannot see a skipped member, and what this one
     * is here to notice is a **fourth** invented slot, or one of these three
     * arriving under a category that is not caption-silent. The state it is taken
     * in — no agent, nothing remembered — is the one where nothing is filled, so
     * every placeholder `withUnusable` can add is in the answer; that it can add
     * none outside `ALWAYS_DRAWN` is read off `agentConfig.ts` and is not pinned
     * here.
     *
     * ⚠ **It overlaps the census further down, and the difference is one column.**
     * This said the two had different subjects; they share one. Both pin the
     * category of all three slots in drawn order — that one adds the id, the label
     * and the chip, this one adds `showsCaption`. And `showsCaption` itself is not
     * this file's to hold: `webcheck.composer-and-config-bar.ts` runs the predicate
     * over its four categories and two misses. What is left here, and is the reason
     * to keep it, is the narrower statement that the categories *this strip
     * invents* fall inside that set.
     */
    check(
      "and no slot this strip invents draws a caption, which is why comparing two proves nothing",
      drawnFrom("exited", [], null).options.map((option) => [option.category, showsCaption(option)]),
      [
        ["mode", false],
        ["model", false],
        ["thought_level", false],
      ],
    );
    /*
     * ⚠ **The refusal that used to stand here is withdrawn, and this is its
     * replacement.** It read "an agent that published nothing at all is already the
     * sentence *this agent has no controls*, and a strip that is not drawn cannot
     * have a slot missing from it" — and it was the permission for an empty
     * composer. What the argument misses is that the comparison a reader makes is
     * against the *previous session they opened*, not against this agent, so a row
     * that appears and disappears moves every control beside it. The three slots
     * are drawn in every state now, unavailable and each saying so.
     *
     * Kept as a check rather than deleted, pointed the other way: the case is
     * still worth naming, it just has the opposite answer.
     */
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
    /*
     * ⚠ **A claim about *width* stood here with no check under it, and it was a
     * withdrawn claim besides.** It read "each placeholder reserves the width a
     * real control of that category would, which is the `chipParts` invariant
     * applied to the two slots that gained one" — and the fixed reserve that made
     * width a `chipParts` invariant is gone on the owner's word (Q3.564), so an
     * unavailable slot is *narrower* than the control it stands for and the
     * cluster does move. Recorded rather than deleted, because this repository
     * keeps its reversals where the reader will hit them.
     *
     * ⚠ **What replaced it claimed more than the checks under it.** It read that
     * what survives about these two slots is "their id, category, name and chip
     * contents" plus "the box around them", and each of those three is wider than
     * what is actually pinned. Narrowed against the two checks it names:
     *
     * "Every synthesized slot stands in for its own control, in its own place",
     * further down, sweeps **all three** slots rather than these two, in drawn
     * order, and pins four fields per slot: the id, the category, `labelFor`'s
     * answer, and `chipParts`. The *name* is in that only through `labelFor`, which
     * answers `CATEGORY_LABEL` for `mode` and `thought_level` and reaches the
     * `name` field for `model` alone. And `chipParts` is the weak column: at
     * `available: false` its value is `UNAVAILABLE_VALUE` whatever the option is,
     * and its caption follows from the category the same row already pins — which
     * is the `"—" === "—"` shape this file has had to repair twice, kept here
     * because it is free beside three fields that can genuinely go red rather than
     * because it discriminates.
     *
     * The box is pinned as a **prefix and an absence**, not as a comparison of two
     * strings: `Absent`'s `${CHIP}` class string and `Select`'s must both start
     * `" border-transparent px-2 "` and must add no sizing utility after it. Read
     * off disk, because neither fact is reachable from a module with no DOM. What
     * follows the prefix is otherwise unread, so two chips whose colours diverge
     * pass, deliberately.
     */
    /* ---- what survives a reload, and what may not ---- */

    /*
     * ⚠ **The reduction keeps the selected choice and drops the rest, and both
     * halves are the assertion.**
     *
     * `chipValue` names a value through the *choice* that carries it, never
     * through the raw value — without one the model chip reads `openai/gpt-5`
     * instead of `GPT-5`, and for a model it mines the choice's description to
     * split `Opus 5 · Best for…` into a name. So dropping the selected choice
     * would restore the chip and draw it wrong, which is worse than a dash.
     *
     * And keeping the others is not available: opencode publishes **362** models
     * on one control, and a few hundred sessions of that is megabytes into a
     * budget shared with the credential. So the count is pinned at one, not
     * merely "contains the right one".
     */
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
      /*
       * ⚠ **A memory written before the notice rule still holds the notice**, and
       * is read back through the same `chipValue`. claude 2.1.280 describes a
       * session resumed on `claude-opus-5[1m]` as `Newer version available · …`,
       * and that sentence is already in somebody's `localStorage` as the selected
       * choice's description — so the rule has to hold on the reduced copy, not only
       * on a live list. Local rather than shared: the driver files keep their own
       * fixtures.
       */
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
      /*
       * The bound is applied on write, so what it keeps is the most recently
       * seen rather than whatever the object happened to enumerate first. A
       * read-time bound would answer differently as storage filled, which is how
       * a chip appears on one load and not the next.
       */
      const many = Object.fromEntries(
        Array.from({ length: 5 }, (_, at) => [`s${at}`, { at, modes: null, options: [] }]),
      );
      check("the bound keeps the most recently seen", Object.keys(prune(many as never, 2)).sort(), ["s3", "s4"]);
      check("and leaves a file already under it alone", Object.keys(prune(many as never, 9)).length, 5);
    }

    const blank = drawnFrom("exited", [], null).options as readonly never[];
    /*
     * ⚠ **The name is read even where it is not drawn.** `showsCaption` keeps
     * every one of these categories off the chip face, so a wrong one looks right;
     * it reaches the reader through `Absent`'s `title` and `aria-label`. `labelFor`
     * falls through to `name` for `model`, and `name` on a synthesized slot is the
     * wire's own category — lower-case and underscored. A screen reader announced
     * the control as "model".
     */
    check(
      "a synthesized slot is named the way a published one would be",
      blank.map((option) => labelFor(option as never)),
      ["Mode", "Model", "Effort"],
    );
    /*
     * ⚠ **The check that stood here was `"—" === "—"`, twice.** It compared
     * `chipParts(slot, false)` against `chipParts(realControl, false)`, and with
     * `available: false` that field is the literal `UNAVAILABLE_VALUE` on both
     * sides without the option being read at all — while `mode` and `model` are
     * both in `CAPTION_SILENT`, so the other field is `null` on both sides too.
     * The slots could have been synthesized in any order, under any ids, for any
     * categories, and it passed. It was written by analogy to the effort one
     * above, which had the same defect and is now the same repair.
     *
     * A census over the three slots **in their drawn order** replaces it, carrying
     * the facts a chip is actually assembled from: the id it occupies —
     * `unavailable` is keyed on ids, so a collision draws a live control as an
     * absent one — the category the glyph, the slot and the label all come from,
     * the name a reader is given, and what the chip says where a value would go.
     *
     * Written out per slot rather than derived from `config`, deliberately:
     * `config` names each option after its id, so `labelFor` answers `model`
     * there and `Model` here, which is the title-casing the check above exists
     * for. Deriving the expectation from the fixture would assert the bug.
     *
     * The **width** is not in here and never was — it is `Absent`'s own class
     * string, asserted against the live chip's below.
     */
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
    /*
     * A select the agent published with nothing in it is the same absence with a
     * chip in front of it. Left out of `unavailable` it drew as a live `Select`
     * onto a heading with no rows under it — a control that opens, says nothing and
     * closes, which is the dead end `commands.ts` refuses to make a command of.
     * It also has to be counted here for the effort slot's own test to be sound:
     * an empty `thought_level` would otherwise suppress the placeholder and put
     * that dead menu in its place.
     */
    {
      const hollow = {
        modes: null,
        options: [
          { id: "mode", name: "Mode", description: null, category: "mode", kind: "select" as const, value: "a", choices: [{ value: "a", name: "A", description: null, group: null }] },
          { id: "effort", name: "Effort", description: null, category: "thought_level", kind: "select" as const, value: "", choices: [] },
        ],
      };
      const empty = drawnControls({ status: "idle", agentConfig: hollow } as never, undefined);
      /*
       * The published-but-empty select is marked; the `model` slot this fixture
       * never mentions is synthesized beside it. Two different routes into
       * `unavailable` — one an agent's own answer, one this client's stand-in —
       * asserted together so neither can quietly take over the other's case.
       */
      check(
        "a select published with nothing in it is drawn as having nothing to choose",
        [empty.options.map((option) => option.id), [...empty.unavailable]],
        [
          ["mode", "effort", ABSENT_MODEL],
          ["effort", ABSENT_MODEL],
        ],
      );
    }
    /*
     * And it must never double up. The withdrawn control above already occupies
     * the category, so the test is on the *drawn* set rather than the live one —
     * written the other way round, an agent that dropped its effort control would
     * have shown two Effort chips side by side, one with the levels it used to
     * offer and one saying there are none.
     */
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
    /*
     * ⚠ **The same three categories again with `never`, because "at the moment"
     * is a claim about time and one agent disproves it.** grok publishes `model`
     * and `reasoning_effort` and no `mode` in any session (1.0.40, measured
     * 2026-09-21), so its mode chip sat greyed for ever under a sentence saying
     * the control might come back — read, correctly, as the feature being broken.
     *
     * Effort is in this list precisely because it must **not** move: its sentence
     * is already permanent for every agent that reaches it, since all five build
     * that list from the selected model. A pair that changed all three would mean
     * the flag was being read as "say something different" rather than as the one
     * fact it carries.
     */
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

    /* ---------------------------------------------------------------- *
     * A choice that restarts the agent says so on its own row
     *
     * ⭐ The bottom-of-viewport toast was the ONLY thing that told anybody why
     * choosing ultracode mid-turn did nothing — and it is a panel over the
     * composer's input, raised after the tap for a refusal the client could have
     * predicted. The row answers first now, and `applyConfigChange` suppresses
     * exactly that one code. These pin the pair: if `restartsAgent` narrows, the
     * refusal goes silent instead of loud. Q3.429.
     * ---------------------------------------------------------------- */
    // Typed off the function under test, so this fixture cannot drift from the
    // shape `restartsAgent` actually reads without failing here first.
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
    // Not a restart: the value is not moving across the ultracode boundary.
    check(
      "moving between ordinary levels does not",
      [restartsAgent(effort("default"), "xhigh"), restartsAgent(effort("ultracode"), "ultracode")],
      [false, false],
    );
    /*
     * The two capability clauses. The daemon appends the row only to a control it
     * found by `thought_level` and only where the agent already offered `xhigh`,
     * so a list missing either is one it never touched — and a false positive here
     * would swallow a tap the daemon would have accepted.
     */
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

    /*
     * **And the chip does not change width when it happens** — the assertion the
     * first version of this slot lacked. It drew the control's name where the
     * live chip deliberately does not, so choosing Haiku widened the effort chip
     * by a word and a gap and shoved the whole right-hand cluster sideways, which
     * is the one thing this strip must never do.
     *
     * The property is structural: the caption does not depend on availability, so
     * the only thing that changes is the string inside the chip. Over every
     * category, because the next control to be dropped will not be this one.
     *
     * ⚠ **It used to say "does not change width", and it cannot any more.** The
     * fixed reserve that made that literally true was withdrawn (Q3.564), so an
     * unavailable chip saying `—` is narrower than the control it stands for and
     * the cluster does move. What survives is the half that was the actual defect:
     * the absent slot drawing a *name* the live chip does not.
     */
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
    /*
     * And nothing else rides `ChipParts`, which is the shape of the claim above:
     * two fields, one of which is availability-independent. A third would be
     * something a chip's rendering depends on that this loop does not compare.
     */
    check("a chip is a caption and a value and nothing else", Object.keys(chipParts(shape as never, true)).sort(), ["caption", "value"]);

    /*
     * **A chip is bounded above and by nothing else**, and the only thing that
     * says so is a class. The fixed reserve is gone (Q3.564), so what stops a
     * pathological value taking the row is `CHIP_MAX` on the value span and on the
     * caption beside it — and what stops it overflowing instead of clipping is
     * `truncate` on the same span, with the full text in the menu and the `title`.
     *
     * ⚠ **Asserted as an absence as well as a presence.** The sizers are what a
     * revert would bring back, and they would bring the empty box back with them:
     * a chip as wide as `Ultracode` while saying `Max`, three times over. Read off
     * disk because there is no DOM here and both halves are one word in a class
     * string — the kind of thing a tidy-up changes without noticing, and every
     * pure assertion above stays green when it does.
     */
    /*
     * ⚠ **Comment-stripped, and that is not a precaution here.** This module
     * argues about `CHIP_MAX`, `px-2` and `sm:absolute` in prose a few lines above
     * the code that sets them — the withdrawn reserve is described in full in
     * `chipInner`'s own docblock — so a regex over raw source matches the
     * argument and reports the rule as held while the code has dropped it.
     */
    const bar = stripComments(readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8"));
    /*
     * ⚠ **Both ends, and never a bare `slice`.** `indexOf` answers -1 for an
     * anchor somebody renamed, and JS `slice` reads a negative end as counting
     * *from the end of the file* — so a missing end anchor does not empty the
     * region, it widens it to nearly the whole module and every regex below goes
     * on matching something. A throw is the only honest answer: a source check
     * that cannot find its subject has not passed.
     */
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

    /*
     * **And the two chips are the same box**, which is the assertion the pair of
     * `chipParts` comparisons in the sections above were pretending to be.
     *
     * `Absent` and `Select` are one button in two states and the rule they exist
     * to keep is that the strip does not move. They already share their
     * *contents*, through `chipInner` — written twice, those drifted inside one
     * release. Nothing shared the box around them, and the box is what has the
     * width on it: `CHIP` carries `inline-flex`, `gap-1.5` and `text-2xs`, the
     * call site adds the horizontal padding, and the tail of each class string is
     * colour. A `min-w`, a `px-3` or a step on the type scale landing on one of
     * the two is the edit that moves that chip and not its twin, and it is exactly
     * the edit every pure assertion in this file stays green through.
     *
     * The first `${CHIP}` template in each function is its own button; the menu
     * panel below it carries none.
     */
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
    /*
     * And what follows the shared prefix is colour and nothing else. Asserted as
     * an absence over both, because the failure this catches arrives as an
     * *addition*: one chip given a width, a padding or a font size the other does
     * not have. `text-faint` and `hover:bg-raised` live here legitimately, so the
     * type-scale half names the six steps rather than everything starting `text-`.
     */
    const SIZING = /\b(?:w|h|min-w|max-w|min-h|max-h|p|px|py|pt|pb|pl|pr|gap|basis|flex)-|\btext-(?:2xs|xs|sm|base|lg|xl)\b/;
    check(
      "and neither of them adds a size of its own after it",
      [SIZING.test(absentChip.slice(GEOMETRY.length)), SIZING.test(liveChip.slice(GEOMETRY.length))],
      [false, false],
    );
  }

  /*
   * `drawnControls` answers these keys and no more, which is worth pinning
   * because one more is how a fact about the *agent* would get smuggled onto a
   * memory of the agent's controls. It carried no usage even when there was a
   * context readout to feed — "a dead agent's window occupancy is not a fact
   * about anything" — and now there is no readout in this client at all, so the
   * shape is the whole of the claim.
   *
   * ⚠ **`never` was the fourth and it is admitted on the same terms the rule
   * states, not as an exception to it.** It is a fact about *these controls* —
   * which of the slots in `unavailable` this agent has already answered without —
   * and it is empty on every arm that draws from memory, which is exactly the
   * fixture below. What the rule forbids is a fact about the agent's *state*
   * riding along; this is a fact about the read, and it goes to nothing but a
   * sentence.
   */
  check("nothing about usage rides the controls", Object.keys(drawnFrom("interrupted", [], ["mode"])).sort(), [
    "never",
    "options",
    "stale",
    "unavailable",
  ]);
}
