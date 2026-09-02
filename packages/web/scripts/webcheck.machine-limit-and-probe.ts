import { readFileSync, readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

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
    "a fresh account on a closed instance is told who to ask",
    noticeOf({ machineCount: 0, machineLimit: 0 }).includes("Ask whoever runs this control plane"),
    noticeOf({ machineCount: 0, machineLimit: 0 }),
  );
  report(
    "and one whose machines just went dark is told they went dark",
    noticeOf({ machineCount: 2, machineLimit: 0 }).includes("stopped working"),
    noticeOf({ machineCount: 2, machineLimit: 0 }),
  );
  report(
    "at the limit, the count is in the sentence",
    noticeOf({ machineCount: 2, machineLimit: 2 }).includes("all 2 of your 2"),
    noticeOf({ machineCount: 2, machineLimit: 2 }),
  );
  report(
    "over it, one machine is singular",
    noticeOf({ machineCount: 3, machineLimit: 2 }).includes("newest one has"),
    noticeOf({ machineCount: 3, machineLimit: 2 }),
  );
  report(
    "and two are plural",
    noticeOf({ machineCount: 4, machineLimit: 2 }).includes("newest 2 have"),
    noticeOf({ machineCount: 4, machineLimit: 2 }),
  );

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
  for (const file of ["ui/SessionBrowser.tsx", "ui/NewSession.tsx", "ui/settings/MachinesSection.tsx"]) {
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
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/MachinesSection.tsx", import.meta.url), "utf8"));
    // The form is downstream of the check that it may be offered at all — the
    // `asksMailUsable < promisesReset` idiom one section over, which guards both
    // operands with `>= 0` for the reason that idiom's neighbours record: dropping
    // the predicate makes the left side -1, and -1 is less than every real
    // position, so the ordering passes with the gate it is about deleted.
    const asks = src.indexOf("mayAddMachine(");
    const form = src.indexOf("<AddMachine");
    check("the screen still asks whether a machine may be added", asks >= 0, true);
    check("and still has a form to gate", form >= 0, true);
    report(
      "the add form is downstream of the check that it is offerable",
      asks >= 0 && form >= 0 && asks < form,
      `${asks} < ${form}`,
    );
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
    check("adding a machine re-reads who you are", /machinesChanged\("machine-added"\)/.test(src), true);
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
    const leavesScreen = machineSrc.indexOf("navigate(settingsPath(\"machines\"), true)");
    const dropsMachine = machineSrc.indexOf("machinesChanged(\"machine-revoked\")");
    check("retiring still navigates away from the machine's screen", leavesScreen >= 0, true);
    check("and still tells the store the machine is gone", dropsMachine >= 0, true);
    check(
      "and retiring leaves the screen before the machine leaves the list",
      leavesScreen >= 0 && dropsMachine >= 0 && leavesScreen < dropsMachine,
      true,
    );
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/UsersSection.tsx", import.meta.url), "utf8"));
    check("the admin panel validates with the shared rule", /machineLimitProblem\(/.test(src), true);
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
    // itself the moment the number goes back up.
    check("lowering is not dressed as irreversible", /DangerButton[\s\S]{0,200}Save limit/.test(src), false);
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
  const { reachText } = await import("../src/ui/bits.js");
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
   * four screens compose `` `${name} is not reachable right now — ${reachText(…)}`
   * `` and one of them ends the line with a full stop. The `unknown` arm was `"…"`,
   * which is the failure this asserts against — swept over all four reaches times
   * all seven `OfflineReason` values rather than over the one arm that broke, since
   * a table entry emptied later fails exactly the same way and by hand.
   */
  const REASONS = [
    null,
    "no_route",
    "no_token",
    "not_enrolled",
    "cp_unreachable",
    "over_limit",
    "owner_disabled",
  ] as const;
  const phrases = (["unknown", "probing", "online", "offline"] as const).flatMap((reach) =>
    REASONS.map((reason) => reachText(reach, reason)),
  );
  check("the sweep found every reach and every reason", phrases.length, 28);
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
    const failing = src.indexOf("is not reachable right now");
    const waitTag = src.slice(src.lastIndexOf("<Empty", waiting), waiting);
    const failTag = src.slice(src.lastIndexOf("<Empty", failing), failing);
    if (waiting < 0 || /\bfailed\b/.test(waitTag)) claimsWithoutMeasuring.push(name);
    if (failing < 0 || !/\bfailed\b/.test(failTag)) failureNotMarked.push(name);
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
  {
    const plugins = stripComments(
      readFileSync(new URL("../src/ui/settings/MachinePluginsSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "the section whose caller says it for it does not say it twice",
      [/daemonRead\(/.test(plugins), /is not reachable right now/.test(plugins)],
      [false, false],
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
  check("and the panel passes the platform through", /stanceLine\(agent, stance, canSignIn, os\)/.test(panel), true);

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
