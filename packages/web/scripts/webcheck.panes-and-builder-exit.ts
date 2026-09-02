import { check } from "./webcheck.env.js";

process.stdout.write("\nwhat several machines' settings panes add up to\n");
{
  const { paneAgreement, blankForm } = await import("../src/pane.js");
  const { seedForm } = await import("../src/plugins.js");
  const { scopeSummary } = await import("../src/install.js");

  const field = (key: string, kind: string, value: string | null): unknown => ({
    key,
    label: key,
    kind,
    value,
    options: [],
    placeholder: null,
    help: null,
  });
  const form = (action: string, fields: unknown[]): unknown => ({ type: "form", fields, submit: "Save", action });
  const view = (...blocks: unknown[]): unknown => ({ title: null, refreshMs: null, blocks });
  const say = (type: string, text: string, tone: string): unknown => ({ type, text, tone });
  const read = (id: string, v: unknown): never => ({ machineId: id, view: v }) as never;

  const HOST = (v: string | null): unknown => form("save", [field("host", "text", v), field("loud", "toggle", "true")]);

  /*
   * ⚠ **One rule with two spellings, pinned equal.** A blank form is exactly what
   * `seedForm` produces for a plugin that sent no values at all, including the
   * toggle's `"false"` — every field is a string on the wire, so there is one
   * narrowing here and not five.
   */
  const fields = [field("host", "text", "a"), field("loud", "toggle", "true"), field("mode", "select", "x")] as never;
  check(
    "blank is seedForm over a plugin that sent nothing",
    blankForm(fields),
    seedForm((fields as never as { value: unknown }[]).map((one) => ({ ...one, value: null })) as never),
  );
  check("a toggle is off and everything else is empty", blankForm(fields), { host: "", loud: "false", mode: "" });

  /*
   * ⚠ **Compared after `seedForm` normalisation, never as raw `value`.** `null` on
   * one machine and `""` on another are the same on screen and the same on submit,
   * so a fleet that is identical must not be reported as differing — the red
   * warning that follows would be a lie about somebody's configuration.
   */
  check(
    "an absent value and an empty one agree",
    paneAgreement([read("m_1", view(form("save", [field("host", "text", null)]))), read("m_2", view(form("save", [field("host", "text", "")])))]).form.kind,
    "agreed",
  );
  check(
    "two machines that agree seed the form from what they hold",
    paneAgreement([read("m_1", view(HOST("a"))), read("m_2", view(HOST("a")))]).form,
    { kind: "agreed", block: HOST("a"), values: { host: "a", loud: "true" } },
  );
  {
    const answer = paneAgreement([read("m_1", view(HOST("a"))), read("m_2", view(HOST("b")))]);
    check("two that differ open blank", answer.form.kind, "mixed");
    check("with nothing filled in", answer.form.kind === "mixed" ? answer.form.values : null, { host: "", loud: "false" });
    /*
     * ⚠ **And only the keys that actually disagreed are named.** A blanked toggle is
     * not empty, it is *off*, and a checkbox has no third state — so without this the
     * warning says "they were different" while a switch nobody looked at is about to
     * be written off across a fleet.
     */
    check("naming only what disagreed", answer.form.kind === "mixed" ? answer.form.differing : null, ["host"]);
    check("and both machines are still written to", answer.targets, ["m_1", "m_2"]);
  }

  /*
   * ⚠ **A different form is a third answer and refuses to draw one.** Submitting
   * one machine's keys to another writes fields that machine does not have and omits
   * ones it does — the first stores garbage inside a hook nobody is waiting on, the
   * second leaves or clears a value depending entirely on how the author wrote the
   * handler. Both are silent, so the screen says so instead.
   */
  const divergent = [
    ["a different action id", paneAgreement([read("m_1", view(form("save", [field("host", "text", "a")]))), read("m_2", view(form("apply", [field("host", "text", "a")])))])],
    ["a different key set", paneAgreement([read("m_1", view(form("save", [field("host", "text", "a")]))), read("m_2", view(form("save", [field("port", "text", "a")])))])],
    ["a key whose kind differs", paneAgreement([read("m_1", view(form("save", [field("host", "text", "a")]))), read("m_2", view(form("save", [field("host", "select", "a")])))])],
  ] as const;
  check("every shape of disagreement is divergent", divergent.map(([, answer]) => answer.form.kind), ["divergent", "divergent", "divergent"]);
  check("and nothing is written to on that arm", divergent.map(([, answer]) => answer.targets), [[], [], []]);
  check(
    "with every machine in exactly one group, and named as excluded",
    divergent.map(([, answer]) => [
      answer.form.kind === "divergent" ? answer.form.groups.flatMap((one) => one.machines).sort() : null,
      answer.excluded.map((one) => one.machineId).sort(),
    ]),
    [
      [["m_1", "m_2"], ["m_1", "m_2"]],
      [["m_1", "m_2"], ["m_1", "m_2"]],
      [["m_1", "m_2"], ["m_1", "m_2"]],
    ],
  );
  /*
   * And the three things that are deliberately NOT divergent, because each would
   * refuse a whole fleet over something that changes no write.
   */
  check(
    "a reworded label is not",
    paneAgreement([
      read("m_1", view(form("save", [field("host", "text", "a")]))),
      read("m_2", view(form("save", [{ ...(field("host", "text", "a") as object), label: "Hostname" }]))),
    ]).form.kind,
    "agreed",
  );
  check(
    "nor a different field order",
    paneAgreement([
      read("m_1", view(form("save", [field("a", "text", "1"), field("b", "text", "2")]))),
      read("m_2", view(form("save", [field("b", "text", "2"), field("a", "text", "1")]))),
    ]).form.kind,
    "agreed",
  );
  check(
    "nor a select whose options are local facts",
    paneAgreement([
      read("m_1", view(form("save", [{ ...(field("m", "select", "x") as object), options: [{ value: "x", label: "X" }] }]))),
      read("m_2", view(form("save", [{ ...(field("m", "select", "x") as object), options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] }]))),
    ]).form.kind,
    "agreed",
  );
  /*
   * ⚠ **A machine with no form at all is excluded rather than divergent**, which is
   * `offersSettings`' *anywhere, not everywhere* rule holding end to end: a fleet
   * mid-update is the ordinary case, and refusing the screen over a host that has
   * nothing to say would be the wrong half of it.
   */
  {
    const answer = paneAgreement([read("m_1", view(HOST("a"))), read("m_2", view(say("text", "hello", "muted")))]);
    check("a machine offering no form is excluded, not divergent", answer.form.kind, "agreed");
    check("and is named", answer.excluded, [{ machineId: "m_2", reason: "no_form" }]);
    check("and is not written to", answer.targets, ["m_1"]);
  }
  {
    const answer = paneAgreement([read("m_1", view(HOST("a"))), read("m_2", null)]);
    check("an unreadable machine takes no part and is named", answer.excluded, [{ machineId: "m_2", reason: "unreadable" }]);
    check("and is never a target", answer.targets, ["m_1"]);
  }

  /*
   * ⚠ **The partition, and it is the one that would actually bite.** Every machine
   * handed in is a target or is named, exactly once. One that fell out of both is a
   * machine somebody selected and never heard about again — `planTargets`' own
   * thesis, at the other end of the same screen.
   */
  {
    const bodies = [null, view(HOST("a")), view(HOST("b")), view(form("apply", [field("host", "text", "a")])), view(say("notice", "x", "danger"))];
    const stranded: string[] = [];
    for (let a = 0; a < bodies.length; a += 1) {
      for (let b = 0; b < bodies.length; b += 1) {
        for (let c = 0; c < bodies.length; c += 1) {
          const answer = paneAgreement([read("m_1", bodies[a]), read("m_2", bodies[b]), read("m_3", bodies[c])]);
          const seen = [...answer.targets, ...answer.excluded.map((one) => one.machineId)].sort();
          if (JSON.stringify(seen) !== JSON.stringify(["m_1", "m_2", "m_3"])) stranded.push(`${a}${b}${c}`);
        }
      }
    }
    check("every machine handed in is a target or is named, exactly once", stranded, []);
  }

  /*
   * ⚠ **Nothing a machine said is dropped** — `notice` is the whole diagnostic
   * channel for a plugin with no screen — **and an identical block collapses**, so
   * a danger notice on one host is the only attributed line on the screen rather
   * than one wall among five.
   */
  {
    const same = say("text", "the same sentence", "muted");
    const only = say("notice", "this host is signed out", "danger");
    const answer = paneAgreement([read("m_1", view(same)), read("m_2", view(same, only)), read("m_3", view(same))]);
    check("an identical block is drawn once", answer.said.length, 2);
    check("unattributed where every machine sent it", answer.said[0]?.machines, ["m_1", "m_2", "m_3"]);
    check("and named where only one did", answer.said[1], { block: only, machines: ["m_2"] });
    check("with its tone intact", (answer.said[1]?.block as { tone?: string } | undefined)?.tone, "danger");
    check("and an unreadable machine says nothing", paneAgreement([read("m_1", null)]).said, []);
  }

  /* The sentence above the form. */
  check("one machine is named", scopeSummary(["laptop"]), "laptop");
  check("three are named", scopeSummary(["a", "b", "c"]), "a, b, c");
  check("four are counted", scopeSummary(["a", "b", "c", "d"]), "4 machines");
  check("and none is said out loud", scopeSummary([]), "no machines");
  /*
   * ⚠ **It never says "all".** This is a scope somebody chose rather than a fact
   * about the fleet, and "all" is the word most likely to be read as a standing
   * policy — Q7.42's hazard, on the line whose whole job is to say what the choice
   * was.
   */
  check("and it never says all", [1, 2, 3, 4, 9].map((n) => scopeSummary(Array.from({ length: n }, (_, i) => `m${i}`)).includes("all")), [false, false, false, false, false]);
}

