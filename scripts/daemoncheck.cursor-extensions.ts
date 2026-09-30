import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { SESSION_SCOPED_ENV, forgetPathHits, resolveAgent } from "../src/acp/agents.js";
import {
  CURSOR_CLIENT_META,
  CURSOR_PLAN_OPTIONS,
  clientMetaFor,
  mergeTodos,
  parseImageRequest,
  parsePlanRequest,
  parseQuestionRequest,
  parseTodosRequest,
  planPermission,
  planResponse,
  questionElicitation,
  questionResponse,
  readSubagentSpawn,
  todosAsPlan,
} from "../src/acp/cursor.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { toElicitationForm } from "../src/session.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { now, tokenFor, verifier, credentials, stubAgentConfig } from "./daemoncheck.fixtures.js";

// Shaped from cursor-agent 2026.09.28-64d2043's own ACP server (Q6.117); no sessionId, as cursor sends none.
const QUESTION = {
  toolCallId: "toolu_ask_1",
  questions: [
    {
      id: "drink",
      prompt: "Which drink?",
      options: [
        { id: "coffee", label: "Coffee" },
        { id: "tea", label: "Tea" },
      ],
      allowMultiple: false,
    },
  ],
};
const TWO = {
  toolCallId: "toolu_ask_2",
  title: "Before I start",
  questions: [
    QUESTION.questions[0],
    {
      id: "snacks",
      prompt: "Which snacks?",
      options: [
        { id: "nuts", label: "Nuts" },
        { id: "fruit", label: "Fruit" },
        { id: "cake", label: "Cake" },
      ],
      allowMultiple: true,
    },
  ],
};
const PLAN = {
  toolCallId: "toolu_plan_1",
  name: "Comment the README",
  overview: "One line",
  plan: "# Plan\n\nAdd one comment line to README.md.\n",
  todos: [{ id: "t1", content: "Add the line", status: "pending" }],
};
const TODOS = {
  toolCallId: "toolu_todo_1",
  todos: [
    { id: "a", content: "Read the file", status: "completed" },
    { id: "b", content: "Change it", status: "in_progress" },
    { id: "c", content: "Something dropped", status: "cancelled" },
  ],
  merge: false,
};

