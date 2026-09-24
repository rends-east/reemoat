import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { GROK_SPAWN_ENV, forgetPathHits, resolveAgent, sessionMetaFor } from "../src/acp/agents.js";
import {
  XAI_PLAN_OPTIONS,
  mcpElicitResponse,
  mcpElicitation,
  parseMcpElicitRequest,
  parsePlanRequest,
  parseQuestionRequest,
  planPermission,
  planResponse,
  questionElicitation,
  questionResponse,
  readInteractionResolved,
} from "../src/acp/xai.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { toElicitationForm } from "../src/session.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { now, tokenFor, verifier, credentials, stubAgentConfig } from "./daemoncheck.fixtures.js";

// Verbatim from grok 1.0.40 over `grok agent stdio`, 2026-09-24 (Q6.113); the session and call ids are that run's.
const MEASURED_QUESTION = {
  sessionId: "conv_g",
  toolCallId: "call-96b1221b-9a3a-4937-86b5-635b5384f909-0",
  questions: [
    {
      question: "Which drink?",
      options: [
        { label: "Coffee", description: "Hot, black" },
        { label: "Tea", description: "Green" },
        { label: "Water", description: "Still" },
      ],
      multiSelect: false,
    },
  ],
  mode: "default",
};
const MEASURED_TWO = {
  sessionId: "conv_g",
  toolCallId: "call-c4aef4c3-3935-47e3-87c5-420682a68216-0",
  questions: [
    MEASURED_QUESTION.questions[0],
    {
      question: "Which snacks?",
      options: [
        { label: "Nuts", description: "Nuts" },
        { label: "Fruit", description: "Fruit" },
        { label: "Cake", description: "Cake" },
      ],
      multiSelect: true,
    },
  ],
  mode: "default",
};
const MEASURED_PLAN = {
  sessionId: "conv_g",
  toolCallId: "call-db1e94e8-084b-466e-a119-ef830c66bda4-2",
  planContent: "# Plan\n\nAdd one comment line to README.md.\n",
};
const MEASURED_MCP = {
  sessionId: "conv_g",
  toolCallId: "mcp-elicit-ffb00a18-adf9-4ea4-b438-e21936e2bfe9",
  serverName: "probe",
  message: "Pick a colour for the probe",
  mode: "form",
  requestedSchema: {
    type: "object",
    properties: {
      color: { type: "string", title: "Colour", enum: ["red", "green", "blue"], enumNames: ["Red", "Green", "Blue"] },
      note: { type: "string", title: "Note", description: "Anything else" },
      loud: { type: "boolean", title: "Loud?", default: false },
    },
    required: ["color"],
  },
};

