import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { REVIEW_LOOP_TEXT } from "@reemoat/board";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import { PeerHub, type PeerNetwork } from "../src/peers/hub.js";
import { SessionRegistry, type ManagedSession } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import type { PeerLink } from "../src/store/sqlite.js";
import { TaskDesk } from "../src/tasks/desk.js";
import { MemoryBoardConfigStore, MemoryTaskStore } from "../src/tasks/store.js";
import { check } from "./daemoncheck.env.js";
import { signedClaims, stubAgentConfig, tokenFor, verifier } from "./daemoncheck.fixtures.js";
import { tmp } from "./tmp.js";

// Two daemons in one process, each with its own store and app, linked as the owner's app links them (Q2.269).
process.stdout.write("\nthe board across machines: the coder on a Mac, the reviewer pinned to a server\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

  // One origin, cloned on each machine, its URL the one both name it by.
  const root = tmp("board-fleet-");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" });
  git(seed, "-c", "user.email=b@x", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "start");
  git(seed, "push", "-q", "origin", "main");
  const clone = (name: string): string => {
    const dir = join(root, name);
    execFileSync("git", ["clone", "-q", origin, dir]);
    git(dir, "remote", "set-url", "origin", "https://example.com/acme/app.git");
    git(dir, "config", "user.email", `${name}@x`);
    git(dir, "config", "user.name", name);
    return dir;
  };
  const macRepo = clone("mac");
  const serverRepo = clone("server");

  interface Agent {
    acpId: string;
    prompts: string[];
    held: number[];
    send(message: unknown): void;
  }
  const agents = new Map<string, Agent>();
  let launched = 0;
  const spawn = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let current: Agent | null = null;
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === undefined) continue;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] } });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume: {
            const acpId = message["params"]?.["sessionId"] ?? `c_fleet_${++launched}`;
            current = agents.get(acpId) ?? { acpId, prompts: [], held: [], send };
            current.send = send;
            agents.set(acpId, current);
            send({ jsonrpc: "2.0", id, result: message["method"] === acp.methods.agent.session.new ? { sessionId: acpId } : {} });
            break;
          }
          case acp.methods.agent.session.prompt:
            current?.prompts.push(((message["params"]?.["prompt"] ?? []) as { text: string }[]).map((block) => block.text).join("\n\n"));
            current?.held.push(id);
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };
  class FleetRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "claude", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawn();
    }
  }

  interface Machine {
    id: string;
    name: string;
    registry: SessionRegistry;
    desk: TaskDesk;
    hub: PeerHub;
    app: { fetch(request: Request): Response | Promise<Response> };
    down: boolean;
  }
  const machines = new Map<string, Machine>();
  const linkTo = (from: Machine, to: { id: string; name: string }, scopes: string[]): PeerLink => ({
    id: `lk_${from.id}_${to.id}`,
    targetMachineId: to.id,
    targetName: to.name,
    targetKey: "k",
    relayUrl: null,
    token: signedClaims({ lnk: `lk_${from.id}_${to.id}`, src: from.id, srcl: from.name }, scopes),
    expiresAt: Date.now() + 86_400_000,
    updatedAt: 0,
  });
  const scopesOf = new Map<string, string[]>();
  // Each machine's clock, moved forward to make a retry due without waiting for it.
  const skew = new Map<string, number>();
  const make = (id: string, name: string, other: { id: string; name: string }): Machine => {
    const registry = new SessionRegistry(new MemoryEventStore(), null, { worktreeRoot: tmp(`fleet-wt-${name}-`), branchPrefix: "reemoat", defaultMode: "auto" }, new FleetRuntime(), null);
    const machine = { id, name, down: false } as Machine;
    const network: PeerNetwork = {
      links: () => [linkTo(machine, other, scopesOf.get(id) ?? ["session:message", "task:handoff"])],
      request: async (link, request) => {
        const target = machines.get(link.targetMachineId);
        if (target === undefined || target.down) return { ok: false, status: 503, code: "no_tunnel", relayUrl: null };
        const response = await target.app.fetch(
          new Request(`http://d${request.path}`, {
            method: request.method,
            headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          }),
        );
        const raw = await response.text();
        return { ok: true, status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as unknown) };
      },
    };
    const hub = new PeerHub({ registry, enabled: true, machineId: id, network });
    const desk = new TaskDesk({
      registry,
      store: new MemoryTaskStore(),
      peers: hub,
      configs: new MemoryBoardConfigStore(),
      tickMs: 0,
      machineName: name,
      now: () => Date.now() + (skew.get(id) ?? 0),
      // The server's harness, asked as a judge from the Mac's board, says ship.
      judges: { ask: async () => '{"exit": "ship", "confidence": 0.8}' },
    });
    hub.serveTasks();
    machine.registry = registry;
    machine.desk = desk;
    machine.hub = hub;
    machine.app = createApp({ registry, verifier, instanceId: `i_${id}`, startedAt: Date.now(), peers: { hub, links: { replaceAll: () => {} } as never }, tasks: desk }).app;
    machines.set(id, machine);
    return machine;
  };
  const mac = make("m_mac", "mac", { id: "m_srv", name: "server" });
  const server = make("m_srv", "server", { id: "m_mac", name: "mac" });

  const settle = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (done: () => boolean | Promise<boolean>, ms = 8_000): Promise<boolean> => {
    for (const started = Date.now(); Date.now() - started < ms; ) {
      if (await done()) return true;
      await settle(10);
    }
    return done();
  };
  const agentOf = (managed: ManagedSession): Agent => agents.get(managed.agentSessionId ?? "")!;
  const finish = async (machine: Machine, managed: ManagedSession, report: Record<string, unknown>): Promise<void> => {
    const agent = agentOf(managed);
    await until(() => agent.held.length > 0);
    machine.desk.update(managed.id, report);
    await settle();
    agent.send({ jsonrpc: "2.0", id: agent.held.shift(), result: { stopReason: "end_turn" } });
  };
  const where = (id: string): Machine | null => [...machines.values()].find((one) => one.desk.get(id) !== null) ?? null;
  const runOn = async (machine: Machine, id: string): Promise<ManagedSession> => {
    await until(() => {
      const session = machine.desk.get(id)?.flow.run?.session;
      return session != null && machine.registry.get(session) !== undefined && machine.desk.get(id)?.flow.run?.state === "working";
    });
    return machine.registry.get(machine.desk.get(id)!.flow.run!.session!)!;
  };

  // The server has used its clone before: a session there is how a daemon knows the folder holds the project.
  await server.registry.create({ agent: "claude", cwd: serverRepo, worktree: "never", nickname: "earlier" });
  mac.desk.engine.putBoard(REVIEW_LOOP_TEXT, 0);

  const made = mac.desk.create({ title: "Add the notes", brief: "Write NOTES.md.", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: macRepo, key: null });
  if (made === "full") throw new Error("daemoncheck: full");
  const id = made.task.id;
  mac.desk.move(id, { to: "build" });
  await mac.desk.engine.kick(id);
  const coder = await runOn(mac, id);
  const macWork = mac.desk.get(id)!.flow.workdir!;
  writeFileSync(join(macWork, "NOTES.md"), "notes from the coder\n");
  await finish(mac, coder, { summary: "Wrote NOTES.md.", status: "review" });

  await until(() => server.desk.get(id) !== null);
  check("Review's role is pinned to the server, so the task goes there, with a tombstone left behind", [
    where(id)?.name,
    mac.desk.tombstones().map((stone) => [stone.id === id, stone.movedTo, stone.epoch]),
  ], ["server", [[true, "m_srv", 2]]]);
  check("the server took the board it was placed by from the Mac first", server.desk.engine.current.revision, 1);
  const reviewer = await runOn(server, id);
  const serverWork = server.desk.get(id)!.flow.workdir!;
  check(
    "the reviewer runs on the server, in a worktree of its own clone on the task's branch, which holds the coder's commit",
    [serverWork.startsWith(serverRepo) === false && existsSync(join(serverWork, "NOTES.md")), git(serverWork, "rev-parse", "--abbrev-ref", "HEAD"), git(serverWork, "log", "-1", "--format=%s")],
    [true, mac.desk.engine.current.board.columns.length > 0 ? server.desk.get(id)!.flow.code!.branch : "", "board: build #2 claude@mac"],
  );
  check("in a new conversation, sent the skill", agentOf(reviewer).prompts[0]?.split("\n")[0], "/review");
  writeFileSync(join(serverWork, "NOTES.md"), "notes from the coder\nand a fix from the reviewer\n");
  await finish(server, reviewer, { summary: "One fix made.", outcome: "fix" });

  await until(() => mac.desk.get(id) !== null && mac.desk.get(id)?.flow.run?.state === "working");
  const back = mac.desk.get(id)!;
  check("fix sends it back to the coder's machine, at the next epoch, and the server keeps a tombstone", [where(id)?.name, back.flow.epoch, server.desk.tombstones()[0]?.movedTo], ["mac", 3, "m_mac"]);
  await until(() => agentOf(coder).prompts.length === 2);
  check(
    "the coder continues its own conversation, on its worktree moved forward to the reviewer's commit",
    [agentOf(coder).prompts[1]?.split("\n")[0], readFileSync(join(macWork, "NOTES.md"), "utf8"), git(macWork, "log", "-1", "--format=%s")],
    ["The task came back from Review (fix): One fix made.", "notes from the coder\nand a fix from the reviewer\n", "board: review #3 claude@server"],
  );
  check(
    "the history travelled with it",
    mac.desk.history(id).filter((one) => one.kind === "moved").map((one) => one.text),
    ["Backlog → Build by you", "Build → Review by auto", "the run goes to claude@server: the role is pinned there", "came from mac to run here", "Review → Build (fix) by self", "the run goes to claude@mac: continues its conversation", "came from server to run here"],
  );

  process.stdout.write("  the machine with the code away, and a copy that is older\n");
  const stale = await mac.app.fetch(
    new Request(`http://d/peer/tasks/${id}/handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${linkTo(server, mac, ["session:message", "task:handoff"]).token}`, "content-type": "application/json" },
      body: JSON.stringify(mac.desk.engine.handoffPayload(mac.desk.get(id)!, 2, "mac")),
    }),
  );
  check("a copy at an older epoch is refused where a newer one is", [stale.status, ((await stale.json()) as any).error.code], [409, "task_stale"]);
  const noScope = await mac.app.fetch(
    new Request(`http://d/peer/tasks/${id}/handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${linkTo(server, mac, ["session:message"]).token}`, "content-type": "application/json" },
      body: "{}",
    }),
  );
  check("and a link without task:handoff moves nothing", noScope.status, 403);

  await finish(mac, coder, { summary: "Fixed.", status: "review" });
  // The review goes back to the server, which still has the code: the coder's machine goes away before the next fix comes home.
  await until(() => server.desk.get(id)?.flow.run?.state === "working");
  const reviewer2 = await runOn(server, id);
  mac.down = true;
  await finish(server, reviewer2, { summary: "Still one thing.", outcome: "fix" });
  await until(() => server.desk.get(id)?.flow.handoff != null);
  check("its run cannot go to a machine that is away: the move waits and is tried again", [where(id)?.name, server.desk.snapshot(server.desk.get(id)!).phase], ["server", "moving"]);
  mac.down = false;
  skew.set("m_srv", 60_000);
  await server.desk.engine.kick(id);
  await until(() => mac.desk.get(id)?.flow.run?.state === "working");
  check("and goes once it is back", [where(id)?.name, mac.desk.get(id)?.flow.epoch], ["mac", 5]);

  // The coder's machine holds the code and goes away as the review is handed to the server.
  const coder3 = await runOn(mac, id);
  writeFileSync(join(macWork, "NOTES.md"), "notes from the coder\nand a fix from the reviewer\nand one more from the coder\n");
  mac.down = true;
  await finish(mac, coder3, { summary: "Fixed again.", status: "review" });
  await until(() => server.desk.get(id) !== null && server.desk.get(id)?.flow.wait?.reason === "code_holder_offline");
  const waiting = server.desk.get(id)!;
  check("with the machine holding the code away, the run waits for it and says so", [waiting.flow.wait?.reason, waiting.flow.wait?.detail], [
    "code_holder_offline",
    "waiting for mac, which has the code",
  ]);
  mac.down = false;
  await server.desk.engine.kick(id);
  const reviewer3 = await runOn(server, id);
  check("and once it is back the code comes and the run starts", [reviewer3.status === "running" || reviewer3.status === "idle", readFileSync(join(server.desk.get(id)!.flow.workdir!, "NOTES.md"), "utf8").includes("one more from the coder")], [true, true]);

  const asked = await server.app.fetch(
    new Request("http://d/peer/judge", {
      method: "POST",
      headers: { authorization: `Bearer ${linkTo(mac, server, ["session:message", "task:handoff"]).token}`, "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude",
        model: null,
        title: "Add the notes",
        column: "Review",
        exits: [{ name: "fix", means: "problems", label: "fix" }, { name: "ship", means: "fine", label: "ship" }],
        sees: ["report"],
        context: { report: "One fix made." },
      }),
    }),
  );
  const verdict = (await asked.json()) as { exit?: unknown; confidence?: unknown };
  check("a role asked on another machine answers from there, read as strictly as here", [asked.status, verdict.exit, verdict.confidence], [200, "ship", 0.8]);

  scopesOf.set("m_mac", ["session:message"]);
  check("a link that does not carry task:handoff offers no machine to place a run on", (await mac.desk["fleet"]()).length, 0);
  void tokenFor;
}