const refusal = (parse: () => unknown): number | "accepted" => {
  try {
    parse();
    return "accepted";
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
};

process.stdout.write("\ncursor's own requests, as tables\n");
{
  check("a question parses to what the card needs, with no title when cursor sent none", parseQuestionRequest(QUESTION), {
    toolCallId: "toolu_ask_1",
    title: null,
    questions: [{ id: "drink", prompt: "Which drink?", options: QUESTION.questions[0]!.options, allowMultiple: false }],
  });
  check(
    "and every shape it cannot answer is refused before anything is parked",
    [
      refusal(() => parseQuestionRequest({ ...QUESTION, questions: [] })),
      refusal(() => parseQuestionRequest({ ...QUESTION, questions: [{ ...QUESTION.questions[0], options: [] }] })),
      refusal(() => parseQuestionRequest({ ...QUESTION, questions: [QUESTION.questions[0], QUESTION.questions[0]] })),
      refusal(() => parseQuestionRequest({ ...QUESTION, questions: [{ ...QUESTION.questions[0], allowMultiple: "yes" }] })),
      refusal(() => parseQuestionRequest({ ...QUESTION, toolCallId: "x".repeat(257) })),
      refusal(() => parseQuestionRequest({ questions: QUESTION.questions })),
    ],
    [-32602, -32602, -32602, -32602, -32602, -32602],
  );
  const one = questionElicitation(parseQuestionRequest(QUESTION), "cursor_s");
  check("one question is one field valued by option id and titled by label, with the question as the message", [one.message, one.requestedSchema], [
    "Which drink?",
    {
      type: "object",
      properties: {
        question_0: { type: "string", title: "Which drink?", description: undefined, oneOf: [{ const: "coffee", title: "Coffee" }, { const: "tea", title: "Tea" }] },
      },
    },
  ]);
  const two = questionElicitation(parseQuestionRequest(TWO), "cursor_s");
  check(
    "several take cursor's title as the message, and a multiple-choice one is a list — with no own-answer box, since cursor reads none",
    [two.message, Object.keys(two.requestedSchema.properties ?? {}), (two.requestedSchema.properties?.["question_1"] as { type: string } | undefined)?.type],
    ["Before I start", ["question_0", "question_1"], "array"],
  );
  check("and the card can draw both", toElicitationForm(two.requestedSchema).fields.map((field) => [field.key, field.alternativeTo]), [["question_0", null], ["question_1", null]]);
  const questions = parseQuestionRequest(TWO).questions;
  check(
    "an answer goes back as option ids per question id; Skip is cursor's skipped and a cancel its cancelled",
    [
      questionResponse({ action: "accept", content: { question_0: "tea", question_1: ["nuts", "cake", "forged"] } }, questions),
      questionResponse({ action: "decline" }, questions),
      questionResponse({ action: "cancel" }, questions),
    ],
    [
      { outcome: { outcome: "answered", answers: [{ questionId: "drink", selectedOptionIds: ["tea"] }, { questionId: "snacks", selectedOptionIds: ["nuts", "cake"] }] } },
      { outcome: { outcome: "skipped" } },
      { outcome: { outcome: "cancelled" } },
    ],
  );

  const plan = parsePlanRequest(PLAN);
  check("a plan is its markdown and its call", plan, { toolCallId: "toolu_plan_1", plan: PLAN.plan });
  check(
    "drawn as a permission whose two options are named for the plan, and whose plan rides rawInput",
    [planPermission(plan, "cursor_s").toolCall.rawInput, CURSOR_PLAN_OPTIONS.map((option) => [option.optionId, option.kind])],
    [{ plan: PLAN.plan }, [["accepted", "allow_once"], ["rejected", "reject_once"]]],
  );
  check(
    "and refused only by cursor's own word, since an error makes cursor accept the plan itself",
    [
      planResponse({ outcome: { outcome: "selected", optionId: "accepted" } }),
      planResponse({ outcome: { outcome: "selected", optionId: "rejected" } }),
      planResponse({ outcome: { outcome: "selected", optionId: "forged" } }),
      planResponse({ outcome: { outcome: "cancelled" } }),
    ],
    [{ outcome: { outcome: "accepted" } }, { outcome: { outcome: "rejected" } }, { outcome: { outcome: "cancelled" } }, { outcome: { outcome: "cancelled" } }],
  );

  const todos = parseTodosRequest(TODOS);
  const replaced = mergeTodos([{ id: "z", content: "old", status: "pending" }], todos);
  check("a todo update that is not a merge replaces the list", replaced.map((one) => one.id), ["a", "b", "c"]);
  const merged = mergeTodos(replaced, parseTodosRequest({ toolCallId: "toolu_todo_2", todos: [{ id: "b", content: "Change it", status: "completed" }, { id: "d", content: "Test it", status: "pending" }], merge: true }));
  check("and a merge changes what it names in place and appends the rest", merged.map((one) => `${one.id}:${one.status}`), ["a:completed", "b:completed", "c:cancelled", "d:pending"]);
  check(
    "drawn as ACP's plan, with a cancelled item left off rather than drawn as still to do",
    todosAsPlan(merged),
    [
      { content: "Read the file", priority: "medium", status: "completed" },
      { content: "Change it", priority: "medium", status: "completed" },
      { content: "Test it", priority: "medium", status: "pending" },
    ],
  );
  check("an unknown status reads as pending, as cursor maps it", parseTodosRequest({ ...TODOS, todos: [{ id: "a", content: "x", status: "weird" }] }).todos[0]?.status, "pending");
  check("a generated image is its path, or nothing", [parseImageRequest({ toolCallId: "t", filePath: "/tmp/i.png" }).filePath, parseImageRequest({ toolCallId: "t" }).filePath], ["/tmp/i.png", null]);

  check(
    "a subagent's spawn names its session and the call it runs under",
    readSubagentSpawn({ sessionUpdate: "subagent_spawned", subagentSessionId: "agent-1", task: "", capabilities: {}, _meta: { cursor: { toolCallId: "task-1", agentId: "agent-1" } } }),
    { childSessionId: "agent-1", parentToolCallId: "task-1" },
  );
  check(
    "and anything else is nothing, never a throw",
    [
      readSubagentSpawn({ sessionUpdate: "subagent_state_update", subagentSessionId: "agent-1", state: "completed" }),
      readSubagentSpawn({ sessionUpdate: "subagent_spawned", subagentSessionId: "agent-1" }),
      readSubagentSpawn(null),
      readSubagentSpawn("x"),
    ],
    [null, null, null, null],
  );
  check(
    "the two client capabilities are declared to cursor and to nobody else",
    [clientMetaFor("cursor"), clientMetaFor("claude"), clientMetaFor("grok")],
    [{ subagents: true, parameterizedModelPicker: true }, undefined, undefined],
  );
}

process.stdout.write("\ncursor's launch\n");
{
  const bin = tmp("cursorbin-");
  const fake = join(bin, "cursor-agent");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  const saved = process.env["PATH"];
  const savedConversation = process.env["CURSOR_CONVERSATION_ID"];
  process.env["PATH"] = `${bin}:${saved ?? ""}`;
  process.env["CURSOR_CONVERSATION_ID"] = "the parent's";
  forgetPathHits();
  try {
    const config = resolveAgent("cursor");
    check(
      "cursor is its own CLI's acp subcommand, updater off, spawned in the session's directory",
      [config.command, config.args, config.inSessionCwd],
      [fake, ["--disable-auto-update", "acp"], true],
    );
    check(
      "and a daemon started from a cursor shell does not hand that conversation to the agent it spawns",
      [SESSION_SCOPED_ENV.filter((name) => name.startsWith("CURSOR_")), config.env["CURSOR_CONVERSATION_ID"]],
      [["CURSOR_AGENT", "CURSOR_CONVERSATION_ID", "CURSOR_REQUEST_ID"], undefined],
    );
  } finally {
    process.env["PATH"] = saved;
    if (savedConversation === undefined) delete process.env["CURSOR_CONVERSATION_ID"];
    else process.env["CURSOR_CONVERSATION_ID"] = savedConversation;
    forgetPathHits();
  }
}

process.stdout.write("\ncursor's own requests, through the real client\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  interface Rig {
    ask: (method: string, params: Record<string, unknown>) => Promise<{ result?: any; error?: any }>;
    update: (sessionId: string, update: Record<string, unknown>) => void;
    initialize: unknown[];
    opened: { method: string; params: any }[];
    /** What the next session/load replays before it answers. */
    replay: Record<string, unknown>[];
  }
  const rigs: Rig[] = [];
  /** Handed to the next process spawned: a load replays what the conversation held. */
  const nextReplay: Record<string, unknown>[] = [];

  const spawnCursor = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    const waiting = new Map<number, (answer: { result?: any; error?: any }) => void>();
    // cursor's own request ids start at 0; the SDK must answer that one like any other.
    let nextId = -1;
    const rig: Rig = {
      ask: (method, params) =>
        new Promise((resolve) => {
          nextId += 1;
          waiting.set(nextId, resolve);
          send({ jsonrpc: "2.0", id: nextId, method, params });
        }),
      update: (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }),
      initialize: [],
      opened: [],
      replay: [...nextReplay],
    };
    rigs.push(rig);
    const opened = {
      modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }, { id: "ask", name: "Ask" }] },
      configOptions: [
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }, { value: "ask", name: "Ask" }] },
      ],
    };
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === undefined && id !== undefined) {
          waiting.get(id)?.({ result: message["result"], error: message["error"] });
          waiting.delete(id);
          continue;
        }
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            rig.initialize.push(message["params"]);
            // cursor's answer: load but no resume, and cursor_login is the only advertised method.
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, subagents: {} } },
                authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
              },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume:
          case acp.methods.agent.session.load: {
            rig.opened.push({ method: message["method"], params: message["params"] });
            const sessionId = message["method"] === acp.methods.agent.session.new ? "cursor_s" : message["params"].sessionId;
            if (message["method"] === acp.methods.agent.session.load) for (const update of rig.replay) rig.update(sessionId, update);
            send({ jsonrpc: "2.0", id, result: message["method"] === acp.methods.agent.session.new ? { sessionId, ...opened } : opened });
            // A different list after a load, so a check on it cannot pass on what the previous process left.
            const name = message["method"] === acp.methods.agent.session.load ? "after-load" : "copy-request-id";
            setTimeout(() => rig.update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name, description: "Copy the last request ID" }] }), 0);
            break;
          }
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
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
    } as unknown as AgentProcess;
  };

  class CursorRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "cursor", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return { ...stubAgentConfig(agent), id: agent };
    }
    override async launch(): Promise<AgentProcess> {
      return spawnCursor();
    }
  }

  const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new CursorRuntime());
  const dir = tmp("cursorcheck-");
  const { app } = createApp({ registry, verifier, instanceId: "i_cursor", startedAt: now, credentials, roots: [dir] });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await app.fetch(
      new Request(`http://d${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
  };

  const managed = await registry.create({ agent: "cursor", cwd: dir });
  const rig = rigs[0]!;
  const log = () => managed.log.read(0, 10_000, 4 * 1024 * 1024).map((stored) => stored.event);
  const meta = (rig.initialize[0] as { clientCapabilities?: { _meta?: Record<string, unknown> } }).clientCapabilities?._meta ?? {};
  check("cursor is told this client takes subagents and the parameterized picker, under _meta", [meta["subagents"], meta["parameterizedModelPicker"]], [CURSOR_CLIENT_META["subagents"], CURSOR_CLIENT_META["parameterizedModelPicker"]]);
  check("and is never sent authenticate, whose only advertised method opens a browser", rig.opened.map((one) => one.method), ["session/new"]);

  const asked = rig.ask("cursor/ask_question", QUESTION);
  await settle();
  const waitingOn = managed.snapshot().pendingElicitations[0];
  check("cursor's question, which names no session, is parked on the one this process serves", [managed.status, waitingOn?.message, waitingOn?.toolCallId], ["blocked", "Which drink?", "toolu_ask_1"]);
  await post(`/sessions/${managed.id}/elicitations/${waitingOn?.elicitationId}`, { content: { question_0: "tea" } });
  check("and answered in cursor's shape", (await asked).result, { outcome: { outcome: "answered", answers: [{ questionId: "drink", selectedOptionIds: ["tea"] }] } });
  const skipped = rig.ask("cursor/ask_question", TWO);
  await settle();
  await post(`/sessions/${managed.id}/elicitations/${managed.snapshot().pendingElicitations[0]?.elicitationId}`, { decline: true });
  check("Skip is skipped", (await skipped).result, { outcome: { outcome: "skipped" } });

  const plan = rig.ask("cursor/create_plan", PLAN);
  await settle();
  const parked = managed.snapshot().pendingPermissions[0];
  check(
    "a plan is parked as a permission with its own two options and the plan on it",
    [parked?.title, parked?.options.map((option) => option.optionId), parked?.rawInput],
    ["Approve plan", ["accepted", "rejected"], { plan: PLAN.plan }],
  );
  check("and written onto cursor's own call, where the card recovers a long one", log().some((event) => event.type === "tool_call_update" && event.toolCallId === "toolu_plan_1"), true);
  await post(`/sessions/${managed.id}/permissions/${parked?.permissionId}`, { optionId: "accepted" });
  check("approving it is cursor's accepted", (await plan).result, { outcome: { outcome: "accepted" } });
  const rejected = rig.ask("cursor/create_plan", { ...PLAN, toolCallId: "toolu_plan_2" });
  await settle();
  await post(`/sessions/${managed.id}/permissions/${managed.snapshot().pendingPermissions[0]?.permissionId}`, { optionId: "rejected" });
  check("and rejecting it is rejected, never an error, which cursor would read as acceptance", (await rejected).result, { outcome: { outcome: "rejected" } });

  const plansBefore = log().filter((event) => event.type === "plan").length;
  check("a todo update is answered at once, since cursor holds it open", (await rig.ask("cursor/update_todos", TODOS)).result, {});
  const planned = log().filter((event) => event.type === "plan");
  check("and becomes the session's plan", [planned.length - plansBefore, (planned.at(-1) as { entries?: unknown[] } | undefined)?.entries?.length], [1, 2]);
  check("a task report is answered and drawn as nothing new", (await rig.ask("cursor/task", { toolCallId: "task-1", description: "", prompt: "", subagentType: { custom: {} } })).result, {});
  check("a generated image is answered", (await rig.ask("cursor/generate_image", { toolCallId: "img-1", description: "a cat", filePath: "/tmp/cat.png" })).result, {});
  check(
    "and its path is put on its card",
    log().filter((event) => event.type === "tool_call_update" && event.toolCallId === "img-1").map((event) => (event as { locations: { path: string }[] }).locations.map((one) => one.path)),
    [["/tmp/cat.png"]],
  );

  // A subagent: announced on the parent, then every frame of its own on its own session id.
  rig.update("cursor_s", { sessionUpdate: "tool_call", toolCallId: "task-1", title: "Task: look around", kind: "other", status: "pending" });
  rig.update("cursor_s", { sessionUpdate: "subagent_spawned", subagentSessionId: "agent-1", name: "explore", task: "look around", capabilities: {}, _meta: { cursor: { toolCallId: "task-1", agentId: "agent-1" } } });
  rig.update("agent-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the subagent thinking aloud" } });
  rig.update("agent-1", { sessionUpdate: "tool_call", toolCallId: "child-call", title: "Read README.md", kind: "read", status: "pending" });
  rig.update("agent-1", { sessionUpdate: "tool_call_update", toolCallId: "child-call", status: "completed" });
  rig.update("agent-9", { sessionUpdate: "tool_call", toolCallId: "orphan-call", title: "Nobody spawned me", kind: "read", status: "pending" });
  rig.update("cursor_s", { sessionUpdate: "subagent_state_update", subagentSessionId: "agent-1", state: "completed", _meta: { cursor: { toolCallId: "task-1", agentId: "agent-1" } } });
  await settle();
  const child = log().filter((event) => (event.type === "tool_call" || event.type === "tool_call_update") && event.toolCallId === "child-call");
  check(
    "a subagent's calls land in the session that spawned it, under the call that spawned it",
    child.map((event) => [event.type, (event as { parentToolCallId: string | null }).parentToolCallId]),
    [["tool_call", "task-1"], ["tool_call_update", "task-1"]],
  );
  check(
    "while what it said does not, and a session nobody announced reaches nothing",
    [log().some((event) => event.type === "text" && event.text === "the subagent thinking aloud"), log().some((event) => event.type === "tool_call" && event.toolCallId === "orphan-call")],
    [false, false],
  );
  check("and neither announcement is left in the transcript as an unknown update", log().filter((event) => event.type === "other" && String((event as { sessionUpdate: string }).sessionUpdate).startsWith("subagent_")).length, 0);
  const childTodos = planned.length;
  await rig.ask("cursor/update_todos", { ...TODOS, toolCallId: "child-call" });
  check("a subagent's todo list does not replace this session's", log().filter((event) => event.type === "plan").length, childTodos);
  const fromChild = rig.ask("session/request_permission", {
    sessionId: "agent-1",
    toolCall: { toolCallId: "subagent-web-fetch-1", title: "Allow web fetch?", kind: "other", status: "pending" },
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
  });
  await settle();
  const childAsk = managed.snapshot().pendingPermissions[0];
  check("and a permission it asks on its own session id is asked of the person all the same", childAsk?.title, "Allow web fetch?");
  await post(`/sessions/${managed.id}/permissions/${childAsk?.permissionId}`, { optionId: "allow-once" });
  check("with the answer going back to it", (await fromChild).result, { outcome: { outcome: "selected", optionId: "allow-once" } });

  // Resume: cursor has load and no resume, and the load replays the whole conversation before it answers.
  // A conversation somebody has spoken in, or the registry opens a fresh one instead of reattaching.
  check("a message first, so there is a conversation to come back to", (await post(`/sessions/${managed.id}/prompt`, { text: "hello" })).status, 202);
  await settle();
  const lengthBefore = log().length;
  await managed.stop();
  nextReplay.push(
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "REPLAYED question" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED answer" } },
    { sessionUpdate: "tool_call", toolCallId: "replay-0-0", title: "Read README.md", kind: "read", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "replay-0-0", status: "completed" },
  );
  await managed.resume();
  nextReplay.length = 0;
  await settle();
  const loadRig = rigs.at(-1)!;
  check("a session comes back through session/load, cursor having no resume", loadRig.opened.map((one) => [one.method, one.params.sessionId]), [["session/load", "cursor_s"]]);
  check(
    "and nothing the load replayed is written a second time",
    log().slice(lengthBefore).filter((event) => (event.type === "text" && event.text.startsWith("REPLAYED")) || (event.type === "tool_call" && event.toolCallId === "replay-0-0")).length,
    0,
  );
  check("while what follows the answer is taken as state", managed.agentCommands.commands.map((one) => one.name), ["after-load"]);
  check("and the session is live again", managed.snapshot().status, "idle");
  await managed.stop();

  // Questions off: cursor then asks through permissions of its own accord, which is its fallback for this refusal.
  registry.setElicitation(false);
  const quiet = await registry.create({ agent: "cursor", cwd: dir });
  check("with questions off, cursor's question is -32601", (await rigs.at(-1)!.ask("cursor/ask_question", QUESTION)).error?.code, -32601);
  await quiet.stop();
  registry.setElicitation(true);

  await registry.shutdown();
}