/* ------------------------------------------------------------------ *
 * A harness, a system, and which pairs of them exist
 *
 * ⚠ **This is the client's half of a rule the daemon also enforces, and the two
 * are asserted separately on purpose.** `daemoncheck` drives `hostable` in
 * `src/acp/systems.ts`, which is the gate; this drives the copy in
 * `packages/web/src/agents.ts`, which is the courtesy that greys a row out
 * before anybody picks it. Both read the *agent's own answer* about which
 * protocols it accepts, which arrives on the wire, so neither transcribes the
 * protocol matrix.
 *
 * ⚠ **They do not agree arm for arm, and "neither writes a matrix down" was too
 * strong.** The daemon holds one table the client cannot see — `ROUTED_MODEL_ENV`,
 * how each harness is told which model to run on a foreign system — and refuses a
 * pairing missing from it. Nothing on the wire stands for that fact, so this side
 * has no such arm; see the docblock on the client's `hostable`. The two agree
 * today only because every routed system is `anthropic`-shaped and the one
 * harness missing from that table is refused an arm earlier.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe way out of the agent builder\n");
{
  const { agentBuilderPath, agentEditPath, agentFromPath, depthOf, sheetTitle, sheetUpLabel, upFrom, newSessionPath } =
    await import("../src/nav.js");
  const { parsePath } = await import("../src/router.js");

  /*
   * ⚠ **The ◀ goes back to New session *with its folder*, and `under` is the
   * wrong value for it.** `under` carries forward what the first pop-up was drawn
   * over, so it would close the whole stack — and the folder somebody had walked
   * three levels into would be gone. That is the trap `marketUpFrom` needed
   * `origin` in `history.state` for; here the address holds both halves already,
   * so nothing extra is recorded.
   */
  const deep = parsePath("/agent/m_1/%2FUsers%2Fme%2Fsrc");
  check("the builder's route carries the folder", [deep.name, (deep as never as {cwd: string}).cwd], ["agent", "/Users/me/src"]);
  check(
    "and up is the picker it came from, folder and all",
    upFrom(deep, "/"),
    "/new/m_1/%2FUsers%2Fme%2Fsrc",
  );
  check(
    "with no folder it is still the picker rather than the screen underneath",
    upFrom(parsePath("/agent/m_1"), "/"),
    "/new/m_1",
  );
  /*
   * ⚠ **A choosing screen walks back to the builder, never past it to the
   * picker.** Both are one pop-up and the ◀ moves one level at a time — the same
   * rule `settingsUp` keeps — so answering "which model" returns you to the form
   * the answer goes into rather than throwing the half-assembled agent away.
   */
  const choosing = parsePath("/agent/m_1/llm/%2FUsers%2Fme%2Fsrc");
  check(
    "a choosing screen is the builder's own route with a step on it",
    [choosing.name, (choosing as never as { step: string }).step, (choosing as never as { cwd: string }).cwd],
    ["agent", "llm", "/Users/me/src"],
  );
  check("and up from it is the builder, folder and all", upFrom(choosing, "/"), "/agent/m_1/%2FUsers%2Fme%2Fsrc");
  check(
    "the other one behaves identically",
    upFrom(parsePath("/agent/m_1/harness"), "/"),
    "/agent/m_1",
  );
  /*
   * ⚠ **The step sits before the folder and a folder can never be read as one.**
   * A `cwd` is an absolute POSIX path from the daemon's own listing, so it always
   * begins with `/` and `encodeURIComponent` always writes that as `%2F`. That is
   * what lets both tail segments be optional with no placeholder standing in for
   * the absent one — and it is the property that would break silently if a
   * relative path ever reached this encoder.
   */
  check(
    "a folder alone is still a folder",
    (parsePath("/agent/m_1/%2Fhome%2Fllm") as never as { step: string | null; cwd: string }),
    { name: "agent", machineId: "m_1", cwd: "/home/llm", step: null, preset: null , harness: null } as never,
  );
  /*
   * ⚠ **And the marker cannot be a folder either, which is why it is a literal
   * word rather than a recognition of the daemon's `ca_` + 8 hex id shape.** The
   * client must not hold a copy of the daemon's id generator; what it may hold is
   * a segment that can never collide. A `cwd` is an absolute POSIX path from the
   * daemon's own listing, so `encodeURIComponent` always writes its leading `/` as
   * `%2F` — a folder literally called `/edit` still arrives as `%2Fedit` and is
   * read as a folder. That is the same property both tail segments already rest
   * on, extended one position left rather than a new rule.
   */
  check(
    "a folder that would collide with the marker is not writable",
    [agentBuilderPath("m_1", "/edit"), (parsePath("/agent/m_1/%2Fedit") as never as { cwd: string; preset: string | null }).cwd],
    ["/agent/m_1/%2Fedit", "/edit"],
  );
  check(
    "and is a folder rather than an edit",
    (parsePath("/agent/m_1/%2Fedit") as never as { preset: string | null }).preset,
    null,
  );
  check(
    "one encoding of the builder's address, step and all",
    [agentBuilderPath("m_1", "/home/me"), agentBuilderPath("m_1", "/home/me", "llm"), agentBuilderPath("m_1", null, "harness")],
    ["/agent/m_1/%2Fhome%2Fme", "/agent/m_1/llm/%2Fhome%2Fme", "/agent/m_1/harness"],
  );

  /* ---------------------------------------------------------------- *
   * Editing one that already exists
   *
   * ⚠ **An edit is an address, and that is the whole of why it works.** The
   * builder is rendered by `StartSheet` and `NewSession` unmounts for the entire
   * flow, so there is nothing to carry a preset id in but the URL — a prop would
   * have to survive a screen that is not on screen.
   * ---------------------------------------------------------------- */
  const edited = parsePath("/agent/m_1/edit/ca_1234abcd");
  check(
    "an edit address names the agent and nothing else",
    edited,
    { name: "agent", machineId: "m_1", cwd: null, step: null, preset: "ca_1234abcd" , harness: null } as never,
  );
  check(
    "and a choice inside one carries both the agent and the folder",
    parsePath("/agent/m_1/edit/ca_1234abcd/llm/%2FUsers%2Fme%2Fsrc"),
    { name: "agent", machineId: "m_1", cwd: "/Users/me/src", step: "llm", preset: "ca_1234abcd" , harness: null } as never,
  );
  check(
    "a step with no folder is still a step",
    parsePath("/agent/m_1/edit/ca_1234abcd/harness"),
    { name: "agent", machineId: "m_1", cwd: null, step: "harness", preset: "ca_1234abcd" , harness: null } as never,
  );
  /*
   * ⚠ **Every address written before the marker existed still parses**, and the
   * one that fails must fail *towards the new-agent screen* — the arm holding none
   * of somebody else's work to overwrite. `compatibility.md` rule 2 is what
   * decides the direction; this is the sweep that says it is true of all of them
   * rather than of the one somebody thought to check.
   */
  check(
    "no old address grew a preset",
    ["/agent/m_1", "/agent/m_1/%2Fhome%2Fme", "/agent/m_1/llm", "/agent/m_1/llm/%2Fhome%2Fme", "/agent/m_1/harness"]
      .map((path) => (parsePath(path) as never as { preset: string | null }).preset),
    [null, null, null, null, null],
  );
  /*
   * The marker with nothing after it: the new-agent screen, and **not** a preset
   * named nothing and not a folder called "edit". Nothing else asserts the stated
   * failure direction, and an id is the one segment here a person can mistype.
   */
  check(
    "a marker with no agent behind it degrades to the screen that holds no work",
    parsePath("/agent/m_1/edit"),
    { name: "agent", machineId: "m_1", cwd: null, step: null, preset: null, harness: null } as never,
  );
  /* ---------------------------------------------------------------- *
   * ⭐ The second marker: a harness to start from
   *
   * ⚠ **It exists because a built-in agent is an agent.** The Agents screen lists
   * what the New session strip offers, and a built-in row and an assembled one are
   * the same kind of thing there — ordered, removable, and now editable. A harness
   * has no row to `PATCH`, so "edit" means *start from it*, and the harness has to
   * survive the same walk the preset does: this component unmounts for every
   * picker screen inside the flow.
   *
   * ⚠ **One marker, read at one position, so the pair is unexpressible.** `edit`
   * names a row the daemon holds and `from` names a harness to begin at; a route
   * carrying both would be a screen that has to decide which of two things it is
   * about. There is no address for it, which is stronger than a check.
   * ---------------------------------------------------------------- */
  check("a harness seed parses", parsePath("/agent/m_1/from/claude"), {
    name: "agent",
    machineId: "m_1",
    cwd: null,
    step: null,
    preset: null,
    harness: "claude",
  } as never);
  check("and round-trips through its own builder", parsePath(agentFromPath("m_1", "codex")), {
    name: "agent",
    machineId: "m_1",
    cwd: null,
    step: null,
    preset: null,
    harness: "codex",
  } as never);
  check(
    "the two markers are exclusive, at every address either can appear in",
    [
      parsePath("/agent/m_1/from/claude").name === "agent"
        ? [
            (parsePath("/agent/m_1/from/claude") as never as { preset: unknown }).preset,
            (parsePath("/agent/m_1/edit/ca_1234abcd") as never as { harness: unknown }).harness,
          ]
        : ["?", "?"],
    ].flat(),
    [null, null],
  );
  /*
   * The step and the folder still ride behind it, told apart by the `%2F` a folder
   * cannot lose — the same property the `edit` marker's own block asserts, and the
   * one that would break first if the tail offset were computed for one marker and
   * not the other.
   */
  check(
    "a seed carries a step and a folder like an edit does",
    parsePath("/agent/m_1/from/claude/llm/%2FUsers%2Fme%2Fsrc"),
    {
      name: "agent",
      machineId: "m_1",
      cwd: "/Users/me/src",
      step: "llm",
      preset: null,
      harness: "claude",
    } as never,
  );
  // And the ◀ out of that picker rebuilds it, for the reason it rebuilds a preset:
  // dropped here, the way back lands on the blank new-agent screen.
  check(
    "and the ◀ out of a picker inside it keeps the seed",
    upFrom(parsePath("/agent/m_1/from/claude/llm"), "/"),
    "/agent/m_1/from/claude",
  );
  // A seed this build cannot resolve is not an error: `AgentBuilder` weighs it with
  // `isAgentId` and opens the ordinary new-agent screen, which is rule 2's
  // direction and the same one the `edit` marker fails in.
  check(
    "a harness this build has never heard of still parses, and the screen drops it",
    parsePath("/agent/m_1/from/gemini").name === "agent"
      ? (parsePath("/agent/m_1/from/gemini") as never as { harness: unknown }).harness
      : null,
    "gemini",
  );
  /*
   * One encoding of the edit address, beside the builder's own above.
   * `agentEditPath` exists as a second name rather than callers writing
   * `agentBuilderPath(m, cwd, null, id)`: an edit is opened at the builder and
   * never at a step, so every ordinary caller would be threading a `null` through
   * the middle of a four-argument call — the positional hole somebody fills wrong.
   */
  check(
    "one encoding of the edit address",
    [
      agentEditPath("m_1", "ca_1234abcd"),
      agentEditPath("m_1", "ca_1234abcd", "/home/me"),
      agentBuilderPath("m_1", "/home/me", "llm", "ca_1234abcd"),
    ],
    ["/agent/m_1/edit/ca_1234abcd", "/agent/m_1/edit/ca_1234abcd/%2Fhome%2Fme", "/agent/m_1/edit/ca_1234abcd/llm/%2Fhome%2Fme"],
  );
  /*
   * ⚠ **And it round-trips**, which is the assertion neither half can pass alone:
   * `nav.ts` writes the address and `router.ts` reads it, they are separate files
   * on purpose (`nav.ts` may not import `router.ts`), and a marker moved in one of
   * them leaves the other still passing its own encoding check.
   */
  check(
    "and what the builder writes is what the router reads back",
    [
      agentEditPath("m_1", "ca_1234abcd", "/home/me"),
      agentBuilderPath("m_1", "/home/me", "llm", "ca_1234abcd"),
      agentBuilderPath("m_1", null, null, "ca_1234abcd"),
      agentBuilderPath("m_1", "/home/me", "harness", null),
    ].map((path) => {
      const back = parsePath(path) as never as { cwd: string | null; step: string | null; preset: string | null };
      return `${String(back.preset)}|${String(back.step)}|${String(back.cwd)}`;
    }),
    ["ca_1234abcd|null|/home/me", "ca_1234abcd|llm|/home/me", "ca_1234abcd|null|null", "null|harness|/home/me"],
  );
  /*
   * ⚠ **The head, the ◀'s name, the depth and where up goes — over all six screens
   * the builder has, as a total sweep rather than at the cells that matter
   * today.** That is the discipline the `sheetUpLabel` sweep further up already
   * uses, and it is the one that would have caught what shipped: `preset` was
   * absent from two hand-built literals and `undefined === null` is `false`, so a
   * *new* agent's ◀ silently became "Edit agent".
   *
   * Three properties are asserted together here on purpose, because they are one
   * property split across four functions. The ◀ is named after its destination's
   * own head, so `sheetUpLabel` at a step must equal `sheetTitle` at the step-less
   * route it points at — a chevron named "Configure agent" pointing at a screen
   * titled "Edit agent" is the control naming somewhere you are not going. And
   * `upFrom` has to actually go there: dropped from that arm, the ◀ out of a
   * picker lands on the new-agent screen and the agent being edited is gone from
   * the address, which is the same loss the `cwd` segment exists to prevent one
   * field over.
   *
   * ⚠ **`depthOf` is unmoved by a preset, and that is a decision rather than an
   * omission.** An edit is the same screen with its rows filled in, reached from
   * and left to the same place, so a preset changes what the screen is *about* and
   * never where it sits — a third depth would play the deeper animation over a
   * screen nobody went deeper into.
   */
  const agentScreen = (step: string | null, preset: string | null): unknown =>
    ({ name: "agent", machineId: "m_1", cwd: null, step, preset }) as never;
  check(
    "the head, the ◀ and the depth over every screen the builder has",
    [null, "llm", "harness"].flatMap((step) =>
      [null, "ca_1234abcd"].map((preset) => {
        const route = agentScreen(step, preset) as never;
        return `${String(sheetTitle(route))} · ${String(sheetUpLabel(route))} · ${depthOf(route)} · ${String(upFrom(route, "/"))}`;
      }),
    ),
    [
      "Configure agent · New session · 2 · /new/m_1",
      "Edit agent · New session · 2 · /new/m_1",
      "Choose model · Configure agent · 3 · /agent/m_1",
      "Choose model · Edit agent · 3 · /agent/m_1/edit/ca_1234abcd",
      "Choose harness · Configure agent · 3 · /agent/m_1",
      "Choose harness · Edit agent · 3 · /agent/m_1/edit/ca_1234abcd",
    ],
  );
  /*
   * ⚠ **The builder has two ways in, and the ◀ has to name and reach whichever it
   * was.** It was opened from New session alone, so the label was a constant and
   * `upFrom` rebuilt the address from the route's own segments. The machine's
   * Agents screen opens it now, and walking back to `/new` from there drops
   * somebody out of settings onto a screen they never asked for — the same failure
   * `origin` was added to the market for, arriving at a second pop-up.
   *
   * The New-session case is asserted beside it and is the one that must **not**
   * move: `originFor` records a crossing, so the origin there is the very address
   * `newSessionPath` would have built, and the answer is unchanged.
   */
  {
    const fromNew = "/new/m_1/%2FUsers%2Fme%2Fsrc";
    const fromSettings = "/settings/machines/m_1/agents";
    const builder = agentScreen(null, "ca_1234abcd") as never;
    check(
      "the ◀ out of the builder names and reaches the pop-up it was opened from",
      [
        `${String(sheetUpLabel(builder, fromNew))} · ${String(upFrom(builder, "/", fromNew))}`,
        `${String(sheetUpLabel(builder, fromSettings))} · ${String(upFrom(builder, "/", fromSettings))}`,
        `${String(sheetUpLabel(builder))} · ${String(upFrom(builder, "/"))}`,
      ],
      [
        `New session · ${fromNew}`,
        `Agents · ${fromSettings}`,
        "New session · /new/m_1",
      ],
    );
    /*
     * ⚠ **A picker one depth in ignores the origin entirely**, and that is the
     * "walk the pop-up's own depths first" rule this file already states for the
     * market: an origin reached at the *second* depth would short-circuit past the
     * screen somebody is actually editing on.
     */
    check(
      "and a picker inside it still walks back to the builder, whichever door was used",
      upFrom(agentScreen("llm", "ca_1234abcd") as never, "/", fromSettings),
      "/agent/m_1/edit/ca_1234abcd",
    );
  }
  // And with a folder in hand, which is the case the ◀ actually loses things in.
  check(
    "and a picker inside an edit walks back to the edit, folder and all",
    upFrom(parsePath("/agent/m_1/edit/ca_1234abcd/llm/%2FUsers%2Fme%2Fsrc"), "/"),
    "/agent/m_1/edit/ca_1234abcd/%2FUsers%2Fme%2Fsrc",
  );
  check(
    "while the edit itself leaves to the same place a new agent does",
    upFrom(parsePath("/agent/m_1/edit/ca_1234abcd/%2FUsers%2Fme%2Fsrc"), "/"),
    "/new/m_1/%2FUsers%2Fme%2Fsrc",
  );
  /*
   * ⚠ **The word moved and the address did not, and both halves are asserted in
   * one check or the next rename separates them.** "Choose LLM" was pinned
   * nowhere at all — it is the one string in this flow that used an acronym for
   * the thing beside it, while every refusal on the same screen already said
   * *model* — and the sweep that should have caught it is a closure over
   * `hostable`'s return values which reads neither `.tsx` nor this file. The
   * segment is deliberately untouched: it is an address, and a link written down
   * last week has to keep opening this screen.
   */
  check(
    "the model screen is named in words, over a segment that is still an address",
    [sheetTitle(parsePath("/agent/m_1/llm")), agentBuilderPath("m_1", null, "llm")],
    ["Choose model", "/agent/m_1/llm"],
  );
  /*
   * And the sweep that was missing, over the returns rather than over one arm:
   * every string `nav.ts` can put in a pop-up's head or on its ◀. `agentCard.ts`
   * states the standing rule — a reader who has never seen an environment variable
   * must not meet an acronym either — and until now nothing reached these values
   * at all, which is exactly how the acronym shipped.
   */
  const spoken = [
    { name: "settings", section: "account", machineId: null, system: null },
    { name: "plugins", tab: "market", entry: null, settings: [] },
    { name: "plugin", machineId: "m_1", pluginId: "p" },
    { name: "new", machineId: "m_1", cwd: null },
    { name: "home" },
    { name: "session", id: "s_1" },
    ...[null, "llm", "harness"].flatMap((step) =>
      [null, "ca_1234abcd"].map((preset) => ({ name: "agent", machineId: "m_1", cwd: null, step, preset })),
    ),
  ].flatMap((route) => [sheetTitle(route as never), sheetUpLabel(route as never)])
    .filter((one): one is string => one !== null);
  check("every head and ◀ in this app has a name", spoken.length > 0, true);
  check("and none of them says LLM", spoken.filter((one) => /\bllm\b/i.test(one)), []);
  /*
   * `newSessionPath` lives in `nav.ts` and `router.ts` re-exports it as
   * `newPath`, because `upFrom` needs the rule and `nav.ts` may not import
   * `router.ts`. Asserted as one encoding rather than two that drift.
   */
  check("one encoding of the picker's address", newSessionPath("m_1", "/Users/me/src"), "/new/m_1/%2FUsers%2Fme%2Fsrc");
  check("and a machine on its own", newSessionPath("m_1"), "/new/m_1");
  check("and neither", newSessionPath(), "/new");
  // A bare `/agent` names no machine and every question this screen asks is one
  // daemon's, so it is not a route at all.
  check("a builder with no machine is not a route", parsePath("/agent").name, "home");
}

