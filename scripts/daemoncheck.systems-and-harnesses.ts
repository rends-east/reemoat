import { mkdirSync } from "node:fs";
import { credentialEnvNames, type AgentId } from "../src/acp/agents.js";
// Type only: every *value* in that module is reached through a dynamic import
// inside the block that drives it, so each section reads the table rather than a
// binding somebody could have shadowed at the top of this file.
import type { BuiltinSystemId } from "../src/acp/systems.js";
import { LocalRuntime } from "../src/runtime/local.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { storeOf, rowFor } from "./daemoncheck.fixtures.js";

process.stdout.write("\nbeing told a session appeared\n");
{
  const { SessionRegistry } = await import("../src/registry.js");

  const root = tmp("observer-");
  mkdirSync(root, { recursive: true });
  const warnings: string[] = [];
  const registry = new SessionRegistry(
    undefined,
    storeOf([rowFor("s_one", root), rowFor("s_two", root)]),
    undefined,
    undefined,
    undefined,
    (detail) => warnings.push(detail),
  );

  /*
   * ⚠ **A throwing observer is reported, kept, and does not stop the ones after
   * it.** All three are asserted here because all three are the opposite of what
   * `SessionLog.append` does to a throwing listener, and the difference is
   * deliberate: there, a listener is one WebSocket and evicting it costs that
   * socket its events; here it is a whole subsystem, and dropping it on one bad
   * frame would stop every plugin hook on the machine for the life of the daemon
   * with nothing anywhere saying so.
   *
   * Registered **first**, so "the ones after it" is a real position rather than a
   * hope about iteration order.
   */
  let threw = 0;
  const unstable = registry.watchSessions(() => {
    threw += 1;
    throw new Error("this observer is broken");
  });
  const seen: [string, string][] = [];
  const stop = registry.watchSessions((managed, arrival) => seen.push([managed.id, arrival]));

  registry.restore({ reapOrphans: false });

  check(
    "every session already here is announced, as restored",
    seen,
    [
      ["s_one", "restored"],
      ["s_two", "restored"],
    ],
  );
  report("a throwing observer is called for every one of them", threw === 2, `${threw} calls`);
  report(
    "each throw is reported rather than swallowed",
    warnings.filter((one) => one.includes("this observer is broken")).length === 2,
    `${warnings.length} warnings`,
  );

  unstable();
  stop();
  const before = seen.length;
  registry.restore({ reapOrphans: false });
  check("and unsubscribing really stops it", seen.length, before);

  await registry.shutdown();
}

