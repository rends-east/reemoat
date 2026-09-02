import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { stripComments } from "./webcheck.source.js";
import {
  chipParts,
  choiceRefusal,
  drawnControls,
  gapPlan,
  hasLiveAgent,
  holdConfig,
  isTerminal,
  restartsAgent,
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
  ] as const;

  /*
   * The other two shapes the extraction below pins, listed here for the same
   * reason `REASONS` is: written out once, so the compiler ties them to the
   * *client's* unions (`isTerminal`/`hasLiveAgent` take a `SessionStatus`,
   * `gapPlan` takes a `LaggedFrame["reason"]`) while the checks tie the same
   * list to the daemon's source. Neither half is worth anything alone.
   */
  const STATUSES = ["starting", "idle", "running", "blocked", "stopping", "exited", "failed", "interrupted"] as const;
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
    check(
      "the two exit-reason lists partition the daemon's union",
      [...DAEMON_EXIT_REASONS, ...FINAL_EXIT_REASONS].sort(),
      [...members].sort(),
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
  check(
    "every reason in the union is accounted for",
    REASONS.filter((reason) => endedWithDaemon({ reason })).sort(),
    [...DAEMON_EXIT_REASONS].sort(),
  );

  const sessionOf = (over: Record<string, unknown>) => ({ ...snapshot, ...over }) as never;

  /*
   * The partition. Three predicates decide what a terminal row looks like, and
   * they are only correct *together*: exactly one must hold for any terminal
   * session and none for a live one. Asserted as a property over the whole
   * matrix rather than case by case, because the way this breaks is a new state
   * falling into two buckets at once — visible as a row that is both in Active
   * and in Ended, which no individual case would catch.
   */
  const matrix: Record<string, unknown>[] = [];
  for (const status of ["running", "idle", "exited", "failed", "interrupted"]) {
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
    const hits = [waitingForDaemon(session), resumeStalled(session), showsAsEnded(session)].filter(Boolean).length;
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
  const { configBarShows } = await import("../src/ui/agentConfig.js");

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
   * The control strip's early return, extracted because its third clause is the
   * half that fails on exactly one agent — and the case it fails on stopped
   * being rare the moment the composer began surviving a restart.
   */
  check("a restored session still draws its bar, for the paperclip", configBarShows(0, null, true), true);
  check("and without one there is nothing to draw", configBarShows(0, null, false), false);
  check("a context readout alone is enough", configBarShows(0, 42, false), true);
  check("and so is a single control", configBarShows(1, null, false), true);

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
   * The id of the slot `drawnControls` synthesizes for an effort control that was
   * never published — see `NO_LEVELS`. Not exported from the module, and pinned
   * here against the function's own answer rather than restated from memory: the
   * string itself is a contract with nobody, but *that it is namespaced* is one,
   * since `unavailable` is keyed on ids and a collision would draw a live control
   * as an absent one.
   */
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
    "a live agent's controls come from the daemon",
    [
      drawnFrom("idle", ["mode"], ["mode"]).options.map((o: { id: string }) => o.id),
      drawnFrom("idle", ["mode"], ["mode"]).stale,
    ],
    [["mode", ABSENT_EFFORT], false],
  );
  check(
    "and one it has dropped is added after them, marked",
    [
      drawnFrom("idle", ["mode"], ["old"]).options.map((o: { id: string }) => o.id),
      [...drawnFrom("idle", ["mode"], ["old"]).unavailable],
    ],
    [["mode", "old", ABSENT_EFFORT], ["old", ABSENT_EFFORT]],
  );
  check(
    "a live agent with nothing to offer draws nothing, and is not stale",
    [drawnFrom("idle", [], ["old"]).options.length, drawnFrom("idle", [], ["old"]).stale],
    [0, false],
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
    "an absent agent with nothing remembered draws nothing rather than claiming staleness",
    [drawnFrom("exited", [], null).options.length, drawnFrom("exited", [], null).stale],
    [0, false],
  );
  /*
   * The sequence that is the bug, walked end to end: a restart is a live frame,
   * then an emptied `interrupted` one, then an emptied `starting` one. The strip
   * must draw the same controls at every step and must never fall to the state
   * where `configBarShows` has only the paperclip to keep it alive.
   */
  {
    let held = holdConfig(undefined, { status: "idle", agentConfig: live });
    const drawn: { ids: string[]; stale: boolean; shows: boolean }[] = [];
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
        shows: configBarShows(step.options.length, null, true),
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
      { ids: ["mode", "model", ABSENT_EFFORT], stale: true, shows: true },
      { ids: ["mode", "model", ABSENT_EFFORT], stale: true, shows: true },
      { ids: ["mode", "model", ABSENT_EFFORT], stale: false, shows: true },
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
      [ABSENT_EFFORT.startsWith("reemoat:"), opencode.options.at(-1)?.category],
      [true, "thought_level"],
    );
    check(
      "and it says the one thing that is true about it",
      unavailableHint(opencode.options.at(-1) as never),
      "The model in use offers no levels here. Another model may.",
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
     * The width invariant `ChipParts` exists for, applied to the row this client
     * invents: a chip that reserves a different width from a real effort control
     * would move every button beside it on exactly the sessions this fix is for.
     */
    check(
      "and reserves the same width as an effort control the agent did publish",
      chipParts(opencode.options.at(-1) as never, false),
      chipParts(config(["effort"]).options[0] as never, false),
    );
    /*
     * The one refusal that stands: an agent that published nothing at all is
     * already the sentence "this agent has no controls", and a strip that is not
     * drawn cannot have a slot missing from it. A *memory*, by contrast, keeps the
     * slot — asserted in the restart sequence above, where leaving it out is what
     * moved the buttons.
     */
    check(
      "a live agent offering nothing still offers nothing",
      drawnFrom("idle", [], ["mode"]).options.length,
      0,
    );
    check(
      "and neither does a session with no agent and nothing remembered",
      [drawnFrom("exited", [], null).options.length, drawnFrom("exited", [], null).stale],
      [0, false],
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
      check(
        "a select published with nothing in it is drawn as having nothing to choose",
        [empty.options.map((option) => option.id), [...empty.unavailable]],
        [["mode", "effort"], ["effort"]],
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
      [unavailableHint({ category: "thought_level" }), unavailableHint({ category: "mode" })],
      [
        "The model in use offers no levels here. Another model may.",
        "The agent is not offering this control at the moment.",
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
     * The property is structural: everything that decides a chip's width — the
     * caption and the reserve — is the same in both states, so the only thing
     * that changes is the string inside a box already sized for it. Over every
     * category, because the next control to be dropped will not be this one.
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
      check(`and reserves exactly the same width`, gone.reserve, shown.reserve);
      check(`while its value says there is nothing to choose`, gone.value, "—");
    }
    check(
      "and that placeholder is inside the width the chip reserved",
      chipParts({ ...shape, category: "thought_level" } as never, false).reserve?.includes("—"),
      true,
    );

    /*
     * **The reserve is a width, not a floor**, and the only thing that says so is
     * a class: a grid column is as wide as the widest thing in it, so while the
     * value sat in flow beside the sizers, a value longer than all of them
     * widened the chip. `GPT-5.6-Luna` is one character more than the string this
     * list was measured from, and that was enough for two codex sessions to draw
     * two different strips. Taking the value out of flow is what makes the column
     * exactly the reserve.
     *
     * Read off disk because there is no DOM here and the rule is one word in a
     * class string — the kind of thing a tidy-up deletes without noticing, and
     * every pure assertion above stays green when it does.
     */
    const bar = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8");
    const inner = bar.slice(bar.indexOf("function chipInner"), bar.indexOf("function Absent"));
    check("the sizers only hold the width open where there is room for it", inner.includes("hidden col-start-1 row-start-1 whitespace-pre sm:block"), true);
    check("and the value cannot widen the column it sits in", inner.includes("sm:absolute sm:inset-0"), true);
  }

  /*
   * The context readout is deliberately **not** held. "A dead agent's window
   * occupancy is not a fact about anything" — the ring keeps its slot and says
   * "cannot tell", which is true, and `drawnControls` has nowhere to put a usage
   * even if somebody wanted to.
   */
  check("nothing about usage rides the controls", Object.keys(drawnFrom("interrupted", [], ["mode"])).sort(), [
    "options",
    "stale",
    "unavailable",
  ]);
}