process.stdout.write("\nthe agent a pop-up handed back\n");
{
  const { rememberPick, rememberRemoval, takePick, takeRemoval, keepPick, heldPick, forgetPick } = await import(
    "../src/agentPick.js"
  );
  const one = { id: "ca_1", name: "n", harness: "claude", system: "moonshot", model: "m", createdAt: 0 } as never;

  check("nothing is waiting to begin with", takePick("m_1" as never), null);
  rememberPick("m_1" as never, one);
  check("what was assembled comes back once", takePick("m_1" as never), one);
  /*
   * ⚠ **Consumed, not read.** A hand-off left in place would re-select the same
   * agent the *next* time somebody opened New session, long after they had chosen
   * something else — and `NewSession` reads it from an effect, which React may
   * run more than once.
   */
  check("and only once", takePick("m_1" as never), null);
  rememberPick("m_1" as never, one);
  check("it is per machine", takePick("m_2" as never), null);
  check("so the other machine's is still there", takePick("m_1" as never), one);
  /*
   * ⚠ **Two machines holding one each at the same time, which is the property a
   * map is here for and which none of the three checks above can see.** They only
   * ever put one entry in, so a `pending` that kept the *newest* hand-off and
   * dropped the rest — one `clear()` before the `set`, or a single variable
   * carrying its own machine id — passes every one of them: the untouched machine
   * still answers `null`, and the machine that was written to still answers what
   * was written. That is exactly the single-value bug scoping to a machine was
   * meant to fix, arriving one layer down. Assembling an agent on two machines
   * before either strip is redrawn is the flow: the builder is a route away and
   * `NewSession` is unmounted for the whole of it, so nothing consumes a hand-off
   * until somebody comes back to that machine's strip.
   */
  const other = { id: "ca_2", name: "n2", harness: "codex", system: "anthropic", model: "m2", createdAt: 1 } as never;
  rememberPick("m_1" as never, one);
  rememberPick("m_2" as never, other);
  check("and a second machine's hand-off does not displace the first", takePick("m_1" as never), one);
  check("with each machine still getting its own", takePick("m_2" as never), other);
  // The removal half of the same property, for the reason the whole removal suite
  // exists: it is the same hand-off with the same failure modes, and it arrived
  // with none of the pick suite's assertions.
  rememberRemoval("m_1" as never, "ca_1");
  rememberRemoval("m_2" as never, "ca_2");
  check(
    "and removals are retained per machine too, not just keyed by one",
    [takeRemoval("m_1" as never), takeRemoval("m_2" as never)],
    ["ca_1", "ca_2"],
  );

  /*
   * ⚠ **The removal half, swept the same four ways**, because it is the same
   * hand-off with the same three failure modes and it arrived without any of the
   * assertions above. Removing the tile that is *currently* selected leaves the
   * strip naming a row the daemon has dropped: nothing draws as chosen, the Edit
   * control goes with it, and `Start` posts a `404` on an id that no longer
   * exists. The builder is a route away and `NewSession` is unmounted while it is
   * open, so there is no parent to report to — hence a module variable, and hence
   * these.
   */
  check("no removal is waiting to begin with", takeRemoval("m_1" as never), null);
  rememberRemoval("m_1" as never, "ca_1");
  check("what was removed comes back once", takeRemoval("m_1" as never), "ca_1");
  /*
   * ⚠ **The one that matters, and the property the docblock argues for.** A
   * removal left in place clears a selection on some later visit — long after the
   * removal that produced it, and against a preset somebody has since assembled
   * and chosen again. `NewSession` reads it from an effect, which React may run
   * more than once, so `read` and `take` are indistinguishable on the first run
   * and opposite on the second.
   */
  check("and a removal, only once as well", takeRemoval("m_1" as never), null);
  rememberRemoval("m_1" as never, "ca_1");
  check("removals are per machine too", takeRemoval("m_2" as never), null);
  check("so the other machine's removal is still there", takeRemoval("m_1" as never), "ca_1");
  /*
   * ⚠ **And the assertion the pick suite has no equivalent of, because it is the
   * whole justification for two maps rather than one union.** One machine can
   * honestly be carrying both at once — remove one agent in the pop-up, assemble
   * another, come back — and the two are answered by different things at the far
   * end: a pick replaces what is chosen, a removal only withdraws it. A union
   * would have made the second `remember` overwrite the first and the strip would
   * hear about exactly one of them.
   */
  rememberRemoval("m_1" as never, "ca_gone");
  rememberPick("m_1" as never, one);
  check(
    "a machine holding both gives up each independently",
    [takeRemoval("m_1" as never), takePick("m_1" as never)],
    ["ca_gone", one],
  );
  check(
    "and neither is left behind by the other",
    [takeRemoval("m_1" as never), takePick("m_1" as never)],
    [null, null],
  );

  /* ── the third map, whose discipline is the opposite of the two above ── */
  {
    /*
     * ⚠ **This one is *read*, and the two above are *taken*.** Nothing drove it,
     * and the natural edit — copying the take-pattern from the functions it sits
     * between — is a regression no other assertion in this file can see.
     *
     * The asymmetry is the whole rule. Those two carry an event that happened once
     * — an agent was assembled, an agent was removed — so consuming one twice
     * re-applies it long after the fact. This carries a *standing* choice: the tile
     * somebody tapped, which stays true until they tap another. `NewSession` reads
     * it from an effect React may run more than once, so a take-on-read clears the
     * selection on the first render that happens to run twice: no tile draws as
     * chosen and `Start` is dead until somebody taps again.
     *
     * It exists because a pop-up can leave for another pop-up — the strip's gear
     * opens `/settings/machines/:id/agents`, which unmounts `StartSheet` — and the
     * choice has to survive that walk.
     */
    const tile = { kind: "custom", id: "ca_1" } as never;
    const harness = { kind: "harness", id: "claude" } as never;

    forgetPick("m_1" as never);
    forgetPick("m_2" as never);
    check("nothing is chosen to begin with", heldPick("m_1" as never), null);
    keepPick("m_1" as never, tile);
    /*
     * ⚠ **Two consecutive reads, and the second is the assertion.** One read alone
     * is satisfied by a take, which is exactly the implementation this must refuse.
     */
    check(
      "a chosen tile comes back every time it is asked for",
      [heldPick("m_1" as never), heldPick("m_1" as never), heldPick("m_1" as never)],
      [tile, tile, tile],
    );
    // Per machine, and both directions: a second machine's choice must neither
    // answer for the first nor displace it.
    keepPick("m_2" as never, harness);
    check(
      "and each machine holds its own",
      [heldPick("m_1" as never), heldPick("m_2" as never)],
      [tile, harness],
    );
    // A standing choice is replaced by tapping another, which is the one way it
    // changes short of being dropped.
    keepPick("m_1" as never, harness);
    check("tapping another replaces it", heldPick("m_1" as never), harness);
    /*
     * ⚠ **And the one caller that clears a choice rather than making one.**
     * Removing the agent a tile stood for has to reach this map, or the next mount
     * restores a pick naming a row the daemon dropped — the state `rememberRemoval`
     * prevents one mount earlier, arriving here by the other door. It clears one
     * machine and only one.
     */
    forgetPick("m_1" as never);
    check(
      "forgetting one machine's choice leaves the other's standing",
      [heldPick("m_1" as never), heldPick("m_2" as never)],
      [null, harness],
    );
    // The module outlives this block, so nothing downstream inherits a choice.
    forgetPick("m_2" as never);
  }
}
