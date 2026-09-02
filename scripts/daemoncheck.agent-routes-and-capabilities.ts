import { join } from "node:path";
import { AGENT_IDS } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { openStores } from "../src/store/sqlite.js";
import { check, report } from "./daemoncheck.env.js";
import { sandbox, users, now, tokenWith, tokenFor, verifier } from "./daemoncheck.fixtures.js";

process.stdout.write("\nthe system and assembled-agent routes\n");
{
  const { createApp: build } = await import("../src/server.js");
  // The other half of the pairing sweep below. `AGENT_IDS` is already imported at
  // the top of this file; this one is not, and reaching for it here keeps the
  // matrix driven off the table rather than off a list typed out beside it.
  const { SYSTEM_IDS } = await import("../src/acp/systems.js");

  const keys = new Map<string, { secret: string; updatedAt: number }>();
  const presets = new Map<string, any>();
  const stripRows: any[] = [];
  const systems = {
    credentials: {
      list: () => [...keys].map(([system, held]) => ({ system: system as never, updatedAt: held.updatedAt })),
      get: (system: string) => keys.get(system)?.secret ?? null,
      save: (system: string, secret: string) => void keys.set(system, { secret, updatedAt: 7 }),
      remove: (system: string) => void keys.delete(system),
    },
    customAgents: {
      list: () => [...presets.values()],
      get: (id: string) => presets.get(id) ?? null,
      save: (one: any) => void presets.set(one.id, one),
      remove: (id: string) => void presets.delete(id),
    },
    /*
     * ⚠ **An array and not a `Map`, unlike the two ports above it, because order
     * is the whole subject.** A `Map` would keep insertion order and would
     * therefore pass a round trip that a replace-in-place implementation fails —
     * which is the same class of blindness `SqliteCustomAgentStore`'s upsert
     * records from the other side: this section stands a `Map` in for that port,
     * and `Map.set` is an upsert by construction, so only the real store could
     * show the bug. Here the stand-in is the thing being ordered, so it holds an
     * array and `replace` is a replace.
     */
    strip: {
      list: () => [...stripRows],
      replace: (entries: readonly any[]) => void stripRows.splice(0, stripRows.length, ...entries),
      forget: (kind: string, ref: string) => {
        const at = stripRows.findIndex((one) => one.kind === kind && one.ref === ref);
        if (at !== -1) stripRows.splice(at, 1);
      },
    },
  };

  /*
   * ⚠ **A stub, which is the whole reason `ServerOptions.asks` is a port rather
   * than `AgentAskRuns`.** The real one spawns an agent per harness; standing in
   * for it here is what makes the compatibility refusal reachable on a machine
   * with no agent installed and nobody signed in.
   */
  const asks = {
    capabilities: async (agent: string) => ({
      models: agent === "claude" ? [{ id: "opus", name: "Opus", description: null, group: null }] : [],
      routing:
        agent === "claude"
          ? { providerId: "main", supported: ["anthropic"] }
          : agent === "codex"
            ? { providerId: "custom-gateway", supported: ["openai"] }
            : null,
    }),
  };

  const withSystems = build({
    registry: new SessionRegistry(new MemoryEventStore()),
    verifier,
    instanceId: "i_systems",
    startedAt: now,
    systems: systems as never,
    asks: asks as never,
    roots: [users],
  }).app;

  // The same server without the stores, because "answers 503 rather than
  // pretending" is a property of every one of these routes and is exactly what a
  // daemon built with no database has.
  const without = build({
    registry: new SessionRegistry(new MemoryEventStore()),
    verifier,
    instanceId: "i_nosystems",
    startedAt: now,
    roots: [users],
  }).app;

  const call = async (
    which: typeof withSystems,
    method: string,
    path: string,
    body?: unknown,
    // Defaulted rather than passed everywhere: the scope gate is one assertion
    // out of many here and the rest are about the routes, not about who is asking.
    token: string = tokenFor("u_alice"),
  ): Promise<{ status: number; body: any }> => {
    const response = await which.fetch(
      new Request(`http://d${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  };

  /*
   * Status and code as one pair, with `null` where the answer carried no error.
   * Reading `body.error.code` straight would throw out of the driver the moment a
   * refusal became an acceptance — which is exactly the regression these
   * assertions exist to report, and a thrown `TypeError` takes every section
   * after it down instead of naming the one that moved.
   */
  const answered = (one: { status: number; body: any }): [number, string | null] => [
    one.status,
    one.body?.error?.code ?? null,
  ];

  const listed = await call(withSystems, "GET", "/systems");
  check("every system is listed", listed.body.systems.length, 7);
  /*
   * ⚠ **The secret sweep is *below*, on the listing taken after a key is saved,
   * and it stood here for a release where it could not fail.** Nothing has been
   * saved at this point — the assertion one line down is that very fact — so
   * `JSON.stringify(listed.body).includes("sekrit")` was false over a daemon
   * holding no secret at all, and would have stayed false against a route that
   * returned every stored key verbatim. The same shape `routedModelEnv`'s sweep
   * had one section up: a search for a value the subject could not have held.
   */
  check("nothing has a key yet", listed.body.systems.every((one: any) => one.keySet === false), true);

  check(
    "an unknown system is refused by name",
    (await call(withSystems, "PUT", "/systems/gemini", { token: "x" })).body.error.code,
    "invalid_system",
  );
  check(
    "an empty token is refused",
    (await call(withSystems, "PUT", "/systems/moonshot", { token: "   " })).status,
    400,
  );
  check(
    "and one past the ceiling",
    (await call(withSystems, "PUT", "/systems/moonshot", { token: "x".repeat(9000) })).status,
    400,
  );
  check("saving one works", (await call(withSystems, "PUT", "/systems/moonshot", { token: "sekrit" })).status, 200);
  check("and the daemon can read it back", systems.credentials.get("moonshot"), "sekrit");
  /*
   * Both halves off **one** listing, taken with the key genuinely in the store —
   * which is what makes the second half an assertion rather than a sentence. The
   * line above is the precondition it needs: a sweep for a string nothing holds
   * is the no-op this block used to open with.
   */
  const afterSave = await call(withSystems, "GET", "/systems");
  check(
    "the listing says so",
    afterSave.body.systems.find((one: any) => one.id === "moonshot").keySet,
    true,
  );
  check(
    "and still shows no secret, over a daemon that is now holding one",
    JSON.stringify(afterSave.body).includes("sekrit"),
    false,
  );

  /*
   * ⚠ **Rotating a key, which nothing drove.** `SqliteSystemCredentialStore.save`
   * is an upsert, and against a bare `INSERT` this second `PUT` would be a `500`
   * out of `SQLITE_CONSTRAINT_PRIMARYKEY` — which is exactly the defect the
   * *preset* store shipped with and this section's `Map` stand-in cannot see,
   * because a `Map` upserts by construction. Replacing a vendor key is the
   * ordinary act, not an edge.
   */
  check("rotating one works", (await call(withSystems, "PUT", "/systems/moonshot", { token: "sekrit2" })).status, 200);
  check("and the new secret is what is stored", systems.credentials.get("moonshot"), "sekrit2");
  check("with one row still, not two", systems.credentials.list().length, 1);

  /*
   * ⚠ **Assembling is refused for a pairing that cannot run, on the route and
   * not only in the picker.** A saved preset that cannot start is a row whose
   * only button answers 502 for ever, days after anybody could connect the two.
   */
  const bad = await call(withSystems, "POST", "/custom-agents", {
    name: "nope",
    harness: "codex",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check("an impossible pairing is refused", bad.status, 400);
  check("and says which two", bad.body?.error?.code ?? null, "incompatible_pairing");
  check("and nothing was written", presets.size, 0);

  const good = await call(withSystems, "POST", "/custom-agents", {
    name: "Claude Code · K2",
    harness: "claude",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check("a real one is created", good.status, 201);
  check("with an id of ours", /^ca_[0-9a-f]{8}$/.test(good.body.customAgent.id), true);
  check("and it is listed", (await call(withSystems, "GET", "/custom-agents")).body.customAgents.length, 1);

  check(
    "a nameless one is refused",
    (await call(withSystems, "POST", "/custom-agents", { harness: "claude", system: "moonshot", model: "m" })).status,
    400,
  );
  check(
    "so is an unknown harness",
    (await call(withSystems, "POST", "/custom-agents", { name: "n", harness: "gemini", system: "moonshot", model: "m" })).body?.error?.code ?? null,
    "invalid_agent",
  );

  /* ---------------------------------------------------------------- *
   * Clearing a key, which was driven only as a refusal
   *
   * ⚠ **Both halves, and the second is the one with teeth.** That the key goes is
   * obvious; that presets naming the system are *left alone* is a decision the
   * route's own comment makes and nothing asserted — so a change that swept them
   * on key removal would have destroyed somebody's named agents with every driver
   * green. This runs before the edit section below, which needs that preset.
   * ---------------------------------------------------------------- */
  {
    const cleared = await call(withSystems, "DELETE", "/systems/moonshot");
    check("clearing a key answers removed", answered(cleared), [200, null]);
    check("and says which", [cleared.body.removed, cleared.body.system], [true, "moonshot"]);
    check("the daemon cannot read it any more", systems.credentials.get("moonshot"), null);
    const after = await call(withSystems, "GET", "/systems");
    const row = after.body.systems.find((one: any) => one.id === "moonshot");
    check("and the listing agrees", [row.keySet, row.keyUpdatedAt], [false, null]);
    check(
      "the preset naming that system is untouched",
      (await call(withSystems, "GET", "/custom-agents")).body.customAgents.length,
      1,
    );
    /*
     * ⚠ **An id this build does not know is `200 {removed:false}`, not `400`.**
     * `SqliteSystemCredentialStore.list` drops a row naming a system this version
     * cannot resolve, so a `400` before the `remove` — which is what this route
     * did — made a key written by a newer daemon undeletable after a downgrade:
     * unlistable, unreadable and unremovable, in plaintext. Same argument and
     * same shape as `DELETE /custom-agents/:id`.
     */
    const unknown = await call(withSystems, "DELETE", "/systems/gemini");
    check("an id this build does not know is not refused", unknown.status, 200);
    check("and says it removed nothing", unknown.body.removed, false);
    // Put it back for the sections below, which assume a key is there.
    check("and the key can be saved again", (await call(withSystems, "PUT", "/systems/moonshot", { token: "sekrit" })).status, 200);
  }

  /* ---------------------------------------------------------------- *
   * Editing one, which is `PATCH /custom-agents/:id`
   *
   * ⚠ **Every refusal below is asserted in two halves: the answer, and that the
   * stored row is byte-identical afterwards.** A route that refuses and writes
   * anyway answers exactly like one that refuses and does not, and the difference
   * only shows up days later as a preset whose only button returns 502. That is
   * the whole reason `POST`'s own refusal above carries `presets.size` beside it,
   * and an edit needs it more than a create does: a create that half-lands leaves
   * a row nobody had yet, while an edit that half-lands destroys one that worked.
   *
   * ⚠ **And the create and the edit are one predicate.** `readAssembledAgent` is
   * a single function for exactly that reason, so the assertions here are written
   * to fail the day somebody copies the checks back into either handler — the
   * pairing message is compared to `POST`'s own string rather than to a literal,
   * and the whole table of malformed bodies is driven through both routes and
   * compared to each other.
   * ---------------------------------------------------------------- */

  const preset = good.body.customAgent.id;
  const born = good.body.customAgent.createdAt;
  /*
   * The whole store as bytes, which is what "nothing changed" means here.
   *
   * The listing rather than the one row on purpose: a refusal that wrote a
   * *second* row leaves the row it was sent at untouched, so a snapshot of that
   * row alone would call it clean.
   */
  /*
   * ⚠ **Both stores, because a refusal that wrote to *either* is a refusal that
   * wrote.** It held the presets alone while the strip was the only other thing a
   * verb in this section can touch, so a scope gate that leaked on
   * `PUT /agent-strip` would have reordered somebody's screen with every
   * assertion here green.
   */
  const frozen = (): string => JSON.stringify([[...presets.values()], stripRows]);

  const edited = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    name: "Claude Code · Opus",
    harness: "claude",
    system: "anthropic",
    model: "opus",
  });
  check("an assembled agent can be edited", edited.status, 200);
  check(
    "and all four fields it named moved",
    [
      edited.body.customAgent.name,
      edited.body.customAgent.harness,
      edited.body.customAgent.system,
      edited.body.customAgent.model,
    ],
    ["Claude Code · Opus", "claude", "anthropic", "opus"],
  );
  /*
   * ⚠ **`id` and `createdAt` are the daemon's, and an edit is the only place they
   * could be lost.** `sessions.custom_agent` holds a *reference* rather than a
   * copy and `ManagedSession.assembled` resolves it at every launch, so an edit
   * that minted a new id would silently drop every session on the old one to its
   * bare harness while a row that looks identical sat beside it — which is the
   * outcome this route exists to prevent, reintroduced by the route itself.
   */
  check("while the id it was reached by is unchanged", edited.body.customAgent.id, preset);
  check("and so is the moment it was created", edited.body.customAgent.createdAt, born);
  check("the store holds exactly the row that was answered", presets.get(preset), edited.body.customAgent);
  check("an edit replaces rather than adds", presets.size, 1);
  check(
    "and the listing carries it at once",
    (await call(withSystems, "GET", "/custom-agents")).body.customAgents,
    [edited.body.customAgent],
  );

  /*
   * ⚠ **A body naming `id` or `createdAt` is answered, not refused — and it is
   * answered with the daemon's values.** There is no field to refuse: the
   * validator returns four fields and the route reads the other two off the
   * stored row, so an extra key is one nothing looks at. Driven because the shape
   * somebody reaches for instead — taking them off the body "when present" —
   * fails with a 200 and a second row rather than with an error, and both halves
   * of that are invisible to a status-code assertion.
   */
  const hijack = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    id: "ca_hijack",
    createdAt: 0,
    name: "still mine",
    harness: "claude",
    system: "anthropic",
    model: "opus",
  });
  check("a client naming the id is answered rather than refused", hijack.status, 200);
  check("with the id the row already had", hijack.body.customAgent.id, preset);
  check("and the age the row already had", hijack.body.customAgent.createdAt, born);
  check("nothing was created under the id it asked for", presets.has("ca_hijack"), false);
  check("and there is still exactly one row", presets.size, 1);

  check(
    "editing one that is not there is a 404",
    answered(await call(withSystems, "PATCH", "/custom-agents/ca_nope", {
      name: "n",
      harness: "claude",
      system: "anthropic",
      model: "opus",
    })),
    /*
     * ⚠ **Its own code, not the bare `not_found` this asserted for a release.**
     * `POST /sessions` answers `400 not_found` for a `cwd` that does not exist —
     * a `PathError` — so a client branching on the code alone, which `docs/API.md`
     * says is the only thing it may branch on, could not tell "pick a different
     * folder" from "that preset is gone".
     */
    [404, "custom_agent_not_found"],
  );
  /*
   * ⚠ **The 404 is decided before the body is.** Somebody holding a listing a
   * second out of date should be told the agent is gone rather than complained at
   * about a field, and the two answers are indistinguishable from where they are
   * standing. Only a request that is wrong in *both* ways can see which check ran
   * first, so that is what this sends.
   */
  const goneFirst = await call(withSystems, "PATCH", "/custom-agents/ca_nope", {});
  check("and an unknown id outranks a body that is also wrong", answered(goneFirst), [404, "custom_agent_not_found"]);

  /** One refusal, both halves: what was answered, and that the row did not move. */
  const refuses = async (what: string, body: unknown, want: [number, string]): Promise<void> => {
    const before = frozen();
    const answer = await call(withSystems, "PATCH", `/custom-agents/${preset}`, body);
    check(`editing: ${what}`, answered(answer), want);
    check(`editing: ${what} — and the row is where it was`, frozen(), before);
  };

  await refuses("an unknown harness", { name: "n", harness: "gemini", system: "moonshot", model: "m" }, [400, "invalid_agent"]);
  await refuses("an unknown system", { name: "n", harness: "claude", system: "gemini", model: "m" }, [400, "invalid_system"]);
  await refuses("no name at all", { harness: "claude", system: "anthropic", model: "opus" }, [400, "bad_request"]);
  await refuses("a name of nothing but space", { name: "   ", harness: "claude", system: "anthropic", model: "opus" }, [400, "bad_request"]);
  await refuses("a name one character past the bound", { name: "x".repeat(81), harness: "claude", system: "anthropic", model: "opus" }, [400, "bad_request"]);
  await refuses("no model at all", { name: "n", harness: "claude", system: "anthropic" }, [400, "bad_request"]);
  await refuses("a model of nothing but space", { name: "n", harness: "claude", system: "anthropic", model: " \t " }, [400, "bad_request"]);
  await refuses("a model id one character past the bound", { name: "n", harness: "claude", system: "anthropic", model: "x".repeat(257) }, [400, "bad_request"]);
  await refuses("a body that is a list", [], [400, "invalid_agent"]);
  await refuses("a body that is a bare number", 7, [400, "invalid_agent"]);

  /*
   * ⚠ **An edit is a replace, and a partial body is refused by the field it left
   * out.** This is the failure mode with no symptom. If a subset body were
   * accepted, `hostable` would have to be weighed against the *merge* of body and
   * stored row — and a handler that weighs it against the body alone takes
   * `{ "system": "moonshot" }` at a codex preset, refuses that pairing at creation
   * and saves it at edit, with a 200 and no complaint anywhere. Requiring all four
   * leaves nothing to merge and so nothing to get wrong; these two are what say so
   * out loud, since a route that quietly started merging would break no other
   * assertion in this file.
   */
  await refuses("a body naming only a new system", { system: "moonshot" }, [400, "invalid_agent"]);
  await refuses("a body naming only a new name", { name: "renamed" }, [400, "invalid_agent"]);

  // The positive control for the two bounds above: at the bound, not past it. A
  // validator that refused everything would satisfy every refusal here.
  const atBound = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    name: "n".repeat(80),
    harness: "claude",
    system: "anthropic",
    model: "m".repeat(256),
  });
  check("editing: a name and a model exactly at the bound are accepted", atBound.status, 200);

  /*
   * ⚠ **The pairing is re-weighed on every edit, and it is refused in the words a
   * create refuses it in.** An edit is the harder half of the two: a create that
   * is refused leaves nobody worse off, while an edit can take a row that started
   * fine yesterday and leave it unstartable. The message is compared to `POST`'s
   * own answer rather than to a literal, which is what pins the two routes to one
   * validator — a literal would keep passing while they drifted, as long as
   * somebody remembered to change it here too.
   */
  const editPairing = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    name: "nope",
    harness: "codex",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check("editing: an impossible pairing is refused", answered(editPairing), [400, "incompatible_pairing"]);
  check("editing: and says which two", editPairing.body?.error?.detail ?? null, { harness: "codex", system: "moonshot" });
  // Two halves, because the comparison alone is vacuous: two routes that had both
  // stopped refusing would agree perfectly about `null`.
  const pairingWords = editPairing.body?.error?.message ?? null;
  check(
    "editing: in the very words a create refuses it in",
    [typeof pairingWords === "string" && pairingWords.length > 0, pairingWords === (bad.body?.error?.message ?? null)],
    [true, true],
  );
  check(
    "editing: and the row that was startable still is",
    [presets.get(preset).harness, presets.get(preset).system],
    ["claude", "anthropic"],
  );

  /*
   * ⚠ **The gate is swept over the whole harness × system matrix rather than at
   * the cell that matters today.** `hostable` is the only place the matrix exists,
   * on each side, and a rule asserted at its interesting points is a rule the next
   * entry in `SYSTEMS` escapes silently — which is the discipline the section
   * above already applies to the function. It is applied here to the *route*
   * because these are two copies of one rule and only this one is reachable from
   * the internet, and because a gate can be right about the answer and wrong about
   * the write: each cell records what happened to the store, so an accepted
   * pairing must have landed and a refused one must not have.
   *
   * ⚠ **The sweep also says the pair is weighed as a pair.** Each cell is sent at
   * whatever the previous cell left in the store, so `codex x openai` arrives at a
   * row holding `kimi`/`moonshot` — and a route that weighed the body's harness
   * against the stored system, or the stored harness against the body's system,
   * refuses it. That is the merge this route is written to make impossible, and
   * the twenty-eight cells are where it would show.
   */
  const editMatrix: string[] = [];
  for (const harness of AGENT_IDS) {
    for (const system of SYSTEM_IDS) {
      const before = frozen();
      const answer = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
        name: `${harness} on ${system}`,
        harness,
        system,
        model: "m",
      });
      const held = presets.get(preset);
      const landed = held.harness === harness && held.system === system;
      editMatrix.push(
        answer.status === 200
          ? `${harness} x ${system}: saved${landed ? "" : " BUT NOT STORED"}`
          : `${harness} x ${system}: ${answer.body?.error?.code ?? answer.status}${frozen() === before ? "" : " BUT STORED"}`,
      );
    }
  }
  check("editing: the route's matrix is the adapters' matrix", editMatrix, [
    "claude x anthropic: saved",
    "claude x openai: incompatible_pairing",
    "claude x openrouter: saved",
    "claude x moonshot: saved",
    "claude x zhipu: saved",
    "claude x minimax: saved",
    "claude x zen: incompatible_pairing",
    "kimi x anthropic: incompatible_pairing",
    "kimi x openai: incompatible_pairing",
    "kimi x openrouter: incompatible_pairing",
    "kimi x moonshot: saved",
    "kimi x zhipu: incompatible_pairing",
    "kimi x minimax: incompatible_pairing",
    "kimi x zen: incompatible_pairing",
    "codex x anthropic: incompatible_pairing",
    "codex x openai: saved",
    "codex x openrouter: incompatible_pairing",
    "codex x moonshot: incompatible_pairing",
    "codex x zhipu: incompatible_pairing",
    "codex x minimax: incompatible_pairing",
    "codex x zen: incompatible_pairing",
    "opencode x anthropic: incompatible_pairing",
    "opencode x openai: incompatible_pairing",
    // The route's own copy of the native cell below, and the reason this sweep
    // exists beside the pure one: `readAssembledAgent` reaches for
    // `asks.capabilities` before it weighs the pairing, and opencode's honest
    // answer there is `routing: null` — which the native arm never consults.
    "opencode x openrouter: saved",
    "opencode x moonshot: incompatible_pairing",
    "opencode x zhipu: incompatible_pairing",
    "opencode x minimax: incompatible_pairing",
    "opencode x zen: saved",
  ]);

  // Twenty-eight edits later, with nine of them landing, the two fields the wire never
  // named are still the ones the row was born with.
  const restored = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    name: "Claude Code · K2",
    harness: "claude",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check(
    "editing: the id and the age came through all twenty-eight",
    [restored.body.customAgent.id, restored.body.customAgent.createdAt],
    [preset, born],
  );
  check("and there is still one row to show for it", presets.size, 1);

  /*
   * ⚠ **Editing is `write`, like creating and removing.** The one edit a
   * read-only token must not be able to make is re-pointing somebody's preset at
   * another system, which changes where their key is sent — so this is the
   * destructive half of the two paths that decide the same predicate, and it
   * carries the stronger authority rather than the weaker one.
   */
  const beforeScope = frozen();
  const readOnly = await call(
    withSystems,
    "PATCH",
    `/custom-agents/${preset}`,
    { name: "n", harness: "claude", system: "anthropic", model: "opus" },
    tokenWith("u_reader", ["session:read"]),
  );
  check("a read-only token may not edit an assembled agent", answered(readOnly), [403, "insufficient_scope"]);
  check("and nothing moved", frozen(), beforeScope);

  /*
   * ⚠ **The create and the edit may not disagree about a body.** They are one
   * function today, and this is the assertion that fails the day somebody copies
   * the checks back into either handler. Compared as pairs rather than against a
   * table of literals, so it stays true through a change to any of the codes and
   * false the moment the two paths answer differently — including in the
   * direction that matters, where the edit accepts what the create refuses.
   */
  const bodies: [string, unknown][] = [
    ["nothing at all", {}],
    ["a list", []],
    ["a bare number", 7],
    ["an unknown harness", { name: "n", harness: "gemini", system: "moonshot", model: "m" }],
    ["an unknown system", { name: "n", harness: "claude", system: "gemini", model: "m" }],
    ["no name", { harness: "claude", system: "moonshot", model: "m" }],
    ["a blank name", { name: "  ", harness: "claude", system: "moonshot", model: "m" }],
    ["a name past the bound", { name: "x".repeat(81), harness: "claude", system: "moonshot", model: "m" }],
    ["no model", { name: "n", harness: "claude", system: "moonshot" }],
    ["a blank model", { name: "n", harness: "claude", system: "moonshot", model: "  " }],
    ["a model past the bound", { name: "n", harness: "claude", system: "moonshot", model: "x".repeat(257) }],
    ["a pairing that cannot run", { name: "n", harness: "codex", system: "moonshot", model: "m" }],
    ["only a name", { name: "renamed" }],
  ];
  const disagreed: string[] = [];
  const swallowed: string[] = [];
  for (const [what, body] of bodies) {
    const created = await call(withSystems, "POST", "/custom-agents", body);
    const patched = await call(withSystems, "PATCH", `/custom-agents/${preset}`, body);
    if (created.status < 300 || patched.status < 300) swallowed.push(what);
    const one = answered(created).join(" ");
    const other = answered(patched).join(" ");
    if (one !== other) disagreed.push(`${what}: POST ${one}, PATCH ${other}`);
  }
  report(
    "a create and an edit answer a malformed body identically",
    disagreed.length === 0,
    disagreed.length === 0 ? `${bodies.length} bodies` : disagreed.join(" · "),
  );
  // The positive half: every body in that table is malformed, so "identically"
  // must mean identically *refused*. Without this, two routes that both started
  // accepting one of them would agree with each other all the way down.
  check("and every one of them is a body both refuse", swallowed, []);
  check("and not one of them wrote anything", presets.size, 1);

  /*
   * ⚠ **A preset names a harness, and `POST /sessions` fills `agent` in from it
   * rather than making the caller keep the two in step.** Driven by sending a
   * body whose `agent` disagrees: what must not happen is a session on the agent
   * the body named.
   */
  const unknownPreset = await call(withSystems, "POST", "/sessions", {
    customAgent: "ca_deadbeef",
    cwd: users,
  });
  check("a preset that does not exist is a 404", unknownPreset.status, 404);
  check(
    "an empty customAgent is a bad request rather than a bare harness",
    (await call(withSystems, "POST", "/sessions", { customAgent: "", cwd: users })).status,
    400,
  );

  /*
   * ⚠ **Removing one is idempotent, and this block used to pin the opposite.**
   * It asserted `404` for an id with nothing under it, which is the answer that
   * cannot survive the transport: `DELETE` is on `isReplayable` and deliberately
   * **off** `slowRoute` — that table calls this route "a lookup plus a delete",
   * which is the 15s budget `settleTransport` names as the one an LTE drop earns
   * — so the request a dropped answer produces is the *same* delete, sent again.
   * A 404 there puts `errorText` on the builder's screen over an act that
   * succeeded. `DELETE /plugins/:pluginId` already answers this way and is
   * already pinned that way further up; this is the same convention in the same
   * daemon rather than a new one.
   *
   * The stated cost, which is the plugin route's too: a mistyped id is no longer
   * refused. That is why the discriminator is pinned beside the status — a `200`
   * on its own cannot tell a replay from a delete that found nothing, so an
   * assertion on the status alone would pin nothing at all.
   */
  const missing = await call(withSystems, "DELETE", "/custom-agents/ca_nope");
  check("removing one that is not there is a 200", missing.status, 200);
  check("and says nothing was removed", missing.body.removed, false);
  check("and echoes back the id it was asked about", missing.body.id, "ca_nope");

  /*
   * The replay itself, which is the request the defect was about: the same
   * delete twice, which is what a client that never saw the first answer sends.
   * Nothing else in this file reaches it, and before the route changed the
   * second send was a 404 over a row that really had gone.
   */
  const doomed = good.body.customAgent.id;
  const firstTry = await call(withSystems, "DELETE", `/custom-agents/${doomed}`);
  check("removing a real one works", [firstTry.status, firstTry.body.removed, firstTry.body.id], [200, true, doomed]);
  check("and the list is empty again", (await call(withSystems, "GET", "/custom-agents")).body.customAgents.length, 0);
  const replay = await call(withSystems, "DELETE", `/custom-agents/${doomed}`);
  check("sending it a second time succeeds and says so", [replay.status, replay.body.removed, replay.body.id], [200, false, doomed]);
  check("with the list still empty rather than disturbed", (await call(withSystems, "GET", "/custom-agents")).body.customAgents.length, 0);

  /* ---------------------------------------------------------------- *
   * The strip: which agents this machine's New session screen offers, ordered
   *
   * ⚠ **This daemon stores and does not resolve.** A `ref` is never weighed
   * against what exists — that is `AgentStripEntry`'s stated design, so a harness
   * signed out for a week keeps its place — which means every refusal below is
   * about the *shape* of a body and never about whether it names something real.
   * The assertions come in pairs for the editing block's reason: the answer, and
   * that the stored list is byte-identical afterwards. A route that refuses and
   * writes is the failure worth catching, and only the second half catches it.
   * ---------------------------------------------------------------- */
  {
    const strip = (): unknown => JSON.parse(JSON.stringify(stripRows));
    check("an untouched machine remembers nothing", (await call(withSystems, "GET", "/agent-strip")).body, {
      entries: [],
    });

    const order = [
      { kind: "custom", ref: "ca_deadbeef", hidden: false },
      { kind: "harness", ref: "claude", hidden: true },
      { kind: "harness", ref: "kimi", hidden: false },
    ];
    const saved = await call(withSystems, "PUT", "/agent-strip", { entries: order });
    check("a strip can be saved", [saved.status, saved.body.saved], [200, true]);
    /*
     * ⚠ **The answer is what the store now holds, read back, rather than the body
     * echoed.** They are the same today; a caller that trusts the answer instead
     * of its own copy stays right if that ever stops being true, and asserting it
     * here is what keeps the route from being turned into an echo.
     */
    check("and comes back in the order it was written", saved.body.entries, order);
    check("which is what the GET says too", (await call(withSystems, "GET", "/agent-strip")).body.entries, order);
    /*
     * ⚠ **A `ref` naming nothing on this machine is stored, and that is the design
     * rather than a gap.** `ca_deadbeef` is no preset here and `kimi` is no
     * installed harness; both keep their positions, and what drops them is the
     * merge in the browser at the moment it draws. Refusing them would forget an
     * order every time an agent was briefly unavailable.
     */
    check(
      "including refs this machine has nothing under",
      stripRows.map((one: any) => one.ref),
      ["ca_deadbeef", "claude", "kimi"],
    );

    /*
     * ⚠ **Replace, never merge**, which is the whole reason the verb is `PUT`. A
     * reorder is a statement about every position at once, so a route that folded a
     * shorter body into what was already there would leave rows nobody named — and
     * there is no caller that could say what should happen to them.
     */
    const shorter = [{ kind: "harness", ref: "kimi", hidden: false }];
    check(
      "a shorter strip replaces rather than merging",
      (await call(withSystems, "PUT", "/agent-strip", { entries: shorter })).body.entries,
      shorter,
    );
    check(
      "an empty one is a real answer and clears it",
      [(await call(withSystems, "PUT", "/agent-strip", { entries: [] })).status, stripRows.length],
      [200, 0],
    );

    // Put the order back, so the refusals below have something to fail to change.
    await call(withSystems, "PUT", "/agent-strip", { entries: order });
    const before = JSON.stringify(strip());
    const refused: string[] = [];
    for (const [why, body] of [
      ["no body at all", undefined],
      ["entries missing", {}],
      ["entries not an array", { entries: { kind: "harness", ref: "claude", hidden: false } }],
      ["an entry that is not an object", { entries: ["claude"] }],
      ["an entry that is an array", { entries: [[]] }],
      ["a kind this daemon does not have", { entries: [{ kind: "plugin", ref: "x", hidden: false }] }],
      ["a missing kind", { entries: [{ ref: "claude", hidden: false }] }],
      ["an empty ref", { entries: [{ kind: "harness", ref: "", hidden: false }] }],
      ["a ref that is not a string", { entries: [{ kind: "harness", ref: 7, hidden: false }] }],
      ["a ref past the bound", { entries: [{ kind: "harness", ref: "r".repeat(97), hidden: false }] }],
      ["hidden missing", { entries: [{ kind: "harness", ref: "claude" }] }],
      ["hidden as a string", { entries: [{ kind: "harness", ref: "claude", hidden: "yes" }] }],
      [
        "the same pair twice",
        {
          entries: [
            { kind: "harness", ref: "claude", hidden: false },
            { kind: "harness", ref: "claude", hidden: true },
          ],
        },
      ],
      [
        // One past `MAX_STRIP_ENTRIES`. The bound is a thousand rather than the two
        // hundred it started at, and the reason is written beside it: this client
        // sends the **whole** list on every action, so a bound a real fleet could
        // reach would make the screen permanently read-only rather than merely
        // refusing an absurd body.
        "more entries than the bound",
        {
          entries: Array.from({ length: 1001 }, (_, at) => ({
            kind: "harness",
            ref: `r${at}`,
            hidden: false,
          })),
        },
      ],
    ] as const) {
      const answer = await call(withSystems, "PUT", "/agent-strip", body);
      refused.push(`${why}: ${answer.status} ${String(answer.body?.error?.code ?? "")}`.trim());
    }
    check(
      "every malformed strip is refused",
      refused,
      [
        "no body at all",
        "entries missing",
        "entries not an array",
        "an entry that is not an object",
        "an entry that is an array",
        "a kind this daemon does not have",
        "a missing kind",
        "an empty ref",
        "a ref that is not a string",
        "a ref past the bound",
        "hidden missing",
        "hidden as a string",
        "the same pair twice",
        "more entries than the bound",
      ].map((why) => `${why}: 400 bad_request`),
    );
    /*
     * ⚠ **The second half, and it is the one with teeth.** `replace` empties the
     * table before it refills it, so a validator that ran per entry *inside* the
     * loop that writes would answer 400 on the eighth row of a fourteen-row body
     * with the first seven already stored and the rest gone. Reading the whole body
     * before touching the store is what makes that unreachable, and this is what
     * says so.
     */
    check("and not one of them moved anything", JSON.stringify(strip()), before);
    /*
     * ⚠ **At the bound, not merely under it.** This said `repeat(64)` against a
     * bound of 96 while the refusal above says `repeat(97)`, so the pair proved
     * only that the bound lay somewhere in [64, 96] — lowering
     * `MAX_STRIP_REF_CHARS` to 64 would have left both green while truncating
     * every `ca_…` preset id and every contributed harness id longer than that.
     * The custom-agents bounds two sections up are driven at exactly 80/81 and
     * 256/257 and say "at the bound, not past it"; this is that, applied here.
     *
     * 96 is written out rather than imported because `MAX_STRIP_REF_CHARS` is
     * module-private to `server.ts` — so the literal below and the refusal's 97
     * are a pair, and both move together or the acceptance stops sitting on the
     * bound. That is the same trade `pincheck` makes everywhere it compares a
     * written-down number against a source it cannot import.
     */
    check(
      "one at the bound is accepted, which is what makes the refusal a bound",
      (
        await call(withSystems, "PUT", "/agent-strip", {
          entries: [{ kind: "harness", ref: "r".repeat(96), hidden: true }],
        })
      ).status,
      200,
    );

    /*
     * ⚠ **Deleting an assembled agent takes its position with it.** Not
     * correctness — the merge in the browser drops a `ref` that resolves to nothing
     * either way — but the only thing standing between this table and unbounded
     * growth on a machine where presets are made and thrown away and the strip
     * screen is never opened.
     */
    const doomed = await call(withSystems, "POST", "/custom-agents", {
      name: "Doomed",
      harness: "claude",
      system: "moonshot",
      model: "kimi-k2-thinking",
    });
    check("an agent to delete", doomed.status, 201);
    const id = doomed.body.customAgent.id;
    await call(withSystems, "PUT", "/agent-strip", {
      entries: [
        { kind: "custom", ref: id, hidden: false },
        { kind: "harness", ref: "claude", hidden: false },
      ],
    });
    check(
      "deleting it answers removed",
      (await call(withSystems, "DELETE", `/custom-agents/${id}`)).body.removed,
      true,
    );
    check(
      "and its position is forgotten while every other row stays",
      (await call(withSystems, "GET", "/agent-strip")).body.entries,
      [{ kind: "harness", ref: "claude", hidden: false }],
    );

    /* -------------------------------------------------------------- *
     * And once against the real store, which is a combination neither
     * half of this file otherwise covers
     *
     * ⚠ **Everything above drives the routes over an array, and the store
     * section drives the store with no routes at all.** Between them sits the
     * one thing only a database can be wrong about on this path: `replace`
     * empties before it refills, so a `PUT` that reached SQLite and threw
     * half-way would answer 500 with the order *gone* rather than restored —
     * and an array `splice` cannot fail. The same gap `SqliteCustomAgentStore`'s
     * upsert fell into from the other direction, where the stand-in was a `Map`
     * and `Map.set` is an upsert by construction.
     * -------------------------------------------------------------- */
    const realPath = join(sandbox, "strip-live", "reemoat.db");
    const real = openStores({ path: realPath, instanceId: "i_strip_live" });
    const live = build({
      registry: new SessionRegistry(new MemoryEventStore()),
      verifier,
      instanceId: "i_strip_live",
      startedAt: now,
      systems: {
        credentials: real.systemCredentials,
        customAgents: real.customAgents,
        strip: real.agentStrip,
      },
      asks: asks as never,
      roots: [users],
    }).app;
    const written = [
      { kind: "custom", ref: "ca_aabbccdd", hidden: false },
      { kind: "harness", ref: "codex", hidden: true },
    ];
    check(
      "a strip written through the route reaches the real file",
      (await call(live, "PUT", "/agent-strip", { entries: written })).status,
      200,
    );
    check("and the store agrees with the route", real.agentStrip.list(), written);
    check(
      "a second write replaces rather than appending",
      (await call(live, "PUT", "/agent-strip", { entries: [written[1]] })).body.entries,
      [written[1]],
    );
    // The rank column is doing the ordering rather than SQLite's insertion order,
    // which is the one thing a fresh table hides — see the store section.
    check(
      "and the order survives a write that reverses it",
      (
        await call(live, "PUT", "/agent-strip", { entries: [...written].reverse() })
      ).body.entries.map((one: any) => one.ref),
      ["codex", "ca_aabbccdd"],
    );
    real.close();
    const reopened = openStores({ path: realPath, instanceId: "i_strip_live2" });
    check("and outlives the process", reopened.agentStrip.list().map((one) => one.ref), [
      "codex",
      "ca_aabbccdd",
    ]);
    reopened.close();
  }

  /**
   * Every route this section serves, and which scope each is behind.
   *
   * ⚠ **One table, read by two sweeps, because a route in one and not the other
   * is exactly the gap this closes.** The scope sweep below and the no-store
   * sweep under it are the same seven questions asked twice, and they were not:
   * the no-store list was written out here and the scope gate was asserted at one
   * route, `PATCH /custom-agents/:id`, in the middle of the editing block. The
   * other four write verbs could each be downgraded from `write` to `read` in
   * `src/server.ts` — singly or all at once — with this whole file green. The
   * costliest of them is `PUT /systems/:system`, which is where somebody pastes a
   * vendor API key: a read-only grant able to reach it can replace the key every
   * routed session on this machine signs its requests with, and `DELETE` beside it
   * can take it away.
   *
   * The path shapes carry their parameters rather than a literal id, so each
   * sweep substitutes what it needs — the no-store one an id nothing can exist
   * under, the scope one a row that really is there, which is what makes "and
   * nothing moved" a claim about a write that could have landed.
   */
  const sectionRoutes = [
    ["GET", "/systems", "read"],
    ["PUT", "/systems/:system", "write"],
    ["DELETE", "/systems/:system", "write"],
    ["GET", "/custom-agents", "read"],
    ["POST", "/custom-agents", "write"],
    ["PATCH", "/custom-agents/:id", "write"],
    ["DELETE", "/custom-agents/:id", "write"],
    ["GET", "/agent-strip", "read"],
    ["PUT", "/agent-strip", "write"],
  ] as const;

  /*
   * ⚠ **The scope gate, swept over the whole table rather than pinned at one
   * route.** `PATCH /custom-agents/:id` is asserted on its own further up with the
   * argument for why an edit is destructive; this is the same predicate asked of
   * every verb here, and it is what stops the next route added to this section
   * arriving with no gate at all.
   *
   * A body that would really land on each write, so the second assertion is about
   * a write that was refused rather than one that was malformed: `PUT` carries a
   * token a reader must not be able to paste, and both preset writes carry the
   * four fields the route accepts, aimed at a row that exists.
   */
  const gateTarget = await call(withSystems, "POST", "/custom-agents", {
    name: "gated",
    harness: "claude",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check("a row to aim the scope sweep at", gateTarget.status, 201);
  /*
   * ⚠ **Keyed on the *shape* and not on the verb**, since `PUT` now names two
   * routes. A body that the route would refuse anyway makes "and nothing moved" a
   * claim about nothing: the scope gate sits above the handler, so the only way
   * this sweep proves the gate is what stopped the write is for the body to be one
   * that would otherwise have landed.
   */
  const gateBody = (method: string, shape: string): unknown => {
    // A GET or a DELETE carries none: `new Request` refuses a body on a GET
    // outright, and this table now holds two routes that share a path shape and
    // differ only in the verb.
    if (method === "GET" || method === "DELETE") return undefined;
    if (shape === "/systems/:system") {
      return { token: "a-read-only-grant-must-not-be-able-to-paste-this" };
    }
    if (shape === "/agent-strip") return { entries: [{ kind: "harness", ref: "hijacked", hidden: true }] };
    return { name: "hijacked", harness: "claude", system: "anthropic", model: "opus" };
  };
  const said = (one: { status: number; body: any }): string =>
    `${one.status}${one.body?.error?.code == null ? "" : ` ${String(one.body.error.code)}`}`;

  const beforeGate = [frozen(), JSON.stringify([...keys])];
  const denied: string[] = [];
  const allowed: string[] = [];
  for (const [method, shape, scope] of sectionRoutes) {
    const path = shape.replace(":system", "moonshot").replace(":id", gateTarget.body.customAgent.id);
    const answer = await call(withSystems, method, path, gateBody(method, shape), tokenWith("u_reader", ["session:read"]));
    (scope === "write" ? denied : allowed).push(`${method} ${shape}: ${said(answer)}`);
  }
  check("a read-only grant reaches no write verb in this section", denied, [
    "PUT /systems/:system: 403 insufficient_scope",
    "DELETE /systems/:system: 403 insufficient_scope",
    "POST /custom-agents: 403 insufficient_scope",
    "PATCH /custom-agents/:id: 403 insufficient_scope",
    "DELETE /custom-agents/:id: 403 insufficient_scope",
    "PUT /agent-strip: 403 insufficient_scope",
  ]);
  /*
   * The positive half, and it is not decoration: a `write` that had drifted onto
   * either listing would take the assembly screen away from every read-only grant
   * on the machine while all five refusals above went on passing. The same pair
   * the plugin section already drives.
   */
  check("and still reaches every listing", allowed, [
    "GET /systems: 200",
    "GET /custom-agents: 200",
    "GET /agent-strip: 200",
  ]);
  check("and not one of those five moved anything", [frozen(), JSON.stringify([...keys])], beforeGate);
  check(
    "sweeping it away again",
    (await call(withSystems, "DELETE", `/custom-agents/${gateTarget.body.customAgent.id}`)).body.removed,
    true,
  );

  // Every route, against a daemon with no store. `GET /systems` is the exception
  // and is deliberately not one: the table is compiled in, so it can answer
  // honestly with `keySet: false` everywhere rather than refusing.
  for (const [method, shape] of sectionRoutes) {
    if (method === "GET" && shape === "/systems") continue;
    // `ca_1` and `{}` are enough: with no store there is nothing to look an id up
    // in, so the 503 is decided above both the 404 and the first field check.
    const path = shape.replace(":system", "moonshot").replace(":id", "ca_1");
    const answer = await call(without, method, path, method === "GET" || method === "DELETE" ? undefined : {});
    // The code as well as the status: 503 is also what a route answers when an
    // agent will not start, and these two are told apart nowhere else.
    check(`${method} ${path} without a store`, [answer.status, answer.body?.error?.code ?? null], [503, "systems_unavailable"]);
  }
  check(
    "but the table itself still answers",
    (await call(without, "GET", "/systems")).status,
    200,
  );
  check(
    "and a session naming a preset refuses rather than starting a bare harness",
    (await call(without, "POST", "/sessions", { customAgent: "ca_1", cwd: users })).status,
    503,
  );
}

/* ------------------------------------------------------------------ *
 * What each harness offers, and what it will let us point it at
 *
 * ⚠ **`GET /agents/capabilities` was driven nowhere, and it is the route that
 * decides what the builder's model picker offers.** Everything about it is
 * per-harness and answered rather than thrown, so every failure it has is a row
 * quietly missing or a pairing quietly permitted — never an error anybody sees.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat each harness says it can be pointed at\n");
{
  const { createApp: build } = await import("../src/server.js");
  const { BUILTIN_CATALOGUE } = await import("../src/acp/systems.js");
  /*
   * ⚠ **A contributed harness that names *no* model variable, which is the whole
   * point of the fixture.** `pinsModel` is `routedModelNaming(id, machine) !== null`,
   * and among the built-ins it is true for every harness that has an arm — so a
   * catalogue of built-ins alone cannot tell a correct implementation from one
   * that returns a constant `true`, which is exactly what the client reads when the
   * field is absent.
   */
  const flat = {
    id: "acme:flat",
    pluginId: "acme",
    pluginName: "Acme",
    name: "Flat",
    command: "flat",
    args: [],
    envNames: [],
    routedModelEnv: [] as readonly string[],
    authHint: null,
  };
  const catalogue = {
    harness: (id: string) => (id === flat.id ? flat : BUILTIN_CATALOGUE.harness(id)),
    // Deliberately short: `claude`, one harness that will reject, and the flat one.
    // The sweep below reads every key it returns, so a fifth would only add noise.
    harnessIds: () => ["claude", "kimi", flat.id],
    harnessState: (id: string) => (id === flat.id ? "enabled" : BUILTIN_CATALOGUE.harnessState(id)),
    system: (id: string) => BUILTIN_CATALOGUE.system(id),
    systemIds: () => BUILTIN_CATALOGUE.systemIds(),
    systemState: (id: string) => BUILTIN_CATALOGUE.systemState(id),
  };

  const registry = new SessionRegistry(new MemoryEventStore());
  registry.setMachineCatalogue(catalogue as never);

  const asks = {
    capabilities: async (agent: string) => {
      /*
       * ⚠ **One harness that *throws*, because per-agent failures are answered
       * rather than thrown and nothing proved it.** A harness that is not installed
       * must not take down a picker that could still offer the others, and the
       * `catch` that guarantees it is one `return` away from being deleted.
       */
      if (agent === "kimi") throw new Error("kimi not found on PATH");
      return {
        models: [{ id: `${agent}-model`, name: agent, description: null, group: null }],
        // Non-null on both, or `pinsModel` is never reached: the route spreads it
        // onto `routing` and answers `null` outright where the agent published none.
        routing: { providerId: "main", supported: ["anthropic"] },
      };
    },
  };

  const app = build({
    registry,
    verifier,
    instanceId: "i_caps",
    startedAt: now,
    asks: asks as never,
    roots: [users],
  }).app;

  const read = await app.fetch(
    new Request("http://d/agents/capabilities", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  /*
   * ⚠ **Read defensively, for `answered`'s reason one section up.** Reaching
   * straight into `.agents` throws out of the driver the moment this route stops
   * answering one — which is exactly the regression these assertions report — and a
   * thrown `TypeError` takes every section after it down instead of naming the one
   * that moved. Measured: with the per-harness `catch` removed the route 500s, and
   * an unguarded read turned one red line into a stack trace and no summary.
   */
  const agents = (((await read.json()) as any)?.agents ?? {}) as Record<string, any>;
  const rowOf = (id: string): any => agents[id] ?? {};

  check("the route answers", read.status, 200);
  check("with a row per harness this machine offers", Object.keys(agents).sort(), ["acme:flat", "claude", "kimi"]);

  /*
   * ⚠ **The pair is the assertion, and neither half is one alone.** `pinsModel`
   * inverted leaves both halves individually plausible and the pair wrong, and an
   * inversion is not hypothetical: the field is a boolean the client reads as
   * *permission*, and it fails **open** — `packages/web/src/agents.ts` refuses the
   * pairing only on an explicit `false`, because a daemon too old to send the field
   * has no plugin catalogue and so nothing it could be false for. So a dropped or
   * inverted field does not break the picker, it silently re-opens the pairing this
   * field exists to close, and `POST /custom-agents` then refuses what the picker
   * offered.
   */
  check(
    "which harnesses can be told a model to run on somebody else's system",
    [rowOf("claude").routing?.pinsModel ?? null, rowOf("acme:flat").routing?.pinsModel ?? null],
    // claude names two variables in `ROUTED_MODEL_ENV`; the contributed one named
    // none in its manifest, and a harness that cannot be pointed at a model must
    // never be offered a foreign system.
    [true, false],
  );

  check(
    "a harness that could not be read answers for itself and not for the others",
    // `in` rather than `??`, or a `routing` that is legitimately `null` and one that
    // was never sent read alike — and `null` is the answer being asserted.
    [rowOf("kimi").models ?? "(absent)", "routing" in rowOf("kimi") ? rowOf("kimi").routing : "(absent)", typeof rowOf("kimi").error],
    [[], null, "string"],
  );
  check(
    "while the harnesses that answered still carry their rows",
    [
      rowOf("claude").models?.length ?? null,
      rowOf("acme:flat").models?.length ?? null,
      "error" in rowOf("claude") ? rowOf("claude").error : "(absent)",
      "error" in rowOf("acme:flat") ? rowOf("acme:flat").error : "(absent)",
    ],
    [1, 1, null, null],
  );

  /*
   * A daemon built with no capability reader says so, rather than answering an
   * empty catalogue that a picker would draw as "this harness offers nothing".
   */
  const noAsks = build({
    registry,
    verifier,
    instanceId: "i_nocaps",
    startedAt: now,
    roots: [users],
  }).app;
  const refused = await noAsks.fetch(
    new Request("http://d/agents/capabilities", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  check(
    "a daemon that cannot read capabilities refuses rather than answering nothing",
    // Same defensive read, and here it is the whole assertion: a route that stopped
    // refusing answers a body with no `error` at all.
    [refused.status, ((await refused.json()) as any)?.error?.code ?? null],
    [503, "model_unavailable"],
  );
}
