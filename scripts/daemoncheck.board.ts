import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { REVIEW_LOOP_LOCAL_TEXT } from "@reemoat/board";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import { PeerHub } from "../src/peers/hub.js";
import { PeerMcpEndpoint } from "../src/peers/mcp.js";
import { SESSION_CREATE_BURST, SessionRegistry, type ManagedSession } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { openStores } from "../src/store/sqlite.js";
import { TaskDesk } from "../src/tasks/desk.js";
import { MemoryBoardConfigStore, MemoryTaskStore } from "../src/tasks/store.js";
import { check } from "./daemoncheck.env.js";
import { stubAgentConfig, tokenFor } from "./daemoncheck.fixtures.js";
import { tmp } from "./tmp.js";

// The configurable board on one machine (Q2.264-Q2.266): runs, exits, judges, the feed, the budget, the limit, a restart, and a commit.
process.stdout.write("\nthe board: columns, runs and exits, on stub agents whose turns the driver ends\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  // Every prompt holds its turn until the driver says what the agent does with it; ASK parks a permission first.
  interface Agent {
    acpId: string;
    prompts: string[];
    mcpServers: any[];
    held: number[];
    send(message: unknown): void;
    awaiting: Map<number, () => void>;
    /** What it publishes, and each set_config_option it was sent, in order. */
    options: any[];
    sets: string[];
  }
  const agents = new Map<string, Agent>();
  // Off but for the one section that needs controls: a published control changes every snapshot after it.
  let publish: (() => any[]) | null = null;
  let launched = 0;
  let outbound = 9000;

  const spawn = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let current: Agent | null = null;
    const awaiting = new Map<number, () => void>();
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === undefined && typeof id === "number") {
          awaiting.get(id)?.();
          awaiting.delete(id);
          continue;
        }
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume: {
            const acpId = message["params"]?.["sessionId"] ?? `c_board_${++launched}`;
            current = agents.get(acpId) ?? { acpId, prompts: [], mcpServers: [], held: [], send, awaiting, options: publish?.() ?? [], sets: [] };
            current.mcpServers = message["params"]?.["mcpServers"] ?? current.mcpServers;
            current.send = send;
            current.awaiting = awaiting;
            current.held = [];
            agents.set(acpId, current);
            const configOptions = current.options.length === 0 ? {} : { configOptions: current.options };
            send({ jsonrpc: "2.0", id, result: message["method"] === acp.methods.agent.session.new ? { sessionId: acpId, ...configOptions } : configOptions });
            break;
          }
          case acp.methods.agent.session.setConfigOption: {
            const { configId, value } = message["params"] ?? {};
            current?.sets.push(`${configId}=${value}`);
            for (const option of current?.options ?? []) if (option.id === configId) option.currentValue = value;
            send({ jsonrpc: "2.0", id, result: { configOptions: current?.options ?? [] } });
            break;
          }
          case acp.methods.agent.session.prompt: {
            const blocks = (message["params"]?.["prompt"] ?? []) as { type: string; text: string }[];
            const text = blocks.map((block) => block.text ?? "").join("\n\n");
            current?.prompts.push(text);
            if (text.startsWith("ASK")) {
              const ask = ++outbound;
              awaiting.set(ask, () => current?.held.push(id));
              send({
                jsonrpc: "2.0",
                id: ask,
                method: "session/request_permission",
                params: {
                  sessionId: current?.acpId,
                  toolCall: { toolCallId: `call-board-${ask}`, title: "deploy to staging", kind: "execute", status: "pending" },
                  options: [
                    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                  ],
                },
              });
              break;
            }
            current?.held.push(id);
            break;
          }
          case acp.methods.agent.session.cancel:
            for (const held of current?.held.splice(0) ?? []) send({ jsonrpc: "2.0", id: held, result: { stopReason: "cancelled" } });
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

  class BoardRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return (["claude", "codex"] as const).map((id) => ({
        id,
        displayName: id,
        available: true,
        installable: false,
        loggedIn: true,
        hint: null,
        lastStartRefusal: null,
      }));
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawn();
    }
  }

  const settle = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (done: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> => {
    for (const started = Date.now(); Date.now() - started < ms; ) {
      if (await done()) return true;
      await settle(10);
    }
    return done();
  };

  const world = (options: { store?: MemoryTaskStore; configs?: MemoryBoardConfigStore } = {}) => {
    // Never the default root: that is the real ~/.reemoat/worktrees.
    const registry = new SessionRegistry(new MemoryEventStore(), null, { worktreeRoot: tmp("board-wt-"), branchPrefix: "reemoat", defaultMode: "auto" }, new BoardRuntime(), null);
    const store = options.store ?? new MemoryTaskStore();
    const hub = new PeerHub({ registry, enabled: true, machineId: "m_self" });
    const desk = new TaskDesk({ registry, store, peers: hub, configs: options.configs ?? new MemoryBoardConfigStore(), tickMs: 0, machineName: "mac" });
    hub.serveTasks();
    return { registry, store, hub, desk };
  };

  const { registry, store, hub, desk } = world();
  const endpoint = await PeerMcpEndpoint.listen(hub, desk);
  hub.setEndpoint(endpoint.url);
  registry.setPeerMcpServers((id, caps) => hub.mcpServersFor(id, caps));
  const { app } = createApp({ registry, instanceId: "i_board", startedAt: Date.now(), peers: null, tasks: desk, verifier: (await import("./daemoncheck.fixtures.js")).verifier });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.fetch(
      new Request(`http://d${path}`, {
        method,
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };
  const said = (answer: { status: number; body: any }): string => `${answer.status}${answer.body?.error?.code ? ` ${answer.body.error.code}` : ""}`;
  const taskOf = async (id: string): Promise<any> => (await call("GET", "/tasks")).body.tasks.find((task: any) => task.id === id);
  const agentOf = (managed: ManagedSession): Agent => agents.get(managed.agentSessionId ?? "")!;
  const runSession = async (id: string): Promise<ManagedSession> => {
    await until(async () => (await taskOf(id))?.run?.session != null && registry.get((await taskOf(id)).run.session) !== undefined);
    return registry.get((await taskOf(id)).run.session)!;
  };
  /** The board takes its step a tick after the session's event: read once three reads in a row agree. */
  const settled = async (id: string): Promise<any> => {
    let last = JSON.stringify(await taskOf(id));
    for (let calm = 0, tries = 0; calm < 3 && tries < 300; tries += 1) {
      await settle(10);
      const now = JSON.stringify(await taskOf(id));
      calm = now === last ? calm + 1 : 0;
      last = now;
    }
    return JSON.parse(last);
  };

  let rpcId = 0;
  const tool = async (managed: ManagedSession, name: string, args: unknown = {}) => {
    const server = agentOf(managed).mcpServers[0];
    const authorization = server?.headers?.find((h: any) => h.name === "Authorization")?.value ?? "";
    // The endpoint the agent was handed, which is its own world's.
    const response = await fetch(server?.url ?? endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await response.json()) as any).result;
  };
  /** The agent's turn ends, after it says something and reports, as the driver tells it to. */
  const finish = async (managed: ManagedSession, options: { say?: string; report?: Record<string, unknown> } = {}): Promise<void> => {
    const agent = agentOf(managed);
    await until(() => agent.held.length > 0);
    if (options.say !== undefined) {
      agent.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: agent.acpId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: options.say } } },
      });
    }
    if (options.report !== undefined) await tool(managed, "task_update", options.report);
    await settle();
    agent.send({ jsonrpc: "2.0", id: agent.held.shift(), result: { stopReason: "end_turn" } });
  };

  const work = tmp("board-work-");
  check("a daemon with no board written runs the default, at revision 0", [(await call("GET", "/board")).body.revision, (await call("GET", "/board")).body.board.intake], [0, "backlog"]);
  check("GET /tasks says this daemon runs the board", [(await call("GET", "/tasks")).body.board, (await call("GET", "/tasks")).body.boardRevision], [1, 0]);

  process.stdout.write("  writing the board\n");
  const bad = await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT.replace("to: build,   means", "to: buidl,   means"), { "content-type": "text/yaml", "if-match": "0" });
  check("a board that does not parse is refused with every line it fails on", [said(bad), bad.body.error.detail.errors.map((one: any) => one.text)], [
    "400 board_invalid",
    ['19:19 columns[3].next.fix.to: there is no column "buidl"'],
  ]);
  const stale = await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT, { "content-type": "text/yaml", "if-match": "4" });
  check("one written against a revision that is not the current one is a conflict that says which is", [said(stale), stale.body.error.detail.revision], ["409 board_revision", 0]);
  const put = await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT, { "content-type": "text/yaml", "if-match": "0" });
  const again = await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT, { "content-type": "text/yaml", "if-match": "1" });
  check("the reference loop is taken as revision 1, and the same text again is no new revision", [put.status, put.body.revision, again.body.revision, again.body.changed], [200, 1, 1, false]);
  check("the text is kept as written, comments included", (await call("GET", "/board")).body.text.includes("# ends on the coder's report"), true);

  process.stdout.write("  the loop: build, review, fix, build, review, you pick ship, approve, merge\n");
  const made = await call("POST", "/tasks", { title: "Fix the login", brief: "The login button does nothing.", agent: "claude", cwd: work });
  const id = made.body.task.id;
  check("a new task lands in the intake", [made.status, made.body.task.column, made.body.task.phase, made.body.task.status], [201, "backlog", "waiting", "ready"]);
  const entered = await call("POST", `/tasks/${id}/move`, { to: "build", from: "backlog" });
  check("a person moves it into Build", [entered.status, entered.body.task.column], [200, "build"]);
  const coder = await runSession(id);
  check("Build's run starts the coder, handed the brief and the note", agentOf(coder).prompts[0]?.startsWith("The login button does nothing.\n\n<board-task>"), true);
  check("while it works the task is working, which an older client reads as running", [(await taskOf(id)).phase, (await taskOf(id)).status, (await taskOf(id)).run.executor], ["working", "running", "claude@mac"]);
  await finish(coder, { say: "Fixed the handler.", report: { summary: "Handler wired up.", status: "review" } });
  const inReview = await settled(id);
  check("its report ends the run and its one exit takes it to Review", [inReview.column, inReview.run?.state], ["review", "working"]);
  const reviewer = await runSession(id);
  check("Review opens a new conversation with the skill as a slash command", [reviewer.id !== coder.id, agentOf(reviewer).prompts[0]?.split("\n")[0]], [true, "/review"]);
  check("and its note lists the exits with what each means, and carries the brief", [/- fix: /.test(agentOf(reviewer).prompts[0]!), agentOf(reviewer).prompts[0]!.includes("The login button does nothing.")], [true, true]);
  await finish(reviewer, { report: { summary: "Two bugs left.", outcome: "fix" } });
  const fixing = await settled(id);
  check("the reviewer naming fix sends it back to Build", fixing.column, "build");
  await until(() => agentOf(coder).prompts.length === 2);
  check("into the coder's own conversation, with the return hint", agentOf(coder).prompts[1]?.split("\n")[0], "The task came back from Review (fix): Two bugs left.");
  check("a report from the reviewer's old run moves nothing", [(await tool(reviewer, "task_update", { status: "review" })).isError === true, (await settled(id)).column], [false, "build"]);
  await finish(coder, { report: { summary: "Both fixed.", status: "review" } });
  await until(async () => (await taskOf(id)).column === "review" && (await taskOf(id)).run?.state === "working");
  const reviewer2 = await runSession(id);
  check("the second review is a conversation of its own too", [reviewer2.id !== reviewer.id, reviewer2.id !== coder.id], [true, true]);
  await finish(reviewer2, { say: "Looks fine to me." });
  const choosing = await settled(id);
  check(
    "a reviewer who names nothing, and a role that does not decide, leave the pick to you",
    [choosing.column, choosing.phase, choosing.status, choosing.exits.map((exit: any) => exit.name)],
    ["review", "needs_you", "needs_you", ["fix", "ship"]],
  );
  check("a move from where the task no longer is is refused", said(await call("POST", `/tasks/${id}/move`, { exit: "ship", from: "build" })), "409 task_moved");
  const shipped = await call("POST", `/tasks/${id}/move`, { exit: "ship", from: "review" });
  check("your ship takes it to Approve, held by you", [shipped.status, (await settled(id)).column, (await taskOf(id)).holder, (await taskOf(id)).exits.map((exit: any) => exit.label)], [
    200,
    "approve",
    "you",
    ["Merge", "Request changes"],
  ]);
  check("an exit Approve does not have is refused", said(await call("POST", `/tasks/${id}/move`, { exit: "ship", from: "approve" })), "400 bad_request");
  await call("POST", `/tasks/${id}/move`, { exit: "merge", from: "approve" });
  const merged = await settled(id);
  check("Merge closes it", [merged.column, merged.status], ["done", "done"]);
  const history = (await call("GET", `/tasks/${id}/comments`)).body.events.filter((event: any) => event.kind === "moved").map((event: any) => event.text);
  check("the history says each move and who made it", history, [
    "Backlog → Build by you",
    "Build → Review by auto",
    "Review → Build (fix) by self",
    "Build → Review by auto",
    "Review → Approve (ship) by you",
    "Approve → Done (merge) by you",
  ]);
  check("and a role that did not decide is in it", (await call("GET", `/tasks/${id}/comments`)).body.events.some((event: any) => event.kind === "verdict" && event.by === "cheap"), true);

  process.stdout.write("  a question holds the run; one request, answered from the feed or the chat\n");
  const asking = (await call("POST", "/tasks", { title: "Deploy", brief: "ASK then deploy.", agent: "claude", cwd: work })).body.task.id;
  await call("POST", `/tasks/${asking}/move`, { to: "build" });
  const asker = await runSession(asking);
  await until(() => asker.status === "blocked");
  const blocked = await settled(asking);
  check("a question needs you and moves nothing", [blocked.column, blocked.phase, blocked.run.state], ["build", "needs_you", "working"]);
  const feed = (await call("GET", `/tasks/${asking}/comments`)).body.comments.filter((one: any) => one.kind === "question");
  const pending = asker.snapshot().pendingPermissions[0]!;
  check(
    "the feed holds a window on the session's own request, open",
    [feed.length, feed[0]?.sessionId, feed[0]?.request, feed[0]?.state, feed[0]?.pending?.permissionId],
    [1, asker.id, { kind: "permission", id: pending.permissionId }, "open", pending.permissionId],
  );
  // The feed's card answers by the session's own route, the one the chat's card uses: there is one request, so one answer.
  await call("POST", `/sessions/${asker.id}/permissions/${pending.permissionId}`, { decision: "allow" });
  const answered = (await call("GET", `/tasks/${asking}/comments`)).body.comments.find((one: any) => one.kind === "question");
  check("answered, the window closes by itself", answered.state, "closed");
  check("and a second answer to it is the repeat the chat would get", said(await call("POST", `/sessions/${asker.id}/permissions/${pending.permissionId}`, { decision: "allow" })), "409");
  await finish(asker, { report: { summary: "Deployed.", status: "review" } });
  check("the run goes on to its report", (await settled(asking)).column, "review");

  process.stdout.write("  a turn without a report stops; your comment continues the same run\n");
  const quiet = (await call("POST", "/tasks", { title: "Rotate keys", brief: "Rotate the keys.", agent: "claude", cwd: work })).body.task.id;
  await call("POST", `/tasks/${quiet}/move`, { to: "build" });
  const quietly = await runSession(quiet);
  await finish(quietly, { say: "Which keys: staging or production?" });
  const stopped = await settled(quiet);
  const stop = (await call("GET", `/tasks/${quiet}/comments`)).body.comments.find((one: any) => one.kind === "stop");
  check("a stop: still in Build, needing you, with the agent's last message in the feed", [stopped.column, stopped.phase, stop?.text], ["build", "needs_you", "Which keys: staging or production?"]);
  const reply = await call("POST", `/tasks/${quiet}/comments`, { text: "Staging only." });
  check("your comment goes into the run's conversation, as your message", [reply.status, reply.body.comment.delivered], [201, true]);
  await until(() => agentOf(quietly).prompts.length === 2);
  check("the same conversation, the same run", [agentOf(quietly).prompts[1], (await taskOf(quiet)).run.n === stopped.run.n], ["Staging only.", true]);
  await finish(quietly, { report: { summary: "Staging rotated.", status: "review" } });
  check("and it reaches its exit", (await settled(quiet)).column, "review");
  const later = (await call("POST", "/tasks", { title: "Later", brief: "Not yet.", agent: "claude", assignee: "nobody", cwd: work })).body.task.id;
  await call("POST", `/tasks/${later}/comments`, { text: "Use the new client." });
  const laterMoved = await call("POST", `/tasks/${later}/move`, { to: "build" });
  check("let go in Build, it is held by the agent its run is for, before that run is placed too", /^claude(@mac)?$/.test(laterMoved.body.task.holder), true);
  const laterRun = await runSession(later);
  check("a comment with no run at work waits for the next run's note", agentOf(laterRun).prompts[0]?.includes("- Use the new client."), true);
  check("a task nobody was named on is the agent's that ran it from then on", [(await taskOf(later)).assignee, (await taskOf(later)).agent], ["agent", "claude"]);
  await finish(laterRun, { report: { status: "review" } });

  process.stdout.write("  what a move may do while the agent works\n");
  const busy = (await call("POST", "/tasks", { title: "Busy", brief: "Work.", agent: "claude", cwd: work })).body.task.id;
  await call("POST", `/tasks/${busy}/move`, { to: "build" });
  const busyRun = await runSession(busy);
  check(
    "while its run works a task goes nowhere but a final column",
    [said(await call("POST", `/tasks/${busy}/move`, { to: "approve" })), said(await call("PATCH", `/tasks/${busy}`, { status: "review" }))],
    ["409 task_working", "409 task_working"],
  );
  const stopMove = await call("POST", `/tasks/${busy}/move`, { to: "approve", stop: true });
  check("stopping it first moves it", [stopMove.status, (await settled(busy)).column], [200, "approve"]);
  check("and its conversation is still there", busyRun.terminal, false);

  process.stdout.write("  the budget stops a loop\n");
  const loopText = REVIEW_LOOP_LOCAL_TEXT.replace("budget: 8", "budget: 3");
  await call("PUT", "/board", loopText, { "content-type": "text/yaml" });
  const looping = (await call("POST", "/tasks", { title: "Loop", brief: "Loop.", agent: "claude", cwd: work })).body.task.id;
  await call("POST", `/tasks/${looping}/move`, { to: "build" });
  for (let round = 0; round < 2; round += 1) {
    const builder = await runSession(looping);
    await finish(builder, { report: { status: "review" } });
    await until(async () => (await taskOf(looping)).column === "review" && (await taskOf(looping)).run?.session !== builder.id);
    const critic = await runSession(looping);
    await finish(critic, { report: { outcome: "fix" } });
    await settled(looping);
    if ((await taskOf(looping)).phase === "needs_you") break;
  }
  const spent = await settled(looping);
  check("three automatic moves, then it waits for you where it stands", [spent.phase, spent.reason, spent.budget], [
    "needs_you",
    "the board moved this task as many times in a row as it may without you",
    0,
  ]);
  await call("POST", `/tasks/${looping}/comments`, { text: "Carry on." });
  check("anything you do on it gives the budget back", (await settled(looping)).budget > 0, true);

  process.stdout.write("  the limit queues\n");
  await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT.replace("limit: 3", "limit: 1"), { "content-type": "text/yaml" });
  const one = (await call("POST", "/tasks", { title: "One", brief: "First.", agent: "claude", cwd: work })).body.task.id;
  const two = (await call("POST", "/tasks", { title: "Two", brief: "Second.", agent: "claude", cwd: work })).body.task.id;
  for (const busyTask of [busy, looping]) await call("PATCH", `/tasks/${busyTask}`, { status: "done" });
  await call("POST", `/tasks/${one}/move`, { to: "build" });
  const first = await runSession(one);
  await call("POST", `/tasks/${two}/move`, { to: "build" });
  const queued = await settled(two);
  check("a second task waits for the column's one slot here", [queued.phase, queued.status, queued.reason], ["queued", "running", "Build runs 1 at once here"]);
  await finish(first, { report: { status: "review" } });
  await settled(one);
  await desk.engine.kick(two);
  const freed = await settled(two);
  check("and takes it once the first run is over", [freed.phase, freed.run?.state], ["working", "working"]);
  await finish(await runSession(two), { report: { status: "review" } });

  process.stdout.write("  a working column with nobody to run it, until somebody is named there\n");
  await call("PUT", "/board", "version: 1\ncolumns:\n  - { id: backlog, title: Backlog }\n  - { id: build, title: Build, run: {}, next: review }\n  - { id: review, title: Review, holder: you }\n", { "content-type": "text/yaml" });
  const orphan = (await call("POST", "/tasks", { title: "Orphan", brief: "Nobody yet.", agent: "claude", assignee: "nobody", cwd: work })).body.task.id;
  await call("POST", `/tasks/${orphan}/move`, { to: "build" });
  const unnamed = await settled(orphan);
  check("a run that names nobody, on a task nobody holds, asks for an agent and is held by nobody", [unnamed.column, unnamed.phase, unnamed.reason, unnamed.holder], ["build", "needs_you", "assign an agent", "nobody"]);
  // Every section before this one started sessions on the same registry: room for this one's start.
  registry.setSessionLimits({ burst: SESSION_CREATE_BURST * 2 });
  await call("PATCH", `/tasks/${orphan}`, { agent: "claude" });
  const orphanRun = await runSession(orphan);
  const startedThere = await taskOf(orphan);
  check("naming an agent there starts its run, with no move", [startedThere.column, startedThere.phase, startedThere.run?.state, startedThere.reason, startedThere.assignee], ["build", "working", "working", null, "agent"]);
  await finish(orphanRun, { report: { summary: "Nothing to change.", status: "review" } });
  check("its report takes it to Review, which waits on you", (await settled(orphan)).column, "review");
  const redo = await call("POST", `/tasks/${orphan}/comments`, { text: "Do it again, please." });
  check("your comment there reaches its agent: the task goes back to the run's column", [redo.status, redo.body.comment.delivered, (await settled(orphan)).column], [201, true, "build"]);
  await until(() => agentOf(orphanRun).prompts.length === 2);
  check(
    "into the same conversation, with the return hint and your words in the note",
    [agentOf(orphanRun).prompts[1]?.split("\n")[0], agentOf(orphanRun).prompts[1]?.includes("- Do it again, please.")],
    ["The task came back from Review: Nothing to change.", true],
  );
  const commentHistory = (await call("GET", `/tasks/${orphan}/comments`)).body.events.filter((event: any) => event.kind === "moved").map((event: any) => event.text);
  check("and the history says you sent it back", commentHistory.at(-1), "Review → Build by you");
  await finish(orphanRun, { report: { status: "review" } });
  await settled(orphan);
  await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT.replace("limit: 3", "limit: 1"), { "content-type": "text/yaml" });

  process.stdout.write("  the board's own tools: read, check, walk on paper, and a card that changes nothing until Apply\n");
  const got = await tool(coder, "board_get");
  check("board_get answers the YAML as written, its revision and the columns in words", [
    got.structuredContent.revision,
    got.structuredContent.text.includes("limit: 1"),
    /- review "Review": runs reviewer with \/review in a new conversation, done on its turn's end; exits fix → build, ship → approve, decided by self, cheap, human\./.test(got.content[0].text),
  ], [(await call("GET", "/board")).body.revision, true, true]);
  const checked = await tool(coder, "board_check", { text: "version: 1\ncolumns: [{ id: a, title: A, next: b }]\n" });
  check("board_check names every line a draft fails on, and is no error", [checked.isError === true, checked.structuredContent.errors], [false, ['2:36 columns[0].next: there is no column "b"']]);
  const walked = await tool(coder, "board_simulate", { script: ["move build", "report", "outcome fix", "report", "silent", "cheap ship 0.9", "press merge"] });
  check("board_simulate walks a task by the daemons' own rules", walked.structuredContent.trail.filter((line: string) => line.includes("→")), [
    "Backlog → Build by you",
    "Build → Review by auto",
    "Review → Build (fix) by self",
    "Build → Review by auto",
    "Review → Approve (ship) by cheap",
    "Approve → Done (merge) by you",
  ]);
  const before = (await call("GET", "/board")).body;
  const draft = before.text.replace("limit: 1", "limit: 2");
  check(
    "board_propose refuses a board that does not parse, and the board as it is",
    [(await tool(coder, "board_propose", { text: "version: 2\n", why: "x" })).isError, (await tool(coder, "board_propose", { text: before.text, why: "x" })).isError],
    [true, true],
  );
  const proposed = await tool(coder, "board_propose", { text: draft, why: "Two builds at once." });
  const card = coder.log.read(0, 100_000, 1 << 26).map((one) => one.event).find((event) => event.type === "board_proposed");
  check(
    "board_propose puts one card in the transcript against the current revision, and the board is unchanged",
    [proposed.isError === true, card?.type === "board_proposed" ? [card.revision, card.hash === before.hash, card.text === draft, card.why] : null, (await call("GET", "/board")).body.revision],
    [false, [before.revision, true, true, "Two builds at once."], before.revision],
  );
  const proposedTasks = await tool(coder, "propose_tasks", { tasks: [{ title: "Reviewed", brief: "Review it.", project: work, column: "review", role: "reviewer" }] });
  const proposalCard = coder.log.read(0, 100_000, 1 << 26).map((one) => one.event).find((event) => event.type === "tasks_proposed");
  check(
    "propose_tasks takes a column and a role, and the role's agent where none is named",
    [proposedTasks.isError === true, proposalCard?.type === "tasks_proposed" ? [proposalCard.proposals[0]?.column, proposalCard.proposals[0]?.role, proposalCard.proposals[0]?.agent] : null],
    [false, ["review", "reviewer", "claude"]],
  );
  check(
    "and refuses a column or a role the board does not have",
    [
      (await tool(coder, "propose_tasks", { tasks: [{ title: "x", brief: "x", project: work, column: "chats" }] })).isError,
      (await tool(coder, "propose_tasks", { tasks: [{ title: "x", brief: "x", project: work, role: "boss" }] })).isError,
    ],
    [true, true],
  );

  process.stdout.write("  a task whose column the board drops\n");
  const stranded = (await call("POST", "/tasks", { title: "Stranded", brief: "Wait.", agent: "claude", cwd: work })).body.task.id;
  await call("POST", `/tasks/${stranded}/move`, { to: "approve" });
  await call("PUT", "/board", REVIEW_LOOP_LOCAL_TEXT.replace("  - id: approve\n    title: Approve\n    holder: you\n    next:\n      merge:   { to: done,  label: Merge }\n      changes: { to: build, label: Request changes }\n", "").replace("ship: { to: approve,", "ship: { to: done,"), {
    "content-type": "text/yaml",
  });
  const dropped = await settled(stranded);
  check("goes back to the intake, and the history says why", [dropped.column, (await call("GET", `/tasks/${stranded}/comments`)).body.events.at(-1)?.text], [
    "backlog",
    "approve → Backlog: the board no longer has that column",
  ]);

  process.stdout.write("  a role's model, effort and mode, set on its agent as each of its runs starts\n");
  {
    publish = () => [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] },
      { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
    ];
    const lensed = world();
    const lensEndpoint = await PeerMcpEndpoint.listen(lensed.hub, lensed.desk);
    lensed.hub.setEndpoint(lensEndpoint.url);
    lensed.registry.setPeerMcpServers((sid, caps) => lensed.hub.mcpServersFor(sid, caps));
    const coderLine = "coder:    { agent: claude }";
    lensed.desk.engine.putBoard(REVIEW_LOOP_LOCAL_TEXT.replace(coderLine, 'coder:    { agent: claude, model: opus, effort: High, mode: plan, instructions: "Test first." }'), 0);
    const made = lensed.desk.create({ title: "Lens", brief: "Lens.", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: work, key: null, column: "build" });
    if (made === "full") throw new Error("daemoncheck: full");
    const lensId = made.task.id;
    await lensed.desk.engine.kick(lensId);
    const runOf = (): ManagedSession => lensed.registry.get(lensed.desk.get(lensId)!.flow.run!.session!)!;
    const coded = runOf();
    await until(() => agentOf(coded).prompts.length === 1);
    check("the model, the effort matched by its name, then the mode", agentOf(coded).sets, ["model=opus", "effort=high", "mode=plan"]);
    check("and the run's note carries the role's instructions", agentOf(coded).prompts[0]?.includes("Test first."), true);

    await coded.setMode("default");
    await finish(coded, { report: { summary: "Built.", status: "review" } });
    await until(() => lensed.desk.get(lensId)?.flow.column === "review" && lensed.desk.get(lensId)?.flow.run?.session != null);
    const reviewed = runOf();
    check("a role with none of them sets nothing", agentOf(reviewed).sets, []);
    await finish(reviewed, { report: { summary: "One bug.", outcome: "fix" } });
    await until(() => agentOf(coded).prompts.length === 2);
    check(
      "back in the coder's conversation the mode its person changed is the role's again, and an effort already held is not sent",
      agentOf(coded).sets,
      ["model=opus", "effort=high", "mode=plan", "mode=default", "model=opus", "mode=plan"],
    );

    lensed.desk.engine.putBoard(REVIEW_LOOP_LOCAL_TEXT.replace(coderLine, "coder:    { agent: claude, effort: max, mode: yolo }"), lensed.desk.engine.current.revision);
    const other = lensed.desk.create({ title: "Unknown", brief: "x", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: work, key: null, column: "build" });
    if (other === "full") throw new Error("daemoncheck: full");
    await lensed.desk.engine.kick(other.task.id);
    const unknown = lensed.registry.get(lensed.desk.get(other.task.id)!.flow.run!.session!)!;
    await until(() => agentOf(unknown).prompts.length === 1);
    check(
      "a choice the agent does not offer is left, the history says so, and the run goes on",
      [agentOf(unknown).sets, lensed.desk.history(other.task.id).filter((one) => one.kind === "note").map((one) => one.text)],
      [[], ["claude offers no effort called max, so it was not set", "claude offers no mode called yolo, so it was not set"]],
    );
    publish = null;
  }

  process.stdout.write("  roles that decide: a harness asked once, a classifier, and what each abstains on\n");
  // One reviewer, then the cheap harness, then a classifier with a floor, then you.
  const asked: { agent: string; prompt: string; model: string | null; effort: string | null }[] = [];
  let harnessSays = "";
  let classifierSays: unknown = null;
  const judging = world({ configs: new MemoryBoardConfigStore() });
  const judgeDesk = new TaskDesk({
    registry: judging.registry,
    store: new MemoryTaskStore(),
    peers: judging.hub,
    configs: new MemoryBoardConfigStore(),
    tickMs: 0,
    machineName: "mac",
    judges: {
      ask: async (agent, prompt, { model, effort }) => {
        asked.push({ agent, prompt, model, effort });
        return harnessSays;
      },
      classifiers: () => [{ id: "jev:jev", name: "jev" }],
      classify: async () => classifierSays,
    },
  });
  const ladder = REVIEW_LOOP_LOCAL_TEXT.replace(
    "cheap:    { agent: claude, model: haiku }",
    'cheap:    { agent: claude, model: haiku, effort: low, instructions: "Judge as the on-call." }\n  quick:    { agent: jev, min_confidence: 0.8 }',
  )
    .replace("decide: [self, cheap, human]", "decide: [self, quick, cheap, human]")
    .replace("run: { role: coder }", "run: { role: coder, done_when: turn }");
  judgeDesk.engine.putBoard(ladder, 0);
  const judgeRegistry = judging.registry;
  const endpoint2 = await PeerMcpEndpoint.listen(judging.hub, judgeDesk);
  judging.hub.setEndpoint(endpoint2.url);
  judgeRegistry.setPeerMcpServers((sid, caps) => judging.hub.mcpServersFor(sid, caps));
  const judgeTask = async (title: string): Promise<{ id: string; reviewer: ManagedSession }> => {
    const made = judgeDesk.create({ title, brief: `${title}.`, agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: work, key: null, column: "build" });
    if (made === "full") throw new Error("daemoncheck: full");
    await judgeDesk.engine.kick(made.task.id);
    const build = judgeRegistry.get(judgeDesk.get(made.task.id)!.flow.run!.session!)!;
    await finish(build, { say: "Built." });
    await until(() => judgeDesk.get(made.task.id)?.flow.column === "review" && judgeDesk.get(made.task.id)?.flow.run?.session != null);
    const reviewer = judgeRegistry.get(judgeDesk.get(made.task.id)!.flow.run!.session!)!;
    return { id: made.task.id, reviewer };
  };
  const settledAt = async (id: string): Promise<{ column: string; phase: string; events: string[] }> => {
    let last = "";
    for (let calm = 0, tries = 0; calm < 3 && tries < 300; tries += 1) {
      await settle(10);
      const now = JSON.stringify(judgeDesk.get(id)?.flow);
      calm = now === last ? calm + 1 : 0;
      last = now;
    }
    const record = judgeDesk.get(id)!;
    return { column: record.flow.column, phase: judgeDesk.snapshot(record).phase, events: judgeDesk.history(id).filter((one) => one.kind === "verdict").map((one) => one.text) };
  };

  classifierSays = { exit: "ship", confidence: 0.93 };
  const sure = await judgeTask("Sure");
  await finish(sure.reviewer, { say: "Reviewed." });
  const shippedBySure = await settledAt(sure.id);
  check("a classifier sure enough decides, and the history says who and how sure", [shippedBySure.column, shippedBySure.events], ["approve", ["quick: ship · 93%"]]);
  check("and no harness was asked", asked.length, 0);

  classifierSays = { exit: "ship", confidence: 0.5 };
  harnessSays = '{"exit": "fix", "confidence": 0.7}';
  const unsure = await judgeTask("Unsure");
  await finish(unsure.reviewer, { say: "Reviewed." });
  const fixedByCheap = await settledAt(unsure.id);
  check(
    "below its floor it abstains, and the harness role is asked next, with its model and effort",
    [fixedByCheap.column, fixedByCheap.events, asked.at(-1)?.agent, asked.at(-1)?.model, asked.at(-1)?.effort],
    ["build", ["quick did not decide: 50% is below its floor", "cheap: fix · 70%"], "claude", "haiku", "low"],
  );
  check("and through its instructions", asked.at(-1)!.prompt.includes("judge by them:\nJudge as the on-call."), true);
  check("the harness was shown the exits, the contract and what the column sees", [/- fix: the review found problems/.test(asked.at(-1)!.prompt), /Answer with one JSON object/.test(asked.at(-1)!.prompt)], [true, true]);

  for (const [name, says, classifier] of [
    ["an answer in prose", "I think it should ship.", null],
    ["an exit the column does not have", '{"exit": "deploy", "confidence": 1}', { exit: "deploy" }],
    ["stay", '{"exit": "stay"}', { exit: "stay", confidence: 0.99 }],
  ] as const) {
    classifierSays = classifier;
    harnessSays = says;
    const one = await judgeTask(name);
    await finish(one.reviewer, { say: "Reviewed." });
    const left = await settledAt(one.id);
    check(`${name} leaves the pick to you`, [left.column, left.phase], ["review", "needs_you"]);
  }
  const classifierRun = ladder.replace("run: { role: reviewer,", "run: { role: quick,");
  judgeDesk.engine.putBoard(classifierRun, judgeDesk.engine.current.revision);
  const onlyDecides = judgeDesk.create({ title: "Classifier run", brief: "x", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: work, key: null, column: "review" });
  if (onlyDecides !== "full") {
    await judgeDesk.engine.kick(onlyDecides.task.id);
    const record = judgeDesk.get(onlyDecides.task.id)!;
    check("a classifier named to run a column is no executor: you are asked, and told why", [judgeDesk.snapshot(record).phase, record.flow.ask?.detail], [
      "needs_you",
      "jev only decides; it cannot run a column's work",
    ]);
  }
  judgeDesk.engine.stop();
  await endpoint2.close();

  void store;
  await endpoint.close();
}

