import { join } from "node:path";
import { AGENT_IDS } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry, type CreateSessionOptions } from "../src/registry.js";
import { openStores } from "../src/store/sqlite.js";
import { check, report } from "./daemoncheck.env.js";
import { sandbox, users, now, tokenWith, tokenFor, verifier } from "./daemoncheck.fixtures.js";

process.stdout.write("\nthe system and assembled-agent routes\n");
{
  const { createApp: build } = await import("../src/server.js");
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
    // An array, not a Map: a Map keeps insertion order and would pass a round trip a replace-in-place implementation fails.
    strip: {
      list: () => [...stripRows],
      replace: (entries: readonly any[]) => void stripRows.splice(0, stripRows.length, ...entries),
      forget: (kind: string, ref: string) => {
        const at = stripRows.findIndex((one) => one.kind === kind && one.ref === ref);
        if (at !== -1) stripRows.splice(at, 1);
      },
    },
  };

  // A stub for ServerOptions.asks, so the compatibility refusal is reachable with no agent installed.
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

  // Read defensively: a TypeError on a refusal turned acceptance would take down every later section.
  const answered = (one: { status: number; body: any }): [number, string | null] => [
    one.status,
    one.body?.error?.code ?? null,
  ];

  const listed = await call(withSystems, "GET", "/systems");
  check("every system is listed", listed.body.systems.length, SYSTEM_IDS.length);
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
  // Swept for the secret only once a key is saved; before that the sweep could not fail.
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

  // Rotating a key: the store's save must be an upsert, which a Map stand-in cannot show.
  check("rotating one works", (await call(withSystems, "PUT", "/systems/moonshot", { token: "sekrit2" })).status, 200);
  check("and the new secret is what is stored", systems.credentials.get("moonshot"), "sekrit2");
  check("with one row still, not two", systems.credentials.list().length, 1);

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

  // Clearing a key must leave the presets naming that system alone.
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
    // An unknown id is 200 removed:false, or a key written by a newer daemon is undeletable after a downgrade.
    const unknown = await call(withSystems, "DELETE", "/systems/gemini");
    check("an id this build does not know is not refused", unknown.status, 200);
    check("and says it removed nothing", unknown.body.removed, false);
    // Put it back for the sections below, which assume a key is there.
    check("and the key can be saved again", (await call(withSystems, "PUT", "/systems/moonshot", { token: "sekrit" })).status, 200);
  }

  // Every refusal is asserted twice: the answer, and that the stored rows are byte-identical afterwards.

  const preset = good.body.customAgent.id;
  const born = good.body.customAgent.createdAt;
  // Both stores, so a refusal that wrote a second row or touched the strip is caught.
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
  // id and createdAt must survive an edit: sessions reference a preset by id and resolve it at every launch.
  check("while the id it was reached by is unchanged", edited.body.customAgent.id, preset);
  check("and so is the moment it was created", edited.body.customAgent.createdAt, born);
  check("the store holds exactly the row that was answered", presets.get(preset), edited.body.customAgent);
  check("an edit replaces rather than adds", presets.size, 1);
  check(
    "and the listing carries it at once",
    (await call(withSystems, "GET", "/custom-agents")).body.customAgents,
    [edited.body.customAgent],
  );

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
    // Its own code: not_found already means a missing cwd on POST /sessions.
    [404, "custom_agent_not_found"],
  );
  // The 404 is decided before the body; only a body wrong both ways shows which check ran first.
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

  // An edit is a replace: a partial body is refused, so nothing is ever merged with the stored row.
  await refuses("a body naming only a new system", { system: "moonshot" }, [400, "invalid_agent"]);
  await refuses("a body naming only a new name", { name: "renamed" }, [400, "invalid_agent"]);

  // The positive control at the bound: a validator refusing everything would pass every refusal above.
  const atBound = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    name: "n".repeat(80),
    harness: "claude",
    system: "anthropic",
    model: "m".repeat(256),
  });
  check("editing: a name and a model exactly at the bound are accepted", atBound.status, 200);

  // The message is compared to POST's own answer rather than a literal, pinning both routes to one validator.
  const editPairing = await call(withSystems, "PATCH", `/custom-agents/${preset}`, {
    name: "nope",
    harness: "codex",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check("editing: an impossible pairing is refused", answered(editPairing), [400, "incompatible_pairing"]);
  check("editing: and says which two", editPairing.body?.error?.detail ?? null, { harness: "codex", system: "moonshot" });
  // Two halves: two routes that both stopped refusing would agree about null.
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

  // The whole harness x system matrix; each cell starts from the previous cell's row, so the pair is weighed as a pair.
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
    "claude x xai: incompatible_pairing",
    "claude x moonshot: saved",
    "claude x zhipu: saved",
    "claude x minimax: saved",
    "claude x zen: incompatible_pairing",
    "kimi x anthropic: incompatible_pairing",
    "kimi x openai: incompatible_pairing",
    "kimi x openrouter: incompatible_pairing",
    "kimi x xai: incompatible_pairing",
    "kimi x moonshot: saved",
    "kimi x zhipu: incompatible_pairing",
    "kimi x minimax: incompatible_pairing",
    "kimi x zen: incompatible_pairing",
    "codex x anthropic: incompatible_pairing",
    "codex x openai: saved",
    "codex x openrouter: incompatible_pairing",
    "codex x xai: incompatible_pairing",
    "codex x moonshot: incompatible_pairing",
    "codex x zhipu: incompatible_pairing",
    "codex x minimax: incompatible_pairing",
    "codex x zen: incompatible_pairing",
    "opencode x anthropic: incompatible_pairing",
    "opencode x openai: incompatible_pairing",
    // readAssembledAgent consults asks.capabilities first, and opencode's routing is null, which the native arm never reads.
    "opencode x openrouter: saved",
    "opencode x xai: incompatible_pairing",
    "opencode x moonshot: incompatible_pairing",
    "opencode x zhipu: incompatible_pairing",
    "opencode x minimax: incompatible_pairing",
    "opencode x zen: saved",
    "grok x anthropic: incompatible_pairing",
    "grok x openai: incompatible_pairing",
    "grok x openrouter: incompatible_pairing",
    "grok x xai: saved",
    "grok x moonshot: incompatible_pairing",
    "grok x zhipu: incompatible_pairing",
    "grok x minimax: incompatible_pairing",
    "grok x zen: incompatible_pairing",
  ]);

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

  // Editing needs write: re-pointing a preset at another system changes where its key is sent.
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

  // Create and edit share one validator; compared pairwise so a copied check that drifts fails here.
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
  // Identically must mean identically refused: two routes that both accepted a body would agree.
  check("and every one of them is a body both refuse", swallowed, []);
  check("and not one of them wrote anything", presets.size, 1);

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

  // A preset names its harness; a body.agent beside it, disagreeing or not even real, must reach nothing.
  {
    const { PathError } = await import("../src/browse.js");
    const asked: [string, string | null | undefined][] = [];
    class Recording extends SessionRegistry {
      override async create(options: CreateSessionOptions): Promise<never> {
        asked.push([options.agent, options.customAgent]);
        throw new PathError("not_found", "this driver stops every create here");
      }
    }
    const recorded = build({
      registry: new Recording(new MemoryEventStore()),
      verifier,
      instanceId: "i_preset_harness",
      startedAt: now,
      systems: systems as never,
      asks: asks as never,
      roots: [users],
    }).app;
    check("the preset these rows start is on claude", presets.get(preset)?.harness, "claude");
    const answers: [number, string | null][] = [];
    for (const agent of ["kimi", "gemini", undefined]) {
      const body = { customAgent: preset, cwd: users, ...(agent === undefined ? {} : { agent }) };
      answers.push(answered(await call(recorded, "POST", "/sessions", body)));
    }
    check("a session started from a preset runs the preset's harness, whatever the body names", asked, [
      ["claude", preset],
      ["claude", preset],
      ["claude", preset],
    ]);
    check("and a body agent this machine does not offer is not what answers", answers, [
      [400, "not_found"],
      [400, "not_found"],
      [400, "not_found"],
    ]);
  }

  // Removal is idempotent: a DELETE is replayed after a dropped answer, so a missing id is 200 removed:false.
  const missing = await call(withSystems, "DELETE", "/custom-agents/ca_nope");
  check("removing one that is not there is a 200", missing.status, 200);
  check("and says nothing was removed", missing.body.removed, false);
  check("and echoes back the id it was asked about", missing.body.id, "ca_nope");

  const doomed = good.body.customAgent.id;
  const firstTry = await call(withSystems, "DELETE", `/custom-agents/${doomed}`);
  check("removing a real one works", [firstTry.status, firstTry.body.removed, firstTry.body.id], [200, true, doomed]);
  check("and the list is empty again", (await call(withSystems, "GET", "/custom-agents")).body.customAgents.length, 0);
  const replay = await call(withSystems, "DELETE", `/custom-agents/${doomed}`);
  check("sending it a second time succeeds and says so", [replay.status, replay.body.removed, replay.body.id], [200, false, doomed]);
  check("with the list still empty rather than disturbed", (await call(withSystems, "GET", "/custom-agents")).body.customAgents.length, 0);

  // The daemon stores refs without resolving them, so every refusal below is about shape, never existence.
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
    // The answer is what the store holds, read back, not the body echoed.
    check("and comes back in the order it was written", saved.body.entries, order);
    check("which is what the GET says too", (await call(withSystems, "GET", "/agent-strip")).body.entries, order);
    check(
      "including refs this machine has nothing under",
      stripRows.map((one: any) => one.ref),
      ["ca_deadbeef", "claude", "kimi"],
    );

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
        // One past MAX_STRIP_ENTRIES; the client sends the whole list on every action, so the bound must be beyond a real fleet.
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
    // replace empties before it refills, so the whole body must be validated before the store is touched.
    check("and not one of them moved anything", JSON.stringify(strip()), before);
    // At the bound: 96 mirrors MAX_STRIP_REF_CHARS, module-private to server.ts, and moves with the 97 above.
    check(
      "one at the bound is accepted, which is what makes the refusal a bound",
      (
        await call(withSystems, "PUT", "/agent-strip", {
          entries: [{ kind: "harness", ref: "r".repeat(96), hidden: true }],
        })
      ).status,
      200,
    );

    // Deleting a preset forgets its strip position, the only bound on this table's growth.
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

    // Once against the real store: replace empties first, and a SQLite failure mid-write is what an array stand-in cannot show.
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
    // The rank column orders rows, not SQLite's insertion order, which a fresh table hides.
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

  /** Every route in this section and its scope, read by both the scope sweep and the no-store sweep. */
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

  // Each write carries a body that would land, so an unchanged store proves the scope gate refused it.
  const gateTarget = await call(withSystems, "POST", "/custom-agents", {
    name: "gated",
    harness: "claude",
    system: "moonshot",
    model: "kimi-k2-thinking",
  });
  check("a row to aim the scope sweep at", gateTarget.status, 201);
  const gateBody = (method: string, shape: string): unknown => {
    // GET and DELETE carry no body; new Request refuses one on a GET.
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
  // The positive half: a write scope drifting onto a listing would lock every read-only grant out.
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

  // GET /systems is exempt: the table is compiled in, so it answers keySet false everywhere.
  for (const [method, shape] of sectionRoutes) {
    if (method === "GET" && shape === "/systems") continue;
    const path = shape.replace(":system", "moonshot").replace(":id", "ca_1");
    const answer = await call(without, method, path, method === "GET" || method === "DELETE" ? undefined : {});
    // The code too: 503 is also what a route answers when an agent will not start.
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

process.stdout.write("\nwhat each harness says it can be pointed at\n");
{
  const { createApp: build } = await import("../src/server.js");
  const { BUILTIN_CATALOGUE } = await import("../src/acp/systems.js");
  // A contributed harness naming no model variable: built-ins alone cannot tell pinsModel from a constant true.
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
      // kimi throws: a per-harness failure must be answered in its row, not take the picker down.
      if (agent === "kimi") throw new Error("kimi not found on PATH");
      return {
        models: [{ id: `${agent}-model`, name: agent, description: null, group: null }],
        // Non-null routing on both, or pinsModel is never reached.
        routing: { providerId: "main", supported: ["anthropic"] },
        // Distinct per harness, so an assertion cannot pass by reading another row.
        cli: { path: `/bin/${agent}`, version: `1.2.${agent.length}`, source: "path" },
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
  const agents = (((await read.json()) as any)?.agents ?? {}) as Record<string, any>;
  const rowOf = (id: string): any => agents[id] ?? {};

  check("the route answers", read.status, 200);
  check("with a row per harness this machine offers", Object.keys(agents).sort(), ["acme:flat", "claude", "kimi"]);

  // The build rides this answer beside the models it published; a harness never spawned names none.
  check("each row names the build that published its models", rowOf("claude").cli?.version, "1.2.6");
  check("and the source that decided it", rowOf("claude").cli?.source, "path");
  check("a harness that could not be asked names no build", rowOf("kimi").cli, null);
  // The resolved path must not travel: it is this host's filesystem layout.
  check("and no row carries the path it was resolved from", Object.keys(rowOf("claude").cli ?? {}).sort(), ["source", "version"]);
  check("while still reporting why it could not", typeof rowOf("kimi").error, "string");

  // The client reads pinsModel as permission and fails open, so a dropped or inverted field reopens the pairing.
  check(
    "which harnesses can be told a model to run on somebody else's system",
    [rowOf("claude").routing?.pinsModel ?? null, rowOf("acme:flat").routing?.pinsModel ?? null],
    [true, false],
  );

  check(
    "a harness that could not be read answers for itself and not for the others",
    // in rather than ??, because null is the answer being asserted.
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
    [refused.status, ((await refused.json()) as any)?.error?.code ?? null],
    [503, "model_unavailable"],
  );
}

// The daemon sends no mode; the adapter reads permissions.defaultMode from the user's own settings.
process.stdout.write("\nwhere a claude session's opening mode comes from\n");
{
  const { claudeSettingsMode } = await import("../src/acp/agents.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");

  const homeWith = (name: string, contents: string | null): string => {
    const home = join(sandbox, "settings", name);
    mkdirSync(join(home, ".claude"), { recursive: true });
    if (contents !== null) writeFileSync(join(home, ".claude", "settings.json"), contents, "utf8");
    return home;
  };

  const set = await claudeSettingsMode({
    homeDir: homeWith("set", JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } })),
  });
  check("a mode the settings file names is reported", set?.value, "bypassPermissions");
  check("beside the file it came from, so the sentence can name it", set?.file.endsWith("/.claude/settings.json"), true);

  // Reported as written: normalising would copy the adapter's own alias and precedence rules.
  check(
    "an alias is reported as written rather than resolved on the adapter's behalf",
    (await claudeSettingsMode({ homeDir: homeWith("alias", JSON.stringify({ permissions: { defaultMode: "bypass" } })) }))?.value,
    "bypass",
  );

  // Every shape that explains nothing is one null answer; the file is not ours, so its size must be bounded.
  const nothings: [string, string | null][] = [
    ["no file at all", null],
    ["a file that is not JSON", "{not json"],
    ["JSON that is not an object", "[]"],
    ["an object with no permissions", JSON.stringify({ model: "opus" })],
    ["permissions with no defaultMode", JSON.stringify({ permissions: { allow: ["Bash"] } })],
    ["a defaultMode that is not a string", JSON.stringify({ permissions: { defaultMode: 3 } })],
    ["a defaultMode that is only whitespace", JSON.stringify({ permissions: { defaultMode: "   " } })],
    ["a file past the byte bound", `{"permissions":{"defaultMode":"plan"},"pad":"${"x".repeat(300_000)}"}`],
  ];
  for (const [what, contents] of nothings) {
    check(`${what} reports nothing`, await claudeSettingsMode({ homeDir: homeWith(what.replace(/\W+/g, "-"), contents) }), null);
  }

  const long = await claudeSettingsMode({
    homeDir: homeWith("long", JSON.stringify({ permissions: { defaultMode: "m".repeat(400) } })),
  });
  check("and a value too long to be a mode is clipped", [long?.value.length, long?.value.endsWith("…")], [65, true]);

  // Asserted on source, since driving it needs a CLI spawn per harness: both row routes must go through one helper.
  const { readFileSync } = await import("node:fs");
  const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check(
    "the agent row's extra fields are built in one place",
    (serverSrc.match(/const agentRowExtras = async/g) ?? []).length,
    1,
  );
  check(
    "and both routes that answer one go through it",
    (serverSrc.match(/await agentRowExtras\(\)/g) ?? []).length,
    2,
  );
  // loginSupportOf stays at two sites: the helper and GET /agent-auth's credentials row.
  check(
    "and neither of them spreads login by hand",
    (serverSrc.match(/login: loginSupportOf\(/g) ?? []).length,
    2,
  );
}

// deploy/agents.sh knows only the shipped five, so the route must refuse a plugin's harness before the script runs.
// The accepting kimi row is the negative control.

process.stdout.write("\nwhich names may reach the installer script\n");
{
  const { createApp: build } = await import("../src/server.js");
  const { BUILTIN_CATALOGUE } = await import("../src/acp/systems.js");

  // The stub accepts anything, so only the route decides which names get this far.
  const asked: string[] = [];
  const installs = {
    start: (agent: string) => {
      asked.push(agent);
      return { kind: "ok", view: { installId: "in_stub", agent, done: false, outcome: "running" } };
    },
    live: () => null,
    read: () => null,
    cancel: () => false,
  };

  // One enabled and one disabled contributed harness: the route owes them different refusals.
  const contributed = (id: string): unknown => ({
    id,
    pluginId: "acme",
    pluginName: "Acme",
    name: "Gemini",
    command: "a-binary-that-is-not-here",
    args: [],
    envNames: [],
    routedModelEnv: [] as readonly string[],
    authHint: null,
  });
  const catalogue = {
    harness: (id: string) => (id.startsWith("acme:") ? contributed(id) : BUILTIN_CATALOGUE.harness(id)),
    harnessIds: () => ["claude", "kimi", "acme:gemini"],
    harnessState: (id: string) =>
      id === "acme:gemini" ? "enabled" : id === "acme:off" ? "disabled" : BUILTIN_CATALOGUE.harnessState(id),
    system: (id: string) => BUILTIN_CATALOGUE.system(id),
    systemIds: () => BUILTIN_CATALOGUE.systemIds(),
    systemState: (id: string) => BUILTIN_CATALOGUE.systemState(id),
  };

  const registry = new SessionRegistry(new MemoryEventStore());
  registry.setMachineCatalogue(catalogue as never);
  const app = build({
    registry,
    verifier,
    instanceId: "i_installgate",
    startedAt: now,
    installs: installs as never,
    roots: [users],
  }).app;

  /** One press as status, code and whether the script was asked; a refusal after spawning has already paid its cost. */
  const press = async (agent: string): Promise<[number, string | null, boolean]> => {
    const before = asked.length;
    const response = await app.fetch(
      new Request(`http://d/agent-install/${encodeURIComponent(agent)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const text = await response.text();
    const body = (text.length > 0 ? JSON.parse(text) : null) as { error?: { code?: string } } | null;
    return [response.status, body?.error?.code ?? null, asked.length > before];
  };

  const table: [string, string, [number, string | null, boolean]][] = [
    [
      "a harness this repository ships reaches the script",
      "kimi",
      [201, null, true],
    ],
    [
      "a harness a plugin added is refused here rather than by a script that will call it a failed install",
      "acme:gemini",
      [503, "harness_not_installable", false],
    ],
    [
      "while a plugin somebody switched off keeps its own sentence, and never the new one",
      "acme:off",
      [503, "harness_unavailable", false],
    ],
    [
      "and an id nothing has heard of is still the caller's mistake",
      "not-an-agent",
      [400, "invalid_agent", false],
    ],
  ];
  for (const [what, agent, expected] of table) check(what, await press(agent), expected);

  check("and exactly one of the four names got that far", asked, ["kimi"]);
  report(
    "the install gate was driven over a catalogue wider than the five",
    catalogue.harnessIds().some((id) => id.includes(":")),
    `${catalogue.harnessIds().length} harnesses offered, ${table.length} pressed`,
  );
}
