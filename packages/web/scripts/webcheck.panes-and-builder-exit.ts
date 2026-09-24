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

  const fields = [field("host", "text", "a"), field("loud", "toggle", "true"), field("mode", "select", "x")] as never;
  check(
    "blank is seedForm over a plugin that sent nothing",
    blankForm(fields),
    seedForm((fields as never as { value: unknown }[]).map((one) => ({ ...one, value: null })) as never),
  );
  check("a toggle is off and everything else is empty", blankForm(fields), { host: "", loud: "false", mode: "" });

  // Compared after seedForm normalisation, never as raw value: null and empty are the same on screen and on submit.
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
    // A blanked toggle is off rather than empty, so only the keys that disagreed may be named.
    check("naming only what disagreed", answer.form.kind === "mixed" ? answer.form.differing : null, ["host"]);
    check("and both machines are still written to", answer.targets, ["m_1", "m_2"]);
  }

  // A different form draws nothing: one machine's keys submitted to another write fields it lacks and omit ones it has.
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

  check("one machine is named", scopeSummary(["laptop"]), "laptop");
  check("three are named", scopeSummary(["a", "b", "c"]), "a, b, c");
  check("four are counted", scopeSummary(["a", "b", "c", "d"]), "4 machines");
  check("and none is said out loud", scopeSummary([]), "no machines");
  // Never "all": this is a chosen scope, not a fact about the fleet (Q7.42).
  check("and it never says all", [1, 2, 3, 4, 9].map((n) => scopeSummary(Array.from({ length: n }, (_, i) => `m${i}`)).includes("all")), [false, false, false, false, false]);
}

