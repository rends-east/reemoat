import { AgentInstallRuns, INSTALL_RETAIN_MS, readStep, type InstallSink } from "../src/agentinstall.js";
import { AgentScriptGate } from "../src/agentscript.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { check, report } from "./daemoncheck.env.js";
import { now, tokenFor, tokenWith, users, verifier } from "./daemoncheck.fixtures.js";

process.stdout.write("\ninstalling a harness, because somebody asked for it\n");
{
  check(
    "a checkpoint parses into an agent and a phase",
    [readStep("step: kimi download"), readStep("  step: grok link  ")],
    [{ agent: "kimi", phase: "download" }, { agent: "grok", phase: "link" }],
  );
  check(
    "and anything that is not one answers null rather than throwing",
    [
      readStep("  kimi          refresh 0.29.2"),
      readStep(""),
      readStep("step: kimi"),
      readStep("step: kimi download extra"),
      readStep("step: kimi frobnicate"),
    ],
    [null, null, null, null, null],
  );

  const gate = new AgentScriptGate();
  check("the gate is free to start with", gate.holder, null);
  check("an update may take it", gate.tryHold("update"), true);
  check("and an install may not, while it is held", gate.tryHold("install", "kimi"), false);
  gate.release("install");
  check("a release by the caller that did not take it changes nothing", gate.holder?.kind, "update");
  gate.release("update");
  check("while the holder's own release frees it", gate.holder, null);

  type Spawned = { sink: InstallSink; killed: boolean; args: readonly string[] };
  const spawns: Spawned[] = [];
  const order: string[] = [];
  let present = true;

  const runsFor = (over: Partial<ConstructorParameters<typeof AgentInstallRuns>[0]> = {}) =>
    new AgentInstallRuns({
      gate: new AgentScriptGate(),
      verify: async (agent) => {
        order.push(`verify:${agent}`);
        return present;
      },
      onFinished: (agent) => {
        order.push(`forget:${agent}`);
      },
      onWarning: () => {},
      spawnScript: (_agent, args, sink) => {
        const entry: Spawned = { sink, killed: false, args };
        spawns.push(entry);
        return {
          kill: () => {
            entry.killed = true;
          },
        };
      },
      ...over,
    });

  {
    const runs = runsFor();
    const started = runs.start("kimi");
    check("a start answers a run view", [started.kind, started.kind === "ok" ? started.view.agent : null], ["ok", "kimi"]);
    // The fail-if-locked flag matters: the script answers a contended run with exit 0, indistinguishable from success.
    check(
      "the script is asked for that harness alone, and told to fail on a held lock",
      [spawns[0]?.args.slice(0, 3), spawns[0]?.args.includes("--refresh-only")],
      [["--only", "kimi", "--fail-if-locked"], false],
    );

    const second = runs.start("codex");
    check("a second start while one is running is refused, never superseded", second.kind, "busy");
    check("and nothing was killed to make room for it", spawns[0]?.killed, false);
    check("and no second process was spawned", spawns.length, 1);

    spawns[0]?.sink.append("agents (kimi only; from the npm registry)\nstep: kimi start\n");
    check("the transcript is readable through a cursor", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.chunk.includes("kimi only"), true);
    check("and the newest checkpoint is the phase", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.phase, "start");
    spawns[0]?.sink.append("step: kimi down");
    check("a half-written checkpoint does not move the phase", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.phase, "start");
    spawns[0]?.sink.append("load\nstep: kimi install\n");
    check("and the rest of it does", runs.read(started.kind === "ok" ? started.view.installId : "", 0)?.phase, "install");

    // agents.sh exits 0 on a failed install too, so the verdict comes from the verify probe, never the exit code.
    present = false;
    order.length = 0;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    const failedView = runs.live();
    check(
      "a clean exit with the harness still absent is a failure, and says so beside the exit code",
      [failedView?.outcome, failedView?.exit?.code, failedView?.done],
      ["failed", 0, true],
    );
    // A sequence, not a set: findOnPath caches misses for 30 s, so the caches must drop before the machine is asked.
    check("and the caches were dropped before the machine was asked", order, ["forget:kimi", "verify:kimi"]);
  }

  {
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("codex");
    const id = started.kind === "ok" ? started.view.installId : "";
    present = true;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    check("a clean exit with the harness now present is an install", runs.live()?.outcome, "installed");
    const again = runs.start("codex");
    check("and a start over a finished record is allowed", again.kind, "ok");
    check("while its id is a new one", again.kind === "ok" && again.view.installId !== id, true);
  }

  {
    const runs = runsFor();
    spawns.length = 0;
    runs.start("grok");
    spawns[0]?.sink.close({ code: 3, signal: null }, "locked");
    await new Promise((r) => setTimeout(r, 0));
    check("a lock the gate could not see reaches the client as its own outcome", runs.live()?.outcome, "locked");
    check("and no verdict was taken over it", runs.live()?.exit?.code, 3);
  }

  {
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("opencode");
    const id = started.kind === "ok" ? started.view.installId : "";
    check("a run can be cancelled", runs.cancel(id), true);
    check("and the kill reached the script", spawns[0]?.killed, true);
    check("while an id nothing is holding is not found", runs.cancel("in_nope"), false);
    check("and neither is a poll for one", runs.read("in_nope", 0), null);
  }

  {
    // The TTL runs from the end, unlike LoginRun: a running install is bounded only by the script's own deadline.
    // read does not sweep, so the private sweep is driven with an explicit clock.
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("kimi");
    const id = started.kind === "ok" ? started.view.installId : "";
    const clocked = runs as unknown as { sweep: (now: number) => void };
    clocked.sweep(Date.now() + INSTALL_RETAIN_MS * 3);
    check("a running run survives a sweep, however long it runs", runs.read(id, 0) !== null, true);
    present = true;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    clocked.sweep(Date.now());
    check("and a finished one is still readable while it is fresh", runs.read(id, 0) !== null, true);
    // Negative control: without it both cells above pass over an expiry measured from startedAt.
    clocked.sweep(Date.now() + INSTALL_RETAIN_MS + 1);
    check("while a finished record ages out past the retention", runs.read(id, 0), null);
  }

  {
    // cancel SIGKILLs the process group, and during install or link a vendor installer writes straight into ~/.local/bin.
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("claude");
    const id = started.kind === "ok" ? started.view.installId : "";
    const at = (): { cancellable: boolean | undefined; phase: string | null | undefined } => ({
      cancellable: runs.read(id, 0)?.cancellable,
      phase: runs.read(id, 0)?.phase,
    });
    check("a run with no checkpoint yet may be stopped", at(), { cancellable: true, phase: null });
    spawns[0]?.sink.append("step: claude download\n");
    check("and so may one still fetching into its temporary directory", at(), {
      cancellable: true,
      phase: "download",
    });
    spawns[0]?.sink.append("step: claude install\n");
    check("but not one whose installer is writing outside it", at(), {
      cancellable: false,
      phase: "install",
    });
    check("and the Stop is refused rather than signalled", runs.cancel(id), false);
    check("so nothing was killed", spawns[0]?.killed, false);
    spawns[0]?.sink.append("step: claude link\n");
    check("the repoint is the second refused phase", [at().cancellable, runs.cancel(id), spawns[0]?.killed], [
      false,
      false,
      false,
    ]);
    spawns[0]?.sink.append("step: claude done\n");
    check("while the phases after the writes are stoppable again", at().cancellable, true);
    check("where the Stop does reach the script", [runs.cancel(id), spawns[0]?.killed], [true, true]);

    order.length = 0;
    present = false;
    spawns[0]?.sink.close({ code: null, signal: "SIGKILL" }, "cancelled");
    await new Promise((r) => setTimeout(r, 0));
    check(
      "a stopped run reports itself cancelled rather than failed",
      [runs.live()?.outcome, runs.live()?.done],
      ["cancelled", true],
    );
    check("with the caches dropped and the machine not asked", order, ["forget:claude"]);
    check("while a finished record may not be stopped again", [runs.live()?.cancellable, runs.cancel(id)], [
      false,
      false,
    ]);
  }

  {
    // Node emits both error and close for a failed spawn, so the sink closes twice and must settle once.
    const gate = new AgentScriptGate();
    const runs = runsFor({ gate });
    spawns.length = 0;
    runs.start("kimi");
    check("the install holds the script gate while it runs", [gate.holder?.kind, gate.holder?.agent], [
      "install",
      "kimi",
    ]);
    present = true;
    order.length = 0;
    spawns[0]?.sink.close({ code: null, signal: null }, "spawn_failed");
    spawns[0]?.sink.close({ code: null, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    check("a run closed twice settles exactly once", order, ["forget:kimi"]);
    check("with the first close's outcome, not the second's", runs.live()?.outcome, "spawn_failed");
    check("and the gate given back", gate.holder, null);
    const next = runs.start("codex");
    check("so the next install can take it", [next.kind, gate.holder?.agent], ["ok", "codex"]);
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    check("while a late close on the old run leaves the new hold alone", gate.holder?.agent, "codex");
  }

  {
    const gate = new AgentScriptGate();
    spawns.length = 0;
    const runs = runsFor({
      gate,
      spawnScript: () => {
        throw new Error("spawn deploy/agents.sh ENOENT");
      },
    });
    const refused = runs.start("kimi");
    check(
      "a spawn that throws is a refusal carrying what threw",
      [refused.kind, refused.kind === "spawn_failed" ? refused.detail : null],
      ["spawn_failed", "spawn deploy/agents.sh ENOENT"],
    );
    check("and the gate it had already taken is handed back", gate.holder, null);
    check("so the next run is not locked out for the life of the process", gate.tryHold("update"), true);
    gate.release("update");
    check("while this daemon is holding no run it could report", runs.live(), null);
    check("and nothing was spawned to poll", spawns.length, 0);
  }

  {
    const gate = new AgentScriptGate();
    spawns.length = 0;
    const runs = runsFor({ gate });
    runs.shutdown();
    const after = runs.start("kimi");
    check(
      "a start after shutdown is refused with a sentence rather than a spawn",
      [after.kind, after.kind === "spawn_failed" ? after.detail : null],
      ["spawn_failed", "this daemon is shutting down"],
    );
    check("and it took no gate on its way out", gate.holder, null);
    check("nor spawned anything", spawns.length, 0);
  }

  {
    // agents.sh writes warnings on stderr between stdout chunks, so each stream keeps its own partial-line carry.
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("grok");
    const id = started.kind === "ok" ? started.view.installId : "";
    const sink = spawns[0]?.sink;
    sink?.append("step: grok dow", "stdout");
    sink?.append("  grok         install failed; this machine has no copy of it\n", "stderr");
    sink?.append("nload\n", "stdout");
    check("a warning between the halves of a checkpoint does not splice them", runs.read(id, 0)?.phase, "download");
    const text = runs.read(id, 0)?.chunk ?? "";
    check(
      "and each stream's line is whole in the transcript",
      [text.includes("step: grok download\n"), text.includes("no copy of it\n")],
      [true, true],
    );
  }

  {
    // The cap applies after every mutation, the carry flush included: a chunk with no newline sits in the carry until close.
    const runs = runsFor();
    spawns.length = 0;
    const started = runs.start("kimi");
    const id = started.kind === "ok" ? started.view.installId : "";
    const held = (): number => {
      const view = runs.read(id, 0);
      return (view?.cursor ?? 0) - (view?.dropped ?? 0);
    };
    spawns[0]?.sink.append(`${"x".repeat(70 * 1024)}\n`);
    report("the transcript is held under its ceiling", held() <= 64 * 1024, `${String(held())} bytes`);
    check("with the front dropped rather than the tail", runs.read(id, 0)?.dropped !== 0, true);
    spawns[0]?.sink.append("y".repeat(70 * 1024));
    report("and a held partial line is not counted in yet", held() <= 64 * 1024, `${String(held())} bytes`);
    present = true;
    spawns[0]?.sink.close({ code: 0, signal: null }, "running");
    await new Promise((r) => setTimeout(r, 0));
    report("nor over it once the flush has run", held() <= 64 * 1024, `${String(held())} bytes`);
  }

  const { createApp: build } = await import("../src/server.js");
  spawns.length = 0;
  const routeRuns = runsFor();
  const withInstalls = build({
    registry: new SessionRegistry(new MemoryEventStore()),
    verifier,
    instanceId: "i_install",
    startedAt: now,
    installs: routeRuns as never,
    roots: [users],
  }).app;
  const without = build({
    registry: new SessionRegistry(new MemoryEventStore()),
    verifier,
    instanceId: "i_noinstall",
    startedAt: now,
    roots: [users],
  }).app;

  const call = async (
    which: typeof withInstalls,
    method: string,
    path: string,
    token: string = tokenFor("u_alice"),
  ): Promise<{ status: number; body: any }> => {
    const response = await which.fetch(
      new Request(`http://d${path}`, { method, headers: { authorization: `Bearer ${token}` } }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  const answered = (one: { status: number; body: any }): [number, string | null] => [
    one.status,
    one.body?.error?.code ?? null,
  ];

  const rows = await call(without, "GET", "/agents");
  // An empty list passes every, so the row count is reported first.
  const listed = (rows.body?.agents ?? []) as { installable?: boolean }[];
  report("the listing route answered with rows at all", listed.length > 0, `${String(listed.length)} rows`);
  check(
    "with no install store, no row is installable",
    [rows.status, listed.filter((one) => one.installable !== false).length],
    [200, 0],
  );
  check("and the route refuses rather than pretending", answered(await call(without, "POST", "/agent-install/kimi")), [503, "install_unsupported"]);
  check("and says so on the listing route too", (await call(without, "GET", "/agent-install")).body?.supported, false);

  // installable is a strict subset of !available: agents.sh repairs only a built-in's CLI missing from PATH and MANAGED_CLI_DIRS.
  {
    const { AgentUnavailableError, resolveAgent } = await import("../src/acp/agents.js");
    const refusalFor = (id: string, machine?: unknown): { message: string; installable: boolean } => {
      try {
        resolveAgent(id, machine as never);
        return { message: "", installable: false };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : String(error),
          installable: error instanceof AgentUnavailableError && error.installable,
        };
      }
    };
    const contributed = {
      harness: (id: string) =>
        id === "acme:gemini"
          ? {
              id,
              name: "Gemini",
              pluginId: "acme",
              pluginName: "Acme",
              command: "a-binary-that-is-not-here",
              args: [],
            }
          : null,
      harnessIds: () => ["acme:gemini"],
    };
    check(
      "a harness a plugin added is never offered an install, however absent it is",
      refusalFor("acme:gemini", contributed).installable,
      false,
    );
    check("and neither is an id nothing has heard of", refusalFor("not-an-agent").installable, false);
  }

  check("an unknown harness is refused by name", answered(await call(withInstalls, "POST", "/agent-install/gemini")), [400, "invalid_agent"]);
  // Writes need machine:admin, as POST /plugins does: an install runs a vendor installer as this uid.
  const driver = tokenWith("u_bob", ["session:read", "session:write"]);
  check("a session grant may not start one", answered(await call(withInstalls, "POST", "/agent-install/kimi", driver)), [403, "insufficient_scope"]);
  check("nor cancel one", answered(await call(withInstalls, "DELETE", "/agent-install/runs/in_x", driver)), [403, "insufficient_scope"]);
  // The poll carries installer output and no secret, unlike a login transcript.
  const polled = await call(withInstalls, "GET", "/agent-install/runs/in_nope", driver);
  check("while reading one needs only a session grant", answered(polled), [404, "install_not_found"]);

  const created = await call(withInstalls, "POST", "/agent-install/kimi");
  check("a start answers 201 with the run", [created.status, created.body?.agent, created.body?.done], [201, "kimi", false]);
  const liveId = created.body?.installId ?? "";
  check("and the listing route hands it back to a client that lost the id", (await call(withInstalls, "GET", "/agent-install")).body?.run?.installId, liveId);
  check("a second start is a conflict that will pass, naming who has it", answered(await call(withInstalls, "POST", "/agent-install/codex")), [409, "install_busy"]);
  check("and the refusal says which run", (await call(withInstalls, "POST", "/agent-install/codex")).body?.error?.detail?.kind, "install");

  spawns.at(-1)?.sink.append("step: kimi start\nagents (kimi only)\n");
  const chunk = await call(withInstalls, "GET", `/agent-install/runs/${liveId}?since=0`);
  check("a poll returns the transcript from the cursor", [chunk.status, chunk.body?.gap, chunk.body?.chunk.includes("kimi only")], [200, false, true]);
  const tail = await call(withInstalls, "GET", `/agent-install/runs/${liveId}?since=${chunk.body?.cursor}`);
  check("and a poll from the end returns nothing new", [tail.body?.chunk, tail.body?.gap], ["", false]);
  check("a cancel is admin's, and frees the slot", (await call(withInstalls, "DELETE", `/agent-install/runs/${liveId}`)).body?.cancelled, true);

  report("the install routes were driven with no agent on the machine", spawns.length > 0, `${spawns.length} stubbed run(s)`);
}
