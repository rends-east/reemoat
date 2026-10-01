import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { QUESTION_TOOL_HARNESSES } from "../src/acp/agents.js";
import { readMcpToolCall } from "../src/acp/cursor.js";
import { MemoryEventStore, type PersistedSession, type PromptEvent, type SessionStore } from "../src/events.js";
import { SessionRegistry, type ManagedSession } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { ASK_PENDING, ASK_TOOL_NAME, answerResult, answerText, parseAskArguments } from "../src/peers/ask.js";
import { PeerHub } from "../src/peers/hub.js";
import { PeerMcpEndpoint } from "../src/peers/mcp.js";
import { openStores } from "../src/store/sqlite.js";
import { join } from "node:path";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { rowFor, stubAgentConfig } from "./daemoncheck.fixtures.js";

// cursor's server withholds AskQuestion over ACP (Q7.154), so the reemoat MCP server offers ask_question to it alone (Q2.250).
process.stdout.write("\nask_question: a question an agent asks through this daemon's own tool\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  process.stdout.write("  the arguments and the answer\n");
  const one = { questions: [{ id: "q", prompt: "Pick one", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }] };
  const parsed = parseAskArguments(one);
  check(
    "cursor's own AskQuestion shape is what it takes",
    parsed,
    { title: null, questions: [{ id: "q", prompt: "Pick one", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], allowMultiple: false }] },
  );
  check(
    "and a refusal comes back as the reason, without the JSON-RPC prefix",
    [parseAskArguments({ questions: [] }), parseAskArguments({ questions: [{ id: "q", prompt: "x", options: [] }] })],
    ["questions must be a non-empty array", "a question must offer at least one option"],
  );
  const posed = typeof parsed === "string" ? null : parsed;
  check("an answer is delivered as the labels it picked", answerText(posed!, { action: "accept", content: { question_0: "b" } }), "Answer to your ask_question:\nPick one — Beta");
  check("a skip still reaches the agent, so it carries on", answerText(posed!, { action: "decline" }), "Skipped your ask_question: carry on without an answer.");
  check("and a dismissed card says nothing at all", answerText(posed!, { action: "cancel" }), null);
  check(
    "inside the call the same answers are its result, a dismissal included, since the call has to return something",
    [
      answerResult(posed!, { action: "accept", content: { question_0: "b" } }),
      answerResult(posed!, { action: "decline" }),
      answerResult(posed!, { action: "cancel" }),
    ],
    [
      "Your user answered:\nPick one — Beta",
      "Your user skipped the question: carry on without an answer.",
      "Your user closed the card without answering: carry on without an answer.",
    ],
  );
  const two = parseAskArguments({
    title: "Two",
    questions: [
      { id: "x", prompt: "First", options: [{ id: "1", label: "One" }, { id: "2", label: "Two" }], allowMultiple: true },
      { id: "y", prompt: "Second", options: [{ id: "n", label: "No" }] },
    ],
  });
  check(
    "several questions answer line by line, an unanswered one saying so",
    typeof two === "string" ? two : answerText(two, { action: "accept", content: { question_0: ["1", "2", "zzz"] } }),
    "Answer to your ask_question:\nFirst — One, Two\nSecond — (no answer)",
  );
  check(
    "cursor names the server and tool on the call's rawInput, and nothing else reads as one",
    [
      readMcpToolCall({ providerIdentifier: "reemoat", toolName: "ask_question", args: {} }),
      readMcpToolCall({ server: "reemoat", tool: "ask_question" }),
      readMcpToolCall(null),
    ],
    [{ server: "reemoat", tool: "ask_question" }, null, null],
  );
  check("offered to cursor alone", [...QUESTION_TOOL_HARNESSES], ["cursor"]);

  interface Agent {
    readonly prompts: string[];
    mcpServers: any[];
    /** What the client answered to each permission this stub asked, by tool name. */
    readonly permissionAnswers: Map<string, unknown>;
    /** What each MCP call returned, by tool name, once it did. */
    readonly toolResults: Map<string, string>;
  }
  // Short, so the driver can outlast it; the daemon's own is ASK_WAIT_MS.
  const ASK_WAIT = 300;
  const outlast = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, ASK_WAIT + 150));
  const agents = new Map<string, Agent>();
  let launched = 0;

  const spawn = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let current: Agent | null = null;
    let sessionId = "";
    let outbound = 1000;
    const awaiting = new Map<number, (result: unknown) => void>();
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
          awaiting.get(id)?.(message["result"] ?? message["error"]);
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
            sessionId = message["params"]?.["sessionId"] ?? `c_ask_${++launched}`;
            const state: Agent = agents.get(sessionId) ?? { prompts: [], mcpServers: [], permissionAnswers: new Map(), toolResults: new Map() };
            state.mcpServers = message["params"]?.["mcpServers"] ?? [];
            agents.set(sessionId, state);
            current = state;
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          }
          case acp.methods.agent.session.prompt: {
            const text = (message["params"]?.["prompt"] ?? [])
              .filter((block: any) => block?.type === "text")
              .map((block: any) => block.text)
              .join("");
            current?.prompts.push(text);
            const asks = /^CALL (\S+)$/.exec(text);
            if (asks === null) {
              send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              break;
            }
            // What cursor sends for an MCP call, in its measured order: the update naming the tool, then the permission.
            const tool = asks[1]!;
            const callId = `call-${tool}`;
            const update = (payload: Record<string, unknown>) =>
              send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
            update({ sessionUpdate: "tool_call", toolCallId: callId, title: "MCP: tool", kind: "other", status: "pending", rawInput: {} });
            update({
              sessionUpdate: "tool_call_update",
              toolCallId: callId,
              title: `reemoat: ${tool}`,
              rawInput: { providerIdentifier: "reemoat", toolName: tool, args: {} },
            });
            const ask = ++outbound;
            const caller = current;
            awaiting.set(ask, (result) => {
              caller?.permissionAnswers.set(tool, result);
              const finish = () => {
                update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed" });
                send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              };
              // Allowed, it then calls the tool on the server it was handed, as cursor does, and the turn waits on the call.
              const server = caller?.mcpServers[0];
              if (tool !== ASK_TOOL_NAME || (result as any)?.outcome?.optionId !== "allow-once" || server === undefined) {
                finish();
                return;
              }
              void fetch(server.url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...Object.fromEntries(server.headers.map((h: any) => [h.name.toLowerCase(), h.value])),
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: one } }),
              })
                .then((response) => response.json())
                .then((reply: any) => caller?.toolResults.set(tool, reply?.result?.content?.[0]?.text ?? ""))
                .finally(finish);
            });
            send({
              jsonrpc: "2.0",
              id: ask,
              method: "session/request_permission",
              params: {
                sessionId,
                toolCall: { toolCallId: callId, title: `reemoat-${tool}: ${tool}`, kind: "other", status: "pending" },
                options: [
                  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
                  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                ],
              },
            });
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

  class AskRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return (["cursor", "claude"] as const).map((id) => ({
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

  // A store that keeps rows, so a second registry over it is a daemon restart.
  const rows = new Map<string, PersistedSession>();
  const store: SessionStore = {
    put: (row) => void rows.set(row.id, structuredClone(row)),
    list: () => [...rows.values()].map((row) => structuredClone(row)),
    remove: (id) => void rows.delete(id),
  };

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
  const agentOf = (managed: ManagedSession): Agent => agents.get(managed.agentSessionId ?? "")!;
  const bearerOf = (managed: ManagedSession): string =>
    agentOf(managed).mcpServers[0]?.headers?.find((h: any) => h.name === "Authorization")?.value ?? "";
  const promptsOf = (managed: ManagedSession): string[] =>
    managed.log
      .read(0, 10_000, 1 << 24)
      .map((stored) => stored.event)
      .filter((event): event is PromptEvent => event.type === "prompt")
      .map((event) => event.text);
  const eventsOf = (managed: ManagedSession, type: string): any[] =>
    managed.log
      .read(0, 10_000, 1 << 24)
      .map((stored) => stored.event)
      .filter((event) => event.type === type);

  const open = async (enabled: boolean) => {
    const registry = new SessionRegistry(new MemoryEventStore(), store, undefined, new AskRuntime(), null);
    const hub = new PeerHub({ registry, enabled, askWaitMs: ASK_WAIT });
    const endpoint = await PeerMcpEndpoint.listen(hub);
    hub.setEndpoint(endpoint.url);
    registry.setPeerMcpServers((id, caps) => hub.mcpServersFor(id, caps));
    let rpcId = 0;
    const rpc = async (managed: ManagedSession, method: string, params: unknown = {}) => {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearerOf(managed) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      return (await response.json()) as any;
    };
    const ask = async (managed: ManagedSession, args: Record<string, unknown>) =>
      (await rpc(managed, "tools/call", { name: ASK_TOOL_NAME, arguments: args })).result as {
        content: { text: string }[];
        isError?: boolean;
      };
    return { registry, hub, endpoint, rpc, ask };
  };

  process.stdout.write("  who is offered it\n");
  const first = await open(true);
  const cur = await first.registry.create({ agent: "cursor", cwd: tmp("ask-cursor-"), nickname: "ask-cursor" });
  const cla = await first.registry.create({ agent: "claude", cwd: tmp("ask-claude-"), nickname: "ask-claude" });
  const names = async (managed: ManagedSession) =>
    ((await first.rpc(managed, "tools/list")).result?.tools ?? []).map((tool: any) => tool.name);
  check("a cursor session is served the messaging tools and ask_question", await names(cur), ["list_agents", "send_message", ASK_TOOL_NAME]);
  check("a claude session the messaging tools only: it has a question tool of its own", await names(cla), ["list_agents", "send_message"]);
  const instructions = (await first.rpc(cur, "initialize", { protocolVersion: "2025-06-18" })).result?.instructions ?? "";
  check("and cursor's instructions say what ask_question does", /ask_question/.test(instructions), true);

  const quiet = await open(false);
  const curQuiet = await quiet.registry.create({ agent: "cursor", cwd: tmp("ask-quiet-"), nickname: "ask-quiet" });
  const claQuiet = await quiet.registry.create({ agent: "claude", cwd: tmp("ask-quiet-claude-"), nickname: "ask-quiet-claude" });
  check("with messaging off a cursor session still gets the server", agentOf(curQuiet).mcpServers.map((server) => server.name), ["reemoat"]);
  check(
    "holding ask_question alone, with instructions that say nothing of messaging",
    [
      ((await quiet.rpc(curQuiet, "tools/list")).result?.tools ?? []).map((tool: any) => tool.name),
      /list_agents/.test((await quiet.rpc(curQuiet, "initialize", {})).result?.instructions ?? ""),
    ],
    [[ASK_TOOL_NAME], false],
  );
  check("and a claude session gets nothing at all", agentOf(claQuiet).mcpServers, []);
  const refusedQuiet = await quiet.ask(curQuiet, one);
  check("no messaging switch refuses a question", [refusedQuiet?.isError ?? false, refusedQuiet?.content[0]?.text], [false, ASK_PENDING]);
  await quiet.registry.shutdown();
  await quiet.endpoint.close();

  process.stdout.write("  a question answered while its call waits, as every other harness's is\n");
  const quick = first.ask(cur, { ...one, title: "Choose" });
  await settle();
  const pending = cur.snapshot().pendingElicitations;
  check("the session holds one question, tied to no tool call when none was seen", pending.map((one) => [one.toolCallId, one.message, one.fieldCount]), [[null, "Choose", 1]]);
  check("so it reads as waiting on its person", cur.status, "blocked");
  check("and the transcript records it being asked", eventsOf(cur, "elicitation_request").map((event) => event.toolCallId), [null]);
  const again = await first.ask(cur, one);
  check("a second one while the first is open is refused in words", [again.isError, again.content[0]?.text], [true, "your previous question is still waiting for an answer"]);
  const bad = await first.ask(cur, { questions: [{ id: "q", prompt: "x", options: [] }] });
  check("and so is a malformed one, with the parser's reason", [bad.isError, bad.content[0]?.text], [true, "a question must offer at least one option"]);
  check("the card is served the form, as cursor's own is", cur.elicitationForm(pending[0]!.elicitationId)?.fields.length, 1);
  const quiet0 = agentOf(cur).prompts.length;
  const answered = cur.answerElicitation(pending[0]!.elicitationId, { content: { question_0: "a" } });
  check("an answer is accepted and reported sent", answered.kind === "ok" ? [answered.action, answered.delivered] : answered.kind, ["accept", "sent"]);
  const quickResult = await quick;
  check("and is the call's own result", [quickResult.isError ?? false, quickResult.content[0]?.text], [false, "Your user answered:\nPick one — Alpha"]);
  await settle();
  check("so no message is sent and none is logged", [agentOf(cur).prompts.length, promptsOf(cur).length], [quiet0, 0]);
  check("and the session is no longer waiting", cur.snapshot().pendingElicitations.length, 0);
  const skipping = first.ask(cur, one);
  await settle();
  cur.answerElicitation(cur.snapshot().pendingElicitations[0]!.elicitationId, { decline: true });
  const closing = (await skipping).content[0]?.text;
  const dismissing = first.ask(cur, one);
  await settle();
  cur.answerElicitation(cur.snapshot().pendingElicitations[0]!.elicitationId, { cancel: true });
  check(
    "a skip and a dismissal are results too, and wake nobody",
    [closing, (await dismissing).content[0]?.text, agentOf(cur).prompts.length],
    ["Your user skipped the question: carry on without an answer.", "Your user closed the card without answering: carry on without an answer.", quiet0],
  );

  process.stdout.write("  a question that outlasts its call\n");
  const shown = await first.ask(cur, one);
  check("unanswered in time, the call returns and tells the agent to end its turn", [shown.isError ?? false, shown.content[0]?.text], [false, ASK_PENDING]);
  const late0 = cur.snapshot().pendingElicitations[0]!.elicitationId;
  check("while the card stays", cur.status, "blocked");
  cur.answerElicitation(late0, { content: { question_0: "a" } });
  await settle();
  check("its answer then reaches the agent as its person's next message", agentOf(cur).prompts.at(-1), "Answer to your ask_question:\nPick one — Alpha");
  check(
    "logged as a prompt naming the question it answers, which the card already draws",
    eventsOf(cur, "prompt").map((event) => [event.text, event.answers]).at(-1),
    ["Answer to your ask_question:\nPick one — Alpha", late0],
  );
  await first.ask(cur, one);
  cur.answerElicitation(cur.snapshot().pendingElicitations[0]!.elicitationId, { decline: true });
  await settle();
  check("a skip is delivered too", agentOf(cur).prompts.at(-1), "Skipped your ask_question: carry on without an answer.");
  const before = agentOf(cur).prompts.length;
  await first.ask(cur, one);
  cur.answerElicitation(cur.snapshot().pendingElicitations[0]!.elicitationId, { cancel: true });
  await settle();
  check("while a dismissed card wakes nobody", agentOf(cur).prompts.length, before);
  await first.ask(cur, one);
  await cur.cancelTurn();
  check("Stop with only a question open dismisses it", [cur.snapshot().pendingElicitations.length, agentOf(cur).prompts.length], [0, before]);
  {
    const gaveUp = new AbortController();
    const abandoned = fetch(first.endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearerOf(cur) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: ASK_TOOL_NAME, arguments: one } }),
      signal: gaveUp.signal,
    }).catch(() => null);
    await settle();
    gaveUp.abort();
    await abandoned;
    await settle();
    const left = cur.snapshot().pendingElicitations[0]?.elicitationId ?? "";
    cur.answerElicitation(left, { content: { question_0: "b" } });
    await settle();
    check("a client that gives up on the call leaves the card, answered by a message", agentOf(cur).prompts.at(-1), "Answer to your ask_question:\nPick one — Beta");
  }

  process.stdout.write("  the call in front of it\n");
  cur.prompt("CALL ask_question");
  await settle();
  check(
    "cursor's permission for ask_question is answered by the daemon, never drawn",
    [agentOf(cur).permissionAnswers.get(ASK_TOOL_NAME), cur.snapshot().pendingPermissions.length],
    [{ outcome: { outcome: "selected", optionId: "allow-once" } }, 0],
  );
  check(
    "and logged as a decision rather than hidden",
    eventsOf(cur, "permission_request").filter((event) => event.toolCallId === "call-ask_question").map((event) => event.decision),
    ["allow-once"],
  );
  const inCall = cur.snapshot().pendingElicitations;
  check(
    "the card names the call that asked, so the transcript folds that call into it as it does claude's",
    [inCall.map((one) => one.toolCallId), eventsOf(cur, "elicitation_request").at(-1)?.toolCallId, rows.get(cur.id)?.openQuestion?.toolCallId],
    [["call-ask_question"], "call-ask_question", "call-ask_question"],
  );
  check("and the turn waits on it", cur.snapshot().turn !== null, true);
  const promptsInCall = agentOf(cur).prompts.length;
  cur.answerElicitation(inCall[0]!.elicitationId, { content: { question_0: "b" } });
  await settle();
  check(
    "answered, the call returns the answer and the turn goes on, with no message",
    [agentOf(cur).toolResults.get(ASK_TOOL_NAME), agentOf(cur).prompts.length, cur.snapshot().turn],
    ["Your user answered:\nPick one — Beta", promptsInCall, null],
  );
  await cur.prompt("CALL send_message");
  await settle();
  const other = cur.snapshot().pendingPermissions;
  check("any other tool on the same server still asks its person", other.map((one) => one.toolCallId), ["call-send_message"]);
  cur.answerPermission(other[0]!.permissionId, { cancel: true });
  await cla.prompt("CALL ask_question");
  await settle();
  const claudeAsks = cla.snapshot().pendingPermissions;
  check("and on a harness that is not offered the tool, the same call asks too", claudeAsks.map((one) => one.toolCallId), ["call-ask_question"]);
  cla.answerPermission(claudeAsks[0]!.permissionId, { cancel: true });
  await settle();

  process.stdout.write("  what a question outlives\n");
  cur.prompt("CALL ask_question");
  await outlast();
  const keptId = cur.snapshot().pendingElicitations[0]!.elicitationId;
  check("past the wait the agent is told to end its turn", [agentOf(cur).toolResults.get(ASK_TOOL_NAME), cur.snapshot().turn], [ASK_PENDING, null]);
  check("and the open question is on the session's row, with its call", [rows.get(cur.id)?.openQuestion?.elicitationId, rows.get(cur.id)?.openQuestion?.toolCallId], [keptId, "call-ask_question"]);
  await first.registry.shutdown();
  await first.endpoint.close();
  check("a daemon shutdown keeps it there", rows.get(cur.id)?.openQuestion?.elicitationId, keptId);

  const second = await open(true);
  second.registry.restore({ reapOrphans: false });
  const back = second.registry.get(cur.id)!;
  check("a restarted daemon draws the same card again, on the same call", back.snapshot().pendingElicitations.map((one) => [one.elicitationId, one.toolCallId]), [[keptId, "call-ask_question"]]);
  check("with its form", back.elicitationForm(keptId)?.fields.length, 1);
  const late = back.answerElicitation(keptId, { content: { question_0: "b" } });
  check("answered after the restart, it is still sent", late.kind === "ok" ? late.delivered : late.kind, "sent");
  await settle();
  await settle();
  check("and wakes the session to deliver it", [back.status, agentOf(back).prompts.at(-1)], ["idle", "Answer to your ask_question:\nPick one — Beta"]);

  await second.ask(back, one);
  await back.stop("stopped");
  check("the person's own Stop dismisses it", [back.snapshot().pendingElicitations.length, rows.get(back.id)?.openQuestion ?? null], [0, null]);

  second.registry.setElicitation(false);
  const off = await second.registry.create({ agent: "cursor", cwd: tmp("ask-off-"), nickname: "ask-off" });
  const offAsk = await second.ask(off, one);
  check(
    "with questions off the tool is not listed, and a call is refused",
    [((await second.rpc(off, "tools/list")).result?.tools ?? []).map((tool: any) => tool.name).includes(ASK_TOOL_NAME), offAsk.isError],
    [false, true],
  );
  await second.registry.shutdown();
  await second.endpoint.close();

  process.stdout.write("  on disk\n");
  {
    const dir = tmp("ask-store-");
    const path = join(dir, "reemoat.db");
    const question = { elicitationId: "elic-3-abc", title: "Choose", questions: one.questions.map((q) => ({ ...q, allowMultiple: false })), raisedAt: 7 };
    const writer = openStores({ path, instanceId: "i_ask_w" });
    writer.sessions.put({ ...rowFor("s_ask_open", join(dir, "open")), openQuestion: question });
    writer.sessions.put({ ...rowFor("s_ask_cleared", join(dir, "cleared")), openQuestion: question });
    // The DO UPDATE has to carry the column, or an answered question would come back after a restart.
    writer.sessions.put({ ...rowFor("s_ask_cleared", join(dir, "cleared")), openQuestion: null });
    writer.sessions.put(rowFor("s_ask_garbled", join(dir, "garbled")));
    writer.db.exec("UPDATE sessions SET open_question_json = '{not json' WHERE id = 's_ask_garbled'");
    writer.close();
    const reader = openStores({ path, instanceId: "i_ask_r" });
    const byId = new Map(reader.sessions.list().map((row) => [row.id, row]));
    check("an open question survives the round trip whole", byId.get("s_ask_open")?.openQuestion, question);
    check("an answered one is cleared by the next write", byId.get("s_ask_cleared")?.openQuestion ?? null, null);
    check("and an unreadable one costs the card, never the session", [byId.has("s_ask_garbled"), byId.get("s_ask_garbled")?.openQuestion ?? null], [true, null]);
    reader.close();
  }
}