process.stdout.write("\nthe board across a restart, and the control commit\n");
{
  // A run that reported before the daemon went down ends on the cut turn when it comes back, and its work is committed on its branch.
  const acp = await import("@agentclientprotocol/sdk");
  const dir = tmp("board-restart-");
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=b@x", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "start"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "b@x"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "board"]);
  const file = join(dir, "reemoat.db");
  const worktrees = join(dir, "worktrees");
  let prompts: string[] = [];
  const spawn = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === acp.methods.agent.initialize) {
          send({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] } });
        } else if (message["method"] === acp.methods.agent.session.new) {
          send({ jsonrpc: "2.0", id, result: { sessionId: "c_restart" } });
        } else if (message["method"] === acp.methods.agent.session.prompt) {
          prompts.push(((message["params"]?.["prompt"] ?? []) as { text: string }[]).map((block) => block.text).join("\n"));
          // Held for ever: the daemon goes down mid-turn.
        } else if (id !== undefined) {
          send({ jsonrpc: "2.0", id, result: {} });
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
  class RestartRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "claude", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawn();
    }
    override reap() {
      return { killed: false, confirmedDead: true, detail: null };
    }
  }
  const boot = (instanceId: string) => {
    const stores = openStores({ path: file, instanceId });
    const registry = new SessionRegistry(stores.events, stores.sessions, { worktreeRoot: worktrees, branchPrefix: "reemoat", defaultMode: "auto" }, new RestartRuntime(), null);
    registry.restore({ reapOrphans: false });
    const desk = new TaskDesk({ registry, store: stores.tasks, configs: stores.boards, tickMs: 0 });
    return { stores, registry, desk };
  };
  const one = boot("i_board_1");
  one.desk.engine.putBoard("version: 1\ncolumns:\n  - { id: backlog, title: Backlog }\n  - { id: build, title: Build, run: {}, next: review }\n  - { id: review, title: Review, holder: you }\n", 0);
  const made = one.desk.create({ title: "Add a file", brief: "Add NOTES.md.", agent: "claude", customAgent: null, assignee: "agent", status: "ready", cwd: repo, key: null });
  if (made === "full") throw new Error("daemoncheck: a fresh desk is full");
  const started = await one.desk.startNow(made.task);
  const session = started.started!;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const record = one.stores.tasks.get(made.task.id)!;
  check("the first run makes the task's worktree on its own branch", [record.flow.code?.branch?.startsWith("reemoat/t-"), record.flow.workdir === session.workspace.root], [true, true]);
  writeFileSync(join(record.flow.workdir!, "NOTES.md"), "notes\n");
  // The agent reports, and the daemon goes down before its turn ends.
  one.desk.update(session.id, { summary: "Added NOTES.md.", status: "review" });
  one.desk.engine.stop();
  one.stores.close();

  prompts = [];
  const two = boot("i_board_2");
  two.desk.resume();
  const until = async (done: () => boolean, ms = 5_000) => {
    for (const at = Date.now(); !done() && Date.now() - at < ms; ) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await until(() => two.stores.tasks.get(made.task.id)?.flow.column === "review");
  const after = two.stores.tasks.get(made.task.id)!;
  check("a run cut by a restart, which had reported, reaches its exit when the daemon is back", after.flow.column, "review");
  const log = execFileSync("git", ["-C", after.flow.workdir!, "log", "--format=%s", "-1"]).toString().trim();
  check("what it left is committed on the task's branch, under the column and the run", log.startsWith("board: build #2 claude@"), true);
  check("and the run's diff is counted", after.flow.last?.diff?.paths, ["NOTES.md"]);
  two.desk.engine.stop();
  two.stores.close();
}
