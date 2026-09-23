import { readFileSync, readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * The machine limit
 *
 * Three states for the copy, two for the rule, and the property that binds them:
 * a door is never missing without a sentence saying why. `gateNotice`'s own
 * shape, asserted the same way — because the defect that rule was extracted from
 * was a three-way answer whose call sites all wanted two.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe machine limit\n");
{
  const {
    HARD_MACHINE_CEILING,
    machineBadgeText,
    machineLimitChangeNotice,
    machineLimitProblem,
    machineQuota,
    machineQuotaNotice,
    mayAddMachine,
  } = await import("../src/quota.js");

  const me = (over: Record<string, unknown>): never =>
    ({ id: "u_1", name: "ada", isAdmin: false, ...over }) as never;

  /* ---- the truth table, across every state plus the two absences ---- */

  const CASES: { what: string; me: never | null; kind: string; may: boolean }[] = [
    { what: "no `me` at all", me: null, kind: "unknown", may: true },
    { what: "a control plane that predates the field", me: me({}), kind: "unknown", may: true },
    // `null` and `undefined` collapse together: one is a service with no
    // opinion, the other one that has never heard of the question, and no screen
    // does anything different about them.
    { what: "an explicit no-limit", me: me({ machineCount: 2, machineLimit: null }), kind: "unknown", may: true },
    {
      what: "room to spare",
      me: me({ machineCount: 0, machineLimit: 2, canAddMachine: true }),
      kind: "room",
      may: true,
    },
    {
      what: "one slot left",
      me: me({ machineCount: 1, machineLimit: 2, canAddMachine: true }),
      kind: "room",
      may: true,
    },
    {
      what: "exactly at the limit",
      me: me({ machineCount: 2, machineLimit: 2, canAddMachine: false }),
      kind: "full",
      may: false,
    },
    {
      what: "past it, which is what a lowering looks like",
      me: me({ machineCount: 3, machineLimit: 2, canAddMachine: false }),
      kind: "full",
      may: false,
    },
    {
      what: "a limit of zero and nothing owned",
      me: me({ machineCount: 0, machineLimit: 0, canAddMachine: false }),
      kind: "none",
      may: false,
    },
    {
      what: "a limit of zero lowered onto machines they had",
      me: me({ machineCount: 1, machineLimit: 0, canAddMachine: false }),
      kind: "none",
      may: false,
    },
  ];

  for (const one of CASES) {
    check(`${one.what}: kind`, machineQuota(one.me).kind, one.kind);
    check(`${one.what}: may add`, mayAddMachine(one.me), one.may);
  }

  /*
   * **The invariant, and the reason the notice carries no "2 of 5" line while
   * there is room** — that would break it, and a progress readout is a second
   * function's job.
   *
   * ⭐ **Over a generated cross-product rather than over `CASES`, and the
   * difference is the whole assertion.** Written as a `.map` over the table
   * above it could not fail: every entry there carries a `canAddMachine` that
   * agrees with its own two numbers, because every entry describes a shape the
   * control plane actually sends. So the property was asserted over exactly the
   * inputs on which the two functions cannot disagree — and they read different
   * fields, which is the only reason there is a property here at all.
   *
   * The counterexample was already in this file, twelve lines below, built for
   * the `canAddMachine` check and never fed to the iff:
   * `{machineCount: 0, machineLimit: 5, canAddMachine: false}` hid the door and
   * drew no sentence. `{machineCount: 5, machineLimit: 5, canAddMachine: true}`
   * was the mirror — a door *and* a sentence saying it was full.
   *
   * `null` and `undefined` are in the limit set because `machineLimit` is
   * `number | null` on the wire and a control plane rolled back past this
   * release sends neither, so both are shapes rather than paranoia.
   */
  for (const machineCount of [0, 1, 2, 3]) {
    for (const machineLimit of [undefined, null, 0, 1, 2, 5]) {
      for (const canAddMachine of [undefined, true, false]) {
        const subject = me({ machineCount, machineLimit, canAddMachine });
        report(
          `a sentence is drawn exactly where the door is not (${machineCount}/${String(machineLimit)}/${String(canAddMachine)})`,
          (machineQuotaNotice(subject) === null) === mayAddMachine(subject),
          `notice ${machineQuotaNotice(subject) === null ? "null" : "sentence"} / may ${mayAddMachine(subject)}`,
        );
      }
    }
  }

  /*
   * The server's own answer wins where there is one, because "somebody at their
   * limit is not offered a way to add more" is the control plane's rule and a
   * client re-deriving it is a second copy. Asserted with the numbers
   * deliberately disagreeing, which is the only way to see which one is read.
   */
  check(
    "`canAddMachine` decides, not the two numbers beside it",
    mayAddMachine(me({ machineCount: 0, machineLimit: 5, canAddMachine: false })),
    false,
  );

  /* ---- the four sentences ---- */

  const noticeOf = (over: Record<string, unknown>): string => machineQuotaNotice(me(over)) ?? "";
  report(
    "a fresh account on a closed instance is told what to ask for",
    noticeOf({ machineCount: 0, machineLimit: 0 }).includes("Ask for it to be raised"),
    noticeOf({ machineCount: 0, machineLimit: 0 }),
  );
  report(
    "and one whose machines just went dark is told they went dark",
    noticeOf({ machineCount: 2, machineLimit: 0 }).includes("your machines are off"),
    noticeOf({ machineCount: 2, machineLimit: 0 }),
  );
  report(
    "at the limit, the count is in the sentence",
    noticeOf({ machineCount: 2, machineLimit: 2 }).includes("All 2 machines in use"),
    noticeOf({ machineCount: 2, machineLimit: 2 }),
  );
  report(
    "over it, one machine is singular",
    noticeOf({ machineCount: 3, machineLimit: 2 }).includes("newest one is off"),
    noticeOf({ machineCount: 3, machineLimit: 2 }),
  );
  report(
    "and two are plural",
    noticeOf({ machineCount: 4, machineLimit: 2 }).includes("newest 2 are off"),
    noticeOf({ machineCount: 4, machineLimit: 2 }),
  );
  /*
   * The copy caps (decision 9B) are held in review rather than by a driver, and
   * this is the one place a driver can count without reading JSX: every notice
   * is a pure string. Fourteen words is the cap for a sentence that replaces a
   * control, and 27 is what these ran to before.
   */
  for (const [count, limit] of [[0, 0], [2, 0], [2, 2], [3, 2], [4, 2], [0, 5]] as const) {
    const text = noticeOf({ machineCount: count, machineLimit: limit, canAddMachine: false });
    report(`the notice for ${count}/${limit} is at most 14 words`, text.split(/\s+/).length <= 14, text);
  }

  /* ---- the admin's consequence line, which is also whether to confirm ---- */

  check("raising costs nothing and asks nothing", machineLimitChangeNotice("ada", 3, 5), null);
  check("nor does setting it to what it already is", machineLimitChangeNotice("ada", 3, 3), null);
  check("nor does zero when they own nothing", machineLimitChangeNotice("ada", 0, 0), null);
  report(
    "lowering onto two machines says two, and says they come back",
    (machineLimitChangeNotice("ada", 3, 1) ?? "").includes("newest 2 working") &&
      (machineLimitChangeNotice("ada", 3, 1) ?? "").includes("brings them back"),
    machineLimitChangeNotice("ada", 3, 1) ?? "(null)",
  );
  report(
    "and onto one says one",
    (machineLimitChangeNotice("ada", 2, 1) ?? "").includes("newest one working"),
    machineLimitChangeNotice("ada", 2, 1) ?? "(null)",
  );
  /*
   * The caps (review D10): fourteen words is the confirmation cap and both
   * consequence lines were over it — the per-user one at seventeen and the fleet
   * one at sixteen, where the plan had counted them at sixteen and fourteen.
   * Both are at the cap now: the per-user line stood at fifteen for a round,
   * "accepted" in a comment with no owner behind it, and the fix round refused
   * that (E11) — the pinned substrings above cost seven of its fourteen.
   * Whitespace tokens, a dash counting as one, which is why both traded theirs
   * for a semicolon.
   */
  {
    const { fleetMachineLimitNotice } = await import("../src/quota.js");
    const wordCount = (text: string): number => text.trim().split(/\s+/).length;
    check("lowering onto two machines is at the fourteen-word cap", wordCount(machineLimitChangeNotice("ada", 3, 1) ?? ""), 14);
    check("and onto one", wordCount(machineLimitChangeNotice("ada", 2, 1) ?? ""), 14);
    check("the fleet line is at the fourteen-word cap", wordCount(fleetMachineLimitNotice("50", "5") ?? ""), 14);
    check("and names only the value being set", /from 50/.test(fleetMachineLimitNotice("50", "5") ?? ""), false);
    check("with the closing arm under it", wordCount(fleetMachineLimitNotice("50", "0") ?? "") <= 14, true);
  }

  /* ---- the validator, shared by both screens ---- */

  check("empty is legal — it hands the value back to the default", machineLimitProblem(""), null);
  // Whitespace alone is the same as empty, which is what every field on the
  // server-settings screen already does with a blank draft: `.trim()` then
  // `clear`. Refusing it would make a stray space look like a malformed number.
  check("and so is a field holding only a space", machineLimitProblem("   "), null);
  // The one that matters: a validator written with a truthiness test refuses
  // precisely the value the whole feature is for.
  check("zero is legal", machineLimitProblem("0"), null);
  check("and so is the ceiling itself", machineLimitProblem(String(HARD_MACHINE_CEILING)), null);
  for (const bad of ["-1", "2.5", "abc", "5 machines"]) {
    report(`"${bad}" is refused`, machineLimitProblem(bad) !== null, String(machineLimitProblem(bad)));
  }
  report(
    "and one past the ceiling names it",
    (machineLimitProblem(String(HARD_MACHINE_CEILING + 1)) ?? "").includes(String(HARD_MACHINE_CEILING)),
    String(machineLimitProblem(String(HARD_MACHINE_CEILING + 1))),
  );

  /* ---- one badge, by precedence ---- */

  check("over the limit outranks not enrolled", machineBadgeText({ overLimit: true, enrolled: false }), "over the limit");
  check("and is the only badge when it applies", machineBadgeText({ overLimit: true, enrolled: true }), "over the limit");
  check("otherwise not-enrolled still draws", machineBadgeText({ overLimit: false, enrolled: false }), "not enrolled");
  check("and an ordinary machine draws nothing", machineBadgeText({ overLimit: false, enrolled: true }), null);
  /*
   * A banned owner outranks the limit, because the remedies differ and only one
   * of them works: retiring a machine does nothing for a machine whose owner is
   * banned, so naming the limit first would send the reader to the wrong act.
   */
  check(
    "a banned owner outranks the limit",
    machineBadgeText({ overLimit: true, ownerDisabled: true, enrolled: true }),
    "owner disabled",
  );
  check(
    "and an absent field degrades to not-banned",
    machineBadgeText({ overLimit: false, enrolled: true }),
    null,
  );

  /*
   * ⭐ **The client's ceiling is the server's**, read out of the control plane's
   * own source rather than transcribed. A number this screen prints in a refusal
   * has to be the number the service enforces.
   */
  const machinesTs = readFileSync(new URL("../../control-plane/src/machines.ts", import.meta.url), "utf8");
  check(
    "the mirrored ceiling is the one `machines.ts` declares",
    Number(/MAX_MACHINES_PER_USER = (\d+)/.exec(machinesTs)?.[1]),
    HARD_MACHINE_CEILING,
  );

  /*
   * ⭐ **The call sites, read off disk — the `gateOffer`/`showsGateLink` defect
   * class.**
   *
   * That rule was lost once by being *asserted* on the pure function while every
   * screen re-derived it at its own call site, and every assertion stayed green.
   * So: each affordance must ask the shared predicate, and must not mention the
   * two numbers it is computed from — and must not count `state.machines`, which
   * is a **different number** (it includes machines granted to you and owned by
   * somebody else, while the limit counts only the ones you own).
   */
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /*
   * ⭐ **The fourth door onto that predicate, and it draws no screen.**
   *
   * `store.ts` creates a machine by itself now, for the computer the desktop app
   * is running on. The three files below are affordances somebody presses; this
   * one is not, which is exactly why it needs naming here — a silent create that
   * skipped `mayAddMachine` would spend a permanent slot and answer `409` to
   * nobody, and every assertion in this file would stay green while it did.
   */
  {
    const store = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    check("the store asks the shared predicate before creating a machine", /mayAddMachine\(/.test(store), true);
    check("and never re-derives it from the fields", /machineLimit|machineCount|canAddMachine/.test(store), false);
    /*
     * ⚠ **Gated on the native shell, never on the fleet being empty**, and this is
     * the assertion that keeps the live bootstrap driver honest. That driver stubs
     * `fetch` with a function that ignores `init.method`, so a `POST /v1/machines`
     * from it would be answered `{machines: []}` with a 200 and a machine id of
     * `undefined`. It cannot reach this code because `__TAURI__` is absent when
     * `native.ts` is first imported and `host` is therefore `null` — a fleet-size
     * gate would have no such protection.
     */
    check(
      "and reaches the host before it decides anything",
      /const boot = this\.snapshot\.host;\s*if \(boot === null\) return;/.test(store),
      true,
    );
    /*
     * ⚠ **A failed setup may not become `cpError`.** That field puts the whole app
     * on the spinner — `bootstrap`'s catch arm forces `phase: "loading"` with no
     * connections, which is precisely the empty-fleet state this runs in. One
     * affordance failing must not read as the control plane being down.
     */
    const setUp = /private async setUpThisComputer\(\)[\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    check("the setup path exists to be checked", setUp.length > 0, true);
    check("and it never writes cpError", /cpError/.test(setUp), false);
    check("and it never moves the phase", /phase:/.test(setUp), false);
    /*
     * And it consults what it already claimed. Creating unconditionally on every
     * bootstrap is the defect this whole record exists to prevent: a machine row is
     * counted with no revoked filter, so each one holds a slot until it is
     * revoked — and nobody revokes a machine they never knew was made.
     */
    check("and it re-mints against a machine it already made", /state\.claimed/.test(setUp), true);
    /*
     * ⭐ **And it asks what is already configured on this computer, before it buys
     * anything.**
     *
     * Measured on a real machine 2026-09-15, and this is the whole failure: a
     * computer carrying a half-finished `deploy/install.sh` install reported
     * `absent` — because nothing looked at the env file — so the store created a
     * machine at 15:15:54, and one second later the host started the daemon on the
     * *old* file's hour-dead enrollment code. `409 code_unusable`, a child gone in
     * under a second, a permanently spent quota slot, and nothing on the screen.
     *
     * Three assertions because the three arms fail differently: without the
     * `elsewhere` arm this app writes over a daemon somebody else configured;
     * without the `here` arm it buys a machine for a computer that has one; and
     * without the empty-argument adoption call the host cannot tell "start what is
     * there" from "provision this".
     */
    check("and it reads what the env file here already says", /state\.config/.test(setUp), true);
    for (const arm of ["elsewhere", "here"] as const) {
      check(`and it has an arm for ${arm}`, new RegExp(`DAEMON_CONFIG\\.${arm}`).test(setUp), true);
    }
    check('and adoption starts with no code at all', /startLocalDaemon\("",\s*""\)/.test(setUp), true);
    /*
     * ⭐ **And adoption is tried *before* a fresh code is minted.**
     *
     * Re-minting first re-enrolls a daemon that was already enrolled: the daemon
     * compares `codeFp` against the file's code (`scripts/daemon.ts`), so a new
     * code is a new fingerprint and `enroll()` runs — rotating the tunnel key on
     * every single launch, and turning a half-reachable control plane into a
     * daemon that exits 2 despite holding a perfectly good identity. The ordering
     * is the whole fix, so it is asserted as an ordering rather than as two arms.
     */
    check(
      "and adoption comes before re-minting",
      setUp.indexOf("DAEMON_CONFIG.here") < setUp.indexOf("remintFor("),
      true,
    );
    /*
     * ⭐ **And a transient mint failure may not buy a machine.** `remintFor`
     * answering a plain boolean read "the wifi dropped" as "that machine is gone"
     * and fell through to `createForThisComputer` — a permanently spent quota slot
     * for a computer that already had one, on the failure most likely to be
     * temporary.
     */
    check('only a refusal falls through to buying one', /!== "dead"/.test(setUp), true);

    /*
     * ⭐ **A daemon per server, and what the setup flow owes each answer now.**
     * Q7.148: the host used to read `~/.reemoat` whoever it belonged to, so on a Mac
     * whose launchd daemon served the dev stand, signing in to production answered
     * `elsewhere` — *"This computer could not be set up"* — and a live daemon for
     * another server in that folder read as `foreign`, which returned without a
     * word. The host reads this server's own root now, and three things follow here.
     *
     * `foreign` means a daemon in *this* server's root that this app did not start
     * — this server's own unless the host flags it a `stranger`, below. One
     * whose machine is in this account's list is adopted silently; one that is not
     * is a sentence, because silence is a computer that never becomes a machine
     * with nothing saying why — and only once the machine list is in hand, since
     * `bootstrap`'s catch leaves no connections and would make somebody's own
     * daemon read as one they cannot see.
     */
    check(
      "a foreign daemon this account can see is adopted without a word",
      /status === "foreign"[\s\S]{0,300}this\.connections\.has\(/.test(setUp),
      true,
    );
    check("and one it cannot see is a sentence rather than silence", /status === "foreign"[\s\S]{0,500}FOREIGN_DAEMON_DETAIL/.test(setUp), true);
    check(
      "and the sentence waits for the machine list",
      /status === "running"\) \{\s*if \(state\.stranger\) return;\s*if \(this\.snapshot\.phase !== "ready"\) return;/.test(setUp),
      true,
    );
    /*
     * ⭐ **And a stranger is silence, before anything else is asked.** The legacy
     * root is every daemon's that was started without `REEMOAT_HOME`, and its
     * announcement is last-writer-wins — so the daemon the host finds there can be
     * a `pnpm daemon` from a checkout enrolled with another control plane, whose
     * machine is in no list this account has. The first version of this arm told
     * that person *"a daemon for this server is running … as a machine this account
     * cannot see"*, with a remedy about this server's accounts: two false things.
     * The host says `stranger` beside the status rather than `absent` in its place,
     * so the silence is a return and never an adoption.
     */
    check(
      "a stranger's daemon is silence, whatever the list says",
      /state\.status === "foreign" \|\| state\.status === "running"\) \{\s*if \(state\.stranger\) return;/.test(setUp),
      true,
    );
    /*
     * ⭐ **And `running` owes the answer `foreign` does.** A sign-out reloads the
     * page and leaves the host and its children up, so the next account on this
     * server finds the child the last one enrolled: a machine it cannot see, which
     * used to fall through to the running-or-starting return without a word. Only
     * in the first read — the settle loop's `running` stays the happy path it is,
     * because a control plane that blinked between the spawn and the poll would
     * otherwise draw a failure over a daemon that came up fine.
     */
    check(
      "a running daemon this account cannot see gets the same sentence",
      /state\.status === "foreign" \|\| state\.status === "running"\)[\s\S]{0,500}FOREIGN_DAEMON_DETAIL/.test(setUp),
      true,
    );
    check(
      "and foreign is answered before the running-or-starting return",
      [setUp.indexOf('state.status === "foreign"') > 0, setUp.indexOf('state.status === "foreign"') < setUp.indexOf('state.status !== "absent"')],
      [true, true],
    );
    /*
     * ⭐ **And a daemon for this server that the host's root does not hold is still
     * adopted before anything is bought or re-minted.** A daemon on the legacy
     * database whose env file lives elsewhere — `REEMOAT_ENV_FILE`, `pnpm daemon`
     * from a checkout, a `daemon.env` moved aside while it ran — answers `absent`
     * for this server's root. Without the check the flow buys a second machine, or
     * re-mints the claimed one into a fresh database and rotates the tunnel key out
     * from under the daemon serving it. Asserted as an ordering, for the same reason
     * the adoption-before-re-mint check above is.
     */
    check(
      "a live daemon this account already reaches is adopted before re-minting or buying",
      /DAEMON_CONFIG\.here[\s\S]*await localDaemon\(\)[\s\S]*this\.connections\.has\([\s\S]*remintFor\(/.test(setUp),
      true,
    );
    /*
     * And the remedy the old sentence gave is gone from every sentence: moving
     * `~/.reemoat/daemon.env` aside strands the *other* server's database — the one
     * that file belongs to — rather than setting anything up here.
     */
    check("and no sentence tells anybody to move ~/.reemoat/daemon.env", /move ~\/\.reemoat\/daemon\.env aside/.test(store), false);
    check("while a file in this server's own folder still has one", /~\/\.reemoat\/servers aside/.test(store), true);
    /*
     * ⚠ **The server picker no longer says that the other accounts' daemons keep
     * running** — the owner's call, 2026-09-24, on seeing it under the field of the
     * add screen. It is still true (the host starts every account's daemon at
     * launch, Q7.149); it is simply not this screen's to say, and the gate on it
     * (`hostsDaemon`) went with it. `webcheck.gate-and-server-settings.ts` pins the
     * sentence absent.
     */
    {
      const chooseServer = strip(readFileSync(new URL("../src/ui/ChooseServer.tsx", import.meta.url), "utf8"));
      check("the server picker reads no daemon capability any more", /canHostDaemon/.test(chooseServer), false);
    }

    /*
     * ⭐ **And the whole flow runs once.** `bootstrap()` has three callers — the
     * entry point, `retry()` and the forced password change — so two runs racing
     * would each read `absent` and each buy a machine.
     */
    check("the setup flow is single-flight", /this\.settingUp \?\?=/.test(store), true);
    /*
     * ⚠ **And the guard is released, never latched.** A flag set once per process
     * also makes `retry()` a no-op for setup: somebody whose control plane was
     * down fixes their network, presses Retry, and nothing happens until they
     * restart the app. Concurrency is all that needs guarding — a second run sees
     * the machine the first made and adopts it.
     */
    check("and it is released when the run settles", /\.finally\(\(\) => \{\s*this\.settingUp = null;/.test(store), true);
    /*
     * ⭐ **And the start is watched rather than assumed.**
     *
     * `startLocalDaemon` resolving means a process was *spawned*. Everything that
     * can still go wrong — a refused code, an unverifiable certificate, a database
     * a newer daemon migrated — happens seconds later in a child whose output goes
     * to a ring buffer. The version of this flow that cleared `setup` on the next
     * line reported success for a daemon that was already dead, which is how the
     * failure above stayed invisible through two builds.
     */
    check("the setup flow settles rather than assuming a spawn worked", /settleDaemon\(/.test(setUp), true);
    const settle = /private async settleDaemon\([\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    const remint = /private async remintFor\([\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    check("and the settle loop exists to be checked", settle.length > 0, true);
    /*
     * ⚠ **And what it reports is a *sentence*, never the daemon's own output** —
     * owner's call, 2026-09-15, reversing the arm this assertion used to pin. The
     * settle loop put `state.detail` — the host's two-hundred-line ring — straight
     * into the rail's notice, which drew it verbatim in a `<pre>`. The ring is
     * Settings → Logs now and the rail says one sentence.
     *
     * Both halves, because either alone goes green over the wrong thing: the tail
     * is not read here, **and** every failure that has evidence says where it went.
     * A negative alone is the anti-pattern this file already names elsewhere — it
     * would pass just as well over a flow that says nothing at all.
     */
    check("and the settle loop never puts the daemon's output in the notice", /state\.detail/.test(settle), false);
    check("while every failure with evidence names where it is", /LOGS_POINTER|DAEMON_STOPPED_DETAIL|GAVE_UP_DETAIL/.test(settle), true);
    const pointer = /const LOGS_POINTER = "([^"]+)"/.exec(store)?.[1] ?? "";
    check("and the pointer names a real settings section", /Logs/.test(pointer), true);
    const sections = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
    check("which the section table actually has", /title: "Logs"/.test(sections), true);
    /*
     * ⚠ **And it retries on the *fact* of an exit, never on the text of one.**
     * Matching `code_unusable` in a log tail would be a fourth reader of a string
     * the daemon is free to reword, and a reworded string would silently switch the
     * retry off. Re-minting costs no quota and the retry is bounded at one.
     */
    check("and it never pattern-matches the log to decide", /code_unusable|code_rejected/.test(settle), false);
    /*
     * ⭐ **And a fresh code answers exactly one exit.** Retrying on the *fact* of
     * an exit was right while an exit was all the daemon said; it says which now,
     * so a held database lock or a missing token stops being answered with a mint
     * that re-enrolls the machine over a problem no code can touch. Still the
     * process's status rather than its words.
     */
    check("a mint answers a refused code and nothing else", /DAEMON_EXIT\.codeRefused/.test(settle), true);
    /*
     * ⭐ **And the fast deadline slows down rather than giving a wrong answer.**
     * Stopping there left the notice saying `failed` over a daemon that came up a
     * second later, with nothing still watching to take it back.
     */
    check("a slow start is waited out, not called a failure", /SETUP_SLOW_POLL_MS/.test(settle), true);
    /*
     * ⭐ **And a computer whose settings cannot start is not a dead end.**
     *
     * The pure form of the original bug: a half-finished `deploy/install.sh`
     * install with a dead code, on a Mac this app has never bought a machine for.
     * Adoption is the right first move and it fails; without this arm the answer is
     * a sentence, identical on every relaunch, escapable only by deleting a file
     * nobody mentions. At most one machine is bought this way — the claim it writes
     * is what the next launch re-mints against.
     */
    check("a failed adoption can still provision", /provisionOver\(\)/.test(settle), true);
    const provision = /private async provisionOver\([\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    check("and buying there asks the shared predicate too", /mayAddMachine\(/.test(provision), true);
    /*
     * ⭐ **And an unreachable control plane keeps its own sentence.** `remintFor`
     * writes why the mint failed; falling through would overwrite it with the
     * daemon's last words, so somebody whose network is down reads "this enrollment
     * code was rejected".
     */
    check("a control plane that could not be reached is not reported as a bad code", /!== "dead"/.test(settle), true);
    /*
     * ⭐ **And a daemon this app did not start is not this app's success.**
     * Reaching `foreign` from inside a settle means the child that *was* started is
     * gone and the machine being set up never enrolled — while something else
     * answers on this computer. Counting it as success cleared the notice and left
     * somebody owning a machine that exists on the control plane and nowhere else.
     */
    check("a foreign daemon does not clear the notice", /status === "foreign"/.test(settle), true);
    check("and only a daemon this app started does", /status === "running"[\s\S]{0,120}setup: null/.test(settle), true);
    check(
      "and the settle loop's running arm asks nothing about the list",
      /status === "running"\) \{\s*this\.patch\(\{ setup: null \}\);\s*await this\.machinesChanged\("machine-added"\);\s*return;\s*\}/.test(settle),
      true,
    );
    /*
     * ⭐ **And a child that died beside a stranger is still a failure — told
     * without "for this server".** Inside a settle the child this app started is
     * gone whoever else is announced, so silence would be the invisible failure
     * this loop exists to end; but `ANOTHER_DAEMON_DETAIL` says the other daemon is
     * this server's and a machine to use instead, and another fleet's is neither.
     */
    check("a stranger in the settle loop gets its own sentence", /state\.stranger \? STRANGER_DAEMON_DETAIL : ANOTHER_DAEMON_DETAIL/.test(settle), true);
    {
      const raw = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
      const strangerSaid = /const STRANGER_DAEMON_DETAIL =\s*`\$\{DAEMON_STOPPED_DETAIL\} ` \+\s*"([^"]+)";/.exec(raw)?.[1] ?? "";
      check("which was found to read", strangerSaid.length > 0, true);
      check("and never calls the other daemon this server's", /for this server/.test(strangerSaid), false);
      check("and says whose it is", /for a different server/.test(strangerSaid), true);
      /*
       * And Settings → Logs, whose `foreign` sentence names "the daemon for this
       * server": picked by the same flag, from the same poll, or that screen says
       * the false thing the setup notice no longer does.
       */
      const logs = strip(readFileSync(new URL("../src/ui/settings/LogsSection.tsx", import.meta.url), "utf8"));
      check("the logs screen reads the flag off the poll", /setStranger\(state\?\.stranger === true\)/.test(logs), true);
      const foreignSaid = /case "foreign":\s*return stranger\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)";/.exec(logs);
      check("and picks its foreign sentence by it", foreignSaid !== null, true);
      check(
        "a stranger's is about a different server, and the other names this one",
        [/found here is for a different server/.test(foreignSaid?.[1] ?? ""), /The daemon for this server/.test(foreignSaid?.[2] ?? "")],
        [true, true],
      );
    }
    /*
     * ⭐ **And "that machine is gone" is a *named* refusal.** With the test the
     * other way round, a 401 on an expired session or any unrecognised 5xx bought a
     * second machine for a machine that is alive — a slot held until a person
     * notices it, so the default has to be the answer that spends nothing.
     */
    for (const code of ["machine_not_found", "machine_revoked"] as const) {
      check(`a dead claim is ${code}`, remint.includes(code), true);
    }
    check("and the mint failure is classified rather than swallowed", /ApiError\.isApiError\(/.test(remint), true);
  }

  /*
   * ⭐ **The name, which is the half that fails on the *second* computer.**
   *
   * A control-plane label is refused when the account can already see one spelled
   * the same, compared case-insensitively — so this is not about tidiness, it is
   * the difference between an app that sets up one Mac and an app that sets up
   * two. And the alphabet is not ours: `MACHINE_LABEL` is
   * `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, so anything this produces that the
   * server would refuse is a `400` nobody can act on.
   *
   * Asserted against the server's own regex rather than against examples, because
   * the property wanted is "whatever comes out is acceptable", not "these six
   * strings map to these six strings".
   */
  {
    const { machineLabelFor } = await import("../src/store.js");
    const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    const cases: [string | null, string][] = [
      ["Rendss-MacBook-Pro", "an ordinary host name survives intact"],
      ["Ann's Mac", "an apostrophe becomes a separator rather than vanishing"],
      ["--weird--", "leading punctuation is dropped, since a label must start alphanumeric"],
      ["...", "a name with nothing usable in it still yields a label"],
      ["", "so does an empty one"],
      [null, "and so does no name at all"],
      ["Ы-машина", "and a name in another script"],
      ["x".repeat(200), "and one far past the length bound"],
    ];
    for (const [input, name] of cases) {
      check(name, LABEL.test(machineLabelFor(input)), true);
    }
    /*
     * The one behavioural assertion, and it is about *collisions* rather than
     * shape: two different computers must not be flattened onto one label by the
     * sanitiser itself, or the retry is asked to fix something it cannot see.
     */
    check(
      "two names that differ only in punctuation stay different machines",
      machineLabelFor("Anns Mac") !== machineLabelFor("Ann's Mac"),
      true,
    );
    /*
     * ⚠ **The machine this app sets up carries the ordinary host name, and
     * `local` is not a name at all** — an owner's call, 2026-09-15, reversing one
     * taken the same day. The first answer was the literal `local`, on the
     * argument that the machine this app sets up is the computer somebody is
     * sitting at. What that missed is who else reads the label: a phone, a second
     * computer, anybody holding a grant — and to all of them `local` names a
     * computer somewhere else.
     *
     * So this pins **both halves of the reversal**, because either alone can be
     * quietly undone: the base is the host name, and no literal `"local"` is left
     * in the function. The `local`-ness moved to the client, drawn off the announce
     * file: a `this device` badge in Settings → Machines, asserted in
     * `webcheck.local-route.ts` where the announce stub lives, and the name `local`
     * first on the home screen, driven in `webcheck.command-menu-and-browser.ts`.
     */
    const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    const creating = /private async createForThisComputer\([\s\S]*?\n  \}/.exec(storeSrc)?.[0] ?? "";
    check("createForThisComputer was found to read", creating.length > 0, true);
    check("the machine this app sets up is named after the computer", /const base = machineLabelFor\(boot\.hostName\)/.test(creating), true);
    check("and nothing there names a machine `local`", /"local"/.test(creating), false);
    check("the constant that used to is gone", /LOCAL_MACHINE_NAME/.test(storeSrc), false);

    /*
     * ⚠ **The retry's suffix, and the boundary that made it vacuous.**
     * `machineLabelFor` applies its `.slice(0, 64)` **last**, so appending `-2`
     * and re-shaping a maximal name answers the original name — the retry would
     * re-post what had just collided. The base is sliced to 61 first; this is the
     * case that proves it, and it is the case the old spelling of this assertion
     * (`machineLabelFor(null)` = eight characters) could never have reached.
     */
    check("a disambiguated name is still a label", LABEL.test(machineLabelFor(`${machineLabelFor(null)}-2`)), true);
    const longest = machineLabelFor("x".repeat(200));
    check("a maximal label is the full sixty-four", longest.length, 64);
    check("and re-shaping it with a suffix gives the name back", machineLabelFor(`${longest}-2`), longest);
    check("so the retry slices first", machineLabelFor(`${longest.slice(0, 61)}-2`).endsWith("-2"), true);
    check("and the code does the slicing", /base\.slice\(0, 61\)/.test(creating), true);
  }

  /*
   * ⚠ **A census against the tree, because the floor that used to guard this list
   * was `quotaDoors.length === 4` — a hand-typed literal compared against a
   * hand-typed copy of its own length, six lines apart.** It read nothing from
   * `src/`, so it could not fail on any product change, and its own comment
   * claimed the opposite: *"a new door not on it passes silently. The floor below
   * is what says the list was walked at all."* It never said that. It also could
   * only ever go red on somebody **adding** a door correctly, which is the
   * driver-fails-on-an-improvement shape this repository names elsewhere.
   *
   * And the claim was already false when it was written: `ui/AppShell.tsx` draws
   * `installCommand(controlPlaneOrigin())` in one arm against
   * `machineQuotaNotice(state.me)` in the other — the door-or-the-sentence pair
   * these three per-file checks exist for — and was on no list.
   *
   * Differencing two derivations is what goes red on a skip: the set of UI files
   * that mention the predicate, against the set somebody wrote down. A count
   * cannot, because a skipped item does not lower one.
   */
  const quotaDoors = [
    "ui/AppShell.tsx",
    "ui/SessionBrowser.tsx",
    "ui/MachineColumn.tsx",
    "ui/NewSession.tsx",
    "ui/settings/MachinesSection.tsx",
  ];
  const asksQuota = srcFiles()
    .filter((file) => file.startsWith("ui/"))
    .filter((file) => /mayAddMachine\(/.test(strip(srcFile(file))))
    .sort();
  check("every door the quota gates is on the list, and nothing else is", asksQuota, [...quotaDoors].sort());
  for (const file of quotaDoors) {
    const src = strip(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    check(`${file} asks the shared predicate`, /mayAddMachine\(/.test(src), true);
    check(`${file} never re-derives it from the fields`, /machineLimit|machineCount|canAddMachine/.test(src), false);
    check(`${file} never counts the machine list instead`, /machines\.length\s*>=?\s*[A-Za-z]/.test(src), false);
  }

  /*
   * ⭐ **One writer for the chosen folder, read off disk because the defect was
   * two of them.**
   *
   * `NewSession` holds `cwd` and `DirectoryPicker` holds `path`, and the picker
   * reports up through an effect keyed on its own `path`. So a parent write to
   * `cwd` that the picker did not make is unrecoverable by construction: `path`
   * has not changed, the report never fires again, and `Start` stays disabled
   * over a folder its own footer is naming. Three ordinary routes hit it — the
   * rail's folder `+`, the "re-check" after an inline sign-in, and any change of
   * machine.
   *
   * None of this is reachable from a pure function: it is a race between two
   * effects in one file. What *is* checkable is the shape that makes the race
   * impossible, which is three separate facts and all three were wrong at once.
   */
  {
    const src = strip(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
    // 1. The parent never writes the folder. Only the picker does.
    check("nothing but the picker clears the chosen folder", /setCwd\(null\)/.test(src), false);
    // 2. A machine change is a remount, so the picker's own `path` cannot survive
    //    into a tree it does not belong to.
    check("the picker is keyed on the machine", /<DirectoryPicker\s+key=\{selected\}/.test(src), true);
    // 3. The report is unconditional, so `cwd` mirrors `path` in both directions.
    //    Guarded on non-null it was half a rule, and the half it was missing is
    //    the one that lets the parent hold a folder the picker is not showing.
    check("and reports the absence of a folder too", /if \(path !== null\) onPick/.test(src), false);
    check("reporting it unconditionally instead", /onPick\(path\);/.test(src), true);
    /*
     * ⚠ **And the report's dependencies are `path` alone**, which is the half that
     * became load-bearing when the picker grew a second arm. `osDialog` can arrive
     * at a `runResume` after the first render, so a dependency list holding it would
     * re-fire the report at that moment — a second writer on a different clock,
     * which is this whole block's subject arriving through a new door.
     */
    check("and the report is keyed on the folder and nothing else", /onPick\(path\);\s*\}, \[path\]\);/.test(src), true);
    /*
     * ⚠ **A dismissed file panel leaves the folder alone.** `pickFolderNative`
     * answers `null` for a cancel, and writing that through would clear a folder
     * somebody had already chosen — which is `setCwd(null)` above arriving by the
     * one route this file did not previously have.
     */
    check("a cancelled panel is not a choice", /if \(picked !== null\) setPath\(picked\);/.test(src), true);
    /*
     * **And the panel arm grows no second way to make a folder.** Every platform's
     * open panel has a New Folder button that hands back what it made, already
     * selected; a copy beside it would post against a parent this arm deliberately
     * does not list. One call site, on the tree arm, is what that means on disk.
     */
    check("there is one route to making a folder, and it is the tree's", (src.match(/\.makeDir\(/g) ?? []).length, 1);
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/MachinesSection.tsx", import.meta.url), "utf8"));
    // The door is downstream of the check that it may be offered at all — the
    // `asksMailUsable < promisesReset` idiom one section over, which guards both
    // operands with `>= 0` for the reason that idiom's neighbours record: dropping
    // the predicate makes the left side -1, and -1 is less than every real
    // position, so the ordering passes with the gate it is about deleted.
    //
    // ⚠ **The door is the one-line installer, and the by-name form is gone.**
    // `<AddMachine` minted an enrollment code to carry to a host by hand; the
    // decision (2026-09-04) is that a machine is added by running the script on
    // it and nothing else, so the form's absence is asserted as the rule rather
    // than left as a gap somebody might close by putting it back.
    const asks = src.indexOf("mayAddMachine(");
    const door = src.indexOf("<CommandLine");
    check("the screen still asks whether a machine may be added", asks >= 0, true);
    check("and the one-line installer is the door it gates", door >= 0, true);
    check("with no by-name form beside it", /<AddMachine/.test(src), false);
    report(
      "the door is downstream of the check that it is offerable",
      asks >= 0 && door >= 0 && asks < door,
      `${asks} < ${door}`,
    );
    /*
     * **The list first, the installer under it, under its own heading, with no
     * sentence** (decision 3B). The intro that opened this screen explained the
     * command before the rows anybody came to scan; the heading is the
     * instruction now. Pinned as the heading's presence, the intro's absence, and
     * the order — the rows' heading before the door's.
     */
    const listHeading = src.indexOf("Your machines");
    const addHeading = src.indexOf("Add a machine");
    check("the installer sits under its own heading", addHeading >= 0, true);
    check("with no sentence introducing it", /host running the daemon|run this on it/.test(src), false);
    check("and the list comes first", listHeading >= 0 && addHeading >= 0 && listHeading < addHeading, true);
    /*
     * **"No machines yet." may never be a false claim.** One skeleton row stands
     * in while the first listing is in flight — exactly one, because the expected
     * count is 0–1 and two placeholders collapsing to one sentence is a layout
     * shift that implied an item. Ordered before the sentence in source so the
     * loading arm is tested first.
     */
    const skeletons = src.split("<SkeletonRow").length - 1;
    check("one skeleton row stands in for the first listing", skeletons, 1);
    check("and it is asked before the empty state is claimed", src.indexOf("<SkeletonRow") < src.indexOf("No machines yet."), true);
    /*
     * **And the outage arm says what every other screen says about the same
     * outage** — `CONTROL_PLANE_UNREACHABLE`, imported rather than a second
     * spelling: this list said "Control plane unreachable." while Account and
     * Keys said "Cannot reach the control plane." (review D7). What is this
     * screen's own is the second sentence, kept: an empty list under an outage is
     * the one place the reader might think the fleet went with it. Read off the
     * arm rather than restated here, and counted with the constant in front of
     * it: "Your machines are not gone." made the pair ten words against the
     * eight-word empty-state cap (E8's review).
     */
    const outageOwn = /<Empty failed>\{CONTROL_PLANE_UNREACHABLE\} ([^<{]+)<\/Empty>/.exec(src)?.[1] ?? null;
    check("the outage arm draws the shared sentence and keeps its own second one", outageOwn !== null, true);
    {
      const { CONTROL_PLANE_UNREACHABLE } = await import("../src/account.js");
      check("at the eight-word empty-state cap", `${CONTROL_PLANE_UNREACHABLE} ${outageOwn ?? ""}`.trim().split(/\s+/).length, 8);
    }
    check("imported from where the sibling sentences live", /import \{ CONTROL_PLANE_UNREACHABLE \} from "\.\.\/\.\.\/account";/.test(src), true);
    check("and the old spelling is gone", /Control plane unreachable/.test(src), false);
    /*
     * **Ownership is a badge, not a clause.** " · not yours to rename or retire"
     * rode the truncating subline, so on a phone the one fact that told you a row
     * was inert was the part that got cut. It is `shared` in a `shrink-0` badge
     * now, and at most one badge draws per row — a limit or enrolment badge wins.
     */
    check("a machine you do not own carries a `shared` badge", /"shared"/.test(src), true);
    // The sentence is absent from the list — and present on the machine's own
    // screen, asserted below once that file is read: a negative alone pointed at
    // the file the sentence left (review D12).
    check("and no longer says so in the subline", /not yours to rename or retire/.test(src), false);
    /*
     * ⚠ **Three ranks now, and the middle one is the 2026-09-15 reversal.** The
     * machine this app sets up is named after the computer like any other, so the
     * only thing left saying *which row you are sitting at* is this badge — and it
     * has to outrank `shared` or a machine somebody shared with you stops being
     * findable on the one screen you are on. A state badge still wins over both.
     */
    check(
      "with the state badge outranking both",
      /machineBadgeText\(machine\)[\s\S]{0,260}\?\? \(isThisDevice \? "this device" : machine\.owned === true \? null : "shared"\)/.test(src),
      true,
    );
    check("and `this device` comes from the store rather than from the route", /isThisDevice=\{machine\.id === state\.localMachineId\}/.test(src), true);
    check("never from the routing preference, which can be switched off", /route[\s\S]{0,40}=== "local"/.test(src), false);
    /*
     * Creating and retiring a machine move `machineCount`, which is the number
     * the limit is enforced against — and `runResume` refreshes `me` only on a
     * `loading → ready` promotion. Through `resume` alone, the add form stays
     * drawn on the screen that just consumed the last slot.
     *
     * Named per act rather than banning `store.resume(` outright, because
     * renaming a machine legitimately still uses it and moves no count.
     */
    /*
     * ⭐ **A setup code is offered before enrollment and never after**, and this is
     * pinned because the row is one `&&` away from coming back as a tidy-up. The
     * route still allows a re-mint on purpose, so nothing on the server side would
     * fail; what would fail is the reading — "New setup code" on a running host is
     * a menu claiming there is a step left. The cost was measured and accepted:
     * six recovery flows, the fleet's only credential rotation among them, are
     * `cpctl enroll` now. ⚠ Retire-then-Add is not the substitute — new machine id,
     * every grant but the creator's dropped silently. Q3.428.
     *
     * ⚠ **Pinned on `mintEnrollment`, and it used to be pinned on the wording.**
     * That read `/New setup code|Replace setup code/` against *this* file, and
     * both halves were wrong: the block had moved to `MachineSection.tsx`, and
     * neither literal existed anywhere in the tree at either revision — so it was
     * a negative about a file the act had left, naming strings nothing wrote,
     * which is exactly what the note under it warns against. `mintEnrollment` is
     * the call itself. The list may still show the code that `POST /v1/machines`
     * hands back for a machine it just created — that one is by construction not
     * enrolled — but it must never mint a *second* one for a row.
     */
    check("the list never mints a code for a machine already on it", /mintEnrollment/.test(src), false);
    /*
     * ⚠ **A machine is added from a terminal now, and this tab learns of it by
     * asking.** The by-name form that called `machinesChanged("machine-added")`
     * is gone (2026-09-04); the one-line installer enrolls the machine from the
     * host itself, so the poll re-lists an empty fleet every tick and re-reads
     * `me` — the count the limit is enforced against — once the first machine
     * lands. Both halves pinned on `store.ts`, since neither has a screen.
     *
     * ⚠ **The second alternative used to be `createMachine\(`, and it went
     * vacuous when that function was deleted from `cp.ts`** — a negative naming a
     * string nothing in the tree can write any more, which is the anti-pattern
     * the note above warns about, reached by deletion rather than by a move. The
     * route is what survives it: this screen may not `POST /v1/machines` under
     * any spelling, whatever the client function is called.
     */
    check(
      "nothing on this screen adds a machine by name",
      /machinesChanged\("machine-added"\)|"\/v1\/machines",\s*\{\s*method:\s*"POST"/.test(src),
      false,
    );
    {
      const storeSrc = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
      check("an empty fleet is re-listed by the poll rather than waiting for a wake", /resume\(this\.snapshot\.phase === "loading" \? "cp-retry" : "awaiting-first-machine"\)/.test(storeSrc), true);
      check("and the first machine landing re-reads who you are", /if \(this\.connections\.size > 0 && epoch === this\.epoch\) await this\.refreshMe\(\);/.test(storeSrc), true);
    }
    /*
     * ⭐ **Retire, rename and the setup code moved onto the machine's own screen**,
     * so the regexes that pin them follow the code rather than the filename — a
     * negative left pointing at the file the act LEFT is worth nothing, which is
     * how this pair would have silently stopped covering the half that moved.
     */
    const machineSrc = strip(
      readFileSync(new URL("../src/ui/settings/MachineSection.tsx", import.meta.url), "utf8"),
    );
    check("a setup code is offered only before a machine has enrolled", /!machine\.enrolled &&/.test(machineSrc), true);
    // Eight words with the remedy, the empty-state cap (review D10): the pane's
    // head is the machine's name, so the sentence does not repeat it.
    check(
      "the not-enrolled state is eight words with its remedy",
      /Not enrolled yet\.\s*\{setupOffered \? " Use the setup code above\." : ""\}/.test(machineSrc),
      true,
    );
    check("and no longer names the machine or its daemon", /has not enrolled yet|Start its daemon/.test(machineSrc), false);
    /*
     * The ownership sentence moved here with Name and Retire (plan 3.5): on a
     * machine somebody else owns, it is the one line explaining why those two
     * sections are missing, so the negative above is only half a pin.
     */
    check("the machine's own screen says it is not yours to rename or retire", /This machine is not yours to rename or retire\./.test(machineSrc), true);
    check("retiring one re-reads who you are too", /machinesChanged\("machine-revoked"\)/.test(machineSrc), true);
    check(
      "neither goes through resume alone",
      /resume\("machine-(added|revoked)"\)/.test(src) || /resume\("machine-(added|revoked)"\)/.test(machineSrc),
      false,
    );
    // A rename moves no count, so it stays on the cheaper call.
    check("a rename still does not", /resume\("machine-renamed"\)/.test(machineSrc), true);
    /*
     * ⚠ And it must leave the screen BEFORE the store drops the machine, or the
     * person reads "That machine is not in your list any more" about the machine
     * they just retired. The only guard on a runtime ordering here. Q3.432.
     *
     * Both operands are checked against `>= 0` first, the same shape as the
     * `App.tsx` ordering pins: a rename makes `indexOf` answer -1, and `-1 < n`
     * is *true*, so an unguarded comparison stays green with the property it
     * guards gone. The two `>= 0` lines fail naming the string that moved.
     */
    /*
     * **And the list is told at once** (review D9): `forgetMachine` drops the row
     * synchronously — the 200 has landed, so it is a fact rather than a guess —
     * where the re-list alone left the retired row on the list for a round trip.
     * **Handed to `navigate`, in the route's own flush.** The fix round moved it
     * there claiming that, as the next statement, the drop re-drew the machine's
     * screen with the wrong sentence on the transition path; `App.tsx` says
     * otherwise — the route is read through `useSyncExternalStore` beside the
     * store subscription and `announce` writes it before any transition, so that
     * render already carried the list (`announce`'s docblock holds the reading).
     * The placement is kept as the ordering by construction, and what is pinned
     * is the wiring rather than a failure: the one call whole, and the router's
     * half beside it — `alongside` runs inside the same flush as `tell`, on both
     * paths, which this driver's `document` (no `startViewTransition`) can read
     * off the source and not take. The store half: it is `dropMachine`, what a
     * re-list does for a revoked grant, plus the whole-snapshot `emit`.
     */
    const leavesScreen = machineSrc.indexOf("navigate(settingsPath(\"machines\"), true, () => store.forgetMachine(machine.id))");
    const dropsMachine = machineSrc.indexOf("machinesChanged(\"machine-revoked\")");
    check("retiring navigates away from the machine's screen with the store's drop in the route's own flush", leavesScreen >= 0, true);
    check("and drops it nowhere else", machineSrc.split("store.forgetMachine(").length - 1, 1);
    check("and still tells the store the machine is gone", dropsMachine >= 0, true);
    check(
      "and retiring leaves the screen before the re-list",
      leavesScreen >= 0 && dropsMachine >= 0 && leavesScreen < dropsMachine,
      true,
    );
    {
      const routerSrc = strip(readFileSync(new URL("../src/router.ts", import.meta.url), "utf8"));
      check("the router runs that work inside the flush that tells the route, under a transition", /flushSync\(\(\) => \{\s*tell\(\);\s*alongside\?\.\(\);\s*\}\);/.test(routerSrc), true);
      check("and on the instant path", /tell\(\);\s*alongside\?\.\(\);\s*return;/.test(routerSrc), true);
      check("and popstate passes none", /addEventListener\("popstate", \(\) => announce\(\)\)/.test(routerSrc), true);
      const storeSrc = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
      check("and the store's forget is the re-list's own drop, published whole", /forgetMachine\(id: MachineId\): void \{\s*this\.dropMachine\(id\);\s*this\.emit\(\);\s*\}/.test(storeSrc), true);
    }
    /*
     * **Retire names its subject and carries its cost only in the confirmation**
     * (decisions 10A and Q3.218). The 45-word paragraph at rest is gone; the
     * question names the machine — this app explicitly supports two machines
     * called the same thing — and the consequence sentence is `TwoStep`'s
     * `consequence` (E7's review, Q3.552), which that primitive draws under the
     * question and only while `armed`. So the pin is that the sentence reaches
     * the primitive as that prop, on the element `armed={confirming}` opens.
     */
    const question = machineSrc.indexOf("Retire {machine.name}?");
    const cost = machineSrc.indexOf('consequence="Frees the name and a slot.');
    const branch = machineSrc.indexOf("armed={confirming}");
    check("the retire confirmation names the machine", question >= 0, true);
    check("and states the cost", cost >= 0, true);
    // Where the element closes: its own `/>` on a line of its own, since a `<>…</>` fragment inside `question` carries a `/>` too.
    check("only inside the confirming arm", branch >= 0 && cost > branch && cost < branch + machineSrc.slice(branch).search(/^\s*\/>/m), true);
    check("with nothing of it drawn at rest", /voids any outstanding setup code|loses it silently/.test(machineSrc), false);
    /*
     * **Two acts, two locks.** One `busy` flag disabled Retire's Cancel while a
     * setup code minted. Minting holds its own flag now and the retire's wait is
     * `TwoStep`'s (E7's review, Q3.552): the request is handed over whole, so
     * the confirming pair's Cancel reads nothing of the mint's, and the resting
     * Retire is not greyed by one either.
     */
    check(
      "minting holds its own flag and the retire's wait is the primitive's",
      [/setMinting\(/.test(machineSrc), /setRetiring\(/.test(machineSrc), /onAct=\{revoke\}/.test(machineSrc)],
      [true, false, true],
    );
    check("and Retire's resting button is not locked by a mint", /rest=\{\s*<DangerButton icon=\{Trash2\} onClick=\{\(\) => setConfirming\(true\)\}>/.test(machineSrc), true);
    // The toast is three words: the facts it carried cannot be re-read once the
    // machine is gone from every screen, which is what a toast may not be the
    // only copy of.
    check("the retire toast carries no facts nothing can re-read", /enrollment code.*stopped working|expire within/.test(machineSrc), false);
    // The unreachable arm no longer restates its own position.
    check("the unreachable line names the reason and stops", /so its systems, agents and plugins/.test(machineSrc), false);
    /*
     * ⭐ **Who brought a machine online, said on both surfaces and said nowhere
     * when there is nothing to say.**
     *
     * `GET /v1/machines` answers `enrolledBy`: `null` where this caller enrolled
     * the machine themselves or where nothing knows, a display name where
     * somebody else's code did, and the two literal strings `"a provisioning
     * key"` and `"a deleted account"` for the cases the control plane
     * deliberately refuses to collapse into the reassuring one. It exists
     * because an admin can revoke a machine — which frees its label — register a
     * new one for the same person under that freed name and enroll it on their
     * own hardware; every step is a route that has to stay, so the composition
     * is **disclosed rather than refused**, and this line is the whole of the
     * disclosure. A client that quietly drew nothing would leave the composition
     * with no disclosure at all and nothing failing anywhere.
     */
    {
      const { enrolledByText } = await import("../src/wire.js");
      /*
       * The sentence, and the two silences that draw none of it. `null` is the
       * server saying *unknown* rather than "you", and `undefined` is a control
       * plane that predates the field — the same silence here on purpose, which
       * is the one place this client is allowed to collapse two absences.
       */
      check("nobody is named where the reader enrolled it themselves", enrolledByText(null), null);
      check("nor on a control plane that predates the field", enrolledByText(undefined), null);
      /*
       * The third silence, and the only one of the three the guard tests
       * separately: `who.length === 0`. Nothing sends `""` today, and that is the
       * point — an upstream `?? ""` is exactly the kind of change that would
       * arrive without a screen, and what it would draw is a bare "Enrolled by"
       * on both surfaces.
       */
      check("nor on an empty name, which would otherwise draw a sentence with nobody in it", enrolledByText(""), null);
      check("somebody else's code names them", enrolledByText("casey"), "Enrolled by casey");
      check("a provisioning key is named as one", enrolledByText("a provisioning key"), "Enrolled by a provisioning key");
      check("and so is an account that has gone since", enrolledByText("a deleted account"), "Enrolled by a deleted account");
      /*
       * ⚠ **The fifth answer, and the one the first release did not have.** A
       * machine that enrolled before `machines.enrolled_by` existed was folded
       * into `null` and drew nothing — which is what a machine you enrolled
       * yourself draws — so on the day the column shipped the disclosure was
       * silent for **every machine in the fleet**. The control plane names the
       * state now; this side has only to carry it through, and carrying it
       * through is the whole of what a client can get wrong here.
       */
      check(
        "a machine enrolled before this was recorded says so rather than nothing",
        enrolledByText("somebody this control plane did not record"),
        "Enrolled by somebody this control plane did not record",
      );
      /*
       * **No full stop in the shared string**, which is what lets one function
       * feed two registers: the list's sublines are fragments beside "online"
       * and "last seen 3 h ago", and the machine's own screen ends the sentence
       * itself. Pinned because the natural tidy-up is to move the stop in here,
       * which puts one in the middle of a row that is a fragment.
       */
      check("the fragment carries no punctuation of its own", /[.!?]$/.test(enrolledByText("casey") ?? ""), false);
    }
    /*
     * ⚠ **Nothing typed can hold a placement**, so both surfaces are read off
     * disk. Three facts per surface: the line is drawn, it is guarded on the
     * function's `null` so a machine you enrolled yourself grows no row, and the
     * sentence comes from `enrolledByText` rather than a second spelling — a
     * disclosure with two homes is two disclosures, and only one of them
     * survives the next shortening pass.
     */
    check("the list row draws it as a subline of its own", /\{provenance !== null && <span className="block truncate text-2xs text-muted">\{provenance\}<\/span>\}/.test(src), true);
    check("the machine's own screen draws it as a sentence", /\{provenance !== null && <p className="mt-1 text-xs text-muted">\{provenance\}\.<\/p>\}/.test(machineSrc), true);
    check(
      "both from the one shared sentence",
      [
        /const provenance = enrolledByText\(machine\.enrolledBy\);/.test(src),
        /const provenance = enrolledByText\(machine\.enrolledBy\);/.test(machineSrc),
      ],
      [true, true],
    );
    check(
      "and neither spells it by hand",
      [/["`>]Enrolled by/.test(src), /["`>]Enrolled by/.test(machineSrc)],
      [false, false],
    );
    /*
     * ⚠ **And it may not ride the `standing` line**, which is the lesson the
     * `shared` badge above already had to learn: " · not yours to rename or
     * retire" was a clause on that truncating subline, so on a 390px phone the
     * one fact worth reading was the part that got cut. `standing` is also about
     * *now* and turns over on the four-second poll, while this changes only when
     * somebody re-enrolls the machine — one line cannot be both. Asserted on the
     * expression itself rather than on a distance in the file, so the two cannot
     * be joined by moving either of them.
     */
    const standingExpr = /const standing =([\s\S]*?);\n/.exec(src)?.[1] ?? "";
    check("the standing line is still there to be kept clear of", standingExpr.length > 0, true);
    check("and carries no part of the provenance", /provenance|enrolledBy/.test(standingExpr), false);
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/UsersSection.tsx", import.meta.url), "utf8"));
    check("the admin panel validates with the shared rule", /machineLimitProblem\(/.test(src), true);
    // The success toast at the six-word cap (review D10), the count in it and
    // the remedy after the semicolon.
    check(
      "the lowering toast is six words and names the count",
      /`\$\{n\} machine\$\{n === 1 \? "" : "s"\} stopped; raise the limit\.`/.test(src),
      true,
    );
    check("and states the consequence before lowering", /machineLimitChangeNotice\(/.test(src), true);
    /*
     * **Whether to confirm is that function's answer**, not a `<` in the JSX.
     * Written inline it would be a rule with nothing to test and an off-by-one
     * to get wrong in a second place.
     */
    check(
      "and the decision to confirm is that function's answer",
      /consequence\s*===\s*null\s*\?/.test(src) && /consequence\s*=\s*dirty\s*\?\s*machineLimitChangeNotice\(/.test(src),
      true,
    );
    // `DangerButton`'s glyph is reserved for the irreversible, and this undoes
    // itself the moment the number goes back up — so the act is `TwoStep`'s
    // `plain` one, with no `danger` on it.
    check("lowering is not dressed as irreversible", /DangerButton[\s\S]{0,200}Save limit/.test(src), false);
    check("and both acts are plain", [/act=\{\{ label: "Save limit" \}\}/.test(src), /act=\{\{ label: "Use the default" \}\}/.test(src)], [true, true]);
    /*
     * **The panel's one lock is held around every write, and the one-tap paths
     * put the arming flag back** (E7's review). `apply` is what both the
     * confirmed acts and the one-tap Save go through, so `busy` is set there
     * rather than in `write`: a poll can empty the consequence while a confirmed
     * act is out, which draws the form again over a flag that read false. And
     * `confirming` outlives that same poll, so a one-tap `write` that left it at
     * "save" drew the question on the next lowering typed, with no tap.
     */
    check(
      "every write holds the panel's busy, from the promise it hands over",
      /const apply = \(work: Promise<cp\.MachineLimitAnswer>\): Promise<void> => \{\s*setBusy\(true\);\s*return work\s*\.then\(/.test(src) && /onChanged\(\);\s*\}\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(src),
      true,
    );
    check("and a one-tap write puts the arming flag back", /const write = \(work: Promise<cp\.MachineLimitAnswer>\): void => \{\s*void apply\(work\)\s*\.then\(\(\) => setConfirming\(null\)\)/.test(src), true);
    /*
     * **An admin draws nobody's keys** (Q1.631). Until 2026-09-06 three checks
     * here pinned the opposite: that `UsersSection` imported the shared
     * `KeyRow` for its per-user key panel, kept no copy of its own, and drew
     * it with the two-step on because it was somebody else's credential. The
     * panel, the "API keys" item that opened it, and the two `cp.ts` functions
     * behind them (`adminUserKeys`, `adminRevokeKey`) are deleted, so the pins
     * invert: nothing from `./KeyRow` reaches this file, neither function is
     * named in it, and neither is exported by `cp.ts` at all. Both sources are
     * read through `strip`, so the names may survive in the comments recording
     * their deletion — `docscheck` needs them to, since Q1.631 cites both —
     * without counting as a caller or an export.
     */
    check("the users screen imports nothing from KeyRow", /from "\.\/KeyRow"/.test(src), false);
    check("and names neither admin key function", [/adminUserKeys/.test(src), /adminRevokeKey/.test(src)], [false, false]);
    check("and offers no API keys item", /"API keys"/.test(src), false);
    const cpSrc = strip(readFileSync(new URL("../src/cp.ts", import.meta.url), "utf8"));
    check(
      "and cp.ts exports neither",
      [/export (?:async )?function adminUserKeys\b/.test(cpSrc), /export (?:async )?function adminRevokeKey\b/.test(cpSrc)],
      [false, false],
    );
    check("nor declares a keys count on the fleet row", /^\s*keys\?: number;/m.test(cpSrc), false);
    /*
     * **A failed listing is the first fact about this screen**, drawn above the
     * form in the app's one failure shape with Try again wired to the read
     * (review D12).
     */
    check("a failed user listing says so with Try again wired to refresh", /\{error !== null && \(\s*<Empty failed action=\{<Button size="sm" onClick=\{refresh\}>Try again<\/Button>\}>\s*\{error\}\s*<\/Empty>\s*\)\}/.test(src), true);
    /*
     * **One panel under a row at a time, and the row's one panel is the
     * machine limit.** The keys list and the limit panel were two booleans, so
     * both could open under one row and the second sat under a list that had
     * just changed height. A union made "both" unspellable, and a single state
     * over it is what keeps that true. The keys member is gone with the admin's
     * view of anybody's keys (Q1.631), and the union is pinned as a union of
     * one rather than let fold into a boolean: the next panel arrives as a
     * member here, never as a flag beside `panel`.
     */
    check("the row's panels are one union, of one", /type RowPanel = "limit" \| null;/.test(src), true);
    check("held in one state per row", (src.match(/useState<RowPanel>\(null\)/g) ?? []).length, 1);
    check("and the one panel is gated on it", [/\{panel === "limit" && \(/.test(src), /panel === "keys"/.test(src)], [true, false]);
    /*
     * **The admin checkbox precedes Create in DOM order.** It came after, so tab
     * order and reading order both reached the button before the one choice
     * that changes what the button does. Source order is DOM order here.
     */
    const adminBox = src.indexOf('type="checkbox"');
    const createButton = src.indexOf('type="submit"');
    check("the admin checkbox is drawn", adminBox >= 0, true);
    check("and so is Create", createButton >= 0, true);
    check("and the checkbox comes first", adminBox >= 0 && createButton >= 0 && adminBox < createButton, true);
    /*
     * The CLI limitation that opened the screen is a fact for `web-shell.md`,
     * not the first line an admin reads (decision 11A); the unreachable empty
     * state is replaced by the reachable one — the admin is always a row.
     */
    check("the grant sentence has left the screen", /cpctl admin grant/.test(src), false);
    check("and the empty arm is one somebody can reach", /Only you so far\./.test(src), true);
    check("and \"Nobody yet\" is not drawn over a list that always has you in it", /Nobody yet/.test(src), false);
    // The panel's direction is measured on the tap, never taken from the index.
    /*
     * ⚠ **The measurement moved out of this file and the property did not.** It
     * read `getBoundingClientRect()` here against `window.innerHeight` — which was
     * the wrong box: this pane is `overflow-y-auto`, so the viewport answered
     * "room below" about a scroller that ends higher up, and the panel grew that
     * scroller instead of fitting. `menuPlacement` in `bits.tsx` is the one
     * spelling now, and it walks to the nearest scrolling ancestor.
     *
     * What is still asserted is what this line always meant: the direction comes
     * from geometry read at the tap, never from the row's `index` — which is how
     * it was wrong before either version, opening the last rows off the screen.
     */
    check(
      "the kebab's direction is measured, not indexed",
      /menuPlacement\(/.test(src) && !/openUp/.test(src) && !/index/.test(src.slice(src.indexOf("setPlacement") - 200, src.indexOf("setPlacement") + 200)),
      true,
    );
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/ServerSection.tsx", import.meta.url), "utf8"));
    check("the settings key is named once, not written out", /"machines\.per_user"/.test(src), false);
    report(
      "and reached through the shared constant",
      src.split("MACHINE_LIMIT_KEY").length - 1 >= 4,
      `${src.split("MACHINE_LIMIT_KEY").length - 1} uses`,
    );
    /*
     * An admin is subject to the limit they just changed, so saving one has to
     * re-read their own quota — otherwise setting the default to 0 leaves their
     * own `+` drawn for the life of the tab, onto a `409`.
     */
    check("saving a server setting re-reads the admin's own quota", /refreshMe\(\)/.test(src), true);
    // The fleet-wide consequence is drawn only once somebody is confirming
    // (decision 10A): at rest this is a field and a disabled Save. The sentence
    // is the primitive's `question`, and the arming is gated on it being there.
    check("the fleet consequence is drawn only in the confirm arm", /armed=\{confirming && consequence !== null\}/.test(src) && /question=\{consequence\}/.test(src), true);
    /*
     * **One lock around every write** (E7's review). The confirmed lowering,
     * the one-tap Save and the field's Reset all go through `write`, which
     * holds `busy` for the request's length, and the primitive takes it back as
     * `disabled` — so the Reset is greyed while a lowering is out and the act
     * is refused while a Reset is. Split into a bare promise for the primitive
     * and a flagged wrapper for the one-tap paths, the Reset was live for the
     * length of a confirmed lowering and a second write on the same key could
     * go out. And the one-tap paths put the arming flag back: a Reset while the
     * question stood left `confirming` true, and the next lowering typed drew
     * the pair with no tap on Save.
     */
    check(
      "the limit's every write holds the section's busy, from the promise it hands over",
      /const write = \(patch: \{ set\?: Record<string, string>; clear\?: string\[\] \}\): Promise<void> => \{\s*setBusy\(true\);\s*return cp\s*\.adminSaveSettings\(patch\)\s*\.then\([\s\S]*?\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(src),
      true,
    );
    check("and the primitive's act is refused while one is out", /onAct=\{\(\) => write\(savePatch\(\)\)\}\s*disabled=\{busy\}/.test(src), true);
    check(
      "and a one-tap write on the fleet limit puts the arming flag back",
      /const writeNow = \(patch: \{ set\?: Record<string, string>; clear\?: string\[\] \}\): void => \{\s*void write\(patch\)\s*\.then\(\(\) => setConfirming\(false\)\)/.test(src),
      true,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Importing a codebase
 *
 * Two of these are about a rule that has no runtime symptom until it is somebody
 * else's machine that breaks. The daemon's route is new, and the client shipping
 * inside the control plane's image means *new client against old daemon* is the
 * ordinary state of this fleet rather than an edge — so the shape of that answer,
 * a 404 with no error envelope, has to keep its own sentence. And `DAEMON_VERSION`
 * may not be read to predict it: rule 1 of `compatibility.md` is that a version is
 * negotiated or it is a label, and this one is a label.
 *
 * The rest are the drag-and-drop invariant nobody discovers by reading — `drop`
 * simply never fires without a `preventDefault` on `dragover` — and the promise
 * the skill text makes to the extractor. Those two drift apart silently: the skill
 * telling somebody to include `.git` would produce an archive refused whole, and
 * the only symptom is a 400 at the end of a five-minute export.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * A sign-in that is not offered
 *
 * The daemon decides — `loginBlockedReason` knows the platform and the flow's
 * shape — and the client's job is to draw the remedy rather than an empty space.
 * Before this, `canSignIn === false` rendered `null`: no button, no sentence, and
 * a credential slot with no account of why it was the only thing there.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Saving a credential while a chat is open
 *
 * A credential reaches an agent only at spawn, so a token saved mid-conversation
 * used to change nothing for the chat in front of you — the badge went green and
 * the messages went on failing to authenticate. The daemon relaunches those
 * sessions now and reports how many; this is the half that says so.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * A re-probe is not the host going away, and asking is not failing
 *
 * `resumeMachine` forgets the route on every wake — a route learned on one
 * network says nothing on another — so a healthy machine was re-probed every time
 * the tab came back. `probeRoute` published `probing` before any I/O and `online`
 * up to 1.5s later, and everything keyed on `reach` changed twice for a question
 * whose answer never changed: every machine row's dot went hollow and back, and
 * the systems panel *unmounted and remounted*, restarting `useAgentAuth` from
 * nothing — a spinner, a second `GET /agent-auth` that shells out to every CLI,
 * and any half-typed credential thrown away. Once per tab switch.
 *
 * `.claude/rules/web-shell.md` already states this rule for the rail: reachability
 * flickers, so a row may not change because of it. These screens are the two that
 * legitimately *show* reachability, and showing it is still not a reason to take
 * the content away while asking.
 *
 * ⚠ **The other half arrived later and is the more embarrassing one: the answer
 * was a boolean, and `false` was being read as *offline*.** Four screens drew
 * `` `${machine.name} is not reachable right now — ${reachText(…)}` `` on the
 * false branch — and `unknown`, a machine **nobody has asked yet**, is false too.
 * `bootstrap` promotes the machine list to `ready` before any `/health` has
 * landed and `resumeMachine` forgets the route on every wake, so `unknown` is the
 * value for the first two or three seconds of every one of those screens, and
 * longer over a relay from a phone. For that whole window they asserted a failure
 * that had not happened — and `reachText`'s `unknown` arm was the bare string
 * `"…"`, so what was actually drawn was **"laptop is not reachable right now —
 * …."**: an ellipsis substituted into a sentence, under a claim nothing had
 * measured. An ellipsis is a *pause*; on its own it is not a phrase.
 *
 * So there is a partition rather than a boolean, and it is asserted by **calling**
 * both functions over all four `Reach` values — the shape `daemonReadable`'s own
 * docblock names for itself, *"`webcheck` walks all four values instead of
 * asserting JSX"*, now that there is something to walk. What the source scan is
 * left with is the only part a call cannot reach: that the screens branch on the
 * partition, and that the arm which has measured nothing claims nothing.
 * ------------------------------------------------------------------ */

process.stdout.write("\na re-probe is not the host going away, and asking is not failing\n");
{
  const { daemonRead, daemonReadable } = await import("../src/machine.js");
  const { reachText, OFFLINE_TEXT } = await import("../src/ui/bits.js");
  const mach = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));

  // All four, because the interesting one is `probing` and a predicate over a
  // union is only asserted by walking it.
  check("a machine that answered is readable", daemonReadable("online"), true);
  check("and one being re-checked still is", daemonReadable("probing"), true);
  check("one that did not answer is not", daemonReadable("offline"), false);
  check("nor is one never asked", daemonReadable("unknown"), false);

  /*
   * ⚠ **The same four through the partition, and the two `false`s coming apart is
   * the whole change.** `unknown` and `offline` are one answer to `daemonReadable`
   * and two different things to say to a person: the first is this client not
   * having asked, which is a fact about this tab, and the second is a host that
   * did not answer, which is a fact about the machine. Only the second has earned
   * the words "not reachable", and only the second can be retried.
   */
  check(
    "the partition tells the two falses apart",
    [daemonRead("online"), daemonRead("probing"), daemonRead("offline"), daemonRead("unknown")],
    ["readable", "readable", "unreachable", "asking"],
  );
  /*
   * ⚠ **And the two can never disagree about the same machine**, which is the
   * reason `daemonReadable` was reimplemented in terms of `daemonRead` rather than
   * left as a second statement of the same three arms. Asserted as the equality
   * over the whole union rather than as the identity of the source line, because
   * the property is what matters — but the source line is pinned too, since an
   * "equivalent" reimplementation is exactly how two copies start drifting.
   */
  check(
    "and the boolean is exactly its first arm, at every value",
    (["unknown", "probing", "online", "offline"] as const).filter(
      (reach) => daemonReadable(reach) !== (daemonRead(reach) === "readable"),
    ),
    [],
  );
  check("derived rather than stated a second time", /return daemonRead\(reach\) === "readable";/.test(mach), true);

  /*
   * The root fix, and the one that covers every other screen: a probe of a
   * machine already believed reachable does not publish `probing` at all.
   * `unknown` is still the value for never having asked.
   */
  check("a re-probe keeps a known-online state", /if \(this\.reach !== "online"\) this\.reach = "probing";/.test(mach), true);
  check("and does not overwrite it unconditionally", /^\s*this\.reach = "probing";$/m.test(mach), false);

  /*
   * ⚠ **Every phrase this function can return has to survive being substituted
   * into somebody else's sentence**, because that is the only way it is ever used:
   * `NotReachable` composes `` `${name} is not reachable right now — ${reachText(…)}`
   * `` once for four screens, and its default ending is a full stop. The `unknown` arm was `"…"`,
   * which is the failure this asserts against — swept over all four reaches times
   * all seven `OfflineReason` values rather than over the one arm that broke, since
   * a table entry emptied later fails exactly the same way and by hand.
   */
  /*
   * ⚠ **Derived from the table, never re-typed beside it.**
   *
   * This was a hand-written list of seven, asserted against the literal `28` — and
   * `28` is four reaches times that same hand-written seven, so both halves moved
   * together and neither could notice a reason the table had grown. `no_machine_key`
   * was added to `OFFLINE_TEXT` and this sweep went on covering the other seven,
   * green, which is the shape a count floor cannot see: a member left out does not
   * lower the number, it fails to raise it.
   *
   * `OFFLINE_TEXT` is typed `Record<NonNullable<OfflineReason>, string>`, so the
   * compiler already forces the table total over the union; taking the keys from it
   * makes this sweep total too, by the same fact rather than by a second promise.
   */
  const REASONS = [null, ...(Object.keys(OFFLINE_TEXT) as (keyof typeof OFFLINE_TEXT)[])];
  const phrases = (["unknown", "probing", "online", "offline"] as const).flatMap((reach) =>
    REASONS.map((reason) => reachText(reach, reason)),
  );
  check("the sweep found every reach and every reason", phrases.length, 4 * (Object.keys(OFFLINE_TEXT).length + 1));
  report(
    "and the table it swept is the shipped one",
    Object.keys(OFFLINE_TEXT).length > 0,
    `${String(Object.keys(OFFLINE_TEXT).length)} reasons`,
  );
  check("and none of them is punctuation standing in for a phrase", phrases.filter((one) => !/[a-z]/.test(one)), []);
  check(
    "the four reaches read as the four things they are",
    [reachText("online", null), reachText("probing", null), reachText("unknown", null), reachText("offline", "over_limit")],
    ["online", "probing…", "not checked yet", "over the machine limit"],
  );
  /*
   * `probing…` keeps its ellipsis and that is not an exception to the rule above:
   * there is a word in front of it, and it is the truthful trailing-off of a
   * measurement in flight. The rule is about a phrase that is *only* punctuation.
   */
  check("and the one that keeps an ellipsis has a word in front of it", /^probing…$/.test(reachText("probing", null)), true);

  /*
   * ⚠ **The four screens, held to branching on the partition rather than on the
   * boolean.** This is the half no call can make: `daemonRead` answering three
   * values is worth nothing if a screen still writes `!daemonReadable(…)` and
   * draws one sentence for both falses. Swept over all four rather than over the
   * one the old assertion named — `MachineSystemsSection` was pinned and
   * `MachineAgentsSection`, `MachineSection` and `AgentBuilder` composed the same
   * broken sentence with nothing watching them.
   *
   * ⚠ **The sentence is composed once now, by `NotReachable` in `bits.tsx`, and
   * none of the four may write it out again** (review D7). So the failing arm is
   * found by the component's tag rather than by the words, and the words are
   * asserted absent from every screen and present in the one place they live —
   * the second half is what keeps a fifth transcription from passing on the
   * strength of the four mounts.
   *
   * ⚠ **`MachinePluginsSection` is deliberately absent and its absence is the
   * fix, not a gap.** It has exactly one caller, `MachineSection`, which now
   * branches above it and collapses all three lists into one sentence — so a
   * branch of its own would have been provably dead code drawing a second copy of
   * the very sentence being de-duplicated. Asserted below as the absence of both
   * halves, so that a second caller appearing without them fails here rather than
   * silently reintroducing the duplicate.
   */
  const REACH_SCREENS = [
    "ui/settings/MachineSystemsSection.tsx",
    "ui/settings/MachineAgentsSection.tsx",
    "ui/settings/MachineSection.tsx",
    "ui/AgentBuilder.tsx",
  ] as const;
  const asksTheBoolean: string[] = [];
  const claimsWithoutMeasuring: string[] = [];
  const failureNotMarked: string[] = [];
  const treatsProbingAsOutage: string[] = [];
  const composesByHand: string[] = [];
  for (const file of REACH_SCREENS) {
    const src = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!/daemonRead\(machine\.reach\)/.test(src) || /!daemonReadable\(/.test(src)) asksTheBoolean.push(name);
    // A re-probe is `readable`, so a screen may not key on `online` by hand: that
    // is the unmount-and-remount this whole section is named after, arriving by a
    // different spelling.
    if (/machine\.reach !== "online"/.test(src)) treatsProbingAsOutage.push(name);
    /*
     * The two arms, read as the span between the `<Empty` that opens them and the
     * sentence inside them — which is where `failed` would be. Positional rather
     * than by pattern because the tag is one line on three of these screens and
     * four on the fourth, where an `action` sits between the prop and the words.
     */
    const waiting = src.indexOf("Checking whether");
    const failing = src.indexOf("<NotReachable");
    const waitTag = src.slice(src.lastIndexOf("<Empty", waiting), waiting);
    const failTag = src.slice(src.lastIndexOf("<Empty", failing), failing);
    if (waiting < 0 || /\bfailed\b/.test(waitTag)) claimsWithoutMeasuring.push(name);
    if (failing < 0 || !/\bfailed\b/.test(failTag)) failureNotMarked.push(name);
    // The composed shape, with its dash: `MachineAgentsSection`'s status line
    // says "That machine is not reachable right now." about a write that did not
    // land, which is a different sentence about a different event and stays.
    if (/is not reachable right now —/.test(src)) composesByHand.push(name);
  }
  check("every screen that draws reachability asks the partition", asksTheBoolean, []);
  check("and none of them reads a measurement in progress as an outage", treatsProbingAsOutage, []);
  /*
   * ⚠ **The arm that has measured nothing claims nothing** — no `failed`, so no
   * triangle and no `role="status"`. Announcing "not reachable" from a live region
   * two or three seconds before the list arrives is the original defect in the one
   * channel a reader cannot skim back over.
   */
  check("the wait is drawn as a wait", claimsWithoutMeasuring, []);
  check("and the failure is drawn as one", failureNotMarked, []);
  check("and none of them composes the sentence by hand", composesByHand, []);
  {
    const bits = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    const start = bits.indexOf("export function NotReachable(");
    const body = start < 0 ? "" : bits.slice(start, bits.indexOf("\nexport ", start + 1));
    check(
      "the one place the sentence lives composes it through reachText",
      /\{machine\.name\} is not reachable right now — \{reachText\(machine\.reach, machine\.offlineReason\)\}/.test(body),
      true,
    );
    // The ending is the caller's, and it is a full stop unless the caller says
    // otherwise — `AgentBuilder` closes with a clause about the draft.
    check("and the full stop is the default ending", /tail = "\."/.test(body), true);
  }
  {
    const plugins = stripComments(
      readFileSync(new URL("../src/ui/settings/MachinePluginsSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "the section whose caller says it for it does not say it twice",
      [/daemonRead\(/.test(plugins), /is not reachable right now/.test(plugins), /NotReachable/.test(plugins)],
      [false, false, false],
    );
  }

  /*
   * ⚠ **And the primitive all four of those arms are drawn with, whose subject is
   * the same distinction one level down.** `Empty` was a single `<p>` serving at
   * least eight materially different states — a list that is genuinely empty, a
   * search that matched nothing, a machine that is not yours any more, a read that
   * *failed*, a catalogue host that could not be reached — every one of them
   * centred grey text with nothing to press. So a failure a tap would fix was
   * drawn identically to an emptiness nobody can act on, and from a dead machine's
   * systems screen the one way out led to a screen showing the same sentence.
   *
   * **Exactly one of the two is announced, and that is the property.** A failure
   * is something that *happened*, with nothing else on screen to say so, which is
   * the definition of what a live region is for. An absence is a **state** the
   * reader has already been told about by the thing they just did — narrowing a
   * filter, opening a fresh machine — so `role="status"` on it is noise in the one
   * channel that cannot be skimmed. Nothing typed can hold that: both variants are
   * the same return type and `role` is a string on a `<div>`, so this is read off
   * the source the way every other placement in this file is.
   */
  {
    const bits = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    const emptyAt = bits.indexOf("export function Empty(");
    const empty = emptyAt < 0 ? "" : bits.slice(emptyAt, bits.indexOf("\n}\n", emptyAt));
    /*
     * A slice that came back empty passes every negative assertion below while
     * asserting nothing at all, which is this driver's one failure mode.
     *
     * Guarded on the *index* rather than on the slice's length, which is the form
     * the `/danger/` narrowing further down already argues for: a missing needle
     * makes `indexOf` answer −1, and `slice(-1, …)` is a legal call that returns
     * the tail rather than throwing — so a length test is reading the shape of an
     * accident. This one cannot be renamed out from under the check quietly.
     */
    check("the primitive was found", emptyAt >= 0, true);
    check("only a failure is announced", /role=\{failed \? "status" : undefined\}/.test(empty), true);
    check("and there is no second way to announce one", (empty.match(/role=/g) ?? []).length, 1);
    /*
     * ⚠ **The plain case returns byte-identically to what it always did**, by an
     * early return rather than by a container that happens to collapse to the same
     * markup. Roughly forty call sites pass text and nothing else, in list bodies,
     * sheet panes and the transcript, and "probably the same box" is not good
     * enough for a change nobody asked those screens for.
     */
    check(
      "an absence with nothing to do about it is the same paragraph it always was",
      /if \(!failed && action === undefined\) \{\s*return <p className="px-4 py-6 text-center text-sm text-muted">\{children\}<\/p>;/.test(empty),
      true,
    );
    /*
     * The failure changes the *drawing* as well as the wording: the leading
     * `AlertTriangle` this app already uses for a failure in `Toast` and in
     * `EventList`'s transcript notice, with the sentence at `text-fg`. A shape
     * survives greyscale, reduced motion and a phone in sunlight, which is the
     * argument `TONE_DOT` makes at the other end of the same scale.
     */
    check("and it takes this app's failure glyph rather than a colour", /\{failed && \(\s*<Icon as=\{AlertTriangle\}/.test(empty), true);
    /*
     * ⚠ **The remedy is available to an absence too, and is gated on itself
     * alone.** "No machines yet" has an obvious next move, and having one does not
     * make it a failure — so `action` must not be drawn inside the `failed` branch,
     * which is the one-character version of this that would have typechecked.
     */
    check(
      "a way out is offered on its own terms rather than only on a failure",
      /\{action !== undefined && <div className="mt-3 flex justify-center">\{action\}<\/div>\}/.test(empty),
      true,
    );
  }

  /*
   * ⚠ **The fifth and sixth sites of this same question, which `REACH_SCREENS`
   * cannot see because they are not JSX** — and which is precisely where the
   * partition had not been applied. `install.ts`'s two predicates both read
   * `if (!daemonReadable(machine.reach)) return "unreachable"`, so a machine nobody
   * had asked yet was reported as an outage: `bootstrap` promotes to
   * `phase: "ready"` on the *machine list*, before a single probe, and
   * `resumeMachine` calls `forgetRoute()` on every wake — so on a cold load every
   * row on the install screen said "not reachable right now" about a fleet that was
   * about to answer, and `settingsNotice` names the first blocker in fleet order,
   * so one unasked machine spoke for the whole selection.
   *
   * Asserted **by call** rather than by source, which is what this pair of pure
   * functions buys over the four components: the question is the same question, so
   * it is swept over the same four `Reach` values here rather than grepped for a
   * spelling.
   */
  {
    const { settingsBlockFor, skipReasonFor } = await import("../src/install.js");
    const at = (reach: string): never =>
      ({
        id: "m_1",
        name: "laptop",
        scopes: ["session:read", "session:write", "machine:admin"],
        owned: true,
        overLimit: false,
        ownerDisabled: false,
        reach,
        offlineReason: null,
      }) as never;
    const pane = { version: "1.0.0", contributes: { settings: true } };
    check(
      "installing asks the partition rather than the boolean, at every reach",
      (["online", "probing", "offline", "unknown"] as const).map((reach) => skipReasonFor(at(reach))),
      [null, null, "unreachable", "asking"],
    );
    check(
      "and so does configuring",
      (["online", "probing", "offline", "unknown"] as const).map((reach) => settingsBlockFor(at(reach), pane)),
      [null, null, "unreachable", "asking"],
    );
    /*
     * ⚠ **The two `false`s of `daemonReadable` coming apart is the whole change**,
     * so the negative is asserted too: nothing here may collapse back to the boolean,
     * which answers `false` for both and is the one-line edit that reverts this.
     */
    check(
      "so a machine nobody has asked is never reported as one that did not answer",
      [skipReasonFor(at("unknown")) === skipReasonFor(at("offline")), daemonReadable("unknown") === daemonReadable("offline")],
      [false, true],
    );
  }

  /*
   * ⚠ **`REACH_SCREENS` is the third copy of a list that also lives in two
   * docblocks** — `reachText`'s in `bits.tsx` and `daemonRead`'s in `machine.ts` —
   * and both of those were corrected in the round that produced the repair above,
   * having drifted from it. A list restated from memory in prose is exactly the
   * thing that drifts, and the member most easily got wrong is the one that is
   * deliberately **absent**: `MachinePluginsSection` draws no such sentence, and its
   * absence is a fix rather than a gap. Both docblocks name `REACH_SCREENS`
   * explicitly now, so a fifth screen composing that sentence has to touch all
   * three. This is the cheapest thing that can hold a prose cross-reference at all:
   * that each of them still points a reader at the list rather than restating it.
   */
  {
    const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    const machineRaw = readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8");
    check(
      "both docblocks that restate this list send the reader to it",
      [bitsRaw.includes("REACH_SCREENS"), machineRaw.includes("REACH_SCREENS")],
      [true, true],
    );
  }
}

process.stdout.write("\nsaving a credential while a chat is open\n");
{
  const { credentialToast } = await import("../src/ui/settings/AgentsPanel.js");

  check("one chat is singular", credentialToast(false, 1), "Saved. 1 chat is restarting to pick it up.");
  check("and several are not", credentialToast(false, 3), "Saved. 3 chats are restarting to pick it up.");
  /*
   * ⚠ **The tail is a removal's own, and this line used to pin the save's.** Every
   * tail here was written for a save and then reused: "restarting to pick it up"
   * after a removal names something to pick up when the key those chats were
   * holding is precisely what is gone, and this assertion is what kept that
   * shipping. Only the head ever varied, so only the head was ever right.
   */
  check("removing says removed", credentialToast(true, 2), "Removed. 2 chats are restarting without it.");
  check("nothing to restart keeps the old sentence", credentialToast(false, 0), "Saved. Checking whether it works…");
  /*
   * And the same correction on the quiet arm: "Checking whether it works…" is
   * about a key that now exists, so a removal with nothing to relaunch ends at the
   * full stop. The chip beside the box going out is the confirmation, and a tail
   * would have to invent a claim about a machine that was asked to stop using
   * something.
   */
  check("and a removal with nothing to relaunch ends there", credentialToast(true, 0), "Removed.");
  /*
   * **`undefined` is not zero.** A daemon predating this omits the field, and
   * "0 chats" there would be a confident claim about behaviour it does not have —
   * the same rule `wire.ts` states for every narrowing in it.
   */
  check("and a daemon that does not say is not read as zero", credentialToast(false, undefined), "Saved. Checking whether it works…");
}

process.stdout.write("\na sign-in that is not offered\n");
{
  const panel = stripComments(readFileSync(new URL("../src/ui/settings/AgentsPanel.tsx", import.meta.url), "utf8"));
  const { stanceLine, osName } = await import("../src/ui/agentCard.js");

  /*
   * **One sentence, and it names the system.** "This machine can't run…" reads as
   * something misconfigured on your box; the truth is that the OS cannot hand a
   * background service the terminal this login needs. The refusal is returned for
   * every BSD, so the name comes from the daemon — a hardcoded "macOS" would tell
   * a FreeBSD operator something false in the one sentence meant to absolve them.
   */
  check("the sentence names the system", stanceLine({ id: "claude" }, "signed_out", false, "darwin"), "macOS can't run Claude Code's own sign-in, so a saved key is the only way in.");
  check("and a different BSD gets its own name", osName("freebsd"), "FreeBSD");
  check("while a daemon that does not say names nothing", osName(undefined), "This machine");
  check("a wizard that can run says nothing at all", stanceLine({ id: "claude" }, "signed_out", true, "darwin"), null);
  // The fifth argument arrived with the install button: `installable` decides
  // which of two true sentences the not-installed arm draws, and absent it is
  // the old one byte for byte. Pinned together, so a call that dropped either
  // fails here rather than silently telling somebody to press a button that is
  // not there.
  /*
   * ⚠ **The fifth argument is asserted as a PROPERTY, not as a spelling.** This
   * pinned the literal `agent.installable === true` inline at the call, and went
   * red the day that expression was lifted into a named `canInstall` that is
   * *stronger* — `installable === true && !noInstallRoute`, so the sentence no
   * longer promises a button on a daemon whose install route answers `supported:
   * false`. A pin on the spelling reports an improvement as a regression, and the
   * improvement is the thing this check exists to protect. So: the call passes
   * the decision through, and the decision is the conjunction.
   */
  const installDecision = /const canInstall = agent\.installable === true && !noInstallRoute;/.test(panel);
  check(
    "and the panel passes the platform through, and whether it can install",
    [/stanceLine\(agent, stance, canSignIn, os, canInstall\)/.test(panel), installDecision],
    [true, true],
  );
  check(
    "an older daemon that sends no such field keeps the sentence it always had",
    [
      stanceLine({ id: "claude" }, "not_installed", false, "darwin"),
      stanceLine({ id: "claude" }, "not_installed", false, "darwin", true),
    ],
    [
      "Claude Code isn't installed. Install it on the machine itself.",
      "Claude Code isn't installed on this machine.",
    ],
  );

  /*
   * **The command sits on the field it fills.** It was a paragraph above the
   * divider, which restated the sentence above it and then said "paste the token
   * below" with a heading and two inputs in between.
   */
  check("the command is rendered inside the credential slot", /howTo !== null && editable && <CommandLine/.test(panel), true);
  check("and only on the slot that command actually fills", /slot\.envName === "CLAUDE_CODE_OAUTH_TOKEN"/.test(panel), true);
  check("and only where the wizard cannot run", /login\.blocked === "interactive_pty"/.test(panel), true);
  check("naming the command the CLI really has", /"claude setup-token"/.test(panel), true);
  /*
   * A row of two, not a control laid over a box: the overlay took its height from
   * the field's own text and hung off the edge the moment the two disagreed.
   */
  /*
   * ⚠ **These two moved file when the component did.** `SetupTokenCommand` became
   * `ui/CommandLine.tsx` the day the empty-fleet screens grew a second caller for
   * it, and reading `panel` for them would have gone quietly green — the regexes
   * would simply stop matching anything, which is the failure mode this driver
   * exists to refuse. What is asserted is the component's own layout, so it is
   * read from wherever the component now is.
   */
  const commandLine = stripComments(readFileSync(new URL("../src/ui/CommandLine.tsx", import.meta.url), "utf8"));
  check("the copy control is a sibling of the field, not an overlay on it", /items-stretch/.test(commandLine), true);
  check("so it cannot be positioned out of the box it belongs to", /absolute top-/.test(commandLine), false);
  check("the button is still gated on supported, not on the reason", /login\.supported && agent\.available/.test(panel), true);

  /*
   * **The key row is shorter only where there is no tap floor to miss.**
   * `FIELD`'s `py-3` exists because `index.css` forces 16px on an input under a
   * coarse pointer — iOS zooms the page otherwise — and at `py-2` the box measures
   * ~39px against 44px. Shrinking it unconditionally would have traded a tidier
   * desktop row for a target under the floor on the device this product is shaped
   * around, and nothing would have said so.
   */
  /*
   * **Two boxes that line up, held to one number rather than to arithmetic.**
   *
   * The first attempt wrote `` `${FIELD} py-2` `` and did nothing at all: Tailwind
   * emits every utility at equal specificity, `.py-3` is emitted after `.py-2`, so
   * the constant won and the field stayed 10px deeper than the command box above
   * it — with no error, and with the code and the review both saying otherwise.
   * That is the same trap `Button` documents for a size passed via `className`,
   * and it is why the short field is a constant of its own.
   */
  {
    const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    /*
     * **One height for every single-line control in the app**, and it is stated
     * rather than arrived at: `py-3` only ever reached 44px by multiplying with a
     * line-height that lives in the type scale, so the rendered height was a
     * coincidence between two files and two controls could differ by 10px with
     * nothing anywhere naming a number.
     */
    check("the field constant states its height", /export const FIELD =\s*\n?\s*"min-h-9/.test(bits), true);
    check("and carries no padding for a caller to lose to", /export const FIELD =\s*\n?\s*"[^"]*\bpy-\d/.test(bits), false);
    check("with the touch floor written down beside it", /export const FIELD =[\s\S]{0,240}\[@media\(pointer:coarse\)\]:min-h-11/.test(bits), true);
    check("and no second field constant to drift from it", /FIELD_SM/.test(bits), false);

    check("the key field uses the standard one", /\$\{FIELD\} min-w-0 flex-1 font-mono/.test(panel), true);
    /*
     * The general form of the defect, not this one instance of it: composing
     * `FIELD` with a vertical padding is always a no-op and always silent.
     */
    /*
   * The general form of the defect rather than this one instance: composing
   * `FIELD` with a vertical padding is always a no-op and always silent, so it is
   * checked across every screen that draws a field, not just this one.
   */
  {
    const withFields = readdirSync(new URL("../src/ui/settings/", import.meta.url))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(new URL(`../src/ui/settings/${f}`, import.meta.url), "utf8"));
    for (const extra of ["SignIn.tsx", "ForcedPasswordChange.tsx", "gate/Gate.tsx", "gate/GateCard.tsx"]) {
      withFields.push(readFileSync(new URL(`../src/ui/${extra}`, import.meta.url), "utf8"));
    }
    const offenders = withFields.filter((src) => /\$\{FIELD\}[^`]*\bpy-\d/.test(src)).length;
    report("no screen composes FIELD with a padding that cannot win", offenders === 0, `${withFields.length} files scanned`);
  }
    /*
     * **The field and the command box are in two files now, so this is a pair
     * rather than a count.** It used to assert `min-h-11` appeared at least twice
     * in `AgentsPanel.tsx` — the field's and the command box's — which stopped
     * meaning anything the moment the box moved to `ui/CommandLine.tsx`: one
     * occurrence would have read as a drift and two in either file alone would
     * have read as agreement. Asked of each file separately it is the same
     * property and it survives the split.
     */
    check("the command box states the same height", /flex min-h-9 items-stretch/.test(commandLine), true);
    check(
      "and the same floor, so the two cannot drift",
      [/\[@media\(pointer:coarse\)\]:min-h-11/.test(panel), /\[@media\(pointer:coarse\)\]:min-h-11/.test(commandLine)],
      [true, true],
    );
  }
  // Width is the other fields', which is what it was before a wrong axis was tried.
  check("and its width is left alone", /max-w-80/.test(panel), false);

  /*
   * **The row is tightened, and Remove keeps the space it actually needs.** Its
   * `after:-inset-2.5` target reaches 10px past its own face, so at an 8px gap it
   * lands on the control to its left — the defect the old blanket `gap-3` was
   * carrying for all three children. Tightening without putting that 4px back on
   * Remove would have reintroduced it silently, on a destructive button.
   */
  /*
   * **Remove keeps the room its own target needs, and only it.** Its
   * `after:-inset-2.5` reaches 10px past its face, so at an 8px gap it lands on
   * the control to its left — which is why the row carried `gap-3` for all three
   * children. Tightening the field and Save without putting that 4px back on
   * Remove reintroduces it silently, on a destructive button.
   */
  check("the field and Save sit closer", /mt-3 flex gap-2/.test(panel), true);
  check("and Remove carries the room its own target needs", /tone="destructive"[\s\S]{0,220}className="ml-1"/.test(panel), true);
  check("with Save wide enough to hold its label", /min-w-20/.test(panel), true);
}

process.stdout.write("\nimporting a codebase\n");
{
  const src = stripComments(readFileSync(new URL("../src/ui/ImportCode.tsx", import.meta.url), "utf8"));
  const picker = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  const client = stripComments(readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8"));

  const { importFailure } = await import("../src/ui/ImportCode.js");
  const { ApiError } = await import("../src/http.js");
  const envelope = (status: number, code: string, detail: unknown = null): unknown =>
    new ApiError(status, code, "refused", detail, { error: { code, detail } });
  /** What `parseBody` makes of a response carrying no envelope at all. */
  const bare = (status: number): unknown =>
    new ApiError(status, `http_${status}`, "Not Found", null, null);

  check(
    "a daemon with no such route is named as old rather than shown a 404",
    importFailure(bare(404)).includes("too old"),
    true,
  );
  /*
   * **The 404 has to be asked for before the archive moves**, because it does not
   * survive one. Measured through a real relay against a daemon predating this
   * route: the same request that answers a clean 404 with an empty body came back
   * `502 tunnel_failed` after 3.4 MB of a 5 MiB upload — the daemon refuses
   * without draining the body, its end of the stream dies, and the relay reports
   * the only thing it can see. So the sentence above was unreachable in exactly
   * the case it exists for, and the ordering is what makes it reachable.
   */
  /*
   * ⭐ **The four ways out of this sheet, and that they all mean the same thing.**
   *
   * This pop-up has no route of its own, so `Sheet`'s own `close` — `navigate(under,
   * true)` — reached past it to whatever the *New session* overlay was drawn over.
   * The ✕, Escape and the scrim therefore each destroyed the machine, the agent and
   * the folder somebody had walked to, while the file's own docblock said the
   * opposite in as many words. Prose is what stood in for this check for four
   * releases, which is the whole argument for reading the props off disk.
   *
   * `onClose` is asserted on **both** files: the caller handing it over, and the
   * primitive taking it as an override rather than as the rule — so the default
   * cannot be quietly inverted for the four pop-ups the URL does name.
   */
  const sheet = stripComments(readFileSync(new URL("../src/ui/Sheet.tsx", import.meta.url), "utf8"));
  check("the import sheet closes back to the form rather than out of it", /onClose=\{onClose\}/.test(src), true);
  check("and its chevron goes to the same place", /up=\{onClose\}/.test(src), true);
  check("and names where that is", /upLabel="New session"/.test(src), true);
  check("which is a thing only a caller can hand over", /const close = onClose \?\?/.test(sheet), true);
  /*
   * And the cost of that close having become cheap: `POST /fs/import` is one at a
   * time per machine (`409 import_busy`), so an upload nobody is watching holds the
   * lock and the next attempt is refused for a reason nothing on screen explains.
   */
  check("an abandoned upload does not keep the machine's import lock", /useEffect\(\(\) => \(\) => abort\.current\?\.abort\(\), \[\]\)/.test(src), true);

  check("the route is probed before any bytes are sent", /importSupported\(\)/.test(src), true);
  check(
    "and the upload only starts once that has answered",
    src.indexOf("importSupported()") < src.indexOf("importArchive("),
    true,
  );
  check(
    "with the probe carrying no body of its own",
    /await this\.machine\.request\("\/fs\/import", \{ method: "POST" \}\)/.test(client),
    true,
  );
  // A tunnel can still die for its own reasons, so the code keeps a sentence.
  check(
    "and a stream that dies mid-upload still says something actionable",
    importFailure(envelope(502, "tunnel_failed")).includes("Try again"),
    true,
  );
  check(
    "and a 404 that *is* this system's own is not",
    importFailure(envelope(404, "not_found")).includes("too old"),
    false,
  );
  check(
    "nothing reads the daemon's version to decide that",
    /DAEMON_VERSION|daemonVersion/.test(src),
    false,
  );
  check(
    "a name collision says which name",
    importFailure(envelope(409, "import_exists", { name: "my-app" })).includes("my-app"),
    true,
  );
  check(
    "and survives a detail that is not the shape it expected",
    typeof importFailure(envelope(409, "import_exists", "nonsense")),
    "string",
  );
  for (const code of ["archive_unsafe", "unsupported_archive", "import_busy", "import_too_large"]) {
    check(`${code} draws a sentence of its own`, importFailure(envelope(400, code)) !== code, true);
  }

  /*
   * What somebody is asked to paste reads their repository and writes files, so
   * it is shown rather than described. A copy button alone asks them to take that
   * on trust, and it is the failure with no symptom: nobody reports a block of
   * text they were never offered.
   */
  check("the text being copied is rendered, not only put on the clipboard", /\{IMPORT_SKILL\}/.test(src), true);
  check("in a box that scrolls on its own", /overflow-y-auto/.test(src), true);
  check("without dragging the sheet behind it when it ends", /overscroll-contain/.test(src), true);
  check("and the control over it carries an icon rather than a word", /as=\{Copy\}/.test(src), true);
  /*
   * **Both glyphs are mounted and swapped by opacity**, never rendered one at a
   * time. A conditional would snap, and the tick going out is the half that
   * carries the meaning: it says the confirmation expired rather than that the
   * state was lost. Asserted as the pair, because rendering one of them
   * conditionally still passes any test that only looks for `Check`.
   */
  check("the tick is mounted beside it rather than swapped in", /as=\{Check\}/.test(src), true);
  check("and neither is drawn conditionally", !/\{copied \? <Icon|copied \? \(/.test(src), true);
  check("they cross-fade instead", (src.match(/transition-opacity/g) ?? []).length >= 2, true);
  /*
   * The tick reverts. It used to be permanent — set on success and never unset —
   * so a screen left open claimed a clipboard that had long since moved on.
   */
  check("and it takes itself down again", /setCopied\(false\), 1400\)/.test(src), true);
  check("with the name following it, for anybody who cannot see either glyph", /aria-label=\{copied \? "Copied" : "Copy to clipboard"\}/.test(src), true);
  /*
   * Set from the *result* this lit the tick on an origin where the clipboard is
   * absent rather than refused — which is every LAN address this app is read on.
   * See `clipboard.ts`, which exists for that measurement.
   */
  check("and it is only ever lit on a copy that worked", !/setCopied\(ok\)/.test(src), true);

  /*
   * **"Machine" is a word this screen has already spent**, and the instructions
   * may not spend it again on something else. There is a machine picker on the
   * form behind this sheet, a Machines section in settings, and an `m_…` on every
   * row — all of them meaning *an enrolled host in your fleet*, which is where an
   * import is going. The source is the opposite end, so "paste this into a coding
   * agent on that machine" read as the machine you had just selected.
   *
   * The *refusals* are deliberately not checked: those say "machine" correctly,
   * about the daemon that answered. The rule is about the instructions alone.
   */
  {
    const steps = [...src.matchAll(/\stext="([^"]*)"/g)].map((m) => m[1] ?? "");
    const intro = /<p className="text-sm text-muted">([^<]*)<\/p>/.exec(src)?.[1] ?? "";
    const lines = [intro, ...steps].filter((line) => line.length > 0);
    report(
      "the instructions never call the source a machine",
      lines.length >= 4 && lines.every((line) => !/machine/i.test(line)),
      `${lines.length} lines checked`,
    );
    check("naming the project instead, which cannot be one", /that project/.test(steps.join(" ")), true);
  }

  // Without this the browser refuses the drop and nothing fires at all — the one
  // bug in a drop target that looks like the handler was never wired.
  check("dragover preventDefaults, or drop never fires", /onDragOver=\{[\s\S]*?preventDefault\(\)/.test(src), true);
  check("and the drop target is the body rather than the box alone", /onDrop=\{/.test(src), true);

  // The folder is drawn from the daemon's answer, never from the file that was
  // sent: an import that fails must not leave a folder named on the screen.
  check("the picker is moved to the path the daemon answered", /onImported\(answer\.import\.path\)/.test(src), true);
  check("and only after it has answered", /onImported\([^)]*\)[\s\S]{0,200}\.catch/.test(src), true);

  check("the control sits in the picker beside New folder here", /Import code/.test(picker), true);
  check("and does not wear the affirmative action's fill", /Import code[\s\S]{0,200}bg-fg/.test(picker), false);
  {
    // 44px, like the sibling whose row it shares: the two swap places with the
    // create form's buttons, and a shorter row makes the panel jump.
    const control = /<button[^>]*onClick=\{\(\) => setImporting\(true\)\}[\s\S]*?>/.exec(picker)?.[0] ?? "";
    check("and clears 44px like the control beside it", /min-h-11/.test(control), true);
  }

  {
    const { IMPORT_SKILL } = await import("../src/importSkill.js");
    const { safeMemberPath } = await import("../../../src/archive.js");
    /*
     * The skill and the extractor have to agree, and `.git` is the one where
     * disagreeing is expensive: `safeMemberPath` refuses the whole archive rather
     * than trimming the member, so a skill that packed one would produce a file
     * that always fails, at the end of the slowest step.
     */
    check("the extractor refuses .git", safeMemberPath("app/.git/config").ok, false);
    check("and the skill says so rather than leaving it to be discovered", /Exclude \.git/.test(IMPORT_SKILL), true);
    check("the skill asks for one top-level folder", /\*\*one\*\* folder named after/.test(IMPORT_SKILL), true);
    check("and names a size the daemon will actually take", /under 50 MB/.test(IMPORT_SKILL), true);
    /*
     * **It names no agent and no path.** The machine on the other end is the
     * customer's, running whatever they run; a skill directory from one vendor
     * is a first step that fails before any work starts. What step one has to
     * be is a single paste that any agent can act on as it stands.
     */
    check("the skill names no vendor path", !/\.claude\//.test(IMPORT_SKILL), true);
    check("and no agent by name", !/Claude Code|Cursor|Copilot/.test(IMPORT_SKILL), true);
    check("it is runnable as pasted, with the skill file optional", /If your agent keeps skills/.test(IMPORT_SKILL), true);
  }
}