/** The JSON-RPC code a parser refused with, or "accepted". */
const refusal = (parse: () => unknown): number | "accepted" => {
  try {
    parse();
    return "accepted";
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
};

process.stdout.write("\ngrok's own requests, as tables\n");
{
  const parsed = parseQuestionRequest(MEASURED_QUESTION);
  check("the measured question parses to what the card needs, and `mode` is not carried", parsed, {
    sessionId: "conv_g",
    toolCallId: MEASURED_QUESTION.toolCallId,
    questions: [
      {
        question: "Which drink?",
        options: [
          { label: "Coffee", description: "Hot, black" },
          { label: "Tea", description: "Green" },
          { label: "Water", description: "Still" },
        ],
        multiSelect: false,
      },
    ],
  });
  const two = parseQuestionRequest(MEASURED_TWO);
  check(
    "a description grok filled in from the label is dropped, not drawn twice",
    two.questions[1]?.options.map((option) => option.description),
    [null, null, null],
  );
  check(
    "multiSelect null, as grok sends in plan mode, is one answer",
    parseQuestionRequest({ ...MEASURED_QUESTION, questions: [{ ...MEASURED_QUESTION.questions[0], multiSelect: null }] })
      .questions[0]?.multiSelect,
    false,
  );
  const malformed: [string, unknown][] = [
    ["params that are not an object", "x"],
    ["no questions", { ...MEASURED_QUESTION, questions: [] }],
    ["questions that are not a list", { ...MEASURED_QUESTION, questions: "Which drink?" }],
    ["a question with no text", { ...MEASURED_QUESTION, questions: [{ options: [] }] }],
    ["two questions with one text, which the answers map could not key", { ...MEASURED_TWO, questions: [MEASURED_QUESTION.questions[0], MEASURED_QUESTION.questions[0]] }],
    ["an option with no label", { ...MEASURED_QUESTION, questions: [{ question: "Q?", options: [{ description: "d" }] }] }],
    ["a description that is not text", { ...MEASURED_QUESTION, questions: [{ question: "Q?", options: [{ label: "A", description: 5 }] }] }],
    ["multiSelect that is not a boolean", { ...MEASURED_QUESTION, questions: [{ ...MEASURED_QUESTION.questions[0], multiSelect: "yes" }] }],
    ["no session", { ...MEASURED_QUESTION, sessionId: undefined }],
    ["no call id", { ...MEASURED_QUESTION, toolCallId: "" }],
    ["a call id past the parent-id bound", { ...MEASURED_QUESTION, toolCallId: "c".repeat(257) }],
  ];
  check(
    "every malformed question is -32602, never a guess and never -32601",
    malformed.map(([why, params]) => [why, refusal(() => parseQuestionRequest(params))]),
    malformed.map(([why]) => [why, -32602]),
  );

  const single = questionElicitation(parsed);
  check("one question is the message, as on claude's bridge", single.message, "Which drink?");
  check("the call id rides along, so the settled row joins the call's own arguments", single.toolCallId, MEASURED_QUESTION.toolCallId);
  const form = toElicitationForm(single.requestedSchema);
  check(
    "through the one projection every agent's form takes: the question, then its own-answer box",
    form.fields.map((field) => [field.key, field.kind, field.title, field.alternativeTo, field.options?.map((option) => option.label) ?? null]),
    [
      ["question_0", "string", "Which drink?", null, ["Coffee", "Tea", "Water"]],
      ["question_0_custom", "string", "Other", "question_0", null],
    ],
  );
  check("with each option's description beside it", form.fields[0]?.options?.map((option) => option.description), ["Hot, black", "Green", "Still"]);
  const twoForm = toElicitationForm(questionElicitation(two).requestedSchema);
  check(
    "several questions carry their text on the field and many-of-several is a list",
    [questionElicitation(two).message, twoForm.fields.map((field) => [field.key, field.kind, field.description])],
    [
      "Please answer the following questions.",
      [
        ["question_0", "string", "Which drink?"],
        ["question_0_custom", "string", "Type your own answer instead of choosing an option above (optional)."],
        ["question_1", "multi_select", "Which snacks?"],
        ["question_1_custom", "string", "Type your own answer instead of choosing an option above (optional)."],
      ],
    ],
  );
  const thirteen = {
    ...MEASURED_QUESTION,
    questions: Array.from({ length: 13 }, (_, index) => ({ question: `Q${index}?`, options: [{ label: "A" }] })),
  };
  check(
    "and the projection's bounds are the bounds: thirteen questions are twenty-six fields, past its twenty-four",
    refusal(() => toElicitationForm(questionElicitation(parseQuestionRequest(thirteen)).requestedSchema)),
    -1,
  );

  check(
    "an answer goes back keyed by the question's text, as grok measured accepts",
    questionResponse({ action: "accept", content: { question_0: "Tea" } }, parsed.questions),
    { outcome: "accepted", answers: { "Which drink?": "Tea" } },
  );
  check(
    "a typed own answer wins over the selection, trimmed",
    questionResponse({ action: "accept", content: { question_0: "Tea", question_0_custom: "  kvass " } }, parsed.questions),
    { outcome: "accepted", answers: { "Which drink?": "kvass" } },
  );
  check(
    "many answers go back as a list, which grok takes as it is",
    questionResponse({ action: "accept", content: { question_0: "Coffee", question_1: ["Nuts", "Fruit"] } }, two.questions),
    { outcome: "accepted", answers: { "Which drink?": "Coffee", "Which snacks?": ["Nuts", "Fruit"] } },
  );
  check(
    "an unanswered question is left out rather than sent empty",
    questionResponse({ action: "accept", content: { question_1: [] } }, two.questions),
    { outcome: "accepted", answers: {} },
  );
  check(
    "a skip and a cancel are both grok's one word for no answer",
    [
      questionResponse({ action: "decline" }, parsed.questions),
      questionResponse({ action: "cancel" }, parsed.questions),
    ],
    [{ outcome: "cancelled" }, { outcome: "cancelled" }],
  );

  const plan = parsePlanRequest(MEASURED_PLAN);
  check("the measured plan parses", plan, { sessionId: "conv_g", toolCallId: MEASURED_PLAN.toolCallId, plan: MEASURED_PLAN.planContent });
  check(
    "an absent plan is the empty one grok opens the same approval over, and a plan that is not text is refused",
    [parsePlanRequest({ ...MEASURED_PLAN, planContent: undefined }).plan, refusal(() => parsePlanRequest({ ...MEASURED_PLAN, planContent: 5 }))],
    ["", -32602],
  );
  const asPermission = planPermission(plan);
  check(
    "it is asked as a permission whose arguments are the plan, which is where the card reads one",
    [asPermission.toolCall.title, asPermission.toolCall.rawInput, asPermission.options.map((option) => [option.optionId, option.kind])],
    ["Approve plan", { plan: MEASURED_PLAN.planContent }, [["approved", "allow_once"], ["abandoned", "reject_once"]]],
  );
  check(
    "and answered in grok's own words, a cancel or anything unknown being the revise grok measured it as",
    [
      planResponse({ outcome: { outcome: "selected", optionId: "approved" } }),
      planResponse({ outcome: { outcome: "selected", optionId: "abandoned" } }),
      planResponse({ outcome: { outcome: "selected", optionId: "something_else" } }),
      planResponse({ outcome: { outcome: "cancelled" } }),
    ],
    [{ outcome: "approved" }, { outcome: "abandoned" }, { outcome: "cancelled" }, { outcome: "cancelled" }],
  );
  check("the options are frozen, so no caller can change what is offered", Object.isFrozen(XAI_PLAN_OPTIONS), true);

  const mcp = parseMcpElicitRequest(MEASURED_MCP);
  check("an MCP server's question names the server, as grok's own card does", mcpElicitation(mcp).message, "probe: Pick a colour for the probe");
  check(
    "and takes the one projection, enumNames and all",
    toElicitationForm(mcpElicitation(mcp).requestedSchema).fields.map((field) => [field.key, field.kind, field.required]),
    [["color", "string", true], ["note", "string", false], ["loud", "boolean", false]],
  );
  check(
    "url mode is refused as elicitation/create's is, and so is a form with no schema",
    [refusal(() => parseMcpElicitRequest({ ...MEASURED_MCP, mode: "url" })), refusal(() => parseMcpElicitRequest({ ...MEASURED_MCP, requestedSchema: null }))],
    [-32602, -32602],
  );
  check(
    "the three answers in grok's measured spelling, which it hands its MCP server as action",
    [
      mcpElicitResponse({ action: "accept", content: { color: "green", loud: true } }),
      mcpElicitResponse({ action: "decline" }),
      mcpElicitResponse({ action: "cancel" }),
    ],
    [{ outcome: "accept", content: { color: "green", loud: true } }, { outcome: "decline" }, { outcome: "cancel" }],
  );

  check(
    "grok settling a call itself is read off its notification stream",
    readInteractionResolved({ sessionId: "conv_g", update: { sessionUpdate: "interaction_resolved", tool_call_id: "call-1" } }),
    { sessionId: "conv_g", toolCallId: "call-1" },
  );
  check(
    "and everything else on that stream is nothing, never a throw",
    [
      readInteractionResolved({ sessionId: "conv_g", update: { sessionUpdate: "pending_interaction", tool_call_id: "call-1", kind: "question" } }),
      readInteractionResolved({ sessionId: "conv_g", update: { sessionUpdate: "tool_call_delta_chunk", tool_index: 0 } }),
      readInteractionResolved(null),
      readInteractionResolved("x"),
      readInteractionResolved({ update: { sessionUpdate: "interaction_resolved", tool_call_id: 5 } }),
    ],
    [null, null, null, null, null],
  );
}

process.stdout.write("\ngrok's launch: its question clock, and its question tool\n");
{
  check("grok's own timeout is off in its spawn environment", GROK_SPAWN_ENV, { GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "false" });
  // A stand-in on PATH, so the real resolver runs with or without grok installed.
  const bin = tmp("grokbin-");
  const fake = join(bin, "grok");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  const saved = process.env["PATH"];
  process.env["PATH"] = `${bin}:${saved ?? ""}`;
  forgetPathHits();
  try {
    const config = resolveAgent("grok");
    check(
      "and it is in what the resolver hands the spawn, beside the flags that were always there",
      [config.env["GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED"], config.args],
      ["false", ["--no-auto-update", "agent", "stdio"]],
    );
  } finally {
    process.env["PATH"] = saved;
    forgetPathHits();
  }
  check(
    "withdrawing the question tool is a session/new key, since grok keeps the tool whatever the client declares",
    [sessionMetaFor("grok", { ultracode: false, elicitation: false }), sessionMetaFor("grok", { ultracode: true, elicitation: true })],
    [{ askUserQuestion: false }, undefined],
  );
}

process.stdout.write("\ngrok's own requests, through the real client\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  interface Rig {
    ask: (method: string, params: Record<string, unknown>) => Promise<{ result?: any; error?: any }>;
    notify: (method: string, params: Record<string, unknown>) => void;
    sessionNewParams: unknown[];
    holdPrompt: boolean;
    heldPrompt: (() => void) | null;
  }
  const rigs: Rig[] = [];

  const spawnGrok = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    const waiting = new Map<number, (answer: { result?: any; error?: any }) => void>();
    let nextId = 900;
    const rig: Rig = {
      ask: (method, params) =>
        new Promise((resolve) => {
          nextId += 1;
          waiting.set(nextId, resolve);
          send({ jsonrpc: "2.0", id: nextId, method, params });
        }),
      notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
      sessionNewParams: [],
      holdPrompt: false,
      heldPrompt: null,
    };
    rigs.push(rig);
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
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            rig.sessionNewParams.push(message["params"]);
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_g" } });
            break;
          case acp.methods.agent.session.prompt: {
            const answer = (): void => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            if (rig.holdPrompt) rig.heldPrompt = answer;
            else answer();
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
    } as unknown as AgentProcess;
  };

  class GrokRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "grok", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnGrok();
    }
  }

  const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new GrokRuntime());
  const dir = tmp("grokcheck-");
  const { app } = createApp({ registry, verifier, instanceId: "i_grok", startedAt: now, credentials, roots: [dir] });
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

  const managed = await registry.create({ agent: "grok", cwd: dir });
  const rig = rigs[0]!;
  const log = () => managed.log.read(0, 10_000, 4 * 1024 * 1024).map((stored) => stored.event);
  const resolved = () =>
    log()
      .filter((event) => event.type === "elicitation_resolved" || event.type === "permission_resolved")
      .map((event) => (event as { by: string }).by);
  check("with questions allowed, grok is opened with no _meta at all", (rig.sessionNewParams[0] as { _meta?: unknown })._meta, undefined);

  // The owner's report: this answered -32601 and grok's tool failed.
  const asked = rig.ask("_x.ai/ask_user_question", MEASURED_QUESTION);
  await settle();
  const waitingOn = managed.snapshot().pendingElicitations[0];
  check("grok's question is parked for a person, not refused", [managed.status, waitingOn?.message], ["blocked", "Which drink?"]);
  check("naming grok's own call, which the transcript joins it to", waitingOn?.toolCallId, MEASURED_QUESTION.toolCallId);
  const served = managed.elicitationForm(waitingOn?.elicitationId ?? "none");
  check("the card is served the same two fields claude's question gets", served?.fields.map((field) => [field.key, field.alternativeTo]), [["question_0", null], ["question_0_custom", "question_0"]]);
  const answered = await post(`/sessions/${managed.id}/elicitations/${waitingOn?.elicitationId}`, { content: { question_0: "Tea" } });
  check("a person answers it over the ordinary route", answered.status, 200);
  check("and grok is answered in the shape it measured accepting", (await asked).result, { outcome: "accepted", answers: { "Which drink?": "Tea" } });
  const settledEvent = log().filter((event) => event.type === "elicitation_resolved").at(-1) as { answers?: unknown; by?: string } | undefined;
  check(
    "the log keeps the answer under the question's own words, by the person",
    [settledEvent?.answers, settledEvent?.by],
    [[{ key: "question_0", label: "Which drink?", value: "Tea" }], "client"],
  );

  const several = rig.ask("_x.ai/ask_user_question", MEASURED_TWO);
  await settle();
  const second = managed.snapshot().pendingElicitations[0]?.elicitationId ?? "none";
  await post(`/sessions/${managed.id}/elicitations/${second}`, { content: { question_0: "Coffee", question_0_custom: "kvass", question_1: ["Nuts", "Cake"] } });
  check("several questions, an own answer and a list, in one reply", (await several).result, {
    outcome: "accepted",
    answers: { "Which drink?": "kvass", "Which snacks?": ["Nuts", "Cake"] },
  });

  const skipped = rig.ask("_x.ai/ask_user_question", MEASURED_QUESTION);
  await settle();
  await post(`/sessions/${managed.id}/elicitations/${managed.snapshot().pendingElicitations[0]?.elicitationId}`, { decline: true });
  check("Skip reaches grok as its one word for no answer", (await skipped).result, { outcome: "cancelled" });

  // grok's own settling: the interaction_resolved that closes its permission step comes first and must not pre-empt the question.
  rig.notify("_x.ai/session_notification", { sessionId: "conv_g", update: { sessionUpdate: "interaction_resolved", tool_call_id: "call-early" } });
  const early = rig.ask("_x.ai/ask_user_question", { ...MEASURED_QUESTION, toolCallId: "call-early" });
  await settle();
  check("a resolution that arrived before its question does not withdraw it", managed.snapshot().pendingElicitations.length, 1);
  rig.notify("_x.ai/session_notification", { sessionId: "conv_g", update: { sessionUpdate: "interaction_resolved", tool_call_id: "call-early" } });
  await settle();
  check("one that arrives while it waits is grok withdrawing it", [managed.snapshot().pendingElicitations.length, resolved().at(-1)], [0, "agent_withdrew"]);
  check("and grok, which has moved on, is still answered rather than left hanging", (await early).result, { outcome: "cancelled" });

  const plan = rig.ask("_x.ai/exit_plan_mode", MEASURED_PLAN);
  await settle();
  const parkedPlan = managed.snapshot().pendingPermissions[0];
  check(
    "grok's plan is parked as a permission with its own two options",
    [managed.status, parkedPlan?.title, parkedPlan?.options.map((option) => option.optionId), parkedPlan?.rawInput],
    ["blocked", "Approve plan", ["approved", "abandoned"], { plan: MEASURED_PLAN.planContent }],
  );
  await post(`/sessions/${managed.id}/permissions/${parkedPlan?.permissionId}`, { optionId: "approved" });
  check("approving it sends grok the outcome it measured as approval", (await plan).result, { outcome: "approved" });

  // Past the snapshot's 8 KiB clamp: the card recovers a plan from the log, so the log must hold it.
  const longPlan = `# Plan\n\n${"Change one line in one file. ".repeat(400)}`;
  const abandoned = rig.ask("_x.ai/exit_plan_mode", { ...MEASURED_PLAN, toolCallId: "call-long", planContent: longPlan });
  await settle();
  const longParked = managed.snapshot().pendingPermissions[0];
  check("a long plan is clamped on the snapshot, as every permission blob is", (longParked?.rawInput as { truncated?: boolean }).truncated, true);
  const written = log().filter((event) => event.type === "tool_call_update" && event.toolCallId === "call-long");
  check("and whole in the log, on grok's own call", written.map((event) => (event as { rawInput: { plan?: string } }).rawInput.plan === longPlan), [true]);
  await post(`/sessions/${managed.id}/permissions/${longParked?.permissionId}`, { optionId: "abandoned" });
  check("abandoning it is grok's abandon", (await abandoned).result, { outcome: "abandoned" });

  const withdrawn = rig.ask("_x.ai/exit_plan_mode", { ...MEASURED_PLAN, toolCallId: "call-gone" });
  await settle();
  rig.notify("_x.ai/session_notification", { sessionId: "conv_g", update: { sessionUpdate: "interaction_resolved", tool_call_id: "call-gone" } });
  await settle();
  check(
    "a plan grok settles itself is withdrawn the same way, and answered as revise",
    [managed.snapshot().pendingPermissions.length, resolved().at(-1), (await withdrawn).result],
    [0, "agent_withdrew", { outcome: "cancelled" }],
  );

  // Revising: the composer cancels, then prompts. With a turn held the cancel sweeps the plan.
  rig.holdPrompt = true;
  managed.prompt("plan something");
  await settle();
  const revising = rig.ask("_x.ai/exit_plan_mode", MEASURED_PLAN);
  await settle();
  const cancel = await post(`/sessions/${managed.id}/cancel`);
  check("Stop dismisses the plan as a person's cancel", [cancel.status, resolved().at(-1)], [200, "turn_cancelled"]);
  check("which grok reads as revise, keeping plan mode on", (await revising).result, { outcome: "cancelled" });
  rig.heldPrompt?.();
  rig.holdPrompt = false;
  await settle();
  check("and the correction goes through as the next message", (await post(`/sessions/${managed.id}/prompt`, { text: "change step 2" })).status, 202);
  await settle();

  const colour = rig.ask("_x.ai/mcp/elicit", MEASURED_MCP);
  await settle();
  const fromServer = managed.snapshot().pendingElicitations[0];
  check("an MCP server's form is parked as a question naming the server", fromServer?.message, "probe: Pick a colour for the probe");
  await post(`/sessions/${managed.id}/elicitations/${fromServer?.elicitationId}`, { content: { color: "green", loud: true } });
  check("and its answer goes back in grok's spelling", (await colour).result, { outcome: "accept", content: { color: "green", loud: true } });
  const declined = rig.ask("_x.ai/mcp/elicit", MEASURED_MCP);
  await settle();
  await post(`/sessions/${managed.id}/elicitations/${managed.snapshot().pendingElicitations[0]?.elicitationId}`, { decline: true });
  check("a decline is a decline", (await declined).result, { outcome: "decline" });

  const before = log().length;
  const broken = await rig.ask("_x.ai/ask_user_question", { ...MEASURED_QUESTION, questions: "Which drink?" });
  check("a malformed question is -32602 to grok", broken.error?.code, -32602);
  check("with nothing parked and nothing written", [managed.snapshot().pendingElicitations.length, log().length - before], [0, 0]);
  check("url mode from an MCP server is -32602, which grok hands the server as a cancel", (await rig.ask("_x.ai/mcp/elicit", { ...MEASURED_MCP, mode: "url" })).error?.code, -32602);
  check(
    "every other extension method still fails loudly, x.ai's own included",
    [(await rig.ask("_x.ai/folder_trust/request", { sessionId: "conv_g" })).error?.code, (await rig.ask("_vendor/thing", {})).error?.code],
    [-32601, -32601],
  );

  const lastWord = rig.ask("_x.ai/ask_user_question", MEASURED_QUESTION);
  await settle();
  await managed.stop();
  check("stopping the session answers a parked question, as the agent going away", [(await lastWord).result, resolved().at(-1)], [{ outcome: "cancelled" }, "session_stopped"]);

  // Questions off: the tool is withdrawn at session/new, and a question that arrives anyway is -32601 as before.
  registry.setElicitation(false);
  const quiet = await registry.create({ agent: "grok", cwd: dir });
  const quietRig = rigs[1]!;
  check("with questions off, grok is opened without its question tool", (quietRig.sessionNewParams[0] as { _meta?: unknown })._meta, { askUserQuestion: false });
  check(
    "and both kinds of question are -32601, as they were for everybody",
    [
      (await quietRig.ask("_x.ai/ask_user_question", MEASURED_QUESTION)).error?.code,
      (await quietRig.ask("_x.ai/mcp/elicit", MEASURED_MCP)).error?.code,
    ],
    [-32601, -32601],
  );
  const stillAsked = quietRig.ask("_x.ai/exit_plan_mode", MEASURED_PLAN);
  await settle();
  check("while a plan, which is a permission, is still asked", quiet.snapshot().pendingPermissions.length, 1);
  await quiet.stop();
  check("and answered when the session goes", (await stillAsked).result, { outcome: "cancelled" });
  registry.setElicitation(true);

  await registry.shutdown();
}