/* ------------------------------------------------------------------ *
 * Systems, and the agents assembled out of them
 *
 * A *system* is who serves a model; a *harness* is the CLI that runs the loop.
 * What is driven here is the seam between them: the table, the compatibility
 * rule, and the seven routes.
 *
 * ⚠ **The compatibility rule is driven as a sweep over the whole matrix rather
 * than at the two cells that happen to matter today.** `hostable` is what decides
 * whether somebody's key is sent to a host that will accept it, and a rule
 * asserted at its interesting points is a rule the next entry in `SYSTEMS`
 * escapes silently.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich harness can be pointed at which system\n");
{
  const { AGENT_IDS: harnesses, isBuiltinAgentId } = await import("../src/acp/agents.js");
  const {
    hostable,
    routedModelEnv,
    routedPairing,
    routingHeaders,
    BUILTIN_CATALOGUE,
    SYSTEM_IDS,
    SYSTEMS,
    systemSecretFor,
    isBuiltinSystemId,
    ROUTED_MODEL_ENV,
  } = await import("../src/acp/systems.js");
  type MachineCatalogue = Parameters<typeof hostable>[3] & object;
  type ContributedHarness = NonNullable<ReturnType<MachineCatalogue["harness"]>>;
  /*
   * ⚠ **This section sweeps what this repository *ships*, and it stays that way.**
   * `AGENT_IDS` and `SYSTEM_IDS` are the built-ins and nothing else, so every
   * assertion below is a real one: `AGENT_IDS.every((id) => AGENT_LOGIN[id])` says
   * something because both halves are the same closed list. Re-pointing either at
   * what a *machine* offers would make these vacuous on the day it mattered.
   *
   * What a plugin adds is swept separately, further down, as a **property** over a
   * synthetic catalogue — because the value of the matrix below is that it is a
   * transcription of four measured answers, and a sweep that computes both sides
   * passes whenever both are wrong.
   */

  // The four answers the pinned adapters actually gave — claude, codex and kimi
  // measured 2026-08-25, opencode 2026-08-27. Written out here so the matrix below
  // is driven against reality rather than against whatever the table would like to
  // be true.
  const routings = {
    claude: { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] },
    codex: { providerId: "custom-gateway", supported: ["openai"] },
    kimi: null,
    // `agent/providers/list` answers `-32601 Method not found` on opencode
    // 1.18.23, and `agentCapabilities` carries no `providers` marker — so
    // `AcpClient.routing()` answers `null` and opencode can reach nothing it does
    // not reach by itself. That is the whole reason `openrouter` names it as a
    // `nativeHarness` rather than leaving it to the routed path.
    opencode: null,
  } as const;

  /*
   * ⚠ **Every native pairing is hostable *without consulting routing at all*.**
   * That is the branch kimi depends on: it answers `-32601` to `providers/list`
   * and still reaches Moonshot, because nothing is being configured. Driven with
   * `null` routing for all three, so a version of `hostable` that reached for
   * `supported` before checking native would fail here rather than in the fleet.
   */
  const nativeMisses = SYSTEM_IDS.flatMap((system) => {
    const native = SYSTEMS[system].nativeHarness;
    return native === null || hostable(native, system, null) === null ? [] : [system];
  });
  check("a native pairing needs no routing at all", nativeMisses, []);

  // The whole matrix, as strings, so a change to any cell is visible as a diff
  // rather than as a count.
  const matrix = harnesses.flatMap((harness) =>
    SYSTEM_IDS.map((system) => {
      const refusal = hostable(harness, system, routings[harness]);
      return `${harness} x ${system}: ${refusal === null ? "yes" : "no"}`;
    }),
  );
  check("the matrix is what the adapters allow", matrix, [
    "claude x anthropic: yes",
    "claude x openai: no",
    // Routed, on the strength of OpenRouter serving an Anthropic-shaped endpoint
    // beside its OpenAI-shaped one — probed 2026-08-27, both answer 401 in their
    // own envelope. Same answer as `moonshot`'s cell, which is the next one along.
    "claude x openrouter: yes",
    "claude x moonshot: yes",
    "claude x zhipu: yes",
    "claude x minimax: yes",
    // Its endpoint is real and this row names none, so claude is refused by the
    // same arm that refuses it Anthropic's: nothing here has an OpenAI-shaped
    // door to route through.
    "claude x zen: no",
    "kimi x anthropic: no",
    "kimi x openai: no",
    "kimi x openrouter: no",
    "kimi x moonshot: yes",
    "kimi x zhipu: no",
    "kimi x minimax: no",
    "kimi x zen: no",
    "codex x anthropic: no",
    "codex x openai: yes",
    "codex x openrouter: no",
    "codex x moonshot: no",
    "codex x zhipu: no",
    "codex x minimax: no",
    "codex x zen: no",
    // opencode answers `null` to routing, so every cell but its own is the
    // "only runs its own models" refusal — and its own is native, which needs no
    // routing at all. Both halves of the row are the point: a fourth harness that
    // reached a fifth system would mean `hostable` had stopped reading `supported`.
    "opencode x anthropic: no",
    "opencode x openai: no",
    "opencode x openrouter: yes",
    "opencode x moonshot: no",
    "opencode x zhipu: no",
    "opencode x minimax: no",
    // The one it reaches with no credential at all.
    "opencode x zen: yes",
  ]);

  /*
   * ⚠ **Routable and un-pinnable must refuse.** `hostable` folds
   * `ROUTED_MODEL_ENV` in for exactly this: a pairing this daemon can route but
   * cannot point at a model would start, look right, and quietly run the
   * endpoint's default. Driven by taking claude's entry away, which is the only
   * way to reach the branch while the table has one arm.
   */
  const claudeEnv = ROUTED_MODEL_ENV.claude;
  delete ROUTED_MODEL_ENV.claude;
  check(
    "a harness that cannot be told which model to run is refused",
    hostable("claude", "moonshot", routings.claude) !== null,
    true,
  );
  ROUTED_MODEL_ENV.claude = claudeEnv;
  check("and putting it back restores the pairing", hostable("claude", "moonshot", routings.claude), null);

  /*
   * The two halves of a routed launch, and which one carries the secret.
   *
   * ⚠ **The key is in the headers and must never be in the environment.** An
   * agent runs as this uid and can print its own environment into a transcript
   * that is appended to the log and rendered in a browser.
   *
   * ⚠ **That property is *not* driven here, and a sweep that looked like it was
   * stood at this line for a release.** It read every value of `routedModelEnv`'s
   * answer and asserted none of them contained the secret — over a function that
   * is pure in a harness, a system and a model id, called from a driver that
   * hands it three literals none of which is a credential. There is no
   * implementation short of one hardcoding the literal that could have failed it,
   * so it protected nothing while reading exactly like the assertion that does.
   * The real one is in "what an assembled session is launched as", over a launch
   * from a rig whose `systemSecret` genuinely answers `sekrit`: the environment
   * the agent process was spawned with and the `providers/set` headers it was
   * sent are compared against each other, which is what "these two are not
   * interchangeable" actually asserts. Both halves below stay here — they are
   * about the *table*, and a table is what this section drives.
   */
  const env = routedModelEnv("claude", "moonshot", "kimi-k2-thinking");
  check("a routed model is named in the environment", env["ANTHROPIC_MODEL"], "kimi-k2-thinking");
  check("and also as a picker row, which is the documented door", env["ANTHROPIC_CUSTOM_MODEL_OPTION"], "kimi-k2-thinking");
  check("a native pairing is spawned with nothing extra", routedModelEnv("kimi", "moonshot", "kimi-k2"), {});
  check("the secret travels as a header", routingHeaders("moonshot", "sekrit"), {
    authorization: "Bearer sekrit",
  });
  check("and a native system has none to send", routingHeaders("anthropic", "sekrit"), {});

  /*
   * ⚠ **Which pairings are *routed* at all — the question asked before the spawn,
   * and the one that decides whether a vendor credential goes into the
   * environment.** `LocalRuntime.launch` takes the answer as its third argument
   * and merges `secrets(agent)` only when it is false.
   *
   * ⚠ **Nothing drove this function for a release, and the gap was total.**
   * `routedPairing` reduced to a bare `return false` left every assertion in this
   * file green while every routed session spawned carrying `ANTHROPIC_API_KEY` and
   * `CLAUDE_CODE_OAUTH_TOKEN` into a process aimed at somebody else's endpoint —
   * author-chosen, the moment a plugin may contribute a provider. The rig two
   * sections down could not see it either: its `launch` override drops the third
   * parameter, so the flag never reached a merge there.
   *
   * All five arms in one array rather than five calls, because what actually
   * failed was the function collapsing to a constant, and a constant is exactly
   * what a single-arm assertion cannot distinguish from the truth.
   */
  check(
    "which pairings are routed, arm by arm",
    [
      routedPairing("claude", null),
      routedPairing("claude", "nobody:nothing"),
      routedPairing("kimi", "moonshot"),
      routedPairing("kimi", "anthropic"),
      routedPairing("claude", "moonshot"),
    ],
    // A bare harness names no system; a system this machine does not offer resolves
    // to nothing; a system reached by its own native harness runs on that harness's
    // own credential; a foreign system with no base URL cannot be reached at all.
    // Only the last is a session pointed somewhere else on a key this daemon holds.
    [false, false, false, false, true],
  );

  {
    /*
     * ⚠ **The merge itself, over a real spawn, because the flag above is only half
     * the property.** The arms say what `routedPairing` answers; this says what
     * `LocalRuntime.launch` *does* with the answer, and the two fail
     * independently — deleting `(routed ? {} : this.secrets(agent))` from
     * `local.ts` leaves every arm above green.
     *
     * ⚠ **Both halves are asserted, and the absent half alone would be worthless.**
     * A rig whose runtime never sets a secret satisfies "the routed launch carries
     * none" trivially and for the wrong reason. What makes the pair an assertion is
     * that the *same* runtime, the *same* harness and the *same* injected secret
     * produce opposite environments across the one flag.
     *
     * ⚠ **Driven through a *contributed* harness, and that is forced rather than
     * chosen.** `launch` resolves its command with `resolveAgent(agent, this.machine)`
     * and never through `describe`, so overriding `describe` — which is what every
     * other rig in this file does — changes nothing here: the first attempt spawned
     * the real `claude-agent-acp`, which waits on stdin for JSON-RPC and hung the
     * driver. A contributed harness is the one door that puts a command of this
     * driver's choosing through the real resolver, so the merge under test is the
     * real one. `node` rather than an absolute path because `findOnPath` joins its
     * argument onto each PATH entry and cannot take one.
     *
     * ⚠ **The pasted names are invented, so an ambient environment cannot answer
     * for them.** The base is `agentEnv()`, which carries the developer's whole
     * environment through; a real `ANTHROPIC_API_KEY` exported in somebody's shell
     * would make the routed half fail for a reason that is not this rule, and —
     * worse — a machine without one would make the native half pass whatever
     * `launch` merged.
     */
    const probe: ContributedHarness = {
      id: "probe:env",
      pluginId: "probe",
      pluginName: "Probe",
      name: "Env probe",
      command: "node",
      args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      envNames: [],
      // Non-empty, or `hostable` refuses the pairing one arm early and this
      // harness could never be routed at all.
      routedModelEnv: ["PROBE_MODEL"],
      authHint: null,
    };
    const withProbe: MachineCatalogue = {
      harness: (id) => (id === probe.id ? probe : BUILTIN_CATALOGUE.harness(id)),
      harnessIds: () => [...BUILTIN_CATALOGUE.harnessIds(), probe.id],
      harnessState: (id) => (id === probe.id ? "enabled" : BUILTIN_CATALOGUE.harnessState(id)),
      system: (id) => BUILTIN_CATALOGUE.system(id),
      systemIds: () => BUILTIN_CATALOGUE.systemIds(),
      systemState: (id) => BUILTIN_CATALOGUE.systemState(id),
    };
    // `secrets` is what somebody pasted for *this harness*, injected the way
    // `scripts/daemon.ts` injects the real credential store.
    const rig = new LocalRuntime({
      machine: withProbe,
      secrets: () => ({ DAEMONCHECK_PASTED_ONE: "sk-vendor", DAEMONCHECK_PASTED_TWO: "sk-oat" }),
    });
    const spawnedWith = async (routed: boolean): Promise<NodeJS.ProcessEnv> => {
      const child = await rig.launch(probe.id, { PROBE_MODEL: "kimi-k2-thinking" }, routed);
      let out = "";
      for await (const chunk of child.stdout) out += String(chunk);
      await child.waitForExit(5_000);
      return JSON.parse(out) as NodeJS.ProcessEnv;
    };
    const routedEnv = await spawnedWith(routedPairing(probe.id, "moonshot", withProbe));
    const nativeEnv = await spawnedWith(routedPairing(probe.id, "anthropic", withProbe));
    /*
     * ⚠ **The flag is computed rather than written down, so the two halves are
     * the two answers `routedPairing` actually gives.** Passing `true` and `false`
     * as literals here would pin the merge and let the function that decides it go
     * on returning a constant — which is the defect that was live.
     */
    check(
      "a routed launch is spawned with none of the harness's own credentials",
      [routedEnv["DAEMONCHECK_PASTED_ONE"] ?? null, routedEnv["DAEMONCHECK_PASTED_TWO"] ?? null],
      [null, null],
    );
    check(
      "while a native launch on the same harness and the same store carries both",
      [nativeEnv["DAEMONCHECK_PASTED_ONE"] ?? null, nativeEnv["DAEMONCHECK_PASTED_TWO"] ?? null],
      ["sk-vendor", "sk-oat"],
    );
    /*
     * And what this daemon's own tables produced reaches both, or the routed half
     * above would also be satisfied by a `launch` that merged nothing at all.
     */
    check(
      "with the model this daemon pinned reaching either way",
      [routedEnv["PROBE_MODEL"] ?? null, nativeEnv["PROBE_MODEL"] ?? null],
      ["kimi-k2-thinking", "kimi-k2-thinking"],
    );
  }

  /*
   * ⚠ **The sixth row, and the two facts about it that only a probe could give.**
   * Both were measured 2026-08-27 against the live endpoint and neither is
   * derivable from anything else in this repository.
   *
   * The base URL is the one that fails *quietly* if it is wrong. The SDK appends
   * `/v1/messages`, so a base carrying its own `/v1` reaches
   * `openrouter.ai/api/v1/v1/messages`, which answers an **HTML 404 page** rather
   * than a JSON error — a shape no error reader here recognises, arriving only
   * once somebody has pasted a real key and started a real session.
   */
  check("the routed base for the sixth system carries no version segment", SYSTEMS.openrouter.baseUrl, "https://openrouter.ai/api");
  check("and its key travels as a header like every other routed row", routingHeaders("openrouter", "sekrit"), {
    authorization: "Bearer sekrit",
  });

  /*
   * ⚠ **The prefix, both ways, because it is the one place a stored id is
   * respelled.** opencode publishes `openrouter/qwen/qwen3-coder` for what the
   * endpoint claude is routed at calls `qwen/qwen3-coder` — measured, 356 of the
   * 362 models a keyed opencode publishes carry it. Everything stored and sent is
   * the unprefixed spelling; `pinNativeModel` is what puts it back.
   *
   * The `null` half is the guard rather than the trivia: a system that grew a
   * prefix it did not have would respell every id in the fleet at once.
   */
  check(
    "which systems respell a native model id",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].nativeModelPrefix !== null).map(
      (id) => `${id}: ${SYSTEMS[id].nativeModelPrefix ?? ""}`,
    ),
    // Both belong to opencode, which is the whole reason `allModels` divides a
    // published list by prefix: one harness, two systems, one list holding both.
    ["openrouter: openrouter/", "zen: opencode/"],
  );
  /*
   * ⚠ **The two spellings are relatable and every other pair in this table is
   * not.** Moonshot's two lists are different products on different endpoints
   * with different billing — Q3.488 — and the refusal there is correct. Asserting
   * the *absence* is what stops a later reader "tidying" a prefix onto that row
   * and quietly claiming an equivalence nothing carries.
   */
  /*
   * ⚠ **A system that is not routable must name the harness its credentials live
   * on**, because the absent arm of that field draws a *system* key box — and a
   * system credential is only ever spent in `providers/set` headers. On a row with
   * no `baseUrl` it would be stored and never read: a control that accepts a
   * secret and does nothing with it, which is worse than no control.
   *
   * Driven over the whole table rather than at the row that was wrong, because
   * the next row added is the one that will get it wrong.
   */
  check(
    "no system offers a key box it could never spend",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].baseUrl === null && SYSTEMS[id].loginVia === null),
    [],
  );
  check(
    "and no natively-reached system claims one it cannot honour",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].nativeModelPrefix !== null && SYSTEMS[id].nativeHarness === null),
    [],
  );
  /*
   * ⚠ **Which of a harness's variables belongs to *this* system, and it is only
   * ever set where the harness reads more than one.** opencode takes a key for
   * OpenRouter and a key for OpenCode Zen, so the settings screen for a system —
   * which mounts that harness's card under the system's own name — drew **both**
   * boxes under whichever heading you opened, one of them for an account that has
   * nothing to do with the page. Every other harness reads exactly one variable,
   * where `null` is the honest answer rather than a value: there is nothing to
   * narrow, and a value there would be a second place for the same fact.
   */
  check(
    "which systems name a key of their own",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].keyEnv !== null).map((id) => `${id}: ${SYSTEMS[id].keyEnv ?? ""}`),
    ["openrouter: OPENROUTER_API_KEY", "zen: OPENCODE_API_KEY"],
  );
  /*
   * ⚠ **And every one it names is a variable that harness actually reads.** A
   * name matching nothing narrows the card to an empty list, and the client falls
   * back to drawing them all — so the symptom of a typo here is the bug this
   * field was added to fix, silently restored.
   */
  check(
    "and each one is a variable its own harness reads",
    SYSTEM_IDS.filter((id) => {
      const named = SYSTEMS[id].keyEnv;
      if (named === null) return false;
      const harness = SYSTEMS[id].nativeHarness;
      // `isBuiltinAgentId` first: every row in this table names one, and the
      // narrowing is what says so rather than assuming it.
      if (harness === null || !isBuiltinAgentId(harness)) return true;
      return !credentialEnvNames(harness).includes(named);
    }),
    [],
  );
  /*
   * ⚠ **And that name is what lets one key answer for two boxes.** Both secrets
   * are the same string from the same account spent at the same host — the system
   * row travels in `providers/set` headers, the agent row is merged into the
   * native harness's environment — so a machine with one and not the other refused
   * a start over a key it plainly had. `systemSecretFor` is the single answer to
   * "is there a key for this system", read by `applySystem` **and** by
   * `GET /systems`'s `keySet`: two readers of that question is how the picker came
   * to offer a pairing the start then refused.
   */
  const held = (agent: string, envName: string, secret: string) => (a: AgentId) =>
    a === agent ? { [envName]: secret } : {};
  check(
    "a stored system key wins, and its harness's key answers when there is none",
    [
      systemSecretFor("openrouter", "stored", held("opencode", "OPENROUTER_API_KEY", "borrowed")),
      systemSecretFor("openrouter", null, held("opencode", "OPENROUTER_API_KEY", "borrowed")),
      systemSecretFor("openrouter", null, () => ({})),
    ],
    ["stored", "borrowed", null],
  );
  /*
   * ⚠ **And Moonshot may never borrow, which is the whole reason this is gated on
   * `keyEnv` rather than on "the native harness has a key".** `KIMI_API_KEY` is a
   * Kimi Code *subscription* at `api.kimi.com/coding`; `system_credentials.moonshot`
   * is a pay-as-you-go key at `api.moonshot.ai`. Different product, different host,
   * different billing — Q3.488 — so lending one to the other sends the wrong secret
   * to the wrong endpoint and answers 401 with nothing on screen to explain it.
   *
   * Swept over the whole table rather than asserted at that row, because the next
   * system added is the one that will get it wrong.
   */
  check(
    "no system with a key of its own borrows one it was never offered",
    SYSTEM_IDS.filter(
      (id) =>
        SYSTEMS[id].keyEnv === null &&
        SYSTEMS[id].nativeHarness !== null &&
        systemSecretFor(id, null, () => ({ KIMI_API_KEY: "x", ANTHROPIC_API_KEY: "x", CODEX_API_KEY: "x" })) !== null,
    ),
    [],
  );

  /*
   * ⚠ **What a refusal *says*, which this driver pinned nowhere.** Everything
   * above reduces a cell to "yes"/"no", which is the right shape for the rule and
   * blind to the sentence — and the sentence is the whole of what a person gets:
   * `applySystem` throws it as a `SystemRoutingError`, the route answers `502
   * system_not_routable` carrying it, and `errorText` puts it on a phone. The
   * string this module records as having shipped for one release — "This agent
   * accepts openai systems, and Moonshot is anthropic" — passes every assertion
   * above, and passes `webcheck` too, because that driver imports the *client's*
   * mirror in `packages/web/src/agents.ts` and never this function. Restoring it
   * was a green build.
   *
   * ⚠ **Four templates, and the partition is what makes them four.** Pinning the
   * literals alone pins the strings that exist today; the sweep below collects
   * every sentence the whole matrix can produce — over both routing answers and
   * with `ROUTED_MODEL_ENV` emptied, which is the only way to the fourth — puts
   * each system's own display name back out, and asserts the set is exactly
   * these four. Splitting one arm into two, which is precisely the change that
   * added the vocabulary `webcheck` had to grow a rule for, fails here.
   */
  const templateOf = (why: string): string => {
    // `split`/`join` rather than a regex: "Z.ai (GLM)" is a display name with
    // three regex metacharacters in it, and escaping it would be a second thing
    // to get wrong about a table this function is supposed to be reading.
    let shape = why;
    for (const system of SYSTEM_IDS) shape = shape.split(SYSTEMS[system].displayName).join("{system}");
    return shape;
  };

  check(
    "a system with no routed endpoint names the CLI that reaches it",
    hostable("codex", "anthropic", routings.codex),
    "Anthropic can only be reached by the CLI it ships with.",
  );
  check(
    "a harness that answers nothing about routing says what it does instead",
    hostable("kimi", "zhipu", routings.kimi),
    "This agent only runs its own models.",
  );
  check(
    "a protocol mismatch says which models, never which protocol",
    hostable("codex", "moonshot", routings.codex),
    "This agent cannot run Moonshot models.",
  );
  // The fourth is unreachable while the table has claude's arm, exactly as the
  // yes/no assertion above is — same door, and it is put back immediately.
  delete ROUTED_MODEL_ENV.claude;
  check(
    "and one that can be routed but not pinned names the thing that is wrong",
    hostable("claude", "moonshot", routings.claude),
    "This agent cannot be told which model to use on another system.",
  );
  ROUTED_MODEL_ENV.claude = claudeEnv;

  /** Every (harness, system) a refusal can be drawn for, on both routing answers. */
  const drawn: { system: BuiltinSystemId; why: string }[] = [];
  for (const pinnable of [true, false]) {
    if (!pinnable) delete ROUTED_MODEL_ENV.claude;
    for (const harness of harnesses) {
      for (const system of SYSTEM_IDS) {
        // Both the answer the adapter gave and `null`, because a harness that
        // declares no provider capability at all is a third of this fleet and
        // reaches a branch the measured answers cannot.
        for (const routing of [routings[harness], null]) {
          const why = hostable(harness, system, routing);
          if (why !== null) drawn.push({ system, why });
        }
      }
    }
    ROUTED_MODEL_ENV.claude = claudeEnv;
  }
  check(
    "every sentence this function can produce is one of four",
    [...new Set(drawn.map((one) => templateOf(one.why)))].sort(),
    [
      "This agent cannot be told which model to use on another system.",
      "This agent cannot run {system} models.",
      "This agent only runs its own models.",
      "{system} can only be reached by the CLI it ships with.",
    ],
  );

  /*
   * ⚠ **`webcheck` has a `noJargon` of its own and this is deliberately not it.**
   * The two drivers are separate processes over separate packages and neither can
   * import the other, so sharing would mean a third module written for two
   * callers — and the honest reason not to build one is that the *rule* differs,
   * not just the file. `webcheck`'s forbids the words `anthropic` and `openai`
   * outright, which this side cannot: they are the `displayName` of two systems
   * here, and "Anthropic can only be reached by the CLI it ships with." is a
   * correct sentence naming a company somebody has heard of. And this side has
   * one rule the client's cannot state — a refusal may not name a **harness**,
   * because the daemon has no display name for one and its id is a wire word;
   * the client's mirror puts "Codex" or "Kimi Code" in front of the same
   * sentence, which is the whole reason `hostable`'s own comment says the
   * harness's name "is a name this side does not have".
   *
   * So the shared property is stated as a *relation* instead of a word list: a
   * refusal about one system may name that system and no other. That is
   * case-insensitive, catches the recorded failure by construction — it named
   * Moonshot **and** anthropic **and** openai — and does not have to guess which
   * spelling of a protocol name somebody will reach for next.
   *
   * This repository's view that a copy is a second chance to be wrong is about
   * tables that must agree, `hostable`'s matrix being the one right here. Two
   * predicates that are *supposed* to differ are not that; a shared one would
   * have to be widened until it permitted both, which is weaker than either.
   */
  const jargonIn = (why: string, about: BuiltinSystemId): string[] => {
    const found: string[] = [];
    if (!why.endsWith(".")) found.push("no full stop");
    if (/\bapiType\b|\bprovider(Id)?\b|\bsupported\b|\bnativeHarness\b|\bbaseUrl\b|\//i.test(why)) {
      found.push("wire vocabulary");
    }
    const lower = why.toLowerCase();
    for (const other of SYSTEM_IDS) {
      if (other === about) continue;
      if (lower.includes(other) || lower.includes(SYSTEMS[other].displayName.toLowerCase())) {
        found.push(`names ${other}`);
      }
    }
    /*
     * The harness half. Nothing this function returns names one, and the
     * assertion is what keeps the client's copy the only place that does.
     *
     * ⚠ **Scanned with the subject's own display name taken out first**, because
     * one vendor named its gateway after its CLI: `SYSTEMS.zen` is "OpenCode Zen"
     * and every refusal about it necessarily contains "opencode". That is the
     * provider's name, which a refusal is entitled to say — the rule is that a
     * sentence must not reach for a *harness* to explain a *system*, and a name
     * the vendor chose is not that. Removing only the subject keeps the rule
     * whole: a sentence about Moonshot that said "opencode" still fails.
     */
    const scanned = lower.split(SYSTEMS[about].displayName.toLowerCase()).join(" ");
    for (const harness of harnesses) if (scanned.includes(harness)) found.push(`names ${harness}`);
    return found;
  };
  check(
    "and none of them is written for a developer",
    drawn.flatMap(({ system, why }) => jargonIn(why, system).map((reason) => `${why} — ${reason}`)),
    [],
  );
  /*
   * The predicate against the sentence that actually shipped, because every arm
   * of the sweep above is green today and a predicate that tested nothing would
   * read exactly the same. This is the string `hostable`'s own comment records.
   */
  check(
    "while the sentence that really shipped is caught, and by what",
    jargonIn("This agent accepts openai systems, and Moonshot is anthropic", "moonshot"),
    ["no full stop", "names anthropic", "names openai"],
  );
  /*
   * ⚠ **The sixth id shares a four-character prefix with the second, and the test
   * above is a plain `includes` rather than a word boundary.** So "OpenRouter can
   * only be reached by the CLI it ships with." is one letter from being reported
   * as naming OpenAI, and the OpenAI sentence is one letter from naming
   * OpenRouter. Both directions, because a containment bug is directional and
   * asserting one of them would leave the other.
   *
   * The display name is also a hair from `\bprovider(Id)?\b` — it is not the
   * word, and it carries no slash, but neither fact is obvious enough to leave to
   * a reader.
   */
  /*
   * ⚠ **The carve-out is narrow, and this is what holds it there.** Taking the
   * subject's name out must not become "harness names are allowed": a refusal
   * about Moonshot that reached for a harness is still the failure the rule was
   * written for, and a refusal about OpenCode Zen that named a *different*
   * harness is too.
   */
  check(
    "a harness name is still caught wherever it is not the provider's own",
    [
      jargonIn("Only opencode can run Moonshot models.", "moonshot"),
      jargonIn("OpenCode Zen cannot be run by claude.", "zen"),
      jargonIn("OpenCode Zen can only be reached by the CLI it ships with.", "zen"),
    ],
    [["names opencode"], ["names claude"], []],
  );
  check(
    "and the two ids that share a prefix are not read as naming each other",
    [
      jargonIn("OpenRouter can only be reached by the CLI it ships with.", "openrouter"),
      jargonIn("OpenAI can only be reached by the CLI it ships with.", "openai"),
      jargonIn("This agent cannot run OpenRouter models.", "openrouter"),
    ],
    [[], [], []],
  );

  /*
   * ⚠ **A *built-in* test now, and the change of name is the change of meaning.**
   * `isSystemId` asked "is this in the tuple" and was the HTTP boundary's guard;
   * the boundary now asks a machine's catalogue, because which systems exist is a
   * fact about which plugins are installed. What is left here is the narrower
   * question this predicate can still answer honestly, and the negative case is
   * chosen to say so: `gemini` is not refused because nobody could ever contribute
   * it — a plugin can — but because it is not one of the seven this repository
   * ships. A contributed id could never collide with one, since it carries a
   * colon and none of these does.
   */
  check("an id this repository ships", isBuiltinSystemId("moonshot"), true);
  check("and one it does not", isBuiltinSystemId("gemini"), false);
  check("and a contributed id is never mistaken for one", isBuiltinSystemId("acme:moonshot"), false);
}