process.stdout.write("\nthe way out of the agent builder\n");
{
  const { agentBuilderPath, agentEditPath, agentFromPath, depthOf, sheetTitle, sheetUpLabel, upFrom, newSessionPath } =
    await import("../src/nav.js");
  const { parsePath } = await import("../src/router.js");

  // Up returns to New session with its folder; under would close the whole stack.
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
  // A cwd is absolute, so its leading slash always encodes as %2F; that is what tells the optional step and folder apart.
  check(
    "a folder alone is still a folder",
    (parsePath("/agent/m_1/%2Fhome%2Fllm") as never as { step: string | null; cwd: string }),
    { name: "agent", machineId: "m_1", cwd: "/home/llm", step: null, preset: null , harness: null } as never,
  );
  // The edit marker is a literal word rather than the daemon's id shape: the client must not copy the id generator.
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

  // An edit is an address because NewSession unmounts for the whole flow, so nothing else can carry the preset id.
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
  // Old addresses still parse, and a failure falls towards the new-agent screen (compatibility.md rule 2).
  check(
    "no old address grew a preset",
    ["/agent/m_1", "/agent/m_1/%2Fhome%2Fme", "/agent/m_1/llm", "/agent/m_1/llm/%2Fhome%2Fme", "/agent/m_1/harness"]
      .map((path) => (parsePath(path) as never as { preset: string | null }).preset),
    [null, null, null, null, null],
  );
  check(
    "a marker with no agent behind it degrades to the screen that holds no work",
    parsePath("/agent/m_1/edit"),
    { name: "agent", machineId: "m_1", cwd: null, step: null, preset: null, harness: null } as never,
  );
  // from names a harness to start from; one marker at one position makes edit plus from unexpressible.
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
  check(
    "and the ◀ out of a picker inside it keeps the seed",
    upFrom(parsePath("/agent/m_1/from/claude/llm"), "/"),
    "/agent/m_1/from/claude",
  );
  // An unknown seed is not an error: AgentBuilder weighs it with isAgentId and opens the new-agent screen.
  check(
    "a harness this build has never heard of still parses, and the screen drops it",
    parsePath("/agent/m_1/from/gemini").name === "agent"
      ? (parsePath("/agent/m_1/from/gemini") as never as { harness: unknown }).harness
      : null,
    "gemini",
  );
  check(
    "one encoding of the edit address",
    [
      agentEditPath("m_1", "ca_1234abcd"),
      agentEditPath("m_1", "ca_1234abcd", "/home/me"),
      agentBuilderPath("m_1", "/home/me", "llm", "ca_1234abcd"),
    ],
    ["/agent/m_1/edit/ca_1234abcd", "/agent/m_1/edit/ca_1234abcd/%2Fhome%2Fme", "/agent/m_1/edit/ca_1234abcd/llm/%2Fhome%2Fme"],
  );
  // nav.ts writes the address and router.ts reads it, so only a round-trip catches a marker moved in one of them.
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
  // depthOf is unmoved by a preset on purpose: an edit is the same screen with its rows filled in.
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
    check(
      "and a picker inside it still walks back to the builder, whichever door was used",
      upFrom(agentScreen("llm", "ca_1234abcd") as never, "/", fromSettings),
      "/agent/m_1/edit/ca_1234abcd",
    );
  }
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
  // The llm segment is an address and stays; only the words changed.
  check(
    "the model screen is named in words, over a segment that is still an address",
    [sheetTitle(parsePath("/agent/m_1/llm")), agentBuilderPath("m_1", null, "llm")],
    ["Choose model", "/agent/m_1/llm"],
  );
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
  // newSessionPath lives in nav.ts (router.ts re-exports it as newPath) because nav.ts may not import router.ts.
  check("one encoding of the picker's address", newSessionPath("m_1", "/Users/me/src"), "/new/m_1/%2FUsers%2Fme%2Fsrc");
  check("and a machine on its own", newSessionPath("m_1"), "/new/m_1");
  check("and neither", newSessionPath(), "/new");
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
  // Consumed, not read: NewSession reads it from an effect React may run more than once.
  check("and only once", takePick("m_1" as never), null);
  rememberPick("m_1" as never, one);
  check("it is per machine", takePick("m_2" as never), null);
  check("so the other machine's is still there", takePick("m_1" as never), one);
  // Two machines at once: a single-slot store would pass every check above.
  const other = { id: "ca_2", name: "n2", harness: "codex", system: "anthropic", model: "m2", createdAt: 1 } as never;
  rememberPick("m_1" as never, one);
  rememberPick("m_2" as never, other);
  check("and a second machine's hand-off does not displace the first", takePick("m_1" as never), one);
  check("with each machine still getting its own", takePick("m_2" as never), other);
  rememberRemoval("m_1" as never, "ca_1");
  rememberRemoval("m_2" as never, "ca_2");
  check(
    "and removals are retained per machine too, not just keyed by one",
    [takeRemoval("m_1" as never), takeRemoval("m_2" as never)],
    ["ca_1", "ca_2"],
  );

  check("no removal is waiting to begin with", takeRemoval("m_1" as never), null);
  rememberRemoval("m_1" as never, "ca_1");
  check("what was removed comes back once", takeRemoval("m_1" as never), "ca_1");
  check("and a removal, only once as well", takeRemoval("m_1" as never), null);
  rememberRemoval("m_1" as never, "ca_1");
  check("removals are per machine too", takeRemoval("m_2" as never), null);
  check("so the other machine's removal is still there", takeRemoval("m_1" as never), "ca_1");
  // Two maps rather than one union: a machine can honestly carry a removal and a pick at once.
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

  {
    // This map is read, not taken: it holds a standing choice, and a take would clear it on an effect's second run.
    const tile = { kind: "custom", id: "ca_1" } as never;
    const harness = { kind: "harness", id: "claude" } as never;

    forgetPick("m_1" as never);
    forgetPick("m_2" as never);
    check("nothing is chosen to begin with", heldPick("m_1" as never), null);
    keepPick("m_1" as never, tile);
    // Two consecutive reads: one read alone is satisfied by a take.
    check(
      "a chosen tile comes back every time it is asked for",
      [heldPick("m_1" as never), heldPick("m_1" as never), heldPick("m_1" as never)],
      [tile, tile, tile],
    );
    keepPick("m_2" as never, harness);
    check(
      "and each machine holds its own",
      [heldPick("m_1" as never), heldPick("m_2" as never)],
      [tile, harness],
    );
    keepPick("m_1" as never, harness);
    check("tapping another replaces it", heldPick("m_1" as never), harness);
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
