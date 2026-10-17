import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
    /** Where its runs without code get their folders. */
    runs: string;
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
    const machine = { id, name, down: false, runs: tmp(`fleet-runs-${name}-`) } as Machine;
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
      codelessRoot: machine.runs,
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

  process.stdout.write("  work left out of the branch, and a column that needs no code (Q2.271)\n");
  // A commit hook that refuses, set on the Mac's clone and so on every worktree of it; an empty folder of hooks takes it back.
  const hooks = tmp("fleet-hooks-");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n", { mode: 0o755 });
  const noHooks = tmp("fleet-nohooks-");
  git(macRepo, "config", "core.hooksPath", hooks);
  mac.desk.engine.putBoard(
    REVIEW_LOOP_TEXT.replace(
      "  cheap:    { agent: claude, model: haiku }\n",
      "  cheap:    { agent: claude, model: haiku }\n  maker:    { agent: claude, on: mac }\n  deployer: { agent: claude, on: server }\n  checker:  { agent: claude, on: server }\n",
    ) +
      "  - { id: make, title: Make, run: { role: maker }, next: ship }\n" +
      "  - { id: ship, title: Ship, run: { role: deployer, code: none, done_when: turn }, next: verify }\n" +
      "  - { id: verify, title: Verify, run: { role: checker, conversation: new, done_when: turn } }\n",
    mac.desk.engine.current.revision,
  );

  const second = mac.desk.create({ title: "Add the changelog", brief: "Write CHANGES.md.", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: macRepo, key: null });
  if (second === "full") throw new Error("daemoncheck: full");
  const id2 = second.task.id;
  mac.desk.move(id2, { to: "build" });
  await mac.desk.engine.kick(id2);
  const coder2 = await runOn(mac, id2);
  const macWork2 = mac.desk.get(id2)!.flow.workdir!;
  writeFileSync(join(macWork2, "CHANGES.md"), "a change\n");
  await finish(mac, coder2, { summary: "Wrote CHANGES.md.", status: "review" });
  await until(() => mac.desk.get(id2)?.flow.ask?.reason === "code_dirty");
  const held = mac.desk.get(id2)!;
  check(
    "a hook that refuses the commit keeps the task on its machine, needing its person, with the hook's words",
    [where(id2)?.name, held.flow.column, held.flow.run?.state, held.flow.ask?.detail.startsWith("the task's code here could not be committed, so it does not go to server:"), held.flow.ask?.detail.includes("lint says no")],
    ["mac", "review", "failed", true, true],
  );
  check("and nothing of it reached the server", [server.desk.get(id2), git(serverRepo, "branch", "--list", held.flow.code!.branch)], [null, ""]);

  git(macRepo, "config", "core.hooksPath", noHooks);
  mac.desk.move(id2, { to: "review" });
  await until(() => server.desk.get(id2)?.flow.run?.state === "working");
  const serverWork2 = server.desk.get(id2)!.flow.workdir!;
  check(
    "fixed and retried, what was left is committed before the move, and the server has it",
    [
      where(id2)?.name,
      mac.desk.tombstones().some((stone) => stone.id === id2),
      server.desk.history(id2).some((one) => one.text === "what was left in the task's worktree was committed before the move to server"),
      readFileSync(join(serverWork2, "CHANGES.md"), "utf8"),
      git(serverWork2, "log", "-1", "--format=%s"),
    ],
    ["server", true, true, "a change\n", "board: before the move to server"],
  );

  git(macRepo, "config", "core.hooksPath", hooks);
  const third = mac.desk.create({ title: "Ship the release", brief: "Write SHIP.md.", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: macRepo, key: null });
  if (third === "full") throw new Error("daemoncheck: full");
  const id3 = third.task.id;
  mac.desk.move(id3, { to: "make" });
  await mac.desk.engine.kick(id3);
  const maker = await runOn(mac, id3);
  const macWork3 = mac.desk.get(id3)!.flow.workdir!;
  writeFileSync(join(macWork3, "SHIP.md"), "shipped\n");
  await finish(mac, maker, { summary: "Wrote SHIP.md.", status: "review" });
  await until(() => server.desk.get(id3)?.flow.run?.state === "working");
  const shipping = server.desk.get(id3)!;
  const deployer = server.registry.get(shipping.flow.run!.session!)!;
  check(
    "a column with no code goes even with the work uncommitted: nothing of the code goes with it",
    [where(id3)?.name, shipping.flow.column, shipping.flow.workdir, git(serverRepo, "branch", "--list", shipping.flow.code!.branch)],
    ["server", "ship", null, ""],
  );
  check(
    "its run works in an empty folder of the task's own, made under the machine's root",
    [realpathSync(deployer.workspace.root) === realpathSync(join(server.runs, id3)), deployer.workspace.mode, deployer.workspace.git],
    [true, "plain", null],
  );

  await finish(server, deployer, { summary: "Shipped." });
  await until(() => server.desk.get(id3)?.flow.ask?.reason === "code_dirty");
  const refused = server.desk.get(id3)!;
  check(
    "the next column needs the code, and the Mac will not hand over a worktree with work left out of it",
    [refused.flow.column, refused.flow.run?.state, refused.flow.ask?.detail],
    ["verify", "failed", "the task's code on mac is not all on its branch: 1 file(s) not committed: SHIP.md"],
  );

  // Its person commits on the Mac by hand: the branch moves past the head the task names, and the server must take that one.
  git(macRepo, "config", "core.hooksPath", noHooks);
  git(macWork3, "add", "-A");
  git(macWork3, "commit", "-q", "-m", "by hand");
  const byHand = git(macWork3, "rev-parse", "HEAD");
  server.desk.move(id3, { to: "verify" });
  const checker = await runOn(server, id3);
  const serverWork3 = server.desk.get(id3)!.flow.workdir!;
  check(
    "retried, the code comes, the commit made by hand is the head, and the run starts",
    [checker.status === "running" || checker.status === "idle", readFileSync(join(serverWork3, "SHIP.md"), "utf8"), server.desk.get(id3)!.flow.code?.head === byHand],
    [true, "shipped\n", true],
  );

  process.stdout.write("  a machine by the name its owner gave it, and a task made where its folder is not (Q2.274)\n");
  const { callTaskTool } = await import("../src/tasks/mcp.js");
  const PINNED =
    "version: 1\nroles:\n  dev: { agent: claude@server }\ncolumns:\n  - { id: backlog, title: Backlog }\n" +
    "  - { id: build, title: Build, run: { role: dev }, next: done }\n  - { id: done, title: Done, final: true }\n";
  mac.desk.engine.putBoard(PINNED, mac.desk.engine.current.revision);
  const made4 = (cwd: string) => {
    const one = mac.desk.create({ title: "In the server's folder", brief: "Look around.", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd, key: null });
    if (one === "full") throw new Error("daemoncheck: full");
    mac.desk.move(one.task.id, { to: "build" });
    void mac.desk.engine.kick(one.task.id);
    return one.task.id;
  };
  // A plain folder no session has used: the Mac reads no project from it, and the server lists no such project.
  const plain = tmp("fleet-plain-");
  const id4 = made4(plain);
  await until(() => server.desk.get(id4)?.flow.run?.state === "working");
  const pinnedRun = server.registry.get(server.desk.get(id4)!.flow.run!.session!)!;
  check(
    "a task that has never run goes where its role is pinned, though no machine listed its folder, and starts in it there",
    [where(id4)?.name, realpathSync(pinnedRun.workspace.root) === realpathSync(plain)],
    ["server", true],
  );
  const id5 = made4(join(plain, "gone"));
  await until(() => server.desk.get(id5)?.flow.ask?.reason === "run_failed");
  check(
    "one whose folder that machine does not have either says so in words, not as a failed realpath",
    server.desk.get(id5)?.flow.ask?.detail,
    `the run could not start: its folder ${join(plain, "gone")} is not on this machine`,
  );

  mac.desk.engine.putBoard(PINNED.replace("claude@server", "claude@nowhere"), mac.desk.engine.current.revision);
  const id6 = made4(plain);
  await until(() => mac.desk.get(id6)?.flow.wait?.reason === "no_executor");
  const queued = mac.desk.get(id6)!;
  check(
    "a run no machine takes says why, and its card names the machine it waits for rather than the task's own",
    [queued.flow.wait?.detail, mac.desk.snapshot(queued).holder],
    ["waiting for claude@nowhere: no machine is called nowhere", "claude@nowhere"],
  );
  const got = (await callTaskTool(mac.desk, "s_none", "board_get", {})) as { structuredContent: { machines: { name: string | null; this: boolean }[] } };
  check(
    "board_get lists the machines a role may name, this one by its own name",
    got.structuredContent.machines.map((one) => [one.name, one.this]),
    [["mac", true], ["server", false]],
  );
  const checked = (await callTaskTool(mac.desk, "s_none", "board_check", { text: PINNED.replace("claude@server", "claude@macmini") })) as { structuredContent: { warnings: string[] } };
  check("and board_check warns of a pin to a machine nobody is called", checked.structuredContent.warnings, ['roles.dev: no machine is called "macmini"']);

  // A daemon with no name given at its start learns it from the app, beside its links, and keeps it.
  const settings = new Map<string, string>();
  const named = () => {
    const registry = new SessionRegistry(new MemoryEventStore(), null, { worktreeRoot: tmp("fleet-wt-named-"), branchPrefix: "reemoat", defaultMode: "auto" }, new FleetRuntime(), null);
    const hub = new PeerHub({ registry, enabled: true, machineId: "m_named", policy: { readPolicy: (key) => settings.get(key) ?? null, writePolicy: (key, value) => void settings.set(key, value) } });
    const desk = new TaskDesk({ registry, store: new MemoryTaskStore(), peers: hub, configs: new MemoryBoardConfigStore(), tickMs: 0 });
    return { desk, app: createApp({ registry, verifier, instanceId: "i_named", startedAt: Date.now(), peers: { hub, links: { replaceAll: () => {} } as never }, tasks: desk }).app };
  };
  const first = named();
  const before = first.desk.engine.ownName();
  const put = (body: unknown) =>
    first.app.fetch(new Request("http://d/peers/links", { method: "PUT", headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const wrong = await put({ links: [], self: { name: "" } });
  const right = await put({ links: [], self: { name: "mac" } });
  const again = named();
  check(
    "a daemon learns its name with its links, refuses an empty one, and still has it after a restart",
    [before, wrong.status, right.status, first.desk.engine.ownName(), again.desk.engine.ownName(), first.desk.engine.label({ agent: "claude", customAgent: null, machine: "m_named" })],
    [null, 400, 200, "mac", "mac", "claude@mac"],
  );
  first.desk.engine.stop();
  again.desk.engine.stop();

  scopesOf.set("m_mac", ["session:message"]);
  check("a link that does not carry task:handoff offers no machine to place a run on", (await mac.desk["fleet"]()).length, 0);
  void tokenFor;
}
