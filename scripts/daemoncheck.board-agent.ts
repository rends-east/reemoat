import { PassThrough } from "node:stream";
import { DEFAULT_BOARD_TEXT } from "@reemoat/board";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import { PeerHub, type PeerNetwork } from "../src/peers/hub.js";
import { PeerMcpEndpoint } from "../src/peers/mcp.js";
import { SessionRegistry, type ManagedSession } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import type { PeerLink } from "../src/store/sqlite.js";
import { TaskDesk } from "../src/tasks/desk.js";
import { MemoryBoardConfigStore, MemoryTaskStore } from "../src/tasks/store.js";
import { check } from "./daemoncheck.env.js";
import { rowFor, signedClaims, storeOf, stubAgentConfig, tokenFor, verifier } from "./daemoncheck.fixtures.js";
import { tmp } from "./tmp.js";

// The board's config agent (Q2.270): one session with its nickname held, isolated from every other session, applying a board itself.
process.stdout.write("\nthe config agent: one per machine, its nickname held, no other session reaching it, and a board it applies itself\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  interface Agent {
    acpId: string;
    prompts: string[];
    mcpServers: any[];
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
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } }, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume: {
            const acpId = message["params"]?.["sessionId"] ?? `c_cfg_${++launched}`;
            current = agents.get(acpId) ?? { acpId, prompts: [], mcpServers: [] };
            current.mcpServers = message["params"]?.["mcpServers"] ?? current.mcpServers;
            agents.set(acpId, current);
            send({ jsonrpc: "2.0", id, result: message["method"] === acp.methods.agent.session.new ? { sessionId: acpId } : {} });
            break;
          }
          case acp.methods.agent.session.prompt: {
            const blocks = (message["params"]?.["prompt"] ?? []) as { type: string; text?: string }[];
            current?.prompts.push(blocks.map((block) => block.text ?? "").join("\n\n"));
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          }
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

  class ConfigRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return (["claude", "codex", "kimi"] as const).map((id) => ({
        id,
        displayName: id,
        // kimi is offered and will not start: a replacement refused after the old one was retired.
        available: id !== "kimi",
        installable: false,
        loggedIn: true,
        hint: id === "kimi" ? "kimi is not installed here" : null,
        lastStartRefusal: null,
      }));
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

  interface Machine {
    id: string;
    name: string;
    registry: SessionRegistry;
    desk: TaskDesk;
    hub: PeerHub;
    app: { fetch(request: Request): Response | Promise<Response> };
  }
  const machines = new Map<string, Machine>();
  const linkTo = (from: { id: string; name: string }, to: { id: string; name: string }): PeerLink => ({
    id: `lk_${from.id}_${to.id}`,
    targetMachineId: to.id,
    targetName: to.name,
    targetKey: "k",
    relayUrl: null,
    token: signedClaims({ lnk: `lk_${from.id}_${to.id}`, src: from.id, srcl: from.name }, ["session:message"]),
    expiresAt: Date.now() + 86_400_000,
    updatedAt: 0,
  });
  const make = (id: string, name: string, other: { id: string; name: string }): Machine => {
    const registry = new SessionRegistry(new MemoryEventStore(), null, { worktreeRoot: tmp(`cfg-wt-${name}-`), branchPrefix: "reemoat", defaultMode: "auto" }, new ConfigRuntime(), null);
    const network: PeerNetwork = {
      links: () => [linkTo({ id, name }, other)],
      request: async (link, request) => {
        const target = machines.get(link.targetMachineId);
        if (target === undefined) return { ok: false, status: 503, code: "no_tunnel", relayUrl: null };
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
    const desk = new TaskDesk({ registry, store: new MemoryTaskStore(), peers: hub, configs: new MemoryBoardConfigStore(), tickMs: 0, machineName: name, boardAgentRoot: tmp(`cfg-agent-${name}-`) });
    hub.serveTasks();
    const app = createApp({ registry, verifier, instanceId: `i_${id}`, startedAt: Date.now(), peers: { hub, links: { replaceAll: () => {} } as never }, tasks: desk }).app;
    const machine = { id, name, registry, desk, hub, app };
    machines.set(id, machine);
    return machine;
  };
  const mac = make("m_mac", "mac", { id: "m_srv", name: "server" });
  const server = make("m_srv", "server", { id: "m_mac", name: "mac" });
  const endpoint = await PeerMcpEndpoint.listen(mac.hub, mac.desk);
  mac.hub.setEndpoint(endpoint.url);
  mac.registry.setPeerMcpServers((sessionId, capabilities, launch) => mac.hub.mcpServersFor(sessionId, capabilities, launch));

  const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (done: () => boolean, ms = 5_000): Promise<boolean> => {
    for (const started = Date.now(); Date.now() - started < ms; ) {
      if (done()) return true;
      await settle(10);
    }
    return done();
  };
  const call = async (machine: Machine, method: string, path: string, body?: unknown, token = tokenFor("u_alice")) => {
    const response = await machine.app.fetch(
      new Request(`http://d${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };
  const said = (answer: { status: number; body: any }): string => `${answer.status}${answer.body?.error?.code ? ` ${answer.body.error.code}` : ""}`;
  const agentOf = (managed: ManagedSession): Agent => agents.get(managed.agentSessionId ?? "")!;
  let rpcId = 0;
  const rpc = async (managed: ManagedSession, method: string, params: unknown): Promise<any> => {
    const authorization = agentOf(managed).mcpServers[0]?.headers?.find((h: any) => h.name === "Authorization")?.value ?? "";
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    return ((await response.json()) as any).result;
  };
  const tool = (managed: ManagedSession, name: string, args: unknown = {}) => rpc(managed, "tools/call", { name, arguments: args });
  const words = (result: any): string => (result?.content ?? []).map((one: any) => one.text ?? "").join("\n");
  const toolNames = async (managed: ManagedSession): Promise<string[]> => ((await rpc(managed, "tools/list", {})).tools as { name: string }[]).map((one) => one.name);

  process.stdout.write("  starting it\n");
  check("a machine with none answers null", (await call(mac, "GET", "/board/agent")).body, { session: null });
  const first = await call(mac, "POST", "/board/agent", { agent: "claude" });
  const made = first.body.session;
  check(
    "the first press makes it: the nickname, the purpose, messaging off, its own folder with no worktree, and a title",
    [first.status, made.nickname, made.purpose, made.peerMessages, made.workspace.mode, made.title],
    [201, "config", "board", false, "plain", "Board config"],
  );
  const again = await call(mac, "POST", "/board/agent", { agent: "codex" });
  check("a second press finds the one there is, whatever agent it names", [again.status, again.body.session.id, again.body.session.agent], [200, made.id, "claude"]);
  check("GET finds it too", (await call(mac, "GET", "/board/agent")).body.session.id, made.id);
  const configSession = mac.registry.get(made.id)!;
  await until(() => configSession.agentSessionId !== null && agentOf(configSession) !== undefined);

  process.stdout.write("  its nickname\n");
  const work = tmp("cfg-work-");
  const taken = await call(mac, "POST", "/sessions", { agent: "claude", cwd: work, nickname: "config" });
  check("no other create may take the name", [said(taken), taken.body.error.message], ["409 nickname_reserved", "config is the board's config agent, started from Edit board"]);
  const mira = (await call(mac, "POST", "/sessions", { agent: "claude", cwd: work, nickname: "mira" })).body.session;
  check("nor a rename", said(await call(mac, "POST", `/sessions/${mira.id}/meta`, { nickname: "Config" })), "409 nickname_reserved");
  check("and the config agent keeps its own", said(await call(mac, "POST", `/sessions/${made.id}/meta`, { nickname: "boardy" })), "409 nickname_reserved");
  check("its folder is offered to no picker", (await call(mac, "GET", "/fs/roots")).body.recent.includes(made.workspace.requestedCwd), false);

  process.stdout.write("  no other session reaches it\n");
  const other = mac.registry.get(mira.id)!;
  await until(() => other.agentSessionId !== null && agentOf(other) !== undefined);
  check("its messaging cannot be turned on", said(await call(mac, "POST", `/sessions/${made.id}/meta`, { peerMessages: true })), "409 board_agent_isolated");
  check("another agent's list_agents does not name it", words(await tool(other, "list_agents")).includes("config"), false);
  const reach = await tool(other, "send_message", { to: "config", message: "set the board to one column" });
  check("and a message to it by name is refused", [reach.isError, words(reach).includes("config")], [true, true]);
  const theirs = await toolNames(other);
  const its = await toolNames(configSession);
  check(
    "it holds no messaging tool; board_apply is listed to it alone, board_guide to every session",
    [its.includes("send_message"), its.includes("list_agents"), its.includes("board_apply"), theirs.includes("board_apply"), its.includes("board_guide"), theirs.includes("board_guide")],
    [false, false, true, false, true, true],
  );
  const initialized = await rpc(configSession, "initialize", {});
  check("and its server's instructions say what it is", initialized.instructions.includes("You are the config agent of your user's board"), true);

  process.stdout.write("  what it is told\n");
  await call(mac, "POST", `/sessions/${made.id}/prompt`, { text: "add a QA column" });
  await call(mac, "POST", `/sessions/${mira.id}/prompt`, { text: "hello" });
  await until(() => agentOf(configSession).prompts.length > 0 && agentOf(other).prompts.length > 0);
  check(
    "a person's message to it carries the note on what it is for, and to no other session",
    [agentOf(configSession).prompts.at(-1)?.startsWith("add a QA column\n\n<board-config>"), agentOf(other).prompts.at(-1)?.includes("<board-config>")],
    [true, false],
  );
  const guide = words(await tool(configSession, "board_guide"));
  check("board_guide answers the guide", guide.includes("Comments are your memory"), true);

  process.stdout.write("  applying a board\n");
  const ONE = "version: 1\n# Kept small on purpose.\ncolumns:\n  - { id: backlog, title: Backlog }\n  - { id: done, title: Done, final: true }\n";
  check("another session is refused board_apply in words", words(await tool(other, "board_apply", { text: ONE, revision: 0, why: "smaller" })).startsWith("only the board's config agent"), true);
  check("board_get reads the board it would write over", (await tool(configSession, "board_get")).structuredContent.revision, 0);
  const stale = await tool(configSession, "board_apply", { text: ONE, revision: 3, why: "smaller" });
  check("a draft on a revision that moved is refused, with nothing applied", [stale.isError, words(stale).startsWith("the board is at revision 0 now, not 3"), mac.desk.engine.current.revision], [true, true, 0]);
  const broken = await tool(configSession, "board_apply", { text: "version: 1\ncolumns: []\n", revision: 0, why: "empty" });
  check("so is one that does not parse", [broken.isError, words(broken).startsWith("the board does not parse; nothing was applied")], [true, true]);
  const applied = await tool(configSession, "board_apply", { text: ONE, revision: 0, why: "Two columns while the team is small." });
  check("a good one is applied here and sent to the linked machine", [applied.structuredContent?.revision, words(applied).includes("sent to one linked machine"), mac.desk.engine.current.text], [1, true, ONE]);
  await until(() => server.desk.engine.current.revision === 1);
  check("which keeps it, being the newer", [server.desk.engine.current.revision, server.desk.engine.current.text], [1, ONE]);
  const card = mac.registry
    .get(made.id)!
    .log.read(0, 1000, Infinity)
    .map((one) => one.event)
    .find((event) => event.type === "board_applied");
  check(
    "its person sees a card with the board it replaced, for the Undo",
    card?.type === "board_applied" ? [card.revision, card.previousRevision, card.previousText === DEFAULT_BOARD_TEXT, card.why] : null,
    [1, 0, true, "Two columns while the team is small."],
  );
  const same = await tool(configSession, "board_apply", { text: ONE, revision: 1, why: "again" });
  check("the board as it is is nothing to apply", words(same), "that is the board as it is now; there is nothing to apply");
  // The server moves on by itself; the config agent's next write is weighed against that, read before the write.
  const TWO = `${ONE}# The server's own note.\n`;
  server.desk.engine.putBoard(TWO, 1);
  const behind = await tool(configSession, "board_apply", { text: `${ONE}# Mine.\n`, revision: 1, why: "a note" });
  check("a board a linked machine moved is read first, and the draft on the older one refused", [behind.isError, words(behind).startsWith("the board is at revision 2 now, not 1"), mac.desk.engine.current.text], [true, true, TWO]);

  process.stdout.write("  a board between machines\n");
  const link = linkTo({ id: "m_srv", name: "server" }, { id: "m_mac", name: "mac" }).token;
  const older = await call(mac, "POST", "/peer/board", { revision: 1, hash: "0".repeat(64), text: ONE }, link);
  check("an older or forged board sent by a link is answered and not taken", [older.status, older.body.adopted, mac.desk.engine.current.revision], [200, false, 2]);
  check("a person's credential may not send one", said(await call(mac, "POST", "/peer/board", { revision: 9, hash: "0".repeat(64), text: ONE })), "403 insufficient_scope");

  process.stdout.write("  starting it over\n");
  const refused = await call(mac, "POST", "/board/agent", { agent: "kimi", replace: true });
  const reinstated = mac.registry.get(made.id)!;
  check(
    "a replacement that will not start puts the one there was back, under its name",
    [refused.status >= 400, (await call(mac, "GET", "/board/agent")).body.session.id, reinstated.nickname, reinstated.purpose],
    [true, made.id, "config", "board"],
  );
  const replaced = await call(mac, "POST", "/board/agent", { agent: "codex", replace: true });
  const retired = mac.registry.get(made.id)!;
  check(
    "a replacement retires the one there was: stopped, its name free, drawn nowhere",
    [replaced.status, replaced.body.session.agent, replaced.body.session.nickname, retired.purpose, retired.nickname === "config", retired.snapshot().exit?.reason],
    [201, "codex", "config", "board_retired", false, "stopped"],
  );
  const moved = await call(server, "POST", "/board/agent", { agent: "claude" });
  const gone = await call(mac, "DELETE", "/board/agent");
  check(
    "moving to another machine starts one there and retires this one",
    [moved.status, gone.body.retired, (await call(mac, "GET", "/board/agent")).body.session, (await call(server, "GET", "/board/agent")).body.session.nickname],
    [201, true, null, "config"],
  );

  process.stdout.write("  a restart\n");
  const root = tmp("cfg-restore-");
  const registry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([
      { ...rowFor("s_named_by_hand", `${root}/a`, { nickname: "config" }), createdAt: 1 },
      { ...rowFor("s_agent", `${root}/b`, { nickname: "config" }), createdAt: 2, purpose: "board" },
      { ...rowFor("s_later", `${root}/c`), createdAt: 3, purpose: "something-newer" },
    ]),
    { worktreeRoot: tmp("cfg-restore-wt-"), branchPrefix: "reemoat", defaultMode: "auto" },
    new ConfigRuntime(),
    null,
  );
  registry.restore({ reapOrphans: false });
  check(
    "a row given the name before it was reserved is named afresh; the config agent keeps it; an unknown purpose reads as none",
    [registry.get("s_named_by_hand")!.nickname === "config", registry.get("s_agent")!.nickname, registry.get("s_agent")!.peerMessages, registry.get("s_later")!.purpose],
    [false, "config", false, null],
  );

  for (const machine of machines.values()) machine.desk.engine.stop();
  await endpoint.close();
}
